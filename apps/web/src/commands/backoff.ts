import { COMMAND_POLL_AFTER_MS } from '@seatrelay/contracts';

/**
 * Browser polling schedule for `GET /commands/{id}` (plan §1.3): 300 → 500 → 1000 → 2000 ms
 * (capped), and once 30 s have elapsed since the 202, a slow background cadence of 5 s with a
 * "still processing" hint. Pure: the hook/poller feeds attempt number and elapsed time.
 */

export const POLL_BACKOFF_MS: readonly number[] = [COMMAND_POLL_AFTER_MS, 500, 1000, 2000];
export const POLL_MAX_MS = 2000;
export const POLL_SLOW_AFTER_MS = 30_000;
export const POLL_SLOW_INTERVAL_MS = 5_000;

export interface PollStep {
  /** Wait this long before the next GET. */
  delayMs: number;
  /** The 30 s budget is spent: show the "still processing" hint and poll slowly. */
  slow: boolean;
}

/**
 * @param attempt   number of polls already made (0 before the first GET)
 * @param elapsedMs milliseconds since the 202 was received
 * @param initialMs the `pollAfterMs` hint from the 202 (default 300)
 */
export function nextPollDelay(
  attempt: number,
  elapsedMs: number,
  initialMs: number = COMMAND_POLL_AFTER_MS,
): PollStep {
  if (elapsedMs >= POLL_SLOW_AFTER_MS) {
    return { delayMs: POLL_SLOW_INTERVAL_MS, slow: true };
  }
  if (attempt <= 0) {
    return { delayMs: Math.max(0, initialMs), slow: false };
  }
  const index = Math.min(attempt, POLL_BACKOFF_MS.length - 1);
  return { delayMs: POLL_BACKOFF_MS[index] ?? POLL_MAX_MS, slow: false };
}

/** The first `count` delays as a browser would experience them (elapsed = sum of delays). */
export function pollSchedule(count: number, initialMs: number = COMMAND_POLL_AFTER_MS): PollStep[] {
  const steps: PollStep[] = [];
  let elapsed = 0;
  for (let attempt = 0; attempt < count; attempt += 1) {
    const step = nextPollDelay(attempt, elapsed, initialMs);
    steps.push(step);
    elapsed += step.delayMs;
  }
  return steps;
}
