import type { CommandResultView } from '@seatrelay/contracts';
import { nextPollDelay } from './backoff';

/**
 * Polls `GET /commands/{id}` until the record is APPLIED or REJECTED (plan §1.3). Transient
 * errors (network, 5xx, a 404 while the record propagates) are tolerated up to
 * `maxConsecutiveErrors` in a row; then the caller may resume with the same commandId.
 */

export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

export class PollGaveUpError extends Error {
  readonly commandId: string;
  override readonly cause: unknown;

  constructor(commandId: string, cause: unknown) {
    super('Lost contact with the server while waiting for the outcome');
    this.name = 'PollGaveUpError';
    this.commandId = commandId;
    this.cause = cause;
  }
}

export class PollAbortedError extends Error {
  constructor() {
    super('Polling aborted');
    this.name = 'PollAbortedError';
  }
}

export interface PollOptions {
  signal?: AbortSignal;
  /** `pollAfterMs` from the 202. */
  initialDelayMs?: number;
  /** Fired once when the 30 s budget is spent. */
  onSlow?: () => void;
  /** Fired after every GET (settled or not) with the attempt number (1-based). */
  onAttempt?: (attempt: number, view: CommandResultView | undefined) => void;
  maxConsecutiveErrors?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function isTerminal(view: Pick<CommandResultView, 'status'>): boolean {
  return view.status === 'APPLIED' || view.status === 'REJECTED';
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PollAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new PollAbortedError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollCommand(
  getCommand: (commandId: string, signal?: AbortSignal) => Promise<CommandResultView>,
  commandId: string,
  options: PollOptions = {},
): Promise<CommandResultView> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const maxErrors = options.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const startedAt = now();
  let attempt = 0;
  let consecutiveErrors = 0;
  let slowNotified = false;

  for (;;) {
    const step = nextPollDelay(attempt, now() - startedAt, options.initialDelayMs);
    if (step.slow && !slowNotified) {
      slowNotified = true;
      options.onSlow?.();
    }
    await sleep(step.delayMs, options.signal);
    if (options.signal?.aborted) {
      throw new PollAbortedError();
    }
    attempt += 1;
    try {
      const view = await getCommand(commandId, options.signal);
      consecutiveErrors = 0;
      options.onAttempt?.(attempt, view);
      if (isTerminal(view)) {
        return view;
      }
    } catch (error) {
      if (options.signal?.aborted || error instanceof PollAbortedError) {
        throw new PollAbortedError();
      }
      consecutiveErrors += 1;
      options.onAttempt?.(attempt, undefined);
      if (consecutiveErrors >= maxErrors) {
        throw new PollGaveUpError(commandId, error);
      }
    }
  }
}
