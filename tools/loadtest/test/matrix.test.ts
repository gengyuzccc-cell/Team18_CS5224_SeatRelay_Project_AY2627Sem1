import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseK6Summary, type RunRow } from '../src/lib/k6summary';
import {
  aggregateByLevel,
  buildMatrix,
  checkTokenCacheForMatrix,
  CSV_COLUMNS,
  durationToMs,
  estimateMatrixMs,
  k6Args,
  k6Env,
  mergeRows,
  readMatrixState,
  rowKey,
  renderCommand,
  renderSummaryMarkdown,
  summaryFileFor,
  toCsv,
  writeMatrixState,
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
      warmup: '30s',
      duration: '60s',
      commit: 'abc1234',
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

  it('estimates the matrix length and checks the token cache covers it', () => {
    // 18 runs × (30 s + 60 s + 15 s) + 17 pauses × 15 s
    expect(estimateMatrixMs(spec, 15_000)).toBe(18 * 105_000 + 17 * 15_000);
    const now = Date.parse('2026-10-17T07:00:00.000Z');
    const ends = now + estimateMatrixMs(spec, 15_000);
    const users = (n: number, expiresAt: string) =>
      Array.from({ length: n }, () => ({ expiresAt }));
    expect(
      checkTokenCacheForMatrix(users(60, '2026-10-17T08:00:00.000Z'), 50, ends).problems,
    ).toEqual([]);
    const short = checkTokenCacheForMatrix(users(4, '2026-10-17T07:20:00.000Z'), 50, ends);
    expect(short.problems).toHaveLength(2);
    expect(short.problems[0]).toContain('4 accounts for 50 VUs');
    expect(short.problems[1]).toContain('before the matrix ends');
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

  it('writes raw.csv with every column, joins lists with | and quotes only when needed', () => {
    const csv = toCsv([
      row({
        failedThresholds: ['settle_ms p(95)<5000', 'http_req_failed rate<0.01'],
        thresholdsOk: false,
      }),
      row({
        round: 2,
        // tagged thresholds contain a comma, so the cell must be quoted
        failedThresholds: ['http_req_duration{kind:read,phase:measured} p(95)<1000'],
        thresholdsOk: false,
        note: 'k6 exited "107"',
      }),
    ]);
    const [header, first, second] = csv.trim().split('\n');
    expect(header?.split(',')).toEqual(CSV_COLUMNS);
    expect(first).toContain('hotspot,local,10,1,');
    expect(first).toContain(',false,settle_ms p(95)<5000|http_req_failed rate<0.01,');
    expect(first?.split(',')).toHaveLength(CSV_COLUMNS.length);
    expect(second).toContain(',"http_req_duration{kind:read,phase:measured} p(95)<1000",');
    expect(second).toMatch(/,"k6 exited ""107"""$/);
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

  it('renders summary.md per target and scenario, with per-level medians and notes', () => {
    const md = renderSummaryMarkdown({
      version: 1,
      date: '2026-10-17',
      targets: {
        local: { apiBase: 'http://localhost:3000', notes: ['docker-stats.csv sampled'] },
        dev: {
          apiBase: 'https://api.example',
          notes: ['CloudWatch metrics skipped: no credentials'],
        },
      },
      rows: [
        row({}),
        row({ scenario: 'cross-workshop', sqsDepthMax: 3, sqsOldestAgeMax: 2, cwSettleP95: 420 }),
        row({ target: 'dev', commit: 'def5678' }),
      ],
    });
    expect(md).toContain('# Load test 2026-10-17');
    expect(md).toContain('## Target `local`');
    expect(md).toContain('## Target `dev`');
    expect(md.indexOf('## Target `dev`')).toBeLessThan(md.indexOf('## Target `local`'));
    expect(md).toContain('### local · cross-workshop');
    expect(md).toContain('### local · hotspot');
    expect(md).toContain('### dev · hotspot');
    expect(md).toContain('- API: `http://localhost:3000`');
    expect(md).toContain('warm-up `30s`, measured `60s` per run; commit `abc1234`.');
    expect(md).toContain('commit `def5678`.');
    expect(md).toContain(
      '| 10 | 1 | 18 / 55 | 25 / 80 | 25 | 650 / 1400 | 600 | 0.20 % | 2 | 1 | pass | 3 | 2 | 420 |',
    );
    expect(md).toContain(
      '| 10 | 1 | 18 / 55 | 25 / 80 | 25 | 650 / 1400 | 600 | 0.20 % | 2 | 1 | pass | – | – | – |',
    );
    expect(md).toContain('| 10 | 1 | 55 | 80 | 1400 | 600 | 0.20 % | met |');
    expect(md).toContain('- Note: CloudWatch metrics skipped: no credentials');
  });

  it('accumulates runs of one date across invocations; re-runs replace their row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-state-'));
    const file = path.join(dir, 'runs.json');
    const first = readMatrixState(file, '2026-10-17');
    expect(first.rows).toEqual([]);
    writeMatrixState(file, {
      ...first,
      targets: { local: { apiBase: 'http://localhost:3000', notes: [] } },
      rows: mergeRows(first.rows, [row({ round: 2 }), row({ round: 1, settleP95: 9000 })]),
    });
    const second = readMatrixState(file, '2026-10-17');
    const merged = mergeRows(second.rows, [
      row({ round: 1, settleP95: 1200 }),
      row({ target: 'dev' }),
      row({ scenario: 'cross-workshop', vus: 25 }),
    ]);
    expect(merged.map((r) => `${r.target}/${r.scenario}/${r.vus}/${r.round}`)).toEqual([
      'dev/hotspot/10/1',
      'local/cross-workshop/25/1',
      'local/hotspot/10/1',
      'local/hotspot/10/2',
    ]);
    const replaced = merged.find((r) => rowKey(r) === 'local|hotspot|10|1');
    expect(replaced?.settleP95).toBe(1200);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
