import fs from 'node:fs';
import path from 'node:path';
import type { RunRow } from './k6summary';

/**
 * The plan §3 step 15 matrix: 2 scenarios × 3 VU levels × 3 rounds, each run = warm-up +
 * one measured round, driven by `run-matrix.ts` through `k6 run` with environment variables.
 */
export const DEFAULT_SCENARIOS = ['cross-workshop', 'hotspot'];
export const DEFAULT_VUS = [10, 25, 50];
export const DEFAULT_ROUNDS = 3;
export const DEFAULT_WARMUP = '30s';
export const DEFAULT_DURATION = '60s';

/** plan §4 Performance targets. */
export const TARGETS = {
  readP95Ms: 1000,
  commandP95Ms: 1000,
  settleP95Ms: 5000,
  errorRate: 0.01,
} as const;

export interface MatrixSpec {
  scenarios: string[];
  vus: number[];
  rounds: number;
  warmup: string;
  duration: string;
}

export interface MatrixCell {
  scenario: string;
  vus: number;
  round: number;
  /** `<scenario>-<vus>-<round>`, the summary file's base name. */
  name: string;
}

export function buildMatrix(spec: MatrixSpec): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const scenario of spec.scenarios) {
    for (const vus of spec.vus) {
      for (let round = 1; round <= spec.rounds; round += 1) {
        cells.push({ scenario, vus, round, name: `${scenario}-${vus}-${round}` });
      }
    }
  }
  return cells;
}

/** '30s' | '2m' | '1h30m' | '500ms' | '45' (seconds) → milliseconds (same grammar as the k6 side). */
export function durationToMs(text: string): number {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value) * 1000;
  }
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(re)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total +=
      unit === 'ms'
        ? amount
        : unit === 's'
          ? amount * 1000
          : unit === 'm'
            ? amount * 60_000
            : amount * 3_600_000;
  }
  if (!matched) {
    throw new Error(`cannot parse duration "${text}"`);
  }
  return total;
}

export interface K6RunConfig {
  target: string;
  apiBase: string;
  tokenCache: string;
  scenarioFile: string;
  /** Directory handleSummary writes into (absolute). */
  summaryDir: string;
  warmup: string;
  duration: string;
  pollTimeoutMs?: number;
}

/** Environment variables one k6 run reads (`scripts/lib.js` CONFIG). */
export function k6Env(cell: MatrixCell, config: K6RunConfig): Record<string, string> {
  return {
    TARGET: config.target,
    TARGET_API: config.apiBase,
    TOKEN_CACHE: config.tokenCache,
    SCENARIO_FILE: config.scenarioFile,
    OUT_DIR: config.summaryDir,
    VUS: String(cell.vus),
    ROUND: String(cell.round),
    WARMUP: config.warmup,
    DURATION: config.duration,
    ...(config.pollTimeoutMs === undefined
      ? {}
      : { POLL_TIMEOUT_MS: String(config.pollTimeoutMs) }),
  };
}

export function k6Args(scriptPath: string, extra: string[] = []): string[] {
  return ['run', '--quiet', ...extra, scriptPath];
}

export function summaryFileFor(cell: MatrixCell, summaryDir: string): string {
  return path.join(summaryDir, `${cell.name}.json`);
}

/** Shell-ish rendering of a run for `--dry-run` and logs. */
export function renderCommand(k6Bin: string, args: string[], env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(' ');
  return `${assignments} ${k6Bin} ${args.map(quote).join(' ')}`;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ---------- raw.csv ---------- */

export const CSV_COLUMNS: (keyof RunRow)[] = [
  'scenario',
  'target',
  'vus',
  'round',
  'startedAt',
  'measuredStart',
  'endedAt',
  'warmup',
  'duration',
  'commit',
  'iterations',
  'iterationsMeasured',
  'httpReqs',
  'httpReqFailedRate',
  'readP50',
  'readP95',
  'commandP50',
  'commandP95',
  'pollP50',
  'pollP95',
  'settleP50',
  'settleP95',
  'serverSettleP50',
  'serverSettleP95',
  'pollsPerCommandAvg',
  'commandsFailed',
  'commandsRejected',
  'settleTimeouts',
  'thresholdsOk',
  'failedThresholds',
  'sqsDepthMax',
  'sqsOldestAgeMax',
  'cwSettleP95',
  'cwSettleCount',
  'exitCode',
  'note',
];

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const text = Array.isArray(value) ? value.join('|') : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly RunRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/* ---------- results/loadtest/<date>/runs.json (accumulated across invocations) ---------- */

/**
 * One results directory per date (`results/loadtest/<date>/`) collects every run of that day,
 * whichever target and however many invocations: `run-matrix` merges its rows into
 * `runs.json` (a re-run of the same target/scenario/VUs/round replaces the older row) and
 * regenerates `raw.csv` and `summary.md` from the whole set.
 */
export interface MatrixTargetInfo {
  apiBase: string;
  /** Notes of the latest invocation against this target (e.g. CloudWatch skipped). */
  notes: string[];
}

export interface MatrixState {
  version: 1;
  date: string;
  targets: Record<string, MatrixTargetInfo>;
  rows: RunRow[];
}

export function rowKey(row: Pick<RunRow, 'target' | 'scenario' | 'vus' | 'round'>): string {
  return `${row.target}|${row.scenario}|${row.vus}|${row.round}`;
}

function scenarioRank(scenario: string): number {
  const index = DEFAULT_SCENARIOS.indexOf(scenario);
  return index === -1 ? DEFAULT_SCENARIOS.length : index;
}

/** Stable order: target, scenario (cross-workshop first), VUs, round. */
export function compareRows(a: RunRow, b: RunRow): number {
  return (
    a.target.localeCompare(b.target) ||
    scenarioRank(a.scenario) - scenarioRank(b.scenario) ||
    a.scenario.localeCompare(b.scenario) ||
    a.vus - b.vus ||
    a.round - b.round
  );
}

/** `current` rows replace `previous` rows with the same target/scenario/VUs/round. */
export function mergeRows(previous: readonly RunRow[], current: readonly RunRow[]): RunRow[] {
  const byKey = new Map<string, RunRow>();
  for (const row of [...previous, ...current]) {
    byKey.set(rowKey(row), row);
  }
  return [...byKey.values()].sort(compareRows);
}

export function emptyMatrixState(date: string): MatrixState {
  return { version: 1, date, targets: {}, rows: [] };
}

export function readMatrixState(file: string, date: string): MatrixState {
  if (!fs.existsSync(file)) {
    return emptyMatrixState(date);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MatrixState>;
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) {
    throw new Error(`${file} is not a run-matrix state file`);
  }
  return {
    version: 1,
    date: typeof parsed.date === 'string' ? parsed.date : date,
    targets: parsed.targets ?? {},
    rows: parsed.rows,
  };
}

export function writeMatrixState(file: string, state: MatrixState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/* ---------- summary.md ---------- */

function ms(value: number | undefined): string {
  return value === undefined ? '–' : value.toFixed(0);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)} %`;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface LevelAggregate {
  scenario: string;
  vus: number;
  rounds: number;
  readP95?: number;
  commandP95?: number;
  settleP95?: number;
  serverSettleP95?: number;
  errorRate: number;
  pass: boolean;
}

/** Median of the per-round p95s per (scenario, VUs); pass = every target met by the medians. */
export function aggregateByLevel(rows: readonly RunRow[]): LevelAggregate[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = `${row.scenario}\u0000${row.vus}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as RunRow;
    const pick = (field: keyof RunRow): number | undefined =>
      median(group.map((row) => row[field]).filter((v): v is number => typeof v === 'number'));
    const readP95 = pick('readP95');
    const commandP95 = pick('commandP95');
    const settleP95 = pick('settleP95');
    const errorRate = Math.max(...group.map((row) => row.httpReqFailedRate));
    const aggregate: LevelAggregate = {
      scenario: first.scenario,
      vus: first.vus,
      rounds: group.length,
      errorRate,
      pass:
        readP95 !== undefined &&
        commandP95 !== undefined &&
        settleP95 !== undefined &&
        readP95 < TARGETS.readP95Ms &&
        commandP95 < TARGETS.commandP95Ms &&
        settleP95 < TARGETS.settleP95Ms &&
        errorRate < TARGETS.errorRate,
    };
    if (readP95 !== undefined) aggregate.readP95 = readP95;
    if (commandP95 !== undefined) aggregate.commandP95 = commandP95;
    if (settleP95 !== undefined) aggregate.settleP95 = settleP95;
    const serverP95 = pick('serverSettleP95');
    if (serverP95 !== undefined) aggregate.serverSettleP95 = serverP95;
    return aggregate;
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function listOrDash(values: readonly (string | undefined)[]): string {
  const present = unique(values.filter((v): v is string => v !== undefined && v.length > 0));
  return present.length === 0 ? '–' : present.map((v) => `\`${v}\``).join(', ');
}

/** Renders every run of the date directory, one section per target, then per scenario. */
export function renderSummaryMarkdown(state: MatrixState): string {
  const rows = [...state.rows].sort(compareRows);
  const targets = unique(rows.map((row) => row.target));
  const lines: string[] = [];
  lines.push(`# Load test ${state.date}`);
  lines.push('');
  lines.push(
    '- Each VU iteration: `GET /workshops/{id}` → `POST …/commands` REGISTER (202) → poll `GET /commands/{id}` every 200 ms until APPLIED/REJECTED → CANCEL_REGISTRATION the same way. `cross-workshop` spreads the VUs over 10 workshops, `hotspot` puts all of them on one.',
  );
  lines.push(
    `- Targets (plan §4 Performance): reads p95 < ${TARGETS.readP95Ms} ms, 202 p95 < ${TARGETS.commandP95Ms} ms, client-observed settle p95 < ${TARGETS.settleP95Ms} ms, HTTP error rate < ${pct(TARGETS.errorRate)}. Server-side settle = \`settledAt − acceptedAt\` of the CommandResult (plan §1.3 distinguishes the two); the client figure includes up to 200 ms of polling quantisation.`,
  );
  lines.push(
    '- Custom metrics (reads, 202s, polls, settle) cover the measured phase only; `HTTP errors` is k6 `http_req_failed` over the whole run including warm-up. Raw rows: `raw.csv`; k6 summaries: `k6/<target>/`; k6 output: `logs/<target>/`.',
  );
  lines.push('');
  for (const target of targets) {
    const targetRows = rows.filter((row) => row.target === target);
    const info = state.targets[target];
    const scenarios = unique(targetRows.map((row) => row.scenario));
    lines.push(`## Target \`${target}\``);
    lines.push('');
    if (info !== undefined) {
      lines.push(`- API: \`${info.apiBase}\``);
    }
    lines.push(
      `- Runs: ${targetRows.length} (scenarios ${scenarios.map((s) => `\`${s}\``).join(', ')} × VUs ${unique(targetRows.map((row) => row.vus)).join('/')} × rounds ${unique(targetRows.map((row) => row.round)).join('/')}); warm-up ${listOrDash(targetRows.map((row) => row.warmup))}, measured ${listOrDash(targetRows.map((row) => row.duration))} per run; commit ${listOrDash(targetRows.map((row) => row.commit))}.`,
    );
    for (const note of info?.notes ?? []) {
      lines.push(`- Note: ${note}`);
    }
    lines.push('');
    for (const scenario of scenarios) {
      const scenarioRows = targetRows.filter((row) => row.scenario === scenario);
      lines.push(`### ${target} · ${scenario}`);
      lines.push('');
      lines.push(
        '| VUs | round | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW CommandSettledLatency p95 (ms) |',
      );
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const row of scenarioRows) {
        lines.push(
          `| ${row.vus} | ${row.round} | ${ms(row.readP50)} / ${ms(row.readP95)} | ${ms(row.commandP50)} / ${ms(row.commandP95)} | ${ms(row.pollP95)} | ${ms(row.settleP50)} / ${ms(row.settleP95)} | ${ms(row.serverSettleP95)} | ${pct(row.httpReqFailedRate)} | ${row.commandsRejected} | ${row.settleTimeouts} | ${row.thresholdsOk ? 'pass' : `FAIL (${row.failedThresholds.join('; ')})`} | ${row.sqsDepthMax ?? '–'} | ${row.sqsOldestAgeMax ?? '–'} | ${ms(row.cwSettleP95)} |${row.note === undefined ? '' : ` ${row.note}`}`,
        );
      }
      lines.push('');
      lines.push('Per level (median of the rounds; errors = worst round):');
      lines.push('');
      lines.push(
        '| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | HTTP errors | targets |',
      );
      lines.push('|---|---|---|---|---|---|---|---|');
      for (const level of aggregateByLevel(scenarioRows)) {
        lines.push(
          `| ${level.vus} | ${level.rounds} | ${ms(level.readP95)} | ${ms(level.commandP95)} | ${ms(level.settleP95)} | ${ms(level.serverSettleP95)} | ${pct(level.errorRate)} | ${level.pass ? 'met' : 'NOT met'} |`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
