import type { Command } from '@seatrelay/contracts';
import { createApiApp, type ApiApp } from '../api/app';
import type { WorkerPorts } from '../ports';
import {
  processCommand,
  type ProcessCommandOptions,
  type ProcessCommandResult,
} from '../worker/processCommand';
import { runSweep, type SweepResult } from '../worker/sweep';
import { ManualClock } from './clock';
import { InMemoryUserDirectory } from './directory';
import { SequentialIdGen } from './ids';
import { InMemoryLogger, InMemoryMetrics } from './observability';
import { InMemoryCommandQueue, InMemoryTimerScheduler } from './queue';
import { InMemoryWorkshopStore } from './store';

export interface InMemoryPortsOptions {
  /** Initial clock value (ISO UTC). */
  now?: string;
  allowFaultFlags?: boolean;
  stage?: string;
  idPrefix?: string;
  /** Default worker options for `drain()` / `fireDueTimers()`. */
  worker?: ProcessCommandOptions;
}

export interface DrainOptions extends ProcessCommandOptions {
  /**
   * `throw` (default): a failing command propagates and is dropped.
   * `redeliver`: emulate SQS — the message returns to the head of the queue with an
   * incremented delivery attempt; after `maxReceiveCount` failures it goes to `deadLetters`.
   */
  onError?: 'throw' | 'redeliver';
  maxReceiveCount?: number;
}

export interface DrainedCommand {
  command: Command;
  result: ProcessCommandResult;
  deliveryAttempt: number;
}

export interface InMemoryPorts extends WorkerPorts {
  store: InMemoryWorkshopStore;
  queue: InMemoryCommandQueue;
  timers: InMemoryTimerScheduler;
  clock: ManualClock;
  ids: SequentialIdGen;
  logger: InMemoryLogger;
  metrics: InMemoryMetrics;
  userDirectory: InMemoryUserDirectory;
  api: ApiApp;
  /** Messages that exhausted their redeliveries (only with `onError: 'redeliver'`). */
  deadLetters: { command: Command; error: unknown }[];
  /** Processes every queued command, including continuations it enqueues. */
  drain(options?: DrainOptions): Promise<DrainedCommand[]>;
  /** Enqueues the TICKs of every timer due at the clock's `now()`, then drains. */
  fireDueTimers(options?: DrainOptions): Promise<DrainedCommand[]>;
  /** Runs the sweep (enqueues TICKs for due workshops) without draining. */
  sweep(): Promise<SweepResult>;
}

/**
 * Wires every in-memory adapter into one API app + worker loop for tests and local tooling.
 * The queue is drained one message at a time, which is the per-workshop serialisation the
 * FIFO queue provides in production.
 */
export function createInMemoryPorts(options: InMemoryPortsOptions = {}): InMemoryPorts {
  const store = new InMemoryWorkshopStore();
  const queue = new InMemoryCommandQueue();
  const timers = new InMemoryTimerScheduler();
  const clock = new ManualClock(options.now);
  const ids = new SequentialIdGen(options.idPrefix);
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const userDirectory = new InMemoryUserDirectory();
  const api = createApiApp({
    store,
    queue,
    clock,
    ids,
    logger,
    userDirectory,
    allowFaultFlags: options.allowFaultFlags ?? false,
    stage: options.stage ?? 'test',
  });
  const attempts = new WeakMap<Command, number>();
  const deadLetters: { command: Command; error: unknown }[] = [];

  const ports: InMemoryPorts = {
    store,
    queue,
    timers,
    clock,
    ids,
    logger,
    metrics,
    userDirectory,
    api,
    deadLetters,
    async drain(drainOptions = {}) {
      const { onError = 'throw', maxReceiveCount = 3, ...rest } = drainOptions;
      const processed: DrainedCommand[] = [];
      let guard = 0;
      for (;;) {
        const command = queue.dequeue();
        if (command === undefined) {
          return processed;
        }
        if (++guard > 10_000) {
          throw new Error('drain did not converge');
        }
        const deliveryAttempt = attempts.get(command) ?? 1;
        try {
          const result = await processCommand(ports, command, {
            ...options.worker,
            ...rest,
            deliveryAttempt,
          });
          processed.push({ command, result, deliveryAttempt });
        } catch (error) {
          if (onError === 'throw') {
            throw error;
          }
          if (deliveryAttempt >= maxReceiveCount) {
            deadLetters.push({ command, error });
          } else {
            attempts.set(command, deliveryAttempt + 1);
            queue.messages.unshift(command);
          }
        }
      }
    },
    async fireDueTimers(drainOptions) {
      for (const tick of timers.dueTicks(clock.now())) {
        await queue.enqueue(tick);
      }
      return ports.drain(drainOptions);
    },
    sweep: () => runSweep({ store, queue, clock, logger }),
  };
  return ports;
}
