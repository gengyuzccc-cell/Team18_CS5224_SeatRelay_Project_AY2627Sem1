import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandsQueueName,
  fetchRoundMetrics,
  roundMetricQueries,
  summariseMetricData,
} from '../src/lib/cloudwatch';

const cw = mockClient(CloudWatchClient);

afterEach(() => {
  cw.reset();
});

describe('CloudWatch round metrics', () => {
  it('queries the stage queue and the worker EMF metric', () => {
    const queries = roundMetricQueries('dev');
    expect(commandsQueueName('dev')).toBe('seatrelay-dev-commands.fifo');
    expect(queries.map((q) => q.Id)).toEqual(['sqsDepth', 'sqsAge', 'settleP95', 'settleCount']);
    expect(queries[0]?.MetricStat?.Metric).toEqual({
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Dimensions: [{ Name: 'QueueName', Value: 'seatrelay-dev-commands.fifo' }],
    });
    expect(queries[2]?.MetricStat).toMatchObject({
      Metric: {
        Namespace: 'SeatRelay',
        MetricName: 'CommandSettledLatency',
        Dimensions: [{ Name: 'service', Value: 'worker' }],
      },
      Stat: 'p95',
      Period: 60,
    });
  });

  it('reduces datapoints: max for depth/age/p95, sum for the sample count', () => {
    expect(
      summariseMetricData([
        { Id: 'sqsDepth', Values: [1, 7, 3] },
        { Id: 'sqsAge', Values: [0, 12] },
        { Id: 'settleP95', Values: [800, 1200] },
        { Id: 'settleCount', Values: [40, 55] },
        { Id: 'other', Values: [1] },
      ]),
    ).toEqual({ sqsDepthMax: 7, sqsOldestAgeMax: 12, settleP95: 1200, settleCount: 95 });
    expect(summariseMetricData([{ Id: 'sqsDepth', Values: [] }])).toEqual({});
    expect(summariseMetricData(undefined)).toEqual({});
  });

  it('fetchRoundMetrics widens the window to whole periods and summarises the response', async () => {
    cw.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'sqsDepth', Values: [2] },
        { Id: 'sqsAge', Values: [1] },
        { Id: 'settleP95', Values: [950] },
        { Id: 'settleCount', Values: [120] },
      ],
    });
    const client = new CloudWatchClient({ region: 'ap-southeast-1' });
    const metrics = await fetchRoundMetrics(client, 'dev', {
      start: new Date('2026-10-17T07:00:10.000Z'),
      end: new Date('2026-10-17T07:01:20.000Z'),
    });
    expect(metrics).toEqual({
      sqsDepthMax: 2,
      sqsOldestAgeMax: 1,
      settleP95: 950,
      settleCount: 120,
    });
    const input = cw.commandCalls(GetMetricDataCommand)[0]?.args[0].input;
    expect(input?.StartTime).toEqual(new Date('2026-10-17T07:00:00.000Z'));
    expect(input?.EndTime).toEqual(new Date('2026-10-17T07:02:00.000Z'));
    expect(input?.MetricDataQueries).toHaveLength(4);
  });
});
