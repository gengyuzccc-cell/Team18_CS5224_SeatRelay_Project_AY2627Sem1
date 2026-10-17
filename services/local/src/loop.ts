import { setTimeout as sleep } from 'node:timers/promises';
import { errorFields, type LocalLogger } from './logger';

export interface Loop {
  readonly name: string;
  start(): void;
  /** Stops after the running tick (if any) completes. */
  stop(): Promise<void>;
  /** One tick; resolves to true when the tick did work (the loop then re-ticks at once). */
  runOnce(): Promise<boolean>;
}

export interface LoopOptions {
  name: string;
  /** Idle wait between ticks that found nothing to do (and after an error). */
  intervalMs: number;
  logger: LocalLogger;
  tick: () => Promise<boolean>;
}

/**
 * A polling loop: ticks back-to-back while there is work, sleeps `intervalMs` when idle, logs
 * and backs off on errors, and drains cleanly on `stop()` (graceful shutdown).
 */
export function createLoop(options: LoopOptions): Loop {
  const { name, intervalMs, logger, tick } = options;
  let running = false;
  let stopped = true;
  let finished: Promise<void> = Promise.resolve();
  const abort = new AbortController();

  async function run(): Promise<void> {
    while (!stopped) {
      let busy = false;
      try {
        busy = await tick();
      } catch (error) {
        logger.error(`${name} tick failed`, errorFields(error));
      }
      if (stopped) {
        break;
      }
      if (!busy) {
        try {
          await sleep(intervalMs, undefined, { signal: abort.signal });
        } catch {
          break; // aborted by stop()
        }
      }
    }
  }

  return {
    name,
    start() {
      if (running) {
        return;
      }
      running = true;
      stopped = false;
      logger.info(`${name} started`, { intervalMs });
      finished = run().finally(() => {
        running = false;
      });
    },
    async stop() {
      if (!running) {
        return;
      }
      stopped = true;
      abort.abort();
      await finished;
      logger.info(`${name} stopped`);
    },
    runOnce: tick,
  };
}
