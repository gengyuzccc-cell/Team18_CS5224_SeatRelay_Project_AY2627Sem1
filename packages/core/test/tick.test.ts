import { describe, expect, it } from 'vitest';
import { decide } from '../src/index';
import {
  at,
  cmd,
  makeCtx,
  makeSnapshot,
  offerOf,
  regOf,
  registerMany,
  run,
  sessionOf,
  step,
} from './helpers';

describe('tick-first expiry', () => {
  it('expires a due offer, relays the seat in the same decision and records the latency', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0)); // hold 600 s -> expires at +10
    const r = run(s, cmd.tick('TIMER'), at(12));
    expect(r.decision.status).toBe('APPLIED');
    expect(r.decision.metrics).toEqual({
      offersCreated: 1,
      offersExpired: 1,
      backfillLatenciesMs: [120_000],
    });
    expect(regOf(r.snapshot, 1)).toBeUndefined(); // only session dropped -> ENDED
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_REGISTRATION')).toMatchObject({
      registration: { seq: 1, status: 'ENDED', endReason: 'NO_ACCEPTABLE_SESSION' },
    });
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_OFFER')).toMatchObject({
      offer: { userId: 'u1', status: 'EXPIRED', settledAt: at(12) },
    });
    expect(offerOf(r.snapshot, 2)).toMatchObject({ sessionId: 'A', expiresAt: at(22) });
    expect(r.decision.backfills).toEqual([
      expect.objectContaining({
        cause: 'EXPIRED',
        releasedAt: at(10),
        reallocatedAt: at(12),
        newUserId: 'u2',
        latencyMs: 120_000,
      }),
    ]);
    expect(r.decision.notifications.map((n) => [n.kind, n.userId])).toEqual([
      ['EXPIRED', 'u1'],
      ['OFFER', 'u2'],
    ]);
    expect(r.snapshot.workshop).toMatchObject({ version: 3, nextDueAt: at(22) });
  });

  it('an expired participant with other acceptable sessions goes back to the queue with the same seq', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    const s = registerMany(s0, [1, 2], ['A', 'B'], at(0)); // u1 holds A, u2 holds B
    const r = run(s, cmd.tick(), at(10));
    // both expire; u1 (seq 1) drops A and keeps B, u2 drops B and keeps A -> both re-offered
    expect(regOf(r.snapshot, 1)).toMatchObject({ seq: 1, status: 'OFFERED', acceptable: ['B'] });
    expect(regOf(r.snapshot, 2)).toMatchObject({ seq: 2, status: 'OFFERED', acceptable: ['A'] });
    expect(r.decision.notifications.map((n) => n.kind)).toEqual([
      'EXPIRED',
      'EXPIRED',
      'OFFER',
      'OFFER',
    ]);
    expect(r.decision.notifications[0]?.body).toMatch(/keep your place/);
  });

  it('a late or duplicate tick is a harmless no-op (no writes, no version bump)', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const early = run(s, cmd.tick('TIMER'), at(5));
    expect(early.decision.status).toBe('APPLIED');
    expect(early.decision.writes).toEqual([]);
    expect(early.snapshot.workshop.version).toBe(1);
    const expired = run(s, cmd.tick('TIMER'), at(10));
    expect(expired.decision.metrics.offersExpired).toBe(1);
    const again = run(expired.snapshot, cmd.tick('TIMER'), at(10));
    expect(again.decision.writes).toEqual([]);
    const reallocate = run(expired.snapshot, cmd.reallocate(), at(11));
    expect(reallocate.decision.writes).toEqual([]);
  });

  it('flags sweepLate only for sweep ticks that actually expired something', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    expect(run(s, cmd.tick('SWEEP'), at(10)).decision.metrics.sweepLate).toBe(true);
    expect(run(s, cmd.tick('SWEEP'), at(5)).decision.metrics.sweepLate).toBeUndefined();
    expect(run(s, cmd.tick('TIMER'), at(10)).decision.metrics.sweepLate).toBeUndefined();
    expect(run(s, cmd.tick(), at(10)).decision.metrics.sweepLate).toBeUndefined();
    expect(run(s, cmd.register(2, ['B']), at(10)).decision.metrics.sweepLate).toBeUndefined();
  });

  it('expires at most `maxExpiriesPerDecision` offers and continues with REALLOCATE', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 3 }, { id: 'B' }] });
    const s = registerMany(s0, [1, 2, 3, 4], ['A'], at(0)); // 3 held, u4 queued
    const first = step(s, cmd.tick(), at(10), { maxExpiriesPerDecision: 2 });
    expect(first.decision.metrics.offersExpired).toBe(2);
    expect(first.decision.continuation).toMatchObject({ type: 'REALLOCATE', workshopId: 'ws1' });
    // two seats released, one relayed to u4: the other release travels with the continuation
    expect(
      first.decision.continuation?.type === 'REALLOCATE' &&
        first.decision.continuation.pendingBackfills?.map((b) => b.cause),
    ).toEqual(['EXPIRED']);
    expect(first.snapshot.offers.filter((o) => o.expiresAt === at(10))).toHaveLength(1);
    // u4 is relayed one of the two released seats already
    expect(offerOf(first.snapshot, 4)).toBeDefined();
    const second = run(first.snapshot, first.decision.continuation!, at(10), {
      maxExpiriesPerDecision: 2,
    });
    expect(second.decision.metrics.offersExpired).toBe(1);
    expect(second.decision.continuation).toBeUndefined();
    expect(second.snapshot.offers.map((o) => o.userId)).toEqual(['u4']);
    // An ACCEPT for a due-but-not-yet-expired offer is still rejected (direct time check).
    const due = first.snapshot.offers.find((o) => o.expiresAt === at(10))!;
    const accept = step(first.snapshot, cmd.accept(due.userId.slice(1), due.id), at(10), {
      maxExpiriesPerDecision: 0,
    });
    expect(accept.decision).toMatchObject({ status: 'REJECTED', reason: 'OFFER_EXPIRED' });
  });

  it('releases the seat of a dangling offer without a registration (corrupted snapshot)', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const crafted = structuredClone(s);
    crafted.registrations = [];
    const r = step(crafted, cmd.tick(), at(10));
    expect(r.decision.metrics.offersExpired).toBe(1);
    expect(r.decision.notifications).toEqual([]);
    expect(sessionOf(r.snapshot, 'A').held).toBe(0);
  });
});

describe('cut-off handling (R4)', () => {
  it('ends QUEUED registrations whose sessions all passed cut-off and stops offering those sessions', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', startsInMinutes: 40 }, // cut-off +10
        { id: 'B', startsInMinutes: 60 }, // cut-off +30
      ],
    });
    let s = registerMany(s0, [1, 2, 3], ['A'], at(0)); // u1 holds A (expires +10 = cut-off), u2/u3 queued
    s = registerMany(s, [4], ['A', 'B'], at(0)); // u4 holds B
    s = run(s, cmd.accept(4, offerOf(s, 4)!.id), at(1)).snapshot; // u4 confirmed in B
    s = registerMany(s, [5], ['B', 'A'], at(1)); // u5 queued (B full, A held)
    expect(s.workshop.nextDueAt).toBe(at(10));

    const r = run(s, cmd.tick('SWEEP'), at(10));
    // u1's offer expires exactly at cut-off; A can no longer be offered to anyone.
    expect(r.decision.metrics).toEqual({
      offersExpired: 1,
      offersCreated: 0,
      backfillLatenciesMs: [],
      sweepLate: true,
    });
    expect(regOf(r.snapshot, 1)).toBeUndefined();
    expect(regOf(r.snapshot, 2)).toBeUndefined();
    expect(regOf(r.snapshot, 3)).toBeUndefined();
    expect(r.decision.writes.filter((w) => w.kind === 'ARCHIVE_REGISTRATION')).toEqual([
      expect.objectContaining({
        registration: expect.objectContaining({ seq: 1, endReason: 'NO_ACCEPTABLE_SESSION' }),
      }),
      expect.objectContaining({
        registration: expect.objectContaining({ seq: 2, endReason: 'CUTOFF' }),
      }),
      expect.objectContaining({
        registration: expect.objectContaining({ seq: 3, endReason: 'CUTOFF' }),
      }),
    ]);
    expect(r.decision.notifications.map((n) => [n.kind, n.userId])).toEqual([
      ['EXPIRED', 'u1'],
      ['ENDED', 'u2'],
      ['ENDED', 'u3'],
    ]);
    // u5 still waits for B (cut-off +30); the A release found no taker.
    expect(regOf(r.snapshot, 5)).toMatchObject({ status: 'QUEUED', acceptable: ['B', 'A'] });
    expect(r.decision.backfills.map((b) => [b.cause, b.reallocatedAt])).toEqual([
      ['EXPIRED', undefined],
    ]);
    expect(r.snapshot.workshop.nextDueAt).toBe(at(30));
  });

  it('nextDueAt tracks the nearest pending expiry or demanded cut-off, and is rewritten when a cut-off passes', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', startsInMinutes: 60 }, // cut-off +30
        { id: 'B', startsInMinutes: 120 }, // cut-off +90
      ],
    });
    // nothing pending
    expect(run(s0, cmd.tick(), at(0)).snapshot.workshop.nextDueAt).toBeUndefined();
    // u1 holds A: nextDueAt = offer expiry (+10)
    const s1 = registerMany(s0, [1], ['A', 'B'], at(0));
    expect(s1.workshop.nextDueAt).toBe(at(10));
    // u1 confirmed: no pending expiry, no queued demand -> undefined
    const s2 = run(s1, cmd.accept(1, offerOf(s1, 1)!.id), at(1)).snapshot;
    expect(s2.workshop.nextDueAt).toBeUndefined();
    // u2 queued for A then B (both full? B free -> gets B); make B full first
    const s3 = registerMany(s2, [2], ['B'], at(2)); // u2 holds B until +12
    const s4 = run(s3, cmd.accept(2, offerOf(s3, 2)!.id), at(3)).snapshot;
    expect(s4.workshop.nextDueAt).toBeUndefined();
    const s5 = registerMany(s4, [3], ['A', 'B'], at(4)); // queued: demand on A (+30) and B (+90)
    expect(s5.workshop.nextDueAt).toBe(at(30));
    // At +30 the A cut-off passes; u3 still waits for B, so only nextDueAt changes -> META is written.
    const r = run(s5, cmd.tick('SWEEP'), at(30));
    expect(r.decision.writes).toEqual([
      expect.objectContaining({
        kind: 'PUT_WORKSHOP_STATE',
        nextDueAt: at(90),
        version: s5.workshop.version + 1,
      }),
    ]);
    expect(r.decision.metrics.sweepLate).toBeUndefined();
    // At +90 u3 is ended with CUTOFF and nothing is pending any more.
    const end = run(r.snapshot, cmd.tick('SWEEP'), at(90));
    expect(regOf(end.snapshot, 3)).toBeUndefined();
    expect(end.snapshot.workshop.nextDueAt).toBeUndefined();
  });

  it('the no-starvation invariant holds after every decision even with a late tick', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    const s = registerMany(s0, [1, 2, 3], ['A', 'B'], at(0));
    const d = decide(s, cmd.register(4, ['A']), makeCtx(at(60)));
    expect(d.metrics.offersExpired).toBe(2);
    expect(d.metrics.offersCreated).toBe(2);
    expect(d.status).toBe('APPLIED');
  });
});
