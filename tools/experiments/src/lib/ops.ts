import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  DeleteFunctionConcurrencyCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
} from '@aws-sdk/client-lambda';
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
  injectLateTick(tick: TickCommand): Promise<OpsReport>;
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

  async function psql(sql: string): Promise<{ ok: true; out: string } | { ok: false; reason: string }> {
    if (container.length === 0) {
      return { ok: false, reason: 'PG_CONTAINER is empty' };
    }
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', container, 'psql', '-U', 'seatrelay', '-d', 'seatrelay', '-tA', '-c', sql],
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
        ? { available: true, detail: `TICK inserted into the commands table (dedup ${dedup})` }
        : { available: false, detail: `could not insert the TICK (${result.reason})` };
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
  metricsPeriodSeconds?: number;
}

export function createAwsOps(options: AwsOpsOptions): TargetOps {
  const region = options.region ?? awsRegion();
  const stackName = STACKS.app(options.stage);
  let outputsPromise: Promise<Record<string, string>> | undefined;
  const sqs = () => options.sqs ?? new SQSClient({ region });
  const lambda = () => options.lambda ?? new LambdaClient({ region });

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
        return { available: true, detail: `TICK sent to the FIFO (group ${tick.workshopId}, dedup ${dedup})` };
      } catch (error) {
        return unavailable(error);
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
