import { Worker } from 'node:worker_threads';
import { generateScenario } from './generator';
import type { RunRow } from './report';
import { simulate } from './simulate';

/** Runs one seed under both modes (the unit of work of the CLI and of the worker threads). */
export function runSeed(seed: number, checkInvariants = false): RunRow[] {
  const scenario = generateScenario(seed);
  const rows: RunRow[] = [];
  for (const mode of ['UNIFIED', 'PER_SESSION'] as const) {
    const started = performance.now();
    const result = simulate(scenario, mode, { checkInvariants });
    rows.push({
      seed,
      mode,
      params: scenario.params,
      metrics: result.metrics,
      samples: result.samples,
      durationMs: Math.round(performance.now() - started),
    });
  }
  return rows;
}

export interface RunSeedsOptions {
  seeds: readonly number[];
  /** Worker threads; 1 runs everything on the calling thread. */
  workers?: number;
  checkInvariants?: boolean;
  onProgress?: (completedSeeds: number, totalSeeds: number) => void;
}

/** Worker → main: the rows of one seed. */
export interface WorkerMessage {
  seed: number;
  rows: RunRow[];
}

/** Main → worker: the next seed to run, or nothing left. */
export type WorkerTask = { seed: number } | { done: true };

/** Rough cost of a seed (decisions × snapshot size grow with the population) for scheduling. */
export function estimateCost(seed: number): number {
  const { nParticipants, nSessions } = generateScenario(seed).params;
  return nParticipants * nParticipants * nSessions;
}

export function sortRows(rows: RunRow[]): RunRow[] {
  return rows.sort((a, b) => a.seed - b.seed || a.mode.localeCompare(b.mode));
}

/** Runs every seed (both modes) and returns the rows sorted by seed and mode. */
export async function runSeeds(options: RunSeedsOptions): Promise<RunRow[]> {
  const seeds = [...options.seeds];
  const workers = Math.max(1, Math.min(options.workers ?? 1, seeds.length));
  const checkInvariants = options.checkInvariants ?? false;
  const rows: RunRow[] = [];
  let completed = 0;

  if (workers === 1) {
    for (const seed of seeds) {
      rows.push(...runSeed(seed, checkInvariants));
      completed += 1;
      options.onProgress?.(completed, seeds.length);
    }
    return sortRows(rows);
  }

  // Largest seeds first, handed out one at a time to whichever worker is idle, so that no
  // worker is left alone with a big scenario at the end of the run.
  const pending = seeds
    .map((seed) => ({ seed, cost: estimateCost(seed) }))
    .sort((a, b) => b.cost - a.cost || a.seed - b.seed)
    .map((entry) => entry.seed);
  const nextTask = (): WorkerTask => {
    const seed = pending.shift();
    return seed === undefined ? { done: true } : { seed };
  };
  // tsx's TypeScript hooks are not inherited by worker threads: a plain-JS entry registers
  // them inside the thread before importing worker.ts.
  const workerUrl = new URL('./worker-entry.mjs', import.meta.url);
  await Promise.all(
    Array.from(
      { length: workers },
      () =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(workerUrl, { workerData: { checkInvariants } });
          worker.on('message', (message: WorkerMessage) => {
            rows.push(...message.rows);
            completed += 1;
            options.onProgress?.(completed, seeds.length);
            worker.postMessage(nextTask());
          });
          worker.on('online', () => worker.postMessage(nextTask()));
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`replay worker exited with code ${code}`));
            }
          });
        }),
    ),
  );
  return sortRows(rows);
}
