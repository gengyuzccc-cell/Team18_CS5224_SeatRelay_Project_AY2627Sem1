#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAwsCredentials,
  awsRegion,
  CliError,
  intOption,
  log,
  parseCli,
  parseTarget,
  REPO_ROOT,
  resolveTarget,
  resolveUserPath,
  RESULTS_DIR,
  runMain,
  stringOption,
  tokenCachePath,
} from '@seatrelay/scripts';
import { createCloudWatchClient, fetchRoundMetrics, type MetricDataClient } from './lib/cloudwatch';
import { createDockerStatsSampler, type DockerStatsSampler } from './lib/dockerStats';
import { isK6Summary, parseK6Summary, type RunRow } from './lib/k6summary';
import {
  buildMatrix,
  DEFAULT_DURATION,
  DEFAULT_ROUNDS,
  DEFAULT_SCENARIOS,
  DEFAULT_VUS,
  DEFAULT_WARMUP,
  durationToMs,
  k6Args,
  k6Env,
  mergeRows,
  readMatrixState,
  renderCommand,
  renderSummaryMarkdown,
  summaryFileFor,
  toCsv,
  writeMatrixState,
  type MatrixCell,
  type MatrixSpec,
} from './lib/matrix';
import { scenarioFilePath } from './lib/scenario';

const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));

const USAGE = `
run-matrix — run the k6 matrix (2 scenarios × 3 VU levels × 3 rounds) and collect the results

  pnpm --filter @seatrelay/loadtest run-matrix -- --target local|dev [options]

Options
  --target NAME          local (compose stack) or dev|pilot (default local)
  --api URL              API base URL (default per target; TARGET_API also works)
  --scenarios LIST       comma-separated (default cross-workshop,hotspot)
  --vus LIST             comma-separated VU levels (default 10,25,50)
  --rounds N             rounds per level (default 3)
  --warmup DUR           warm-up ramp per run (default 30s)
  --duration DUR         measured duration per run (default 60s)
  --pause DUR            pause between runs so queues drain (default 15s)
  --out DIR              output directory (default results/loadtest/<date>)
  --date YYYY-MM-DD      date used in the default output directory (default today, UTC)
  --k6 PATH              k6 binary (default k6 on PATH, or K6_BIN)
  --token-cache FILE     default tools/loadtest/.token-cache.<target>.json
  --scenario-file FILE   default tools/loadtest/.scenario.<target>.json (from prepare)
  --no-docker-stats      do not sample docker stats (sampled by default for local)
  --no-cloudwatch        skip the CloudWatch pull (done by default for dev/pilot)
  --stage STAGE          stage of the SQS queue / metrics for CloudWatch (default = target)
  --dry-run              print the k6 command lines and exit

Outputs (one directory per date, shared by every target and invocation of that day):
  <out>/raw.csv            one row per run (re-running a target/scenario/VUs/round replaces it)
  <out>/summary.md         p50/p95 per request kind and settle latency, error rate, per-level
                           medians vs the plan §4 targets, per target; CloudWatch columns for dev
  <out>/runs.json          the accumulated rows (raw.csv and summary.md are rebuilt from it)
  <out>/k6/<target>/*.json k6 handleSummary files (<scenario>-<vus>-<round>.json)
  <out>/logs/<target>/     k6 output per run
  <out>/docker-stats.csv   docker stats of the local containers every 2 s (--target local)
`;

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

interface K6Outcome {
  exitCode: number;
  startedAt: Date;
  endedAt: Date;
}

function runK6(
  k6Bin: string,
  args: string[],
  env: Record<string, string>,
  logFile: string,
): Promise<K6Outcome> {
  return new Promise((resolve, reject) => {
    const startedAt = new Date();
    const out = fs.createWriteStream(logFile);
    const child = spawn(k6Bin, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      out.write(chunk);
      process.stderr.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out.write(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      out.end();
      reject(error);
    });
    child.on('close', (code) => {
      out.end();
      resolve({ exitCode: code ?? -1, startedAt, endedAt: new Date() });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runMain(async () => {
  const { values } = parseCli(
    {
      target: { type: 'string' },
      api: { type: 'string' },
      scenarios: { type: 'string' },
      vus: { type: 'string' },
      rounds: { type: 'string' },
      warmup: { type: 'string' },
      duration: { type: 'string' },
      pause: { type: 'string' },
      out: { type: 'string' },
      date: { type: 'string' },
      k6: { type: 'string' },
      'token-cache': { type: 'string' },
      'scenario-file': { type: 'string' },
      'no-docker-stats': { type: 'boolean' },
      'no-cloudwatch': { type: 'boolean' },
      stage: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    USAGE,
  );
  const targetName = parseTarget(stringOption(values, 'target'));
  const spec: MatrixSpec = {
    scenarios: parseList(stringOption(values, 'scenarios'), DEFAULT_SCENARIOS),
    vus: parseList(stringOption(values, 'vus'), DEFAULT_VUS.map(String)).map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliError(`--vus: ${v} is not a positive integer`);
      }
      return n;
    }),
    rounds: intOption(values, 'rounds', DEFAULT_ROUNDS),
    warmup: stringOption(values, 'warmup', DEFAULT_WARMUP) as string,
    duration: stringOption(values, 'duration', DEFAULT_DURATION) as string,
  };
  const pauseMs = durationToMs(stringOption(values, 'pause', '15s') as string);
  const warmupMs = durationToMs(spec.warmup);
  const date = stringOption(values, 'date') ?? new Date().toISOString().slice(0, 10);
  const outArg = stringOption(values, 'out');
  const outDir =
    outArg === undefined ? path.join(RESULTS_DIR, 'loadtest', date) : resolveUserPath(outArg);
  const summaryDir = path.join(outDir, 'k6', targetName);
  const logsDir = path.join(outDir, 'logs', targetName);
  const stateFile = path.join(outDir, 'runs.json');
  const k6Bin = stringOption(values, 'k6') ?? process.env.K6_BIN ?? 'k6';
  const tokenCache = tokenCachePath(targetName, stringOption(values, 'token-cache'));
  const scenarioFile = scenarioFilePath(targetName, stringOption(values, 'scenario-file'));
  const dryRun = values['dry-run'] === true;
  const dockerStats = targetName === 'local' && values['no-docker-stats'] !== true;
  const cloudWatch = targetName !== 'local' && values['no-cloudwatch'] !== true;
  const stage = stringOption(values, 'stage') ?? targetName;

  const apiFlag = stringOption(values, 'api');
  const target = await resolveTarget({
    target: targetName,
    ...(apiFlag === undefined ? {} : { api: apiFlag }),
  });
  const cells = buildMatrix(spec);
  const runConfig = {
    target: target.name,
    apiBase: target.apiBase,
    tokenCache,
    scenarioFile,
    summaryDir,
    warmup: spec.warmup,
    duration: spec.duration,
  };
  const commandOf = (cell: MatrixCell) => ({
    args: k6Args(path.join(SCRIPTS_DIR, `${cell.scenario}.js`)),
    env: k6Env(cell, runConfig),
  });

  if (dryRun) {
    process.stdout.write(`# ${cells.length} runs → ${outDir}\n`);
    for (const cell of cells) {
      const { args, env } = commandOf(cell);
      process.stdout.write(`${renderCommand(k6Bin, args, env)}\n`);
    }
    return;
  }
  if (!fs.existsSync(tokenCache)) {
    throw new CliError(`token cache ${tokenCache} not found`, {
      hint: 'pnpm --filter @seatrelay/scripts get-tokens-keycloak -- --count 60 (local) or create-test-users (dev)',
    });
  }
  if (!fs.existsSync(scenarioFile)) {
    throw new CliError(`scenario file ${scenarioFile} not found`, {
      hint: `pnpm --filter @seatrelay/loadtest prepare-scenario -- --target ${targetName}`,
    });
  }
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const notes: string[] = [];
  let cw: MetricDataClient | undefined;
  if (cloudWatch) {
    const client = createCloudWatchClient(awsRegion());
    try {
      await assertAwsCredentials(client);
      cw = client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`CloudWatch metrics skipped: ${message}`);
      log('cloudwatch skipped', { reason: message });
    }
  } else if (targetName !== 'local') {
    notes.push('CloudWatch metrics skipped (--no-cloudwatch).');
  }

  let sampler: DockerStatsSampler | undefined;
  if (dockerStats) {
    sampler = createDockerStatsSampler({
      outFile: path.join(outDir, 'docker-stats.csv'),
      onError: (error) =>
        log('docker stats sample failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    sampler.start();
    notes.push(
      'docker-stats.csv: `docker stats` of the seatrelay-local-* containers every 2 s while the matrix runs (join on startedAt/endedAt of each run).',
    );
  }

  const commit = gitCommit();
  const rows: RunRow[] = [];
  const csvFile = path.join(outDir, 'raw.csv');
  const mdFile = path.join(outDir, 'summary.md');
  // Earlier invocations of the same day (other targets, earlier rounds) are kept.
  const previous = readMatrixState(stateFile, date);
  const writeOutputs = (): void => {
    const state = {
      ...previous,
      targets: { ...previous.targets, [target.name]: { apiBase: target.apiBase, notes } },
      rows: mergeRows(previous.rows, rows),
    };
    writeMatrixState(stateFile, state);
    fs.writeFileSync(csvFile, toCsv(state.rows));
    fs.writeFileSync(mdFile, renderSummaryMarkdown(state));
  };

  try {
    for (const [index, cell] of cells.entries()) {
      const { args, env } = commandOf(cell);
      const logFile = path.join(logsDir, `${cell.name}.log`);
      log(`run ${index + 1}/${cells.length}`, { ...cell, logFile });
      const outcome = await runK6(k6Bin, args, env, logFile);
      const measuredStart = new Date(outcome.startedAt.getTime() + warmupMs);
      const meta = {
        scenario: cell.scenario,
        target: target.name,
        vus: cell.vus,
        round: cell.round,
        startedAt: outcome.startedAt.toISOString(),
        measuredStart: measuredStart.toISOString(),
        endedAt: outcome.endedAt.toISOString(),
        warmup: spec.warmup,
        duration: spec.duration,
        ...(commit === undefined ? {} : { commit }),
        exitCode: outcome.exitCode,
      };
      const summaryFile = summaryFileFor(cell, summaryDir);
      let row: RunRow;
      if (fs.existsSync(summaryFile)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        if (!isK6Summary(parsed)) {
          throw new CliError(`${summaryFile} is not a k6 summary`);
        }
        row = parseK6Summary(parsed, meta);
        if (outcome.exitCode !== 0 && outcome.exitCode !== 99) {
          row.note = `k6 exited ${outcome.exitCode}`;
        }
      } else {
        row = {
          ...meta,
          iterations: 0,
          iterationsMeasured: 0,
          httpReqs: 0,
          httpReqFailedRate: 1,
          commandsFailed: 0,
          commandsRejected: 0,
          settleTimeouts: 0,
          thresholdsOk: false,
          failedThresholds: [],
          note: `no summary written (k6 exit ${outcome.exitCode}); see ${path.relative(outDir, logFile)}`,
        };
      }
      if (cw !== undefined) {
        try {
          const metrics = await fetchRoundMetrics(cw, stage, {
            start: measuredStart,
            end: outcome.endedAt,
          });
          Object.assign(row, metrics);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          row.note = `${row.note === undefined ? '' : `${row.note}; `}CloudWatch: ${message}`;
        }
      }
      rows.push(row);
      writeOutputs();
      log('run finished', {
        name: cell.name,
        exitCode: outcome.exitCode,
        readP95: row.readP95,
        commandP95: row.commandP95,
        settleP95: row.settleP95,
        errors: row.httpReqFailedRate,
        thresholdsOk: row.thresholdsOk,
      });
      if (index + 1 < cells.length && pauseMs > 0) {
        await sleep(pauseMs);
      }
    }
  } finally {
    if (sampler !== undefined) {
      await sampler.stop();
      log('docker stats stopped', {
        samples: sampler.samples,
        errors: sampler.errors,
        file: sampler.outFile,
      });
    }
    if (rows.length > 0) {
      writeOutputs();
    }
  }
  process.stdout.write(
    `${JSON.stringify({ outDir, runs: rows.length, csv: csvFile, summary: mdFile }, null, 2)}\n`,
  );
});
