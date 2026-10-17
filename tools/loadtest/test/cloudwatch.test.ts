import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  alignedSpawnMs,
  applyRoundMetrics,
  commandsQueueName,
  fetchRoundMetrics,
  lacksRoundMetrics,
  measuredWindow,
  pullRoundMetrics,
  roundMetricQueries,
  summariseMetricData,
  wholeMinutes,
} from '../src/lib/cloudwatch';
import { parseK6Summary, type RunRow } from '../src/lib/k6summary';
import { CSV_COLUMNS, aggregateByLevel, renderSummaryMarkdown, toCsv } from '../src/lib/matrix';
import { SAMPLE_SUMMARY } from './k6summary.test';

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
        // the deployed worker emits service + stage; service alone is a different, empty series
        Dimensions: [
          { Name: 'service', Value: 'worker' },
          { Name: 'stage', Value: 'dev' },
        ],
      },
      Stat: 'p95',
      Period: 60,
    });
  });

  it('reduces datapoints onto the cw* keys: max for depth/age/p95, sum for the sample count', () => {
    expect(
      summariseMetricData([
        { Id: 'sqsDepth', Values: [1, 7, 3] },
        { Id: 'sqsAge', Values: [0, 12] },
        { Id: 'settleP95', Values: [800, 1200] },
        { Id: 'settleCount', Values: [40, 55] },
        { Id: 'other', Values: [1] },
      ]),
    ).toEqual({ sqsDepthMax: 7, sqsOldestAgeMax: 12, cwSettleP95: 1200, cwSettleCount: 95 });
    expect(summariseMetricData([{ Id: 'sqsDepth', Values: [] }])).toEqual({});
    expect(summariseMetricData(undefined)).toEqual({});
  });

  it('fetchRoundMetrics queries the whole window as ONE period (window p95, not max of minutes)', async () => {
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
      start: new Date('2026-10-17T07:01:00.000Z'),
      end: new Date('2026-10-17T07:03:00.000Z'),
    });
    expect(metrics).toEqual({
      sqsDepthMax: 2,
      sqsOldestAgeMax: 1,
      cwSettleP95: 950,
      cwSettleCount: 120,
    });
    const input = cw.commandCalls(GetMetricDataCommand)[0]?.args[0].input;
    expect(input?.StartTime).toEqual(new Date('2026-10-17T07:01:00.000Z'));
    expect(input?.EndTime).toEqual(new Date('2026-10-17T07:03:00.000Z'));
    expect(input?.MetricDataQueries).toHaveLength(4);
    expect(input?.MetricDataQueries?.map((q) => q.MetricStat?.Period)).toEqual([
      120, 120, 120, 120,
    ]);
  });

  it('keeps the query inside the window: start rounded up, end rounded down', () => {
    expect(
      wholeMinutes({
        start: new Date('2026-10-17T07:00:10.000Z'),
        end: new Date('2026-10-17T07:02:20.000Z'),
      }),
    ).toEqual({
      startMs: Date.parse('2026-10-17T07:01:00.000Z'),
      endMs: Date.parse('2026-10-17T07:02:00.000Z'),
    });
    // 07:00:10 → 07:01:20 holds no whole minute: refused instead of reaching into neighbours.
    expect(() =>
      wholeMinutes({
        start: new Date('2026-10-17T07:00:10.000Z'),
        end: new Date('2026-10-17T07:01:20.000Z'),
      }),
    ).toThrow(/no whole minute/);
  });

  it('aligns k6 starts so the measured phase begins on a minute, and windows stay inside it', () => {
    const at = (iso: string) => Date.parse(iso);
    // warm-up 30 s: spawn at :30 so the measured phase starts at the next whole minute
    expect(alignedSpawnMs(at('2026-10-17T07:00:12.000Z'), 30_000)).toBe(
      at('2026-10-17T07:00:30.000Z'),
    );
    expect(alignedSpawnMs(at('2026-10-17T07:00:30.000Z'), 30_000)).toBe(
      at('2026-10-17T07:00:30.000Z'),
    );
    expect(alignedSpawnMs(at('2026-10-17T07:00:31.000Z'), 30_000)).toBe(
      at('2026-10-17T07:01:30.000Z'),
    );
    // aligned run: setup took 1.2 s, measured 60 s → exactly the minute 07:01–07:02
    const aligned = measuredWindow(at('2026-10-17T07:01:01.200Z'), 60_000);
    expect(aligned).toEqual({
      start: new Date('2026-10-17T07:01:00.000Z'),
      end: new Date('2026-10-17T07:02:00.000Z'),
      beyondMeasured: false,
    });
    // previous run ended at 07:00:50: the window never reaches back into it
    expect(aligned.start.getTime()).toBeGreaterThan(at('2026-10-17T07:00:50.000Z'));
    // 150 s measured → the two whole minutes inside
    expect(measuredWindow(at('2026-10-17T07:01:00.500Z'), 150_000)).toMatchObject({
      start: new Date('2026-10-17T07:01:00.000Z'),
      end: new Date('2026-10-17T07:03:00.000Z'),
      beyondMeasured: false,
    });
    // unaligned 60 s phase (no whole minute inside): one minute, flagged
    expect(measuredWindow(at('2026-10-17T07:00:40.000Z'), 60_000)).toMatchObject({
      start: new Date('2026-10-17T07:01:00.000Z'),
      end: new Date('2026-10-17T07:02:00.000Z'),
      beyondMeasured: true,
    });
  });

  it('merging CloudWatch into a k6 row keeps the client settle p95 (regression)', () => {
    const row = parseK6Summary(
      {
        ...SAMPLE_SUMMARY,
        metrics: {
          ...SAMPLE_SUMMARY.metrics,
          settle_ms: {
            type: 'trend',
            contains: 'time',
            values: { med: 2100, 'p(95)': 6200 },
            thresholds: { 'p(95)<5000': { ok: false } },
          },
        },
      },
      {
        scenario: 'hotspot',
        target: 'dev',
        vus: 50,
        round: 1,
        startedAt: '2026-10-17T07:00:30.000Z',
        measuredStart: '2026-10-17T07:01:00.000Z',
        endedAt: '2026-10-17T07:02:10.000Z',
        warmup: '30s',
        duration: '60s',
      },
    );
    expect(lacksRoundMetrics(row)).toBe(true);
    const metrics = summariseMetricData([
      { Id: 'sqsDepth', Values: [40] },
      { Id: 'sqsAge', Values: [9] },
      { Id: 'settleP95', Values: [240] },
      { Id: 'settleCount', Values: [1020] },
    ]);
    applyRoundMetrics(row, metrics);
    expect(lacksRoundMetrics(row)).toBe(false);
    expect(row.settleP95).toBe(6200);
    expect(row.cwSettleP95).toBe(240);
    expect(row.cwSettleCount).toBe(1020);
    expect(row.sqsDepthMax).toBe(40);
    expect(Object.keys(row)).not.toContain('settleCount');
    const [header, line] = toCsv([row]).trim().split('\n');
    const cells = Object.fromEntries(
      (header?.split(',') ?? []).map((column, i) => [column, line?.split(',')[i]]),
    );
    expect(header?.split(',')).toEqual(CSV_COLUMNS);
    expect(cells.settleP95).toBe('6200');
    expect(cells.cwSettleP95).toBe('240');
    expect(cells.cwSettleCount).toBe('1020');
    // the plan §4 verdict uses the client figure: 6.2 s fails the 5 s target
    expect(aggregateByLevel([row])[0]).toMatchObject({ settleP95: 6200, pass: false });
    const md = renderSummaryMarkdown({ version: 1, date: '2026-10-17', targets: {}, rows: [row] });
    expect(md).toContain('| 50 | 1 | 55 | 80 | 6200 | 600 | 0 | 0.20 % | NOT met |');
    expect(md).toContain('| 40 | 9 | 240 / 1020 |');
  });

  it('pulls after the ingestion delay, once more for empty windows, and notes what is missing', async () => {
    const rowAt = (minute: string, extra: Partial<RunRow> = {}): RunRow => ({
      ...parseK6Summary(SAMPLE_SUMMARY, {
        scenario: 'hotspot',
        target: 'dev',
        vus: 10,
        round: 1,
        startedAt: '2026-10-17T07:00:30.000Z',
        measuredStart: '2026-10-17T07:01:00.000Z',
        endedAt: '2026-10-17T07:02:10.000Z',
        warmup: '30s',
        duration: '60s',
      }),
      cwWindowStart: `2026-10-17T07:${minute}:00.000Z`,
      cwWindowEnd: `2026-10-17T07:${String(Number(minute) + 1).padStart(2, '0')}:00.000Z`,
      ...extra,
    });
    const rows = [rowAt('01'), rowAt('04'), rowAt('07'), rowAt('09', { cwWindowEnd: undefined })];
    let clock = Date.parse('2026-10-17T07:08:30.000Z');
    const slept: number[] = [];
    const calls: string[] = [];
    let secondPass = false;
    const client = {
      send: async (command: GetMetricDataCommand) => {
        const start = command.input.StartTime?.toISOString().slice(11, 16) ?? '';
        calls.push(`${new Date(clock).toISOString().slice(11, 19)} ${start}`);
        if (start === '07:04' && !secondPass) {
          return { MetricDataResults: [{ Id: 'settleP95', Values: [] }] }; // not ingested yet
        }
        if (start === '07:07') {
          throw new Error('Throttling');
        }
        return {
          MetricDataResults: [
            { Id: 'sqsDepth', Values: [3] },
            { Id: 'settleP95', Values: [start === '07:01' ? 300 : 310] },
            { Id: 'settleCount', Values: [50] },
          ],
        };
      },
    };
    let updates = 0;
    const filled = await pullRoundMetrics(client, 'dev', rows, {
      metricsWaitMs: 180_000,
      onUpdate: () => {
        updates += 1;
      },
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
        secondPass = slept.length === 2; // CloudWatch has ingested the 07:04 minute by then
      },
    });
    // last window ends 07:08:00 → first pull at 07:11:00, second pass 60 s later
    expect(slept).toEqual([150_000, 60_000]);
    expect(calls).toEqual([
      '07:11:00 07:01',
      '07:11:00 07:04',
      '07:11:00 07:07',
      '07:12:00 07:04',
      '07:12:00 07:07',
    ]);
    expect(filled).toBe(2);
    expect(rows[0]).toMatchObject({
      cwSettleP95: 300,
      cwSettleCount: 50,
      sqsDepthMax: 3,
      settleP95: 1400,
    });
    expect(rows[1]).toMatchObject({ cwSettleP95: 310, settleP95: 1400 });
    expect(rows[2]?.cwSettleP95).toBeUndefined();
    expect(rows[2]?.note).toBe('CloudWatch: Throttling');
    expect(rows[3]?.cwSettleP95).toBeUndefined(); // no window: not queried
    expect(rows[3]?.note).toBeUndefined();
    expect(updates).toBe(3);
  });
});
