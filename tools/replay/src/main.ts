import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_RESAMPLES,
  headlineTable,
  writeReport,
  type ReportMeta,
} from './report';
import { runSeeds } from './runner';

/**
 * `pnpm replay [--seeds 1000] [--start-seed 1] [--out results/replay] [--workers N]
 *              [--bootstrap 2000] [--check]`
 *
 * Replays every seed under UNIFIED and PER_SESSION mode and writes `raw.csv`, `summary.md`
 * and the SVG charts to the output directory (default: `<repo>/results/replay`).
 */

interface CliOptions {
  seeds: number;
  startSeed: number;
  out: string;
  workers: number;
  bootstrap: number;
  check: boolean;
  quiet: boolean;
}

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_OUT = resolve(PACKAGE_DIR, '..', '..', 'results', 'replay');

function usage(): string {
  return [
    'usage: replay [options]',
    '  --seeds <n>        number of seeds (default 1000)',
    '  --start-seed <n>   first seed (default 1)',
    '  --out <dir>        output directory (default <repo>/results/replay)',
    '  --workers <n>      worker threads (default: available CPUs)',
    '  --bootstrap <n>    bootstrap resamples for the confidence intervals (default 2000)',
    '  --check            run checkInvariants after every decision (slow)',
    '  --quiet            no progress output',
  ].join('\n');
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    seeds: 1000,
    startSeed: 1,
    out: DEFAULT_OUT,
    workers: availableParallelism(),
    bootstrap: DEFAULT_RESAMPLES,
    check: false,
    quiet: false,
  };
  const integer = (flag: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `${flag} expects a non-negative integer, got ${raw ?? 'nothing'}\n${usage()}`,
      );
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    switch (arg) {
      case '--seeds':
        options.seeds = integer(arg, next);
        index += 1;
        break;
      case '--start-seed':
        options.startSeed = integer(arg, next);
        index += 1;
        break;
      case '--out':
        if (next === undefined) {
          throw new Error(`--out expects a directory\n${usage()}`);
        }
        options.out = resolve(next);
        index += 1;
        break;
      case '--workers':
        options.workers = Math.max(1, integer(arg, next));
        index += 1;
        break;
      case '--bootstrap':
        options.bootstrap = integer(arg, next);
        index += 1;
        break;
      case '--check':
        options.check = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${arg}\n${usage()}`);
    }
  }
  return options;
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const seeds = Array.from({ length: options.seeds }, (_, index) => options.startSeed + index);
  if (seeds.length === 0) {
    throw new Error('--seeds must be at least 1');
  }
  const started = performance.now();
  const workers = Math.min(options.workers, seeds.length);
  if (!options.quiet) {
    console.log(
      `replay: ${seeds.length} seed(s) ${seeds[0]}–${seeds[seeds.length - 1]} × 2 modes, ${workers} worker(s), invariants ${options.check ? 'every step' : 'at run end'}`,
    );
  }
  let lastReported = 0;
  const rows = await runSeeds({
    seeds,
    workers,
    checkInvariants: options.check,
    onProgress: (completed, total) => {
      if (options.quiet) {
        return;
      }
      const stepSize = Math.max(1, Math.floor(total / 10));
      if (completed === total || completed - lastReported >= stepSize) {
        lastReported = completed;
        console.log(
          `  ${completed}/${total} seeds (${((performance.now() - started) / 1000).toFixed(1)} s)`,
        );
      }
    },
  });
  const elapsedMs = performance.now() - started;
  const meta: ReportMeta = {
    seedCount: seeds.length,
    firstSeed: seeds[0]!,
    lastSeed: seeds[seeds.length - 1]!,
    elapsedMs,
    workers,
    bootstrapSeed: DEFAULT_BOOTSTRAP_SEED,
    resamples: options.bootstrap,
    generatedAt: new Date().toISOString(),
    invariantsCheckedEveryStep: options.check,
  };
  const { paths, comparisons } = writeReport(options.out, rows, meta);
  const violations = rows.reduce((total, row) => total + row.metrics.invariant_violations, 0);
  console.log('');
  console.log(headlineTable(comparisons));
  console.log('');
  console.log(`invariant violations: ${violations}`);
  console.log(`wrote:\n${paths.map((path) => `  ${path}`).join('\n')}`);
  console.log(`done in ${(elapsedMs / 1000).toFixed(1)} s`);
  if (violations > 0) {
    process.exitCode = 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
