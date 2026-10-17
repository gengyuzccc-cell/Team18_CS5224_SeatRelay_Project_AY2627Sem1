import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import { assertAwsCredentials, awsRegion } from '@seatrelay/scripts';

/**
 * CloudWatch `GetMetricData` fetchers for the dev/pilot stacks (plan §3 step 16): the custom
 * `SeatRelay` namespace (EMF metrics of the Lambda functions, dimension `service`) plus the
 * SQS and Lambda metrics the dashboard shows. Everything degrades gracefully: without AWS
 * credentials (or with a failing call) the result says `available: false` and why, and the
 * experiment summary reports the metric as "not fetched" instead of failing the run.
 */

export const SEATRELAY_NAMESPACE = 'SeatRelay';

/** Custom metric → the Powertools `service` dimension of the function that emits it. */
export const SEATRELAY_METRIC_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  CommandSettledLatency: 'worker',
  BackfillLatency: 'worker',
  OffersCreated: 'worker',
  OffersExpired: 'worker',
  SweepLateExpiries: 'worker',
  MetaConflictRetries: 'worker',
  NotificationFailures: 'notifier',
});

export type MetricStat = 'Sum' | 'SampleCount' | 'Maximum' | 'Minimum' | 'Average' | 'p50' | 'p95' | 'p99';

export interface MetricQuery {
  /** Lower-case alphanumeric, starts with a letter (CloudWatch id rules). */
  id: string;
  namespace: string;
  metricName: string;
  dimensions?: Record<string, string>;
  stat: MetricStat;
  label?: string;
}

export interface MetricWindow {
  start: Date;
  end: Date;
  /** Seconds; default 60. */
  periodSeconds?: number;
}

export interface MetricSeries {
  id: string;
  label: string;
  timestamps: string[];
  values: number[];
  /** Sum of the datapoints (the right aggregate for Sum/SampleCount series). */
  total: number;
  /** Largest datapoint (the right aggregate for Maximum/p95 series). */
  max: number;
  /** No datapoints in the window. */
  empty: boolean;
}

export type MetricsResult =
  | { available: true; region: string; window: { start: string; end: string }; series: MetricSeries[] }
  | { available: false; reason: string };

export interface CloudWatchClientLike {
  send(command: GetMetricDataCommand): Promise<{ MetricDataResults?: MetricDataResult[]; NextToken?: string }>;
  config: { credentials?: unknown };
}

export interface GetMetricDataOptions {
  region?: string;
  client?: CloudWatchClientLike;
  /** Skip the credentials pre-check (tests with a mocked client). */
  skipCredentialsCheck?: boolean;
}

export function metricId(...parts: string[]): string {
  const raw = parts.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^[a-z]/.test(raw) ? raw : `m_${raw}`;
}

/**
 * `extraDimensions` is added to the `service` dimension of every query. Stacks deployed from
 * commit 25b7b9d on emit `service` + `stage` (services/aws/src/lib/metrics.ts); a query with
 * `service` alone then addresses a different (empty) series, so pass `{ stage }` for them.
 */
export function seatRelayQueries(
  metrics: readonly string[] = Object.keys(SEATRELAY_METRIC_SERVICES),
  stats: readonly MetricStat[] = ['Sum', 'SampleCount'],
  extraDimensions: Readonly<Record<string, string>> = {},
): MetricQuery[] {
  const queries: MetricQuery[] = [];
  for (const metricName of metrics) {
    const service = SEATRELAY_METRIC_SERVICES[metricName] ?? 'worker';
    for (const stat of stats) {
      queries.push({
        id: metricId(metricName, stat),
        namespace: SEATRELAY_NAMESPACE,
        metricName,
        dimensions: { service, ...extraDimensions },
        stat,
        label: `${metricName} ${stat}`,
      });
    }
  }
  return queries;
}

export function sqsQueries(queueNames: readonly string[]): MetricQuery[] {
  return queueNames.flatMap((queueName) => [
    {
      id: metricId('sqs_visible', queueName),
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensions: { QueueName: queueName },
      stat: 'Maximum' as const,
      label: `${queueName} visible (max)`,
    },
    {
      id: metricId('sqs_oldest', queueName),
      namespace: 'AWS/SQS',
      metricName: 'ApproximateAgeOfOldestMessage',
      dimensions: { QueueName: queueName },
      stat: 'Maximum' as const,
      label: `${queueName} oldest message age s (max)`,
    },
  ]);
}

export function lambdaQueries(functionNames: readonly string[]): MetricQuery[] {
  return functionNames.flatMap((functionName) => [
    {
      id: metricId('lambda_errors', functionName),
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensions: { FunctionName: functionName },
      stat: 'Sum' as const,
      label: `${functionName} errors`,
    },
    {
      id: metricId('lambda_duration_p95', functionName),
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensions: { FunctionName: functionName },
      stat: 'p95' as const,
      label: `${functionName} duration p95 ms`,
    },
    {
      id: metricId('lambda_iterator_age', functionName),
      namespace: 'AWS/Lambda',
      metricName: 'IteratorAge',
      dimensions: { FunctionName: functionName },
      stat: 'Maximum' as const,
      label: `${functionName} iterator age ms (max)`,
    },
  ]);
}

export function toMetricDataQuery(query: MetricQuery, periodSeconds: number): MetricDataQuery {
  return {
    Id: query.id,
    Label: query.label ?? `${query.metricName} ${query.stat}`,
    ReturnData: true,
    MetricStat: {
      Metric: {
        Namespace: query.namespace,
        MetricName: query.metricName,
        Dimensions: Object.entries(query.dimensions ?? {}).map(([Name, Value]) => ({ Name, Value })),
      },
      Period: periodSeconds,
      Stat: query.stat,
    },
  };
}

/** `GetMetricData` for every query over the window (paginated, ≤ 500 queries per call). */
export async function getMetricData(
  queries: readonly MetricQuery[],
  window: MetricWindow,
  options: GetMetricDataOptions = {},
): Promise<MetricsResult> {
  const region = options.region ?? awsRegion();
  if (queries.length === 0) {
    return { available: true, region, window: { start: window.start.toISOString(), end: window.end.toISOString() }, series: [] };
  }
  const client: CloudWatchClientLike = options.client ?? new CloudWatchClient({ region });
  const period = Math.max(1, Math.round(window.periodSeconds ?? 60));
  try {
    if (!options.skipCredentialsCheck) {
      await assertAwsCredentials(client);
    }
    const results = new Map<string, MetricDataResult>();
    for (let start = 0; start < queries.length; start += 500) {
      const chunk = queries.slice(start, start + 500).map((query) => toMetricDataQuery(query, period));
      let nextToken: string | undefined;
      do {
        const output = await client.send(
          new GetMetricDataCommand({
            MetricDataQueries: chunk,
            StartTime: window.start,
            EndTime: window.end,
            ScanBy: 'TimestampAscending',
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
          }),
        );
        for (const result of output.MetricDataResults ?? []) {
          if (result.Id === undefined) {
            continue;
          }
          const existing = results.get(result.Id);
          if (existing === undefined) {
            results.set(result.Id, { ...result, Timestamps: [...(result.Timestamps ?? [])], Values: [...(result.Values ?? [])] });
          } else {
            existing.Timestamps?.push(...(result.Timestamps ?? []));
            existing.Values?.push(...(result.Values ?? []));
          }
        }
        nextToken = output.NextToken;
      } while (nextToken !== undefined);
    }
    const series = queries.map((query) => toSeries(query, results.get(query.id)));
    return { available: true, region, window: { start: window.start.toISOString(), end: window.end.toISOString() }, series };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function toSeries(query: MetricQuery, result: MetricDataResult | undefined): MetricSeries {
  const values = (result?.Values ?? []).map((value) => Number(value));
  const timestamps = (result?.Timestamps ?? []).map((timestamp) =>
    timestamp instanceof Date ? timestamp.toISOString() : String(timestamp),
  );
  return {
    id: query.id,
    label: query.label ?? result?.Label ?? query.id,
    timestamps,
    values,
    total: values.reduce((acc, value) => acc + value, 0),
    max: values.length === 0 ? Number.NaN : Math.max(...values),
    empty: values.length === 0,
  };
}

export function findSeries(result: MetricsResult, id: string): MetricSeries | undefined {
  return result.available ? result.series.find((series) => series.id === id) : undefined;
}

/** Sum of a `SeatRelay` metric over the window, or undefined when it was not fetched. */
export function seatRelayMetricSum(result: MetricsResult, metricName: string): number | undefined {
  const series = findSeries(result, metricId(metricName, 'Sum'));
  return series === undefined ? undefined : series.total;
}

/** Markdown lines describing a fetch result (for summary.md). */
export function describeMetrics(result: MetricsResult): string[] {
  if (!result.available) {
    return [`CloudWatch metrics not fetched: ${result.reason}`];
  }
  if (result.series.length === 0) {
    return ['CloudWatch metrics: no queries'];
  }
  const lines = [`CloudWatch metrics (${result.region}, ${result.window.start} → ${result.window.end}):`, ''];
  lines.push('| metric | datapoints | total | max |', '|---|---|---|---|');
  for (const series of result.series) {
    lines.push(
      `| ${series.label} | ${series.values.length} | ${series.empty ? 'n/a' : series.total} | ${series.empty ? 'n/a' : series.max} |`,
    );
  }
  return lines;
}
