import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import type { RunRow } from './k6summary';

/**
 * Server-side evidence for one measured round (plan §3 step 15): SQS depth and age of the
 * oldest message of the stage's commands FIFO, and the worker's `CommandSettledLatency`
 * (EMF, namespace SeatRelay, dimensions `service=worker` and `stage=<stage>`) over the round window.
 *
 * CloudWatch keeps these metrics at one-minute resolution and ingests them 1–3 minutes late,
 * so `run-matrix` (a) starts every k6 run so that its measured phase begins on a minute
 * boundary (`alignedSpawnMs`), (b) queries only whole minutes inside the measured phase
 * (`measuredWindow`) with ONE period spanning the window, so the p95 is the p95 of the window
 * (not the max of per-minute p95s), and (c) pulls the metrics after the whole matrix, once the
 * ingestion delay has passed.
 */
export interface RoundWindow {
  start: Date;
  end: Date;
}

/**
 * The CloudWatch figures of one run. The keys are exactly the `RunRow` columns they fill
 * (`cwSettleP95`, not `settleP95`: the client-observed k6 settle p95 lives in `settleP95`).
 */
export interface RoundMetrics {
  sqsDepthMax?: number;
  sqsOldestAgeMax?: number;
  cwSettleP95?: number;
  cwSettleCount?: number;
}

export const ROUND_METRIC_KEYS = [
  'sqsDepthMax',
  'sqsOldestAgeMax',
  'cwSettleP95',
  'cwSettleCount',
] as const satisfies readonly (keyof RoundMetrics & keyof RunRow)[];

const MINUTE_MS = 60_000;

export const METRICS_NAMESPACE = 'SeatRelay';
/** `POWERTOOLS_SERVICE_NAME` of the worker function (templates/app.yaml). */
export const WORKER_SERVICE = 'worker';

export function commandsQueueName(stage: string): string {
  return `seatrelay-${stage}-commands.fifo`;
}

export function roundMetricQueries(
  stage: string,
  service = WORKER_SERVICE,
  period = 60,
): MetricDataQuery[] {
  const queue = { Name: 'QueueName', Value: commandsQueueName(stage) };
  // The worker's EMF metrics carry `service` and `stage` (services/aws/src/lib/metrics.ts); a query
  // on `service` alone addresses a different series that the deployed stacks no longer write.
  const workerDims = [
    { Name: 'service', Value: service },
    { Name: 'stage', Value: stage },
  ];
  return [
    {
      Id: 'sqsDepth',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/SQS',
          MetricName: 'ApproximateNumberOfMessagesVisible',
          Dimensions: [queue],
        },
        Period: period,
        Stat: 'Maximum',
      },
    },
    {
      Id: 'sqsAge',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/SQS',
          MetricName: 'ApproximateAgeOfOldestMessage',
          Dimensions: [queue],
        },
        Period: period,
        Stat: 'Maximum',
      },
    },
    {
      Id: 'settleP95',
      MetricStat: {
        Metric: {
          Namespace: METRICS_NAMESPACE,
          MetricName: 'CommandSettledLatency',
          Dimensions: workerDims,
        },
        Period: period,
        Stat: 'p95',
      },
    },
    {
      Id: 'settleCount',
      MetricStat: {
        Metric: {
          Namespace: METRICS_NAMESPACE,
          MetricName: 'CommandSettledLatency',
          Dimensions: workerDims,
        },
        Period: period,
        Stat: 'SampleCount',
      },
    },
  ];
}

function max(values: number[] | undefined): number | undefined {
  return values === undefined || values.length === 0 ? undefined : Math.max(...values);
}

function sum(values: number[] | undefined): number | undefined {
  return values === undefined || values.length === 0
    ? undefined
    : values.reduce((a, b) => a + b, 0);
}

/** Reduces the datapoints of the window to one number each (max; sum for the sample count). */
export function summariseMetricData(results: MetricDataResult[] | undefined): RoundMetrics {
  const metrics: RoundMetrics = {};
  for (const result of results ?? []) {
    const values = result.Values ?? [];
    switch (result.Id) {
      case 'sqsDepth': {
        const value = max(values);
        if (value !== undefined) metrics.sqsDepthMax = value;
        break;
      }
      case 'sqsAge': {
        const value = max(values);
        if (value !== undefined) metrics.sqsOldestAgeMax = value;
        break;
      }
      case 'settleP95': {
        // One datapoint when the period spans the window (fetchRoundMetrics); the max is a
        // conservative fallback should CloudWatch split it.
        const value = max(values);
        if (value !== undefined) metrics.cwSettleP95 = value;
        break;
      }
      case 'settleCount': {
        const value = sum(values);
        if (value !== undefined) metrics.cwSettleCount = value;
        break;
      }
      default:
        break;
    }
  }
  return metrics;
}

export interface MetricDataClient {
  send(command: GetMetricDataCommand): Promise<{ MetricDataResults?: MetricDataResult[] }>;
}

/**
 * The whole minutes of a window: start rounded up, end rounded down, so the query never reaches
 * into the run before or after. Throws when no whole minute is left.
 */
export function wholeMinutes(window: RoundWindow): { startMs: number; endMs: number } {
  const startMs = Math.ceil(window.start.getTime() / MINUTE_MS) * MINUTE_MS;
  const endMs = Math.floor(window.end.getTime() / MINUTE_MS) * MINUTE_MS;
  if (endMs <= startMs) {
    throw new Error(
      `window ${window.start.toISOString()} → ${window.end.toISOString()} holds no whole minute (CloudWatch resolution)`,
    );
  }
  return { startMs, endMs };
}

/**
 * GetMetricData for one run with a single period spanning the whole window: the SQS maxima,
 * the p95 and the sample count of `CommandSettledLatency` over exactly that window.
 */
export async function fetchRoundMetrics(
  client: MetricDataClient,
  stage: string,
  window: RoundWindow,
  options: { service?: string } = {},
): Promise<RoundMetrics> {
  const { startMs, endMs } = wholeMinutes(window);
  const period = (endMs - startMs) / 1000;
  const output = await client.send(
    new GetMetricDataCommand({
      StartTime: new Date(startMs),
      EndTime: new Date(endMs),
      MetricDataQueries: roundMetricQueries(stage, options.service, period),
      ScanBy: 'TimestampAscending',
    }),
  );
  return summariseMetricData(output.MetricDataResults);
}

/** Copies the CloudWatch figures onto their own `RunRow` columns (and only those). */
export function applyRoundMetrics(row: RunRow, metrics: RoundMetrics): RunRow {
  for (const key of ROUND_METRIC_KEYS) {
    const value = metrics[key];
    if (value !== undefined) {
      row[key] = value;
    }
  }
  return row;
}

/** True when CloudWatch has returned none of the four figures for the row (yet). */
export function lacksRoundMetrics(row: RunRow): boolean {
  return ROUND_METRIC_KEYS.every((key) => row[key] === undefined);
}

/**
 * When to spawn k6 so that its measured phase (after `warmupMs`) starts on a minute boundary:
 * the earliest `B − warmupMs ≥ nowMs` with `B` a whole minute.
 */
export function alignedSpawnMs(nowMs: number, warmupMs: number): number {
  return Math.ceil((nowMs + warmupMs) / MINUTE_MS) * MINUTE_MS - warmupMs;
}

export interface MeasuredWindow extends RoundWindow {
  /** The window had to reach beyond the measured phase (shorter than a minute, or a late start). */
  beyondMeasured: boolean;
}

/**
 * The CloudWatch window of one run: the whole minutes of the measured phase
 * `[measuredStart, measuredStart + duration]`. `slackMs` (default 5 s) tolerates k6's setup
 * time when the run was spawned by `alignedSpawnMs`: the first seconds of the window are then
 * the end of the warm-up ramp, at (almost) full load. A measured phase without a whole minute
 * gets the minute after its start, flagged `beyondMeasured`.
 */
export function measuredWindow(
  measuredStartMs: number,
  durationMs: number,
  slackMs = 5_000,
): MeasuredWindow {
  const startMs = Math.ceil((measuredStartMs - slackMs) / MINUTE_MS) * MINUTE_MS;
  const minutes = Math.floor((measuredStartMs + durationMs - startMs) / MINUTE_MS);
  return {
    start: new Date(startMs),
    end: new Date(startMs + Math.max(1, minutes) * MINUTE_MS),
    beyondMeasured: minutes < 1,
  };
}

export interface PullOptions {
  /** Wait this long after the end of the last window before the first pull (ingestion delay). */
  metricsWaitMs: number;
  /** Wait before the second pull of the rows CloudWatch had nothing for (default 60 s). */
  retryAfterMs?: number;
  /** Called after each pass (the caller persists the rows). */
  onUpdate?: () => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function appendNote(row: RunRow, note: string): void {
  row.note = row.note === undefined ? note : `${row.note}; ${note}`;
}

/**
 * The deferred CloudWatch pull of a matrix: once the last window (`cwWindowEnd`) is
 * `metricsWaitMs` old, every row with a window is fetched; rows CloudWatch had nothing for are
 * fetched once more `retryAfterMs` later. Fills the cw* columns in place; a row still without
 * figures gets a note (no datapoints, or the error). Returns how many rows got figures.
 */
export async function pullRoundMetrics(
  client: MetricDataClient,
  stage: string,
  rows: readonly RunRow[],
  options: PullOptions,
): Promise<number> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const withWindow = rows.filter(
    (row) => row.cwWindowStart !== undefined && row.cwWindowEnd !== undefined,
  );
  if (withWindow.length === 0) {
    return 0;
  }
  const lastEnd = Math.max(...withWindow.map((row) => Date.parse(row.cwWindowEnd as string)));
  const readyAt = lastEnd + options.metricsWaitMs;
  if (readyAt > now()) {
    options.log?.('waiting for CloudWatch ingestion before pulling the metrics', {
      rows: withWindow.length,
      seconds: Math.round((readyAt - now()) / 1000),
    });
    await sleep(readyAt - now());
  }
  const errors = new Map<RunRow, string>();
  for (let pass = 1; pass <= 2; pass += 1) {
    const todo = withWindow.filter(lacksRoundMetrics);
    if (todo.length === 0) {
      break;
    }
    if (pass === 2) {
      const retryAfterMs = options.retryAfterMs ?? 60_000;
      options.log?.('CloudWatch had no datapoints for some windows; pulling them again', {
        rows: todo.length,
        seconds: Math.round(retryAfterMs / 1000),
      });
      await sleep(retryAfterMs);
    }
    for (const row of todo) {
      try {
        const metrics = await fetchRoundMetrics(client, stage, {
          start: new Date(row.cwWindowStart as string),
          end: new Date(row.cwWindowEnd as string),
        });
        applyRoundMetrics(row, metrics);
        errors.delete(row);
      } catch (error) {
        errors.set(row, error instanceof Error ? error.message : String(error));
      }
    }
    options.onUpdate?.();
  }
  const pulledAt = new Date(now()).toISOString();
  const missing = withWindow.filter(lacksRoundMetrics);
  for (const row of missing) {
    const error = errors.get(row);
    appendNote(
      row,
      error === undefined
        ? `CloudWatch returned no datapoints for the window (pulled ${pulledAt})`
        : `CloudWatch: ${error}`,
    );
  }
  if (missing.length > 0) {
    options.onUpdate?.();
  }
  return withWindow.length - missing.length;
}

export function createCloudWatchClient(region: string): CloudWatchClient {
  return new CloudWatchClient({ region });
}
