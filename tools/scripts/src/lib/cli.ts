import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

/** Repository root (this file lives in tools/scripts/src/lib). */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const LOADTEST_DIR = path.join(REPO_ROOT, 'tools', 'loadtest');
export const RESULTS_DIR = path.join(REPO_ROOT, 'results');

/**
 * Directory the user ran the command from. `pnpm --filter <pkg> <script>` runs the script in the
 * package directory but exports the original directory as `INIT_CWD`, so relative paths given
 * on the command line must be resolved against it, not against `process.cwd()`.
 */
export function invocationDir(): string {
  const initCwd = process.env.INIT_CWD;
  return initCwd !== undefined && initCwd.length > 0 ? initCwd : process.cwd();
}

/** Resolves a path typed by the user (flag value) against `invocationDir()`. */
export function resolveUserPath(file: string): string {
  return path.resolve(invocationDir(), file);
}

/** A usage / input error: printed without a stack trace, exit code 2. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'CliError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 2;
  }
}

export function fail(message: string, hint?: string): never {
  throw new CliError(message, hint === undefined ? {} : { hint });
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Progress line on stderr (stdout is reserved for machine-readable output). */
export function log(message: string, fields?: Record<string, unknown>): void {
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
  process.stderr.write(`[${stamp()}] ${message}${suffix}\n`);
}

export type CliOptions = NonNullable<ParseArgsConfig['options']>;
export type CliValues = Record<string, string | boolean | undefined>;

export interface ParsedCli {
  values: CliValues;
  positionals: string[];
}

/**
 * `pnpm <script> -- --flag` forwards the `--` separator to the script (pnpm ≥ 7), where
 * `parseArgs` would treat every following flag as a positional. Drop one leading `--`.
 */
export function stripArgSeparator(argv: readonly string[]): string[] {
  return argv[0] === '--' ? argv.slice(1) : [...argv];
}

/**
 * `node:util` `parseArgs` with `--help` and a usage banner. Unknown options print the usage
 * and exit 2 instead of a stack trace. A leading `--` (from `pnpm <script> -- …`) is ignored.
 */
export function parseCli(
  options: CliOptions,
  usage: string,
  argv: string[] = process.argv.slice(2),
): ParsedCli {
  const withHelp: CliOptions = { ...options, help: { type: 'boolean', short: 'h' } };
  try {
    const parsed = parseArgs({
      args: stripArgSeparator(argv),
      options: withHelp,
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help === true) {
      process.stdout.write(`${usage.trim()}\n`);
      process.exit(0);
    }
    return { values: parsed.values as CliValues, positionals: parsed.positionals };
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(message, { hint: usage.trim() });
  }
}

export function stringOption(
  values: Record<string, unknown>,
  name: string,
  fallback?: string,
): string | undefined {
  const value = values[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}

export function requireString(values: Record<string, unknown>, name: string): string {
  const value = stringOption(values, name);
  if (value === undefined) {
    fail(`--${name} is required`);
  }
  return value;
}

export function intOption(values: Record<string, unknown>, name: string, fallback: number): number {
  const raw = values[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    fail(`--${name} must be an integer (got ${String(raw)})`);
  }
  return value;
}

export function enumOption<const T extends readonly string[]>(
  values: Record<string, unknown>,
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = values[name];
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    fail(`--${name} must be one of ${allowed.join('|')} (got ${String(raw)})`);
  }
  return raw as T[number];
}

/**
 * Errors that describe an operational condition (API answered 4xx/5xx, API or identity
 * provider unreachable, command rejected or not settled, seeded state differs): their message
 * says everything, a stack trace would only hide it.
 */
const OPERATIONAL_ERRORS = new Set([
  'ApiHttpError',
  'ApiNetworkError',
  'CommandTimeoutError',
  'CommandRejectedError',
  'SeedStateError',
]);

/** Runs a CLI main; CliErrors print `error: message` (+ hint), anything else its stack. */
export function runMain(main: () => Promise<void>): void {
  // `… | head`: the reader went away; stop quietly instead of an unhandled EPIPE.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
  });
  main().then(
    () => {
      process.exitCode ??= 0;
    },
    (error: unknown) => {
      if (error instanceof CliError) {
        process.stderr.write(`error: ${error.message}\n`);
        if (error.hint !== undefined) {
          process.stderr.write(`${error.hint}\n`);
        }
        process.exit(error.exitCode);
      }
      if (error instanceof Error && OPERATIONAL_ERRORS.has(error.name)) {
        process.stderr.write(`error: ${error.message}\n`);
        process.exit(1);
      }
      process.stderr.write(
        `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}

/** Runs `fn` over `items` with at most `concurrency` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** ISO-8601 UTC with milliseconds, `now` + `ms`. */
export function isoFromNow(ms: number, now: number = Date.now()): string {
  return new Date(now + ms).toISOString();
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
