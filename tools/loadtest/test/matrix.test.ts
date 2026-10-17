import { describe, expect, it } from 'vitest';
import { parseK6Summary, type RunRow } from '../src/lib/k6summary';
import {
  aggregateByLevel,
  buildMatrix,
  CSV_COLUMNS,
  durationToMs,
  k6Args,
  k6Env,
  renderCommand,
  renderSummaryMarkdown,
  summaryFileFor,
  toCsv,
} from '../src/lib/matrix';
import { SAMPLE_SUMMARY } from './k6summary.test';

const spec = {
  scenarios: ['cross-workshop', 'hotspot'],
  vus: [10, 25, 50],
  rounds: 3,
  warmup: '30s',
  duration: '60s',
};

function row(overrides: Partial<RunRow>): RunRow {
  return {
    ...parseK6Summary(SAMPLE_SUMMARY, {
      scenario: 'hotspot',
      target: 'local',
      vus: 10,
      round: 1,
      startedAt: '2026-10-17T06:58:00.000Z',
      measuredStart: '2026-10-17T06:58:30.000Z',
      endedAt: '2026-10-17T07:00:00.000Z',
    }),
    ...overrides,
  };
}

describe('matrix', () => {
  it('builds 2 × 3 × 3 = 18 cells in scenario → VUs → round order', () => {
    const cells = buildMatrix(spec);
    expect(cells).toHaveLength(18);
    expect(cells.slice(0, 4).map((c) => c.name)).toEqual([
      'cross-workshop-10-1',
      'cross-workshop-10-2',
      'cross-workshop-10-3',
      'cross-workshop-25-1',
    ]);
    expect(cells[17]).toEqual({ scenario: 'hotspot', vus: 50, round: 3, name: 'hotspot-50-3' });
  });

  it('parses k6-style durations', () => {
    expect(durationToMs('30s')).toBe(30_000);
    expect(durationToMs('1m30s')).toBe(90_000);
    expect(durationToMs('500ms')).toBe(500);
    expect(durationToMs('2h')).toBe(7_200_000);
    expect(durationToMs('45')).toBe(45_000);
    expect(() => durationToMs('soon')).toThrow(/duration/);
  });

  it('passes the run parameters to k6 through the environment', () => {
    const cell = buildMatrix(spec)[4] as ReturnType<typeof buildMatrix>[number];
    const env = k6Env(cell, {
      target: 'local',
      apiBase: 'http://localhost:3000',
      tokenCache: '/x/.token-cache.local.json',
      scenarioFile: '/x/.scenario.local.json',
      summaryDir: '/out/summaries',
      warmup: '30s',
      duration: '60s',
    });
    expect(env).toEqual({
      TARGET: 'local',
      TARGET_API: 'http://localhost:3000',
      TOKEN_CACHE: '/x/.token-cache.local.json',
      SCENARIO_FILE: '/x/.scenario.local.json',
      OUT_DIR: '/out/summaries',
      VUS: '25',
      ROUND: '2',
      WARMUP: '30s',
      DURATION: '60s',
    });
    expect(k6Args('/s/hotspot.js')).toEqual(['run', '--quiet', '/s/hotspot.js']);
    expect(summaryFileFor(cell, '/out/summaries')).toBe('/out/summaries/cross-workshop-25-2.json');
    expect(renderCommand('k6', ['run', 'a b.js'], { VUS: '25' })).toBe("VUS=25 k6 run 'a b.js'");
  });

  it('writes raw.csv with every column and escapes lists', () => {
    const csv = toCsv([
      row({
        failedThresholds: ['settle_ms p(95)<5000', 'http_req_failed rate<0.01'],
        thresholdsOk: false,
      }),
    ]);
    const [header, line] = csv.trim().split('\n');
    expect(header?.split(',')).toEqual(CSV_COLUMNS);
    expect(line).toContain('hotspot,local,10,1,');
    expect(line).toContain('"settle_ms p(95)<5000|http_req_failed rate<0.01"');
    expect(line?.split(',').length).toBeGreaterThanOrEqual(CSV_COLUMNS.length);
  });

  it('aggregates per level with medians and checks the plan §4 targets', () => {
    const rows = [
      row({ round: 1, settleP95: 1400 }),
      row({ round: 2, settleP95: 6000 }),
      row({ round: 3, settleP95: 1500 }),
      row({ vus: 50, round: 1, readP95: 1200 }),
    ];
    const levels = aggregateByLevel(rows);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toMatchObject({
      vus: 10,
      rounds: 3,
      settleP95: 1500,
      readP95: 55,
      pass: true,
    });
    expect(levels[1]).toMatchObject({ vus: 50, rounds: 1, readP95: 1200, pass: false });
  });

  it('renders summary.md with a table per scenario, per-level medians and notes', () => {
    const md = renderSummaryMarkdown(
      [
        row({}),
        row({ scenario: 'cross-workshop', sqsDepthMax: 3, sqsOldestAgeMax: 2, cwSettleP95: 420 }),
      ],
      {
        date: '2026-10-17',
        target: 'local',
        apiBase: 'http://localhost:3000',
        spec,
        notes: ['CloudWatch metrics skipped: no credentials'],
        commit: 'abc1234',
      },
    );
    expect(md).toContain('# Load test 2026-10-17 — target `local`');
    expect(md).toContain('## cross-workshop');
    expect(md).toContain('## hotspot');
    expect(md).toContain(
      '| 10 | 1 | 18 / 55 | 25 / 80 | 25 | 650 / 1400 | 600 | 0.20 % | 2 | 1 | pass | 3 | 2 | 420 |',
    );
    expect(md).toContain(
      '| 10 | 1 | 18 / 55 | 25 / 80 | 25 | 650 / 1400 | 600 | 0.20 % | 2 | 1 | pass | – | – | – |',
    );
    expect(md).toContain('| 10 | 1 | 55 | 80 | 1400 | 600 | 0.20 % | met |');
    expect(md).toContain('- CloudWatch metrics skipped: no credentials');
    expect(md).toContain('commit `abc1234`');
  });
});
