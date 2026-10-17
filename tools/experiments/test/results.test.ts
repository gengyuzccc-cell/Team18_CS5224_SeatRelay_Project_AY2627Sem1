import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateResultsDir,
  collectColumns,
  dateStamp,
  formatMs,
  formatNumber,
  gitCommitInfo,
  markdownTable,
  outliers,
  percentile,
  resultsDirName,
  summarize,
  summaryRow,
  toCsv,
  writeCsv,
  writeJson,
  writeMarkdown,
} from '../src/lib/results';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seatrelay-results-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('percentile (nearest rank)', () => {
  const values = [15, 20, 35, 40, 50];

  it('matches the textbook nearest-rank examples', () => {
    expect(percentile(values, 5)).toBe(15);
    expect(percentile(values, 30)).toBe(20);
    expect(percentile(values, 40)).toBe(20);
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 100)).toBe(50);
  });

  it('does not depend on input order and does not mutate the input', () => {
    const shuffled = [40, 15, 50, 35, 20];
    expect(percentile(shuffled, 50)).toBe(35);
    expect(shuffled).toEqual([40, 15, 50, 35, 20]);
  });

  it('p95 of 1..100 is 95, p99 is 99, p0 is the minimum', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 0)).toBe(1);
  });

  it('clamps p outside 0..100 and returns NaN for no samples', () => {
    expect(percentile(values, 150)).toBe(50);
    expect(percentile(values, -5)).toBe(15);
    expect(percentile([], 50)).toBeNaN();
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('summarize / outliers', () => {
  it('computes count, extremes, mean, percentiles and population stdev', () => {
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(summary).toMatchObject({ count: 8, min: 2, max: 9, mean: 5, p50: 4, p95: 9, p99: 9 });
    expect(summary.stdev).toBeCloseTo(2, 10);
  });

  it('is all NaN for an empty sample', () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    for (const key of ['min', 'max', 'mean', 'p50', 'p95', 'p99', 'stdev'] as const) {
      expect(summary[key]).toBeNaN();
    }
  });

  it('lists samples above max(threshold, p95)', () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ id: i, ms: (i + 1) * 100 }));
    // p95 of 100..2000 = 1900: only 2000 is above it when the threshold is lower.
    expect(outliers(samples, (s) => s.ms, 500).map((s) => s.ms)).toEqual([2000]);
    // A threshold above p95 wins.
    expect(outliers(samples, (s) => s.ms, 5000)).toEqual([]);
    expect(outliers([], (s: { ms: number }) => s.ms, 10)).toEqual([]);
  });
});

describe('results directory naming', () => {
  const at = new Date('2026-10-29T23:59:59.000Z');

  it('uses the UTC date', () => {
    expect(dateStamp(at)).toBe('2026-10-29');
    expect(resultsDirName('backfill', at)).toBe('2026-10-29-backfill');
  });

  it('never reuses a directory: -2, -3, … suffixes', () => {
    const first = allocateResultsDir(tmp, 'smoke', at);
    const second = allocateResultsDir(tmp, 'smoke', at);
    const third = allocateResultsDir(tmp, 'smoke', at);
    expect(path.basename(first)).toBe('2026-10-29-smoke');
    expect(path.basename(second)).toBe('2026-10-29-smoke-2');
    expect(path.basename(third)).toBe('2026-10-29-smoke-3');
    for (const dir of [first, second, third]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });
});

describe('CSV writer', () => {
  it('quotes commas, quotes and newlines (RFC 4180) and leaves empty cells for null/undefined', () => {
    const csv = toCsv([
      { a: 'plain', b: 'x,y', c: 'say "hi"' },
      { a: 'multi\nline', b: null, c: undefined },
      { a: 3, b: true, c: 0.5 },
    ]);
    expect(csv).toBe('a,b,c\nplain,"x,y","say ""hi"""\n"multi\nline",,\n3,true,0.5\n');
  });

  it('takes the union of keys in first-seen order unless columns are given', () => {
    const rows = [{ a: 1 }, { b: 2, a: 3 }, { c: 4 }];
    expect(collectColumns(rows)).toEqual(['a', 'b', 'c']);
    expect(toCsv(rows)).toBe('a,b,c\n1,,\n3,2,\n,,4\n');
    expect(toCsv(rows, ['c', 'a'])).toBe('c,a\n,1\n,3\n4,\n');
  });

  it('writes header-only CSV for no rows and creates parent directories', () => {
    const file = path.join(tmp, 'nested', 'raw.csv');
    writeCsv(file, [], ['run', 'latencyMs']);
    expect(fs.readFileSync(file, 'utf8')).toBe('run,latencyMs\n');
  });

  it('writes JSON and Markdown with a trailing newline', () => {
    writeJson(path.join(tmp, 'meta.json'), { runId: 'r', ok: true });
    writeMarkdown(path.join(tmp, 'summary.md'), '# Title');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8'))).toEqual({ runId: 'r', ok: true });
    expect(fs.readFileSync(path.join(tmp, 'summary.md'), 'utf8')).toBe('# Title\n');
  });
});

describe('Markdown helpers', () => {
  it('renders a table, escaping pipes and newlines', () => {
    expect(markdownTable(['a', 'b'], [['x|y', 'line1\nline2'], [1, undefined]])).toBe(
      '| a | b |\n|---|---|\n| x\\|y | line1 line2 |\n| 1 |  |',
    );
  });

  it('formats numbers and n/a', () => {
    expect(formatNumber(1.234, 2)).toBe('1.23');
    expect(formatNumber(Number.NaN)).toBe('n/a');
    expect(formatMs(12.6)).toBe('13 ms');
    expect(formatMs(Number.NaN)).toBe('n/a');
    expect(summaryRow('x', summarize([1, 2, 3]))).toEqual(['x', 3, '2', '3', '3', '3', '2.0']);
  });
});

describe('gitCommitInfo', () => {
  it('returns the 40-hex HEAD hash inside the repository', () => {
    const info = gitCommitInfo(fileURLToPath(new URL('..', import.meta.url)));
    expect(info?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(info?.short).toBe(info?.hash.slice(0, 12));
    expect(typeof info?.dirty).toBe('boolean');
  });

  it('returns undefined outside a git checkout', () => {
    expect(gitCommitInfo(tmp)).toBeUndefined();
  });
});
