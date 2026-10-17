import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Result files of one experiment run (plan §3 step 16): `results/<YYYY-MM-DD>-<name>/` with
 * `raw.csv` (one row per sample or assertion), `summary.md` (what the report quotes) and
 * `meta.json` (run id, time, target, commit hash, parameters). Every number in the report must
 * be traceable to these files, so nothing here is ever overwritten: an existing directory gets
 * a numeric suffix (`-2`, `-3`, …).
 */

export type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvValue>;

/** `YYYY-MM-DD` (UTC) of the given instant. */
export function dateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function resultsDirName(name: string, now: Date = new Date()): string {
  return `${dateStamp(now)}-${name}`;
}

/**
 * Creates and returns `<baseDir>/<date>-<name>`; when it already exists, the first free
 * `<date>-<name>-<n>` (n ≥ 2) so that earlier rounds are never clobbered.
 */
export function allocateResultsDir(baseDir: string, name: string, now: Date = new Date()): string {
  const stem = path.join(baseDir, resultsDirName(name, now));
  let candidate = stem;
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = `${stem}-${n}`;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

export interface CommitInfo {
  hash: string;
  short: string;
  /** Uncommitted changes in the working tree at the time of the run. */
  dirty: boolean;
  branch?: string;
}

/** `git rev-parse HEAD` (+ dirty flag and branch); undefined outside a git checkout. */
export function gitCommitInfo(cwd: string = process.cwd()): CommitInfo | undefined {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const hash = git('rev-parse', 'HEAD');
    const info: CommitInfo = {
      hash,
      short: hash.slice(0, 12),
      dirty: git('status', '--porcelain').length > 0,
    };
    try {
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
      if (branch.length > 0 && branch !== 'HEAD') {
        info.branch = branch;
      }
    } catch {
      // detached HEAD or no branch: fine
    }
    return info;
  } catch {
    return undefined;
  }
}

/* ---------- CSV ---------- */

function csvCell(value: CsvValue): string {
  if (value === undefined || value === null) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV; columns default to the union of keys in first-seen order. */
export function toCsv(rows: readonly CsvRow[], columns?: readonly string[]): string {
  const header = columns === undefined ? collectColumns(rows) : [...columns];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function collectColumns(rows: readonly CsvRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return [...seen];
}

export function writeCsv(file: string, rows: readonly CsvRow[], columns?: readonly string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toCsv(rows, columns));
}

export function writeMarkdown(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/* ---------- statistics ---------- */

/**
 * Nearest-rank percentile (`p` in 0–100): the smallest value such that at least p % of the
 * samples are ≤ it. Matches `services/local` `/metrics` and the usual k6 definition; an empty
 * list yields NaN.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export interface Summary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  stdev: number;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    return {
      count: 0,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      stdev: Number.NaN,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    stdev: Math.sqrt(variance),
  };
}

/** Samples above `max(threshold, p95)`: the ones worth listing individually. */
export function outliers<T>(
  samples: readonly T[],
  valueOf: (sample: T) => number,
  thresholdMs: number,
): T[] {
  const values = samples.map(valueOf);
  const p95 = values.length === 0 ? 0 : percentile(values, 95);
  const cutoff = Math.max(thresholdMs, p95);
  return samples.filter((sample) => valueOf(sample) > cutoff);
}

/* ---------- Markdown ---------- */

export function formatNumber(value: number, digits = 0): string {
  if (Number.isNaN(value)) {
    return 'n/a';
  }
  return value.toFixed(digits);
}

export function formatMs(value: number): string {
  return Number.isNaN(value) ? 'n/a' : `${Math.round(value)} ms`;
}

export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly (string | number | boolean | undefined)[])[],
): string {
  const cell = (value: string | number | boolean | undefined): string =>
    value === undefined ? '' : String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `| ${headers.map(cell).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** A one-line table row of a `Summary` in milliseconds. */
export function summaryRow(label: string, summary: Summary): (string | number)[] {
  return [
    label,
    summary.count,
    formatNumber(summary.p50),
    formatNumber(summary.p95),
    formatNumber(summary.p99),
    formatNumber(summary.max),
    formatNumber(summary.mean, 1),
  ];
}

export const SUMMARY_HEADERS = ['sample', 'n', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'mean ms'];

export function checkmark(ok: boolean): string {
  return ok ? 'PASS' : 'FAIL';
}
