import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  DeleteFunctionConcurrencyCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { GetQueueAttributesCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { TickCommand } from '@seatrelay/contracts';
import {
  STACKS,
  assertAwsCredentials,
  awsRegion,
  getStackOutputs,
  type TargetConfig,
} from '@seatrelay/scripts';
import { getMetricData, seatRelayQueries, type MetricsResult } from './cloudwatch';

/**
 * Side channels an experiment needs beyond the public API, per target:
 *
 * - local (docker compose): the `commands` table (FAILED rows = the DLQ; a late TICK is
 *   injected as a queue row through `docker exec … psql`) and `GET /metrics` (in-process
 *   metric aggregates since the server started);
 * - dev/pilot (AWS): the stack's queues (DLQ depths, a late TICK via `SendMessage` on the
 *   FIFO), the notifier's reserved concurrency (`PutFunctionConcurrency`) and CloudWatch.
 *
 * - traceability of one command (plan §4 "failure recovery: traceable"): the `commands` row
 *   (status, deliveries, last error) on local, a CloudWatch Logs Insights query on the worker
 *   log group on AWS.
 *
 * Every call reports `available`/`done` instead of throwing when the side channel is missing
 * (no docker, no AWS credentials, …), so a script can document what it skipped.
 */

const execFileAsync = promisify(execFile);

export interface OpsReport {
  available: boolean;
  detail: string;
}

export interface DeadLetterReport extends OpsReport {
  /** Per queue / status: the number of messages that failed permanently. */
  counts: Record<string, number>;
  total: number;
}

export interface InjectedTick extends OpsReport {
  /** Deduplication id the TICK was sent with (local: the `commands.dedup_id`). */
  dedupId?: string;
}

/** How one queue message was processed (by `commandId`, or a manual tick's dedup id). */
export interface CommandTrace extends OpsReport {
  /** Deliveries of the message (local `commands.attempts`; AWS: highest deliveryAttempt logged). */
  deliveries?: number;
  /** Local queue status: PENDING | DONE | FAILED. */
  status?: string;
  lastError?: string;
  /** Rows / log lines that document the processing (for raw.csv and summary.md). */
  events: string[];
}

export interface MetricsBaseline {
  at: Date;
  /** local only: cumulative sums at `at`. */
  local?: Record<string, { sum: number; count: number }>;
}

export interface MetricsDelta extends OpsReport {
  /** Per metric: sum (and sample count) since the baseline. */
  values: Record<string, { sum: number; count: number }>;
}

export interface TargetOps {
  readonly kind: 'local' | 'aws';
  deadLetters(): Promise<DeadLetterReport>;
  /** Injects a TICK straight into the command queue (the "late timer message" of plan §4). */
  injectLateTick(tick: TickCommand): Promise<InjectedTick>;
  /** Delivery record of one message (see `CommandTrace`); `sinceMs` bounds the log search. */
  commandTrace(dedupId: string, sinceMs?: number): Promise<CommandTrace>;
  metricsBaseline(): Promise<MetricsBaseline>;
  metricsSince(baseline: MetricsBaseline, names: readonly string[]): Promise<MetricsDelta>;
  /** Stops notification delivery (dev: notifier reserved concurrency 0). */
  pauseNotifier(): Promise<OpsReport>;
  resumeNotifier(): Promise<OpsReport>;
  /** Whether `_fault` flags are honoured by this deployment (ALLOW_FAULT_FLAGS). */
  faultFlagsExpected(): boolean;
}

export interface LocalOpsOptions {
  apiBase: string;
  /** Postgres container of the compose stack (`PG_CONTAINER`, empty = no psql access). */
  container?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_PG_CONTAINER = 'seatrelay-local-postgres-1';

interface LocalMetricsSnapshot {
  since: string;
  metrics: Record<string, { count: number; sum: number }>;
}

export function createLocalOps(options: LocalOpsOptions): TargetOps {
  const container = options.container ?? process.env.PG_CONTAINER ?? DEFAULT_PG_CONTAINER;
  const fetchImpl = options.fetch ?? fetch;

  async function psql(
    sql: string,
    separator = '|',
  ): Promise<{ ok: true; out: string } | { ok: false; reason: string }> {
    if (container.length === 0) {
      return { ok: false, reason: 'PG_CONTAINER is empty' };
    }
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', container, 'psql', '-U', 'seatrelay', '-d', 'seatrelay', '-tA', '-F', separator, '-c', sql],
        { timeout: 20_000 },
      );
      return { ok: true, out: stdout.trim() };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error) };
    }
  }

  async function metricsSnapshot(): Promise<LocalMetricsSnapshot | undefined> {
    try {
      const response = await fetchImpl(`${options.apiBase}/metrics`);
      if (!response.ok) {
        return undefined;
      }
      return (await response.json()) as LocalMetricsSnapshot;
    } catch {
      return undefined;
    }
  }

  return {
    kind: 'local',
    async deadLetters() {
      const result = await psql(`SELECT status, count(*) FROM commands WHERE status = 'FAILED' GROUP BY status`);
      if (!result.ok) {
        return { available: false, detail: `commands table not readable (${result.reason})`, counts: {}, total: 0 };
      }
      const counts: Record<string, number> = { 'commands.FAILED': 0 };
      for (const line of result.out.split('\n')) {
        const [status, count] = line.split('|');
        if (status !== undefined && count !== undefined && status.length > 0) {
          counts[`commands.${status}`] = Number(count);
        }
      }
      const total = Object.values(counts).reduce((acc, value) => acc + value, 0);
      return { available: true, detail: `commands rows with status FAILED: ${total}`, counts, total };
    },
    async injectLateTick(tick) {
      const payload = JSON.stringify(tick).replace(/'/g, "''");
      const dedup = `manual#${tick.offerId ?? 'tick'}#${randomUUID()}`;
      const result = await psql(
        `INSERT INTO commands (workshop_id, payload, dedup_id) VALUES ('${tick.workshopId}', '${payload}'::jsonb, '${dedup}')`,
      );
      return result.ok
        ? { available: true, detail: `TICK inserted into the commands table (dedup ${dedup})`, dedupId: dedup }
        : { available: false, detail: `could not insert the TICK (${result.reason})` };
    },
    async commandTrace(dedupId) {
      const id = dedupId.replace(/'/g, "''");
      const result = await psql(
        `SELECT status, attempts, coalesce(replace(last_error, chr(10), ' '), ''), ` +
          `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ` +
          `coalesce(to_char(done_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') ` +
          `FROM commands WHERE dedup_id = '${id}'`,
        '\t',
      );
      if (!result.ok) {
        return { available: false, detail: `commands table not readable (${result.reason})`, events: [] };
      }
      const line = result.out.split('\n').find((candidate) => candidate.length > 0);
      if (line === undefined) {
        return { available: true, detail: `no commands row with dedup_id ${dedupId}`, events: [] };
      }
      const [status = '', attempts = '0', lastError = '', createdAt = '', doneAt = ''] = line.split('\t');
      const trace: CommandTrace = {
        available: true,
        detail: `commands row: status ${status}, ${attempts} deliveries`,
        deliveries: Number(attempts),
        status,
        events: [`queued ${createdAt}`, ...(doneAt.length > 0 ? [`done ${doneAt}`] : []), ...(lastError.length > 0 ? [`last error: ${lastError}`] : [])],
      };
      if (lastError.length > 0) {
        trace.lastError = lastError;
      }
      return trace;
    },
    async metricsBaseline() {
      const snapshot = await metricsSnapshot();
      const local: Record<string, { sum: number; count: number }> = {};
      for (const [name, series] of Object.entries(snapshot?.metrics ?? {})) {
        local[name] = { sum: series.sum, count: series.count };
      }
      return { at: new Date(), ...(snapshot === undefined ? {} : { local }) };
    },
    async metricsSince(baseline, names) {
      const snapshot = await metricsSnapshot();
      if (snapshot === undefined) {
        return { available: false, detail: `GET ${options.apiBase}/metrics failed`, values: {} };
      }
      const values: Record<string, { sum: number; count: number }> = {};
      for (const name of names) {
        const now = snapshot.metrics[name] ?? { sum: 0, count: 0 };
        const before = baseline.local?.[name] ?? { sum: 0, count: 0 };
        values[name] = { sum: now.sum - before.sum, count: now.count - before.count };
      }
      return { available: true, detail: `GET /metrics deltas since ${baseline.at.toISOString()}`, values };
    },
    async pauseNotifier() {
      return {
        available: false,
        detail: 'the local notifier is an in-process loop of the server; it cannot be paused from outside (plan §4: documented and skipped)',
      };
    },
    async resumeNotifier() {
      return { available: false, detail: 'nothing to resume on the local stack' };
    },
    faultFlagsExpected: () => true,
  };
}

export interface AwsOpsOptions {
  stage: string;
  region?: string;
  /** Pre-resolved stack outputs (tests); otherwise `DescribeStacks` on seatrelay-app-<stage>. */
  outputs?: Record<string, string>;
  sqs?: Pick<SQSClient, 'send' | 'config'>;
  lambda?: Pick<LambdaClient, 'send' | 'config'>;
  logs?: Pick<CloudWatchLogsClient, 'send' | 'config'>;
  metricsPeriodSeconds?: number;
  /** Logs Insights polling (tests inject a no-op sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Give up waiting for a Logs Insights query after this long (default 60 s). */
  logsQueryTimeoutMs?: number;
}

/** Worker log group of a stage (services/aws/templates/app.yaml). */
export function workerLogGroup(stage: string): string {
  return `/aws/lambda/seatrelay-${stage}-worker`;
}

/** Logs Insights query listing the worker log lines of one command. */
export function commandTraceQuery(commandId: string): string {
  const id = commandId.replace(/[^A-Za-z0-9#:._-]/g, '');
  return [
    'fields @timestamp, message, deliveryAttempt, outcome, status, reason',
    `| filter commandId = '${id}'`,
    '| sort @timestamp asc',
    '| limit 50',
  ].join(' ');
}

export function createAwsOps(options: AwsOpsOptions): TargetOps {
  const region = options.region ?? awsRegion();
  const stackName = STACKS.app(options.stage);
  let outputsPromise: Promise<Record<string, string>> | undefined;
  const sqs = () => options.sqs ?? new SQSClient({ region });
  const lambda = () => options.lambda ?? new LambdaClient({ region });
  const logs = () => options.logs ?? new CloudWatchLogsClient({ region });
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function outputs(): Promise<Record<string, string>> {
    outputsPromise ??= (async () => {
      if (options.outputs !== undefined) {
        return options.outputs;
      }
      await assertAwsCredentials(sqs());
      return getStackOutputs(stackName);
    })();
    return outputsPromise;
  }

  const unavailable = (error: unknown): OpsReport => ({
    available: false,
    detail: error instanceof Error ? error.message : String(error),
  });

  return {
    kind: 'aws',
    async deadLetters() {
      try {
        const out = await outputs();
        const queues: [string, string | undefined][] = [
          ['commands-dlq', out.CommandsDlqUrl],
          ['expiry-delay-dlq', out.ExpiryDelayDlqUrl],
          ['notify-dlq', out.NotifyDlqUrl],
        ];
        const counts: Record<string, number> = {};
        for (const [name, url] of queues) {
          if (url === undefined) {
            continue;
          }
          const attributes = await sqs().send(
            new GetQueueAttributesCommand({
              QueueUrl: url,
              AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
            }),
          );
          counts[name] =
            Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0') +
            Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
        }
        const total = Object.values(counts).reduce((acc, value) => acc + value, 0);
        return { available: true, detail: `DLQ depths of ${stackName}: ${JSON.stringify(counts)}`, counts, total };
      } catch (error) {
        return { ...unavailable(error), counts: {}, total: 0 };
      }
    },
    async injectLateTick(tick) {
      try {
        const out = await outputs();
        const queueUrl = out.CommandsQueueUrl;
        if (queueUrl === undefined) {
          return { available: false, detail: `${stackName} has no CommandsQueueUrl output` };
        }
        const dedup = `manual#${tick.offerId ?? 'tick'}#${randomUUID()}`;
        await sqs().send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(tick),
            MessageGroupId: tick.workshopId,
            MessageDeduplicationId: dedup,
          }),
        );
        return {
          available: true,
          detail: `TICK sent to the FIFO (group ${tick.workshopId}, dedup ${dedup})`,
          dedupId: dedup,
        };
      } catch (error) {
        return unavailable(error);
      }
    },
    async commandTrace(commandId, sinceMs) {
      try {
        const client = logs();
        if (options.logs === undefined) {
          await assertAwsCredentials(client);
        }
        const logGroupName = workerLogGroup(options.stage);
        const end = Date.now() + 60_000;
        const start = (sinceMs ?? Date.now() - 3_600_000) - 60_000;
        const started = await client.send(
          new StartQueryCommand({
            logGroupName,
            startTime: Math.floor(start / 1000),
            endTime: Math.floor(end / 1000),
            queryString: commandTraceQuery(commandId),
          }),
        );
        const queryId = started.queryId;
        if (queryId === undefined) {
          return { available: false, detail: 'Logs Insights returned no queryId', events: [] };
        }
        const deadline = Date.now() + (options.logsQueryTimeoutMs ?? 60_000);
        for (;;) {
          const results = await client.send(new GetQueryResultsCommand({ queryId }));
          const status = results.status ?? 'Unknown';
          if (status === 'Complete') {
            const rows = (results.results ?? []).map((fields) =>
              Object.fromEntries(fields.map((field) => [field.field ?? '', field.value ?? ''])),
            );
            const attempts = rows
              .map((row) => Number(row.deliveryAttempt))
              .filter((value) => Number.isFinite(value) && value > 0);
            const events = rows.map(
              (row) =>
                `${row['@timestamp'] ?? ''} ${row.message ?? ''}${row.deliveryAttempt ? ` (delivery ${row.deliveryAttempt})` : ''}${row.outcome ? ` outcome=${row.outcome}` : ''}`,
            );
            const trace: CommandTrace = {
              available: true,
              detail: `${rows.length} worker log lines in ${logGroupName}`,
              events,
            };
            if (attempts.length > 0) {
              trace.deliveries = Math.max(...attempts);
            }
            return trace;
          }
          if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
            return { available: false, detail: `Logs Insights query ${status}`, events: [] };
          }
          if (Date.now() > deadline) {
            return { available: false, detail: 'Logs Insights query did not complete in time', events: [] };
          }
          await pause(1000);
        }
      } catch (error) {
        return { ...unavailable(error), events: [] };
      }
    },
    async metricsBaseline() {
      return { at: new Date() };
    },
    async metricsSince(baseline, names) {
      const end = new Date();
      // EMF datapoints carry the invocation's timestamp; widen the window by a minute each side.
      const result: MetricsResult = await getMetricData(
        seatRelayQueries(names),
        {
          start: new Date(baseline.at.getTime() - 60_000),
          end: new Date(end.getTime() + 60_000),
          periodSeconds: options.metricsPeriodSeconds ?? 60,
        },
        { region },
      );
      if (!result.available) {
        return { available: false, detail: `CloudWatch not fetched: ${result.reason}`, values: {} };
      }
      const values: Record<string, { sum: number; count: number }> = {};
      for (const name of names) {
        const sum = result.series.find((series) => series.id === `${name.toLowerCase()}_sum`);
        const count = result.series.find((series) => series.id === `${name.toLowerCase()}_samplecount`);
        values[name] = { sum: sum?.total ?? 0, count: count?.total ?? 0 };
      }
      return {
        available: true,
        detail: `CloudWatch SeatRelay sums ${result.window.start} → ${result.window.end} (metrics may lag by ~1 min)`,
        values,
      };
    },
    async pauseNotifier() {
      try {
        const out = await outputs();
        const name = out.NotifierFunctionName ?? `seatrelay-${options.stage}-notifier`;
        await lambda().send(new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: 0 }));
        return { available: true, detail: `PutFunctionConcurrency(${name}, 0)` };
      } catch (error) {
        return unavailable(error);
      }
    },
    async resumeNotifier() {
      try {
        const out = await outputs();
        const name = out.NotifierFunctionName ?? `seatrelay-${options.stage}-notifier`;
        await lambda().send(new DeleteFunctionConcurrencyCommand({ FunctionName: name }));
        return { available: true, detail: `DeleteFunctionConcurrency(${name})` };
      } catch (error) {
        return unavailable(error);
      }
    },
    faultFlagsExpected: () => options.stage === 'dev',
  };
}

export function createTargetOps(target: TargetConfig): TargetOps {
  if (target.name === 'local') {
    return createLocalOps({ apiBase: target.apiBase });
  }
  return createAwsOps({ stage: target.stage });
}
