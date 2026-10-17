import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ApiClient,
  CliError,
  DEFAULT_PASSWORD,
  RESULTS_DIR,
  REPO_ROOT,
  intOption,
  log as scriptLog,
  parseCli,
  parseTarget,
  resolveTarget,
  runMain,
  stringOption,
  tokenCachePath,
  userProviderFor,
  type CliOptions,
  type TargetConfig,
  type UserProvider,
} from '@seatrelay/scripts';
import { AccountPool, type AccountNaming } from './accounts';
import { createTargetOps, type TargetOps } from './ops';
import {
  allocateResultsDir,
  checkmark,
  gitCommitInfo,
  markdownTable,
  writeCsv,
  writeJson,
  writeMarkdown,
  type CommitInfo,
  type CsvRow,
} from './results';

/**
 * The harness every experiment script runs in (plan §4, Table 3): one CLI convention
 * (`--target`, `--out`, `--runs`, …), one way of obtaining accounts, and one output layout
 * (`results/<date>-<name>/{raw.csv, summary.md, meta.json}`). A script declares its name,
 * Table 3 row and extra options, then fills `ctx.check(...)` rows and/or raw sample rows and
 * returns the Markdown summary; the harness writes the files, prints the summary and exits 1
 * when any check failed.
 */

export const COMMON_OPTIONS = {
  target: { type: 'string' },
  api: { type: 'string' },
  out: { type: 'string' },
  runs: { type: 'string' },
  hold: { type: 'string' },
  prefix: { type: 'string' },
  domain: { type: 'string' },
  password: { type: 'string' },
  organiser: { type: 'string' },
  outsider: { type: 'string' },
  cache: { type: 'string' },
  'no-create': { type: 'boolean' },
  faults: { type: 'string' },
  'pool-id': { type: 'string' },
  'client-id': { type: 'string' },
  region: { type: 'string' },
  keycloak: { type: 'string' },
  'settle-timeout': { type: 'string' },
  label: { type: 'string' },
} as const satisfies CliOptions;

export const COMMON_USAGE = `
Common options
  --target NAME          local (compose stack, Keycloak tokens) | dev | pilot (Cognito token cache);
                         default local
  --api URL              API base URL (default http://localhost:3000 for local, else the ApiUrl
                         output of stack seatrelay-app-<target>; TARGET_API also works)
  --out DIR              results base directory (default <repo>/results); the run is written to
                         <out>/<YYYY-MM-DD>-<name>[-<n>]/{raw.csv, summary.md, meta.json}
  --runs N               repetitions of the scenario (default 1)
  --hold SECONDS         holdSeconds of the workshops the script creates (min 30; default 60 for the
                         expiry-driven scripts, 900 for the others so that no offer expires
                         mid-scenario on a slow target)
  --prefix / --domain    participant accounts <prefix>-1@<domain> … (default loaduser / example.com)
  --organiser EMAIL      organiser account (default organiser@example.com on local, else
                         <prefix>-organiser@<domain>)
  --outsider EMAIL       organiser of another organisation (default <prefix>-outsider@<domain>)
  --password PASS        password of accounts that must be created / signed in (default Passw0rd!)
  --cache FILE           ID token cache (default tools/loadtest/.token-cache.<target>.json)
  --no-create            never create missing accounts (tokens must be cached or sign-in must work)
  --faults auto|on|off   use _fault flags (auto = on for local and dev, off for pilot)
  --settle-timeout MS    give up polling a command after this long (default 60000; 300000 on dev)
  --pool-id / --client-id / --region   Cognito ids (default: outputs of stack seatrelay-auth)
  --keycloak URL         Keycloak base URL for local (default http://localhost:8080)
  --label TEXT           free text recorded in meta.json
`;

export interface CommonValues {
  runs: number;
  holdSeconds: number;
  password: string;
  cacheFile: string;
  create: boolean;
  faults: boolean;
  settleTimeoutMs: number;
  label: string | undefined;
}

export interface CheckInput {
  /** Repetition the check belongs to (default: the current `beginRun`); for parallel trials. */
  run?: number;
  scenario: string;
  step: string;
  ok: boolean;
  expected?: string;
  actual?: string;
  detail?: string;
  ms?: number;
}

export interface CheckRow extends CheckInput {
  run: number;
}

/** Fields of a check row that may be overridden besides the assertion itself. */
type CheckExtras = Pick<CheckInput, 'detail' | 'ms' | 'run'>;

export interface ExperimentResult {
  /** Markdown body of summary.md (the harness adds the header and the checks section). */
  summary: string;
  /** raw.csv rows; the check rows when omitted. */
  rows?: CsvRow[];
  columns?: string[];
  /** Further CSV files of the run directory, e.g. `{ 'latency.csv': samples }`. */
  extraFiles?: Record<string, CsvRow[]>;
  /** Extra fields for meta.json (headline numbers). */
  extra?: Record<string, unknown>;
  /** Overrides the "every check passed" verdict (e.g. a latency target). */
  ok?: boolean;
}

export interface ExperimentSpec<O extends CliOptions> {
  /** Results directory suffix and script name, e.g. `backfill`. */
  name: string;
  /** Table 3 row of plan §4. */
  tableRow: string;
  /** Pass criterion as stated in plan §4. */
  criterion: string;
  usage: string;
  /** `--hold` default (60 when omitted: the expiry-driven experiments). */
  defaultHoldSeconds?: number;
  options?: O;
  run(ctx: ExperimentContext): Promise<ExperimentResult>;
}

export class ExperimentContext {
  readonly runId = randomUUID();
  readonly startedAt = new Date();
  readonly checks: CheckRow[] = [];
  /** Steps that could not run on this target (documented in summary.md, not counted). */
  readonly skipped: CheckRow[] = [];
  readonly params: Record<string, unknown> = {};
  readonly commit: CommitInfo | undefined;
  readonly anonymous: ApiClient;
  private run = 1;

  constructor(
    readonly name: string,
    readonly target: TargetConfig,
    readonly values: Record<string, unknown>,
    readonly options: CommonValues,
    readonly accounts: AccountPool,
    readonly ops: TargetOps,
    readonly dir: string,
  ) {
    this.commit = gitCommitInfo(REPO_ROOT);
    this.anonymous = new ApiClient({ baseUrl: target.apiBase });
  }

  /** Progress line on stderr. */
  log(message: string, fields?: Record<string, unknown>): void {
    scriptLog(message, fields);
  }

  /** Marks the start of repetition `run` (1-based) for the following checks. */
  beginRun(run: number): void {
    this.run = run;
    if (this.options.runs > 1) {
      this.log(`--- run ${run}/${this.options.runs}`);
    }
  }

  get currentRun(): number {
    return this.run;
  }

  /** Records an assertion; returns `ok`. */
  check(input: CheckInput): boolean {
    const row: CheckRow = { ...input, run: input.run ?? this.run };
    this.checks.push(row);
    const parts = [`${checkmark(input.ok)} ${input.scenario} / ${input.step}`];
    if (input.expected !== undefined || input.actual !== undefined) {
      parts.push(`expected ${input.expected ?? '-'}, got ${input.actual ?? '-'}`);
    }
    if (input.detail !== undefined) {
      parts.push(input.detail);
    }
    if (input.ms !== undefined) {
      parts.push(`${Math.round(input.ms)} ms`);
    }
    this.log(parts.join(' — '));
    return input.ok;
  }

  /** `check` with `ok = expected === actual` (stringified). */
  expectEqual(
    scenario: string,
    step: string,
    expected: unknown,
    actual: unknown,
    extras: CheckExtras = {},
  ): boolean {
    return this.check({
      scenario,
      step,
      ok: String(expected) === String(actual),
      expected: String(expected),
      actual: String(actual),
      ...extras,
    });
  }

  /** Records a thrown error as a failed check. */
  fail(scenario: string, step: string, error: unknown, run?: number): false {
    const message = error instanceof Error ? error.message : String(error);
    this.check({ scenario, step, ok: false, detail: message, ...(run === undefined ? {} : { run }) });
    return false;
  }

  /** Records a step that cannot run on this target: listed in summary.md / meta.json, not a check. */
  skip(scenario: string, step: string, reason: string, run?: number): void {
    this.skipped.push({ run: run ?? this.run, scenario, step, ok: true, detail: `skipped: ${reason}` });
    this.log(`SKIP ${scenario} / ${step} — ${reason}`);
  }

  /** Records a parameter in meta.json. */
  param(name: string, value: unknown): void {
    this.params[name] = value;
  }

  get failedChecks(): CheckRow[] {
    return this.checks.filter((row) => !row.ok);
  }
}

function usageOf<O extends CliOptions>(spec: ExperimentSpec<O>): string {
  return `${spec.usage.trim()}\n${COMMON_USAGE}`;
}

function defaultOrganiser(target: TargetConfig, naming: Pick<AccountNaming, 'prefix' | 'domain'>): string {
  return target.name === 'local'
    ? 'organiser@example.com'
    : `${naming.prefix}-organiser@${naming.domain}`;
}

async function providerFor(
  target: TargetConfig,
  values: Record<string, unknown>,
): Promise<UserProvider> {
  const keycloak = stringOption(values, 'keycloak');
  const poolId = stringOption(values, 'pool-id');
  const clientId = stringOption(values, 'client-id');
  return userProviderFor(target, {
    ...(keycloak === undefined ? {} : { keycloak: { baseUrl: keycloak } }),
    cognito: {
      ...(poolId === undefined ? {} : { userPoolId: poolId }),
      ...(clientId === undefined ? {} : { clientId }),
    },
  });
}

/** Builds the context from the CLI, runs the experiment and writes the result files. */
export function runExperiment<O extends CliOptions>(spec: ExperimentSpec<O>): void {
  runMain(async () => {
    const { values } = parseCli({ ...COMMON_OPTIONS, ...(spec.options ?? {}) }, usageOf(spec));
    const target = await resolveTarget({
      target: parseTarget(stringOption(values, 'target')),
      ...(stringOption(values, 'api') === undefined ? {} : { api: stringOption(values, 'api') }),
    });
    const region = stringOption(values, 'region');
    if (region !== undefined) {
      process.env.AWS_REGION = region;
    }
    const naming: AccountNaming = {
      prefix: stringOption(values, 'prefix', 'loaduser') as string,
      domain: stringOption(values, 'domain', 'example.com') as string,
      organiserEmail: '',
      outsiderEmail: '',
    };
    naming.organiserEmail = stringOption(values, 'organiser', defaultOrganiser(target, naming)) as string;
    naming.outsiderEmail = stringOption(values, 'outsider', `${naming.prefix}-outsider@${naming.domain}`) as string;

    const holdSeconds = intOption(values, 'hold', spec.defaultHoldSeconds ?? 60);
    if (holdSeconds < 30) {
      throw new CliError('--hold must be at least 30 (MIN_HOLD_SECONDS)');
    }
    const runs = intOption(values, 'runs', 1);
    if (runs < 1) {
      throw new CliError('--runs must be at least 1');
    }
    const ops = createTargetOps(target);
    const faultsFlag = stringOption(values, 'faults', 'auto') as string;
    if (!['auto', 'on', 'off'].includes(faultsFlag)) {
      throw new CliError(`--faults must be auto|on|off (got ${faultsFlag})`);
    }
    const options: CommonValues = {
      runs,
      holdSeconds,
      password: stringOption(values, 'password', DEFAULT_PASSWORD) as string,
      cacheFile: tokenCachePath(target.name, stringOption(values, 'cache')),
      create: values['no-create'] !== true,
      faults: faultsFlag === 'on' || (faultsFlag === 'auto' && ops.faultFlagsExpected()),
      settleTimeoutMs: intOption(values, 'settle-timeout', target.name === 'local' ? 60_000 : 300_000),
      label: stringOption(values, 'label'),
    };
    const accounts = new AccountPool({
      target,
      naming,
      password: options.password,
      cacheFile: options.cacheFile,
      create: options.create,
      provider: () => providerFor(target, values),
      log: scriptLog,
    });
    const baseDir = path.resolve(stringOption(values, 'out', RESULTS_DIR) as string);
    const dir = allocateResultsDir(baseDir, spec.name);
    const ctx = new ExperimentContext(spec.name, target, values, options, accounts, ops, dir);
    ctx.log(`${spec.name}: ${spec.tableRow}`, {
      target: target.name,
      api: target.apiBase,
      runs,
      holdSeconds,
      faults: options.faults,
      dir: path.relative(REPO_ROOT, dir),
      commit: ctx.commit?.short,
    });

    let result: ExperimentResult | undefined;
    let error: unknown;
    try {
      result = await spec.run(ctx);
    } catch (caught) {
      error = caught;
      ctx.fail('harness', 'run', caught);
    }
    const finishedAt = new Date();
    const failed = ctx.failedChecks;
    const ok = (result?.ok ?? true) && failed.length === 0 && error === undefined;
    const checkRows: CsvRow[] = ctx.checks.map((row) => ({ ...row }));
    writeCsv(path.join(dir, 'raw.csv'), result?.rows ?? checkRows, result?.columns);
    if (result?.rows !== undefined) {
      writeCsv(path.join(dir, 'checks.csv'), checkRows);
    }
    for (const [file, rows] of Object.entries(result?.extraFiles ?? {})) {
      writeCsv(path.join(dir, path.basename(file)), rows);
    }
    const summary = renderSummary(spec, ctx, result, error, finishedAt, ok);
    writeMarkdown(path.join(dir, 'summary.md'), summary);
    writeJson(path.join(dir, 'meta.json'), {
      runId: ctx.runId,
      name: spec.name,
      tableRow: spec.tableRow,
      criterion: spec.criterion,
      startedAt: ctx.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - ctx.startedAt.getTime(),
      target: { name: target.name, stage: target.stage, apiBase: target.apiBase, apiSource: target.apiSource },
      commit: ctx.commit ?? null,
      runs,
      holdSeconds,
      faults: options.faults,
      label: options.label ?? null,
      accounts: { prefix: naming.prefix, domain: naming.domain, organiser: naming.organiserEmail, ...accounts.stats },
      params: ctx.params,
      checks: {
        total: ctx.checks.length,
        passed: ctx.checks.length - failed.length,
        failed: failed.length,
        skipped: ctx.skipped.length,
      },
      ...(ctx.skipped.length === 0
        ? {}
        : { skipped: ctx.skipped.map((row) => ({ run: row.run, scenario: row.scenario, step: row.step, reason: row.detail })) }),
      ok,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      ...(result?.extra ?? {}),
    });
    process.stdout.write(`${summary}\n`);
    ctx.log(`${ok ? 'PASS' : 'FAIL'}: results in ${dir}`);
    if (!ok) {
      process.exitCode = 1;
    }
  });
}

function renderSummary<O extends CliOptions>(
  spec: ExperimentSpec<O>,
  ctx: ExperimentContext,
  result: ExperimentResult | undefined,
  error: unknown,
  finishedAt: Date,
  ok: boolean,
): string {
  const failed = ctx.failedChecks;
  const lines = [
    `# ${spec.name} — ${spec.tableRow}`,
    '',
    `- Verdict: **${ok ? 'PASS' : 'FAIL'}** (${ctx.checks.length - failed.length}/${ctx.checks.length} checks passed)`,
    `- Pass criterion (plan §4): ${spec.criterion}`,
    `- Run id: \`${ctx.runId}\`, started ${ctx.startedAt.toISOString()}, finished ${finishedAt.toISOString()} (${Math.round((finishedAt.getTime() - ctx.startedAt.getTime()) / 1000)} s)`,
    `- Target: ${ctx.target.name} (${ctx.target.apiBase}); runs: ${ctx.options.runs}; holdSeconds: ${ctx.options.holdSeconds}; fault flags: ${ctx.options.faults ? 'on' : 'off'}`,
    `- Commit: ${ctx.commit === undefined ? 'unknown' : `${ctx.commit.hash}${ctx.commit.dirty ? ' (dirty)' : ''}${ctx.commit.branch === undefined ? '' : ` on ${ctx.commit.branch}`}`}`,
    ...(ctx.options.label === undefined ? [] : [`- Label: ${ctx.options.label}`]),
    `- Script: \`tools/experiments/src/${spec.name}.ts\`; raw samples: \`raw.csv\`; parameters: \`meta.json\``,
    '',
  ];
  if (error !== undefined) {
    lines.push(`**The run aborted with an error:** ${error instanceof Error ? error.message : String(error)}`, '');
  }
  if (result !== undefined) {
    lines.push(result.summary.trim(), '');
  }
  if (ctx.skipped.length > 0) {
    lines.push('## Skipped on this target', '');
    lines.push(
      markdownTable(
        ['run', 'scenario', 'step', 'reason'],
        ctx.skipped.map((row) => [row.run, row.scenario, row.step, row.detail]),
      ),
      '',
    );
  }
  lines.push('## Checks', '');
  if (failed.length === 0) {
    lines.push(`All ${ctx.checks.length} checks passed.`);
  } else {
    lines.push(`${failed.length} of ${ctx.checks.length} checks failed:`, '');
    lines.push(
      markdownTable(
        ['run', 'scenario', 'step', 'expected', 'actual', 'detail'],
        failed.map((row) => [row.run, row.scenario, row.step, row.expected, row.actual, row.detail]),
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}
