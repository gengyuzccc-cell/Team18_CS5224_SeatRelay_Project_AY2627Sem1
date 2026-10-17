import { describe, expect, it } from 'vitest';
import { DEFAULT_DECISION_LIMITS, MAX_OFFERS_PER_DECISION } from '../src/index';
import { at, cmd, makeSnapshot, offerOf, regOf, registerMany, run, step } from './helpers';

describe('allocate', () => {
  it('creates at most 12 offers per decision and continues with REALLOCATE', () => {
    expect(MAX_OFFERS_PER_DECISION).toBe(12);
    expect(DEFAULT_DECISION_LIMITS.maxOffersPerDecision).toBe(12);
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', capacity: 1 },
        { id: 'B', capacity: 1 },
      ],
    });
    const users = Array.from({ length: 16 }, (_, i) => i + 1);
    const s = registerMany(s0, users, ['A'], at(0)); // u1 holds, 15 queued
    const first = step(s, cmd.setCapacity('A', 30), at(1));
    expect(first.decision.status).toBe('APPLIED');
    expect(first.decision.metrics.offersCreated).toBe(12);
    expect(first.decision.timers).toHaveLength(12);
    // 30 − 1 = 29 seats added, 12 taken: the continuation carries the remaining 17.
    expect(first.decision.continuation).toEqual({
      type: 'REALLOCATE',
      workshopId: 'ws1',
      pendingCapacityUp: [{ sessionId: 'A', seats: 17 }],
    });
    expect(first.decision.backfills.filter((b) => b.cause === 'CAPACITY_UP')).toHaveLength(12);
    expect(
      first.snapshot.registrations.filter((r) => r.status === 'QUEUED').map((r) => r.seq),
    ).toEqual([14, 15, 16]);
    const second = run(first.snapshot, first.decision.continuation!, at(1));
    expect(second.decision.metrics.offersCreated).toBe(3);
    expect(second.decision.continuation).toBeUndefined();
    expect(second.decision.backfills.filter((b) => b.cause === 'CAPACITY_UP')).toHaveLength(3);
    expect(second.snapshot.offers).toHaveLength(16);
    // the continuation is an internal command: it does not bump the version when idle
    const idle = run(second.snapshot, cmd.reallocate(), at(2));
    expect(idle.decision.writes).toEqual([]);
  });

  it('honours the caller-provided limits', () => {
    const s = registerMany(
      makeSnapshot({ sessions: [{ id: 'A', capacity: 5 }, { id: 'B' }] }),
      [1, 2, 3, 4, 5],
      ['A'],
      at(0),
    );
    expect(s.offers).toHaveLength(5);
    const limited = step(
      makeSnapshot({ sessions: [{ id: 'A', capacity: 5 }, { id: 'B' }] }),
      cmd.register(1, ['A']),
      at(0),
      {
        maxOffersPerDecision: 0,
      },
    );
    expect(limited.decision.metrics.offersCreated).toBe(0);
    expect(limited.decision.continuation).toBeDefined();
  });

  it('offers the first allocatable session in the participant preference order', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] });
    const r = run(s0, cmd.register(1, ['C', 'B', 'A']), at(0));
    expect(offerOf(r.snapshot, 1)?.sessionId).toBe('C');
    const r2 = run(r.snapshot, cmd.register(2, ['C', 'B', 'A']), at(0));
    expect(offerOf(r2.snapshot, 2)?.sessionId).toBe('B');
    const r3 = run(r2.snapshot, cmd.register(3, ['C', 'B']), at(0));
    expect(r3.decision.resultForCommand?.registration?.status).toBe('QUEUED');
  });

  it('relays released seats FIFO by release time and leaves surplus records pending', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 2 }, { id: 'B' }] });
    const s = registerMany(s0, [1, 2], ['A'], at(0)); // both hold A
    const s2 = run(s, cmd.register(3, ['A']), at(1)).snapshot; // queued
    const r = run(s2, cmd.tick(), at(10)); // both offers expire; one relayed to u3
    expect(r.decision.backfills.map((b) => [b.cause, b.newUserId])).toEqual([
      ['EXPIRED', 'u3'],
      ['EXPIRED', undefined],
    ]);
    expect(r.decision.metrics.backfillLatenciesMs).toEqual([0]);
  });

  it('keeps unrelayed releases pending in the live snapshot so later offers are still attributed', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', capacity: 3 },
        { id: 'B', capacity: 1 },
      ],
    });
    let s = registerMany(s0, [1, 2, 3], ['A'], at(0)); // all hold A
    s = registerMany(s, [4], ['B'], at(0)); // holds B
    s = registerMany(s, [5, 6, 7], ['A', 'B'], at(1)); // queued
    // Only one offer per decision: the first decision expires 3 A offers (+1 B) and relays one.
    const first = step(s, cmd.tick(), at(10), { maxOffersPerDecision: 1 });
    expect(first.decision.metrics.offersExpired).toBe(4);
    expect(first.decision.metrics.offersCreated).toBe(1);
    expect(first.decision.backfills.filter((b) => b.reallocatedAt !== undefined)).toHaveLength(1);
    expect(first.decision.continuation).toEqual({ type: 'REALLOCATE', workshopId: 'ws1' });
    // the three releases without a taker yet are live pending items, oldest first
    expect(first.decision.writes.filter((w) => w.kind === 'PUT_PENDING_BACKFILL')).toHaveLength(3);
    expect(first.snapshot.pendingBackfills.map((b) => b.sessionId)).toEqual(['A', 'A', 'B']);

    const second = step(first.snapshot, first.decision.continuation!, at(10), {
      maxOffersPerDecision: 1,
    });
    // The record filled here is one carried by the snapshot, moved to history with its latency.
    expect(second.decision.backfills).toEqual([
      expect.objectContaining({ cause: 'EXPIRED', newUserId: 'u6', latencyMs: 0 }),
    ]);
    expect(second.decision.writes.filter((w) => w.kind === 'ARCHIVE_BACKFILL')).toHaveLength(1);
    expect(second.snapshot.pendingBackfills).toHaveLength(2);
    expect(second.decision.continuation?.type).toBe('REALLOCATE');
    const third = run(first.snapshot, first.decision.continuation!, at(10), {
      maxOffersPerDecision: 1,
    });
    expect(third.decisions.length).toBeGreaterThan(1);
    expect(third.snapshot.offers.map((o) => o.userId).sort()).toEqual(['u5', 'u6', 'u7']);
    expect(third.snapshot.pendingBackfills).toEqual([]);
    // every release that found a taker is attributed exactly once
    const relayed = [first.decision, ...third.decisions]
      .flatMap((d) => d.backfills)
      .filter((b) => b.newUserId !== undefined);
    expect(relayed.map((b) => b.newUserId).sort()).toEqual(['u5', 'u6', 'u7']);
    // a stale REALLOCATE afterwards changes nothing
    expect(run(third.snapshot, cmd.reallocate(), at(11)).decision.writes).toEqual([]);
  });

  it('attributes a pending release to whichever decision relays the seat, not only the continuation', () => {
    // A seat released while the offer cap is hit; a user command (already queued in the FIFO)
    // runs before the REALLOCATE and takes the seat: the record is still filled.
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 2 }, { id: 'B' }] });
    let s = registerMany(s0, [1, 2], ['A'], at(0)); // both hold A until +10
    s = registerMany(s, [3, 4], ['A'], at(1)); // queued
    const first = step(s, cmd.tick(), at(10), { maxOffersPerDecision: 1 }); // 2 expire, u3 relayed
    expect(first.snapshot.pendingBackfills).toHaveLength(1);
    expect(first.decision.continuation).toBeDefined();
    // a REGISTER that was already in the FIFO runs first: u4 (ahead by seq) takes the seat
    const late = step(first.snapshot, cmd.register(5, ['A']), at(10), { maxOffersPerDecision: 1 });
    expect(offerOf(late.snapshot, 4)).toBeDefined();
    expect(regOf(late.snapshot, 5)?.status).toBe('QUEUED');
    expect(late.decision.backfills).toEqual([
      expect.objectContaining({ cause: 'EXPIRED', newUserId: 'u4', latencyMs: 0 }),
    ]);
    expect(late.decision.metrics.backfillLatenciesMs).toEqual([0]);
    expect(late.decision.writes.filter((w) => w.kind === 'ARCHIVE_BACKFILL')).toHaveLength(1);
    expect(late.snapshot.pendingBackfills).toEqual([]);
    const reallocate = run(late.snapshot, first.decision.continuation!, at(10));
    expect(reallocate.decision.writes).toEqual([]);
  });

  it('closes a pending release once no continuation is pending, and never relays it to a session that closed', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 2 }, { id: 'B' }] });
    let s = registerMany(s0, [1, 2], ['A'], at(0));
    s = registerMany(s, [3, 4], ['A'], at(1));
    const first = step(s, cmd.tick(), at(10), { maxOffersPerDecision: 1 });
    expect(first.snapshot.pendingBackfills).toHaveLength(1);
    // the session is cancelled before the continuation runs: the record is closed unrelayed
    const cancelled = run(first.snapshot, cmd.cancelSession('A'), at(10));
    expect(cancelled.decision.writes.filter((w) => w.kind === 'ARCHIVE_BACKFILL')).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ cause: 'EXPIRED', sessionId: 'A' }),
      }),
    ]);
    expect(cancelled.decision.backfills[0]?.reallocatedAt).toBeUndefined();
    expect(cancelled.snapshot.pendingBackfills).toEqual([]);
  });
});
