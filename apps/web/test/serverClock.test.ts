import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeRegistration } from '../src/commands/copy';
import {
  MAX_SAMPLE_RTT_MS,
  RESAMPLE_AFTER_MS,
  serverClock,
  ServerClock,
  syncServerClock,
} from '../src/util/serverClock';
import { msUntil } from '../src/util/time';
import { S1, sessions, summary } from './fixtures';

const T = Date.UTC(2026, 10, 3, 6, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe('ServerClock (plan §1.4: times follow the server clock)', () => {
  it('estimates the offset from the midpoint of the request', () => {
    let local = T;
    const clock = new ServerClock(() => local);
    // Browser 2 min fast: the server read T − 120 s + 50 ms while the request was in flight.
    expect(clock.observe(iso(T - 120_000 + 50), T, T + 100)).toBe(true);
    expect(clock.offsetMs).toBe(-120_000);
    local = T + 1_000;
    expect(clock.now()).toBe(T + 1_000 - 120_000);
  });

  it('keeps the sample with the smallest round trip and ignores unusable ones', () => {
    const clock = new ServerClock(() => T);
    clock.observe(iso(T + 5_000), T, T + 400);
    expect(clock.offsetMs).toBe(4_800);
    expect(clock.observe(iso(T + 9_000), T, T + 800)).toBe(false);
    expect(clock.observe(iso(T + 5_000), T, T + 100)).toBe(true);
    expect(clock.offsetMs).toBe(4_950);
    expect(clock.observe('not a date', T, T + 10)).toBe(false);
    expect(clock.observe(iso(T), T, T - 1)).toBe(false);
    expect(clock.observe(iso(T), T, T + MAX_SAMPLE_RTT_MS + 1)).toBe(false);
  });

  it('replaces an outdated sample even when the new round trip is slower', () => {
    const clock = new ServerClock(() => T);
    clock.observe(iso(T + 1_000), T, T + 10);
    const later = T + RESAMPLE_AFTER_MS + 1;
    expect(clock.observe(iso(later + 2_000), later, later + 500)).toBe(true);
    expect(clock.offsetMs).toBe(1_750);
  });

  it('syncs from GET /health', async () => {
    let local = T;
    const clock = new ServerClock(() => local);
    const synced = await syncServerClock(
      async () => {
        local += 200;
        return iso(T + 60_000);
      },
      clock,
      () => local,
    );
    expect(synced).toBe(true);
    expect(clock.offsetMs).toBe(59_900);
  });
});

describe('offer countdown with a skewed browser clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down on the server clock, not "expired" because the browser runs fast', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 120_000); // browser 2 min fast
    serverClock.observe(iso(T + 50), T + 120_000, T + 120_100);
    const expiresAt = iso(T + 60_000); // offer valid for 60 s on the server
    expect(msUntil(expiresAt)).toBe(60_000);
    const offered = summary({
      status: 'OFFERED',
      queuePosition: undefined,
      currentOffer: { id: 'offer-1', sessionId: S1, expiresAt },
    });
    expect(describeRegistration(offered, sessions)).toBe(
      'A seat in Session 1 is held for you — confirm within 01:00.',
    );
  });
});
