import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';

/**
 * Server-side evidence for one measured round (plan §3 step 15): SQS depth and age of the
 * oldest message of the stage's commands FIFO, and the worker's `CommandSettledLatency`
 * (EMF, namespace SeatRelay, dimension `service=worker`) over the round window.
 */
export interface RoundWindow {
  start: Date;
  end: Date;
}

export interface RoundMetrics {
  sqsDepthMax?: number;
  sqsOldestAgeMax?: number;
  settleP95?: number;
  settleCount?: number;
}

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
          Dimensions: [{ Name: 'service', Value: service }],
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
          Dimensions: [{ Name: 'service', Value: service }],
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

/** Reduces the per-period datapoints of the window to one number each. */
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
        const value = max(values);
        if (value !== undefined) metrics.settleP95 = value;
        break;
      }
      case 'settleCount': {
        const value = sum(values);
        if (value !== undefined) metrics.settleCount = value;
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

export async function fetchRoundMetrics(
  client: MetricDataClient,
  stage: string,
  window: RoundWindow,
  options: { service?: string; period?: number } = {},
): Promise<RoundMetrics> {
  const period = options.period ?? 60;
  // CloudWatch wants whole periods: widen the window outwards to period boundaries.
  const startMs = Math.floor(window.start.getTime() / (period * 1000)) * period * 1000;
  const endMs = Math.ceil(window.end.getTime() / (period * 1000)) * period * 1000;
  const output = await client.send(
    new GetMetricDataCommand({
      StartTime: new Date(startMs),
      EndTime: new Date(Math.max(endMs, startMs + period * 1000)),
      MetricDataQueries: roundMetricQueries(stage, options.service, period),
      ScanBy: 'TimestampAscending',
    }),
  );
  return summariseMetricData(output.MetricDataResults);
}

export function createCloudWatchClient(region: string): CloudWatchClient {
  return new CloudWatchClient({ region });
}
