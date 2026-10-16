import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  addMs,
  addSeconds,
  compareIso,
  diffMs,
  isAtOrAfter,
  isBefore,
  maxIso,
  minIso,
  parseIso,
  toIso,
} from '../src/time';

const T = '2026-11-03T06:00:00.000Z';

describe('time helpers', () => {
  it('round-trips ISO strings with millisecond precision', () => {
    expect(toIso(parseIso(T))).toBe(T);
    expect(addMs(T, 1)).toBe('2026-11-03T06:00:00.001Z');
    expect(addSeconds(T, 90)).toBe('2026-11-03T06:01:30.000Z');
    expect(addMinutes(T, -30)).toBe('2026-11-03T05:30:00.000Z');
  });

  it('compares and picks min / max', () => {
    const later = addSeconds(T, 1);
    expect(compareIso(T, later)).toBeLessThan(0);
    expect(compareIso(later, T)).toBeGreaterThan(0);
    expect(compareIso(T, T)).toBe(0);
    expect(minIso(T, later)).toBe(T);
    expect(minIso(later, T)).toBe(T);
    expect(maxIso(T, later)).toBe(later);
    expect(maxIso(later, T)).toBe(later);
    expect(isBefore(T, later)).toBe(true);
    expect(isBefore(later, T)).toBe(false);
    expect(isAtOrAfter(T, T)).toBe(true);
    expect(isAtOrAfter(T, later)).toBe(false);
    expect(diffMs(later, T)).toBe(1000);
  });

  it('rejects invalid timestamps', () => {
    expect(() => parseIso('nope')).toThrow(/Invalid ISO timestamp/);
  });
});
