import { describe, expect, it } from 'vitest';
import {
  failedThresholds,
  isK6Summary,
  parseK6Summary,
  type K6Summary,
} from '../src/lib/k6summary';

export const SAMPLE_SUMMARY: K6Summary = {
  metrics: {
    iterations: { type: 'counter', values: { count: 120, rate: 1.3 } },
    iterations_measured: { type: 'counter', values: { count: 90, rate: 1 } },
    http_reqs: { type: 'counter', values: { count: 1500, rate: 16 } },
    http_req_failed: {
      type: 'rate',
      values: { rate: 0.002, passes: 3, fails: 1497 },
      thresholds: { 'rate<0.01': { ok: true } },
    },
    read_ms: {
      type: 'trend',
      contains: 'time',
      values: { avg: 20, min: 5, med: 18, 'p(90)': 40, 'p(95)': 55, 'p(99)': 90, max: 120 },
      thresholds: { 'p(95)<1000': { ok: true } },
    },
    command_ms: {
      type: 'trend',
      contains: 'time',
      values: { avg: 30, min: 8, med: 25, 'p(90)': 60, 'p(95)': 80, 'p(99)': 120, max: 200 },
      thresholds: { 'p(95)<1000': { ok: true } },
    },
    poll_ms: {
      type: 'trend',
      contains: 'time',
      values: { avg: 10, min: 3, med: 9, 'p(90)': 20, 'p(95)': 25, 'p(99)': 40, max: 60 },
    },
    settle_ms: {
      type: 'trend',
      contains: 'time',
      values: {
        avg: 700,
        min: 300,
        med: 650,
        'p(90)': 1200,
        'p(95)': 1400,
        'p(99)': 2000,
        max: 3000,
      },
      thresholds: { 'p(95)<5000': { ok: true } },
    },
    server_settle_ms: {
      type: 'trend',
      contains: 'time',
      values: { avg: 300, min: 100, med: 280, 'p(90)': 500, 'p(95)': 600, 'p(99)': 900, max: 1200 },
    },
    polls_per_command: {
      type: 'trend',
      values: { avg: 2.4, min: 1, med: 2, 'p(90)': 4, 'p(95)': 5, 'p(99)': 7, max: 9 },
    },
    commands_failed: { type: 'counter', values: { count: 0, rate: 0 } },
    commands_rejected: { type: 'counter', values: { count: 2, rate: 0 } },
    settle_timeouts: { type: 'counter', values: { count: 1, rate: 0 } },
    'http_req_duration{kind:read,phase:measured}': {
      type: 'trend',
      contains: 'time',
      values: { med: 18, 'p(95)': 55 },
      thresholds: { 'p(95)<1000': { ok: true } },
    },
  },
  seatrelay: {
    scenario: 'hotspot',
    target: 'local',
    vus: 10,
    round: '1',
    warmup: '30s',
    duration: '60s',
    api: 'http://localhost:3000',
    finishedAt: '2026-10-17T07:00:00.000Z',
  },
};

describe('parseK6Summary', () => {
  const meta = {
    scenario: 'hotspot',
    target: 'local',
    vus: 10,
    round: 1,
    startedAt: '2026-10-17T06:58:00.000Z',
    measuredStart: '2026-10-17T06:58:30.000Z',
    endedAt: '2026-10-17T07:00:00.000Z',
    exitCode: 0,
  };

  it('maps trends (med → p50, p(95)), counters and rates to one row', () => {
    const row = parseK6Summary(SAMPLE_SUMMARY, meta);
    expect(row).toMatchObject({
      scenario: 'hotspot',
      vus: 10,
      round: 1,
      iterations: 120,
      iterationsMeasured: 90,
      httpReqs: 1500,
      httpReqFailedRate: 0.002,
      readP50: 18,
      readP95: 55,
      commandP50: 25,
      commandP95: 80,
      pollP95: 25,
      settleP50: 650,
      settleP95: 1400,
      serverSettleP95: 600,
      pollsPerCommandAvg: 2.4,
      commandsRejected: 2,
      settleTimeouts: 1,
      thresholdsOk: true,
      failedThresholds: [],
    });
  });

  it('lists failed thresholds and leaves missing metrics undefined', () => {
    const failing: K6Summary = {
      metrics: {
        settle_ms: {
          type: 'trend',
          values: { med: 4000, 'p(95)': 9000 },
          thresholds: { 'p(95)<5000': { ok: false } },
        },
        http_req_failed: {
          type: 'rate',
          values: { rate: 0.05 },
          thresholds: { 'rate<0.01': { ok: false } },
        },
      },
    };
    expect(failedThresholds(failing)).toEqual([
      'settle_ms p(95)<5000',
      'http_req_failed rate<0.01',
    ]);
    const row = parseK6Summary(failing, meta);
    expect(row.thresholdsOk).toBe(false);
    expect(row.readP95).toBeUndefined();
    expect(row.settleP95).toBe(9000);
    expect(isK6Summary(failing)).toBe(true);
    expect(isK6Summary({})).toBe(false);
  });
});
