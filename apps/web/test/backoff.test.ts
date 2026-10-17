import { describe, expect, it } from 'vitest';
import {
  nextPollDelay,
  POLL_SLOW_AFTER_MS,
  POLL_SLOW_INTERVAL_MS,
  pollSchedule,
} from '../src/commands/backoff';

describe('polling backoff schedule (plan §1.3)', () => {
  it('starts at 300 ms and backs off 300 → 500 → 1000 → 2000, then stays capped at 2000', () => {
    const delays = pollSchedule(8).map((step) => step.delayMs);
    expect(delays).toEqual([300, 500, 1000, 2000, 2000, 2000, 2000, 2000]);
  });

  it('honours the 202 pollAfterMs hint for the first poll only', () => {
    const delays = pollSchedule(4, 150).map((step) => step.delayMs);
    expect(delays).toEqual([150, 500, 1000, 2000]);
    expect(nextPollDelay(0, 0, -5).delayMs).toBe(0);
  });

  it('drops to 5 s with the slow hint once 30 s have elapsed, and never before', () => {
    const steps = pollSchedule(40);
    let elapsed = 0;
    let firstSlow = -1;
    steps.forEach((step, index) => {
      if (elapsed < POLL_SLOW_AFTER_MS) {
        expect(step.slow).toBe(false);
        expect(step.delayMs).toBeLessThanOrEqual(2000);
      } else {
        expect(step.slow).toBe(true);
        expect(step.delayMs).toBe(POLL_SLOW_INTERVAL_MS);
        if (firstSlow < 0) {
          firstSlow = index;
        }
      }
      elapsed += step.delayMs;
    });
    // 300 + 500 + 1000 = 1800 ms, then 15 × 2000 ms = 31 800 ms ≥ 30 s → the 19th poll is slow.
    expect(firstSlow).toBe(18);
    expect(steps.slice(firstSlow).every((step) => step.delayMs === 5000 && step.slow)).toBe(true);
  });

  it('is monotonic non-decreasing within the fast phase', () => {
    const delays = pollSchedule(18).map((step) => step.delayMs);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
    }
  });

  it('switches to the slow cadence purely on elapsed time, whatever the attempt number', () => {
    expect(nextPollDelay(0, POLL_SLOW_AFTER_MS)).toEqual({ delayMs: 5000, slow: true });
    expect(nextPollDelay(100, POLL_SLOW_AFTER_MS - 1)).toEqual({ delayMs: 2000, slow: false });
  });
});
