import { addMs, parseIso, toIso } from '@seatrelay/core';
import type { Clock } from '../ports';

/** Wall clock for production adapters. */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** Deterministic clock for tests: `set()` or `advance()` it explicitly. */
export class ManualClock implements Clock {
  private current: string;

  constructor(start = '2026-11-03T06:00:00.000Z') {
    this.current = toIso(parseIso(start));
  }

  now(): string {
    return this.current;
  }

  set(iso: string): void {
    this.current = toIso(parseIso(iso));
  }

  advance(ms: number): string {
    this.current = addMs(this.current, ms);
    return this.current;
  }

  advanceSeconds(seconds: number): string {
    return this.advance(seconds * 1000);
  }
}
