import { describe, expect, it } from 'vitest';
import { checkInvariants, estimateCommitItems } from '../src/index';
import {
  at,
  cmd,
  expectHardInvariants,
  makeSnapshot,
  offerOf,
  regOf,
  registerMany,
  run,
  sessionOf,
  step,
  writesOfKind,
} from './helpers';

describe('SET_CAPACITY (R7)', () => {
  it('rejects unknown, cancelled, invalid and over-used capacities', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const confirmed = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot;
    const raised = run(confirmed, cmd.setCapacity('A', 2), at(2)).snapshot; // u2 now holds
    expect(sessionOf(raised, 'A')).toMatchObject({ capacity: 2, confirmed: 1, held: 1 });

    expect(run(raised, cmd.setCapacity('Z', 2), at(3)).decision.reason).toBe('SESSION_NOT_FOUND');
    expect(run(raised, cmd.setCapacity('A', 0), at(3)).decision.reason).toBe('INVALID_CAPACITY');
    expect(run(raised, cmd.setCapacity('A', 1), at(3)).decision.reason).toBe(
      'CAPACITY_BELOW_USAGE',
    );
    const noB = run(raised, cmd.cancelSession('B'), at(3)).snapshot;
    expect(run(noB, cmd.setCapacity('B', 5), at(4)).decision.reason).toBe('SESSION_CANCELLED');
    // lowering to exactly the usage is allowed
    expect(run(raised, cmd.setCapacity('A', 2), at(3)).decision.status).toBe('APPLIED');
  });

  it('raising capacity allocates immediately; CAPACITY_UP is recorded only for seats actually taken', () => {
    const s = registerMany(makeSnapshot(), [1, 2, 3], ['A'], at(0)); // u1 holds, u2/u3 queued
    const r = run(s, cmd.setCapacity('A', 10), at(5));
    expect(r.decision.status).toBe('APPLIED');
    expect(r.decision.resultForCommand).toEqual({ offersCreated: 2 });
    expect(offerOf(r.snapshot, 2)).toBeDefined();
    expect(offerOf(r.snapshot, 3)).toBeDefined();
    expect(r.decision.backfills.map((b) => [b.cause, b.newUserId, b.latencyMs])).toEqual([
      ['CAPACITY_UP', 'u2', 0],
      ['CAPACITY_UP', 'u3', 0],
    ]);
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({ capacity: 10, held: 3 });

    // Raising with an empty queue creates no backfill record at all.
    const quiet = run(r.snapshot, cmd.setCapacity('A', 12), at(6));
    expect(quiet.decision.backfills).toEqual([]);
    expect(quiet.decision.metrics.offersCreated).toBe(0);
    expect(writesOfKind(quiet.decision, 'PUT_SESSION')).toBe(1);
  });

  it('pending releases are relayed before CAPACITY_UP seats', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const expiredAndRaised = run(s, cmd.setCapacity('A', 2), at(10)); // u1's offer expired at +10
    expect(expiredAndRaised.decision.metrics.offersExpired).toBe(1);
    expect(expiredAndRaised.decision.backfills.map((b) => [b.cause, b.newUserId])).toEqual([
      ['EXPIRED', 'u2'],
    ]);
  });
});

describe('CANCEL_SESSION', () => {
  it('revokes offers, re-queues confirmed participants (keeping seq) and drops the session everywhere', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', capacity: 2 },
        { id: 'B', capacity: 1 },
      ],
    });
    let s = registerMany(s0, [1, 2], ['A', 'B'], at(0)); // u1, u2 hold A
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot; // u1 confirmed in A
    s = registerMany(s, [3], ['B', 'A'], at(2)); // u3 holds B
    s = registerMany(s, [4, 5], ['A'], at(3)); // u4, u5 queued for A only
    s = registerMany(s, [6], ['A', 'B'], at(3)); // u6 queued for A then B

    const r = run(s, cmd.cancelSession('A'), at(4));
    expect(r.decision.status).toBe('APPLIED');
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({
      status: 'CANCELLED',
      held: 0,
      confirmed: 0,
    });
    // u2's offer revoked -> back to QUEUED for B with seq 2
    expect(regOf(r.snapshot, 2)).toMatchObject({ status: 'QUEUED', seq: 2, acceptable: ['B'] });
    // u1 confirmed -> QUEUED for B with seq 1, confirmedSessionId cleared
    expect(regOf(r.snapshot, 1)).toMatchObject({ status: 'QUEUED', seq: 1, acceptable: ['B'] });
    expect(regOf(r.snapshot, 1)?.confirmedSessionId).toBeUndefined();
    // u3 keeps the B hold, A removed from its fallback list silently
    expect(regOf(r.snapshot, 3)).toMatchObject({ status: 'OFFERED', acceptable: ['B'] });
    // u4, u5 had only A -> ENDED(NO_ACCEPTABLE_SESSION); u6 -> QUEUED for B
    expect(regOf(r.snapshot, 4)).toBeUndefined();
    expect(regOf(r.snapshot, 5)).toBeUndefined();
    expect(regOf(r.snapshot, 6)).toMatchObject({ status: 'QUEUED', acceptable: ['B'] });
    expect(r.decision.writes.filter((w) => w.kind === 'ARCHIVE_REGISTRATION')).toEqual([
      expect.objectContaining({
        registration: expect.objectContaining({
          seq: 4,
          status: 'ENDED',
          endReason: 'NO_ACCEPTABLE_SESSION',
        }),
      }),
      expect.objectContaining({
        registration: expect.objectContaining({
          seq: 5,
          status: 'ENDED',
          endReason: 'NO_ACCEPTABLE_SESSION',
        }),
      }),
    ]);
    expect(r.decision.notifications.map((n) => [n.kind, n.userId])).toEqual([
      ['REVOKED', 'u2'],
      ['SESSION_CANCELLED', 'u1'],
      ['SESSION_CANCELLED', 'u4'],
      ['SESSION_CANCELLED', 'u5'],
      ['SESSION_CANCELLED', 'u6'],
    ]);
    // one SESSION_CANCELLED backfill record per released seat (held + confirmed), never relayed
    expect(r.decision.backfills.map((b) => [b.cause, b.reallocatedAt])).toEqual([
      ['SESSION_CANCELLED', undefined],
      ['SESSION_CANCELLED', undefined],
    ]);
    expect(r.snapshot.workshop.nextDueAt).toBe(offerOf(r.snapshot, 3)?.expiresAt);
  });

  it('rejects SESSION_NOT_FOUND and SESSION_CANCELLED', () => {
    const s = makeSnapshot();
    expect(run(s, cmd.cancelSession('Z'), at(0)).decision.reason).toBe('SESSION_NOT_FOUND');
    const once = run(s, cmd.cancelSession('A'), at(0)).snapshot;
    expect(run(once, cmd.cancelSession('A'), at(1)).decision.reason).toBe('SESSION_CANCELLED');
    expect(run(once, cmd.setCapacity('A', 9), at(1)).decision.reason).toBe('SESSION_CANCELLED');
  });

  it('drains a big session in budget-sized steps: CANCELLING until nothing references it', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', capacity: 10 },
        { id: 'B', capacity: 2 },
      ],
    });
    let s = registerMany(s0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ['A', 'B'], at(0)); // 10 hold A
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot; // u1 confirmed in A
    s = registerMany(s, [11, 12, 13, 14], ['A'], at(2)); // queued for A only
    const limits = { maxItemsPerDecision: 30 };

    const first = step(s, cmd.cancelSession('A'), at(3), limits);
    expect(first.decision.status).toBe('APPLIED');
    expect(first.decision.continuation).toEqual({ type: 'REALLOCATE', workshopId: 'ws1' });
    expect(sessionOf(first.snapshot, 'A').status).toBe('CANCELLING');
    expect(first.snapshot.workshop.nextDueAt).toBe(at(3)); // now: the sweep can finish the drain
    const revoked = first.decision.writes.filter((w) => w.kind === 'ARCHIVE_OFFER');
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked.length).toBeLessThan(9);
    expect(estimateCommitItems(first.decision)).toBeLessThanOrEqual(30);
    // every unit is complete: no live registration references an archived offer
    expectHardInvariants(first.snapshot, at(3));
    // a user command on the cancelling session is rejected meanwhile; others still work
    const stillHeld = first.snapshot.offers.find((o) => o.sessionId === 'A')!;
    expect(
      step(
        first.snapshot,
        cmd.accept(Number(stillHeld.userId.slice(1)), stillHeld.id),
        at(3),
        limits,
      ).decision.reason,
    ).toBe('SESSION_CANCELLED');
    expect(
      step(first.snapshot, cmd.register(20, ['A', 'B']), at(3), limits).decision.resultForCommand
        ?.registration?.acceptable,
    ).toEqual(['B']);

    const done = run(first.snapshot, first.decision.continuation!, at(3), limits);
    expect(done.decisions.length).toBeGreaterThan(1);
    for (const decision of done.decisions) {
      expect(estimateCommitItems(decision)).toBeLessThanOrEqual(30);
    }
    expect(sessionOf(done.snapshot, 'A')).toMatchObject({
      status: 'CANCELLED',
      held: 0,
      confirmed: 0,
    });
    expect(done.snapshot.registrations.every((r) => !r.acceptable.includes('A'))).toBe(true);
    // the two B seats were relayed to the first two displaced participants (seq order)
    expect(done.snapshot.offers.map((o) => [o.userId, o.sessionId]).sort()).toEqual([
      ['u1', 'B'],
      ['u2', 'B'],
    ]);
    expect(done.snapshot.registrations.filter((r) => r.status === 'QUEUED')).toHaveLength(8);
    expect(regOf(done.snapshot, 11)).toBeUndefined(); // A only: ENDED(NO_ACCEPTABLE_SESSION)
    expect(done.snapshot.workshop.nextDueAt).toBe(offerOf(done.snapshot, 1)?.expiresAt);
  });

  it('revokes dangling offers of a cancelled session (corrupted snapshot)', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const crafted = structuredClone(s);
    crafted.registrations = [];
    const r = step(crafted, cmd.cancelSession('A'), at(1));
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_OFFER')).toMatchObject({
      offer: { status: 'REVOKED' },
    });
    expect(r.decision.notifications).toEqual([]);
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({ status: 'CANCELLED', held: 0 });
  });

  it('even the final status flip of an empty session waits for the budget', () => {
    const first = step(makeSnapshot(), cmd.cancelSession('A'), at(0), { maxItemsPerDecision: 2 });
    expect(sessionOf(first.snapshot, 'A').status).toBe('CANCELLING');
    expect(first.decision.continuation).toBeDefined();
    const done = run(first.snapshot, cmd.reallocate(), at(0));
    expect(sessionOf(done.snapshot, 'A').status).toBe('CANCELLED');
  });

  it('a session cancelled while another drain is pending: the displaced participant ends with NO_ACCEPTABLE_SESSION', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    const s = registerMany(s0, [1], ['A', 'B'], at(0)); // holds A, fallback B
    const limits = { maxItemsPerDecision: 4 }; // nothing but the status flip fits
    const a = step(s, cmd.cancelSession('A'), at(1), limits);
    const b = step(a.snapshot, cmd.cancelSession('B'), at(1), limits);
    expect(b.snapshot.sessions.map((x) => x.status)).toEqual(['CANCELLING', 'CANCELLING']);
    expect(regOf(b.snapshot, 1)?.status).toBe('OFFERED'); // untouched so far
    const done = run(b.snapshot, cmd.reallocate(), at(1));
    expect(done.snapshot.sessions.map((x) => x.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(regOf(done.snapshot, 1)).toBeUndefined();
    expect(
      done.decisions.flatMap((d) => d.writes.filter((w) => w.kind === 'ARCHIVE_REGISTRATION')),
    ).toMatchObject([
      { registration: { seq: 1, status: 'ENDED', endReason: 'NO_ACCEPTABLE_SESSION' } },
    ]);
  });

  it('displaced participants are re-allocated in the same decision when another session is free', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    const s = registerMany(s0, [1], ['A', 'B'], at(0));
    const r = run(s, cmd.cancelSession('A'), at(1));
    expect(offerOf(r.snapshot, 1)?.sessionId).toBe('B');
    expect(r.decision.notifications.map((n) => n.kind)).toEqual(['REVOKED', 'OFFER']);
  });
});

describe('CANCEL_WORKSHOP', () => {
  it('ends every registration, revokes offers, cancels sessions and notifies each user once', () => {
    const s0 = makeSnapshot({ mode: 'PER_SESSION', sessions: [{ id: 'A' }, { id: 'B' }] });
    let s = registerMany(s0, [1], ['A'], at(0));
    s = registerMany(s, [1], ['B'], at(0)); // same user, second session (PER_SESSION)
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot;
    s = registerMany(s, [2], ['A'], at(2)); // queued behind u1 in A
    const r = run(s, cmd.cancelWorkshop(), at(3));
    expect(r.decision.status).toBe('APPLIED');
    expect(r.snapshot.workshop.status).toBe('CANCELLED');
    expect(r.snapshot.workshop.nextDueAt).toBeUndefined();
    expect(r.snapshot.registrations).toEqual([]);
    expect(r.snapshot.offers).toEqual([]);
    expect(r.snapshot.sessions.map((x) => [x.status, x.held, x.confirmed])).toEqual([
      ['CANCELLED', 0, 0],
      ['CANCELLED', 0, 0],
    ]);
    expect(r.decision.writes.filter((w) => w.kind === 'ARCHIVE_REGISTRATION')).toHaveLength(3);
    expect(
      r.decision.writes
        .filter((w) => w.kind === 'ARCHIVE_REGISTRATION')
        .map((w) => (w.kind === 'ARCHIVE_REGISTRATION' ? w.registration.endReason : undefined)),
    ).toEqual(['WORKSHOP_CANCELLED', 'WORKSHOP_CANCELLED', 'WORKSHOP_CANCELLED']);
    expect(r.decision.writes.filter((w) => w.kind === 'ARCHIVE_OFFER')).toHaveLength(1);
    expect(r.decision.notifications.map((n) => [n.kind, n.userId])).toEqual([
      ['WORKSHOP_CANCELLED', 'u1'],
      ['WORKSHOP_CANCELLED', 'u2'],
    ]);
    expect(r.decision.backfills).toEqual([]);
    expect(r.decisions).toHaveLength(1); // small enough for one commit
    // already-cancelled sessions are left alone
    const partly = run(makeSnapshot(), cmd.cancelSession('A'), at(0)).snapshot;
    const r2 = run(partly, cmd.cancelWorkshop(), at(1));
    expect(writesOfKind(r2.decision, 'PUT_SESSION')).toBe(1);
  });

  it('drains a big workshop in budget-sized steps: CANCELLING until everything is archived', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', capacity: 5 },
        { id: 'B', capacity: 5 },
      ],
    });
    const users = Array.from({ length: 45 }, (_, i) => i + 1);
    let s = registerMany(s0, users, ['A', 'B'], at(0)); // 10 hold, 35 queued
    for (const n of [1, 2, 3]) {
      s = run(s, cmd.accept(n, offerOf(s, n)!.id), at(1)).snapshot;
    }
    const first = step(s, cmd.cancelWorkshop(), at(2));
    expect(first.decision.status).toBe('APPLIED');
    expect(first.decision.resultForCommand).toEqual({ offersCreated: 0 });
    expect(first.snapshot.workshop.status).toBe('CANCELLING');
    expect(first.snapshot.workshop.nextDueAt).toBe(at(2));
    expect(estimateCommitItems(first.decision)).toBeLessThanOrEqual(90);
    expect(first.decision.continuation).toEqual({ type: 'REALLOCATE', workshopId: 'ws1' });
    // archived in seq order; held/confirmed counters follow the archived registrations
    const archivedSeqs = first.decision.writes
      .filter((w) => w.kind === 'ARCHIVE_REGISTRATION')
      .map((w) => (w.kind === 'ARCHIVE_REGISTRATION' ? w.registration.seq : 0));
    expect(archivedSeqs.length).toBeGreaterThan(10);
    expect(archivedSeqs.length).toBeLessThan(45);
    expect(archivedSeqs).toEqual(archivedSeqs.map((_, i) => i + 1));
    expect(checkInvariants(first.snapshot, at(2))).toEqual({ ok: true, violations: [] });
    // every user command is rejected from the first decision on; the sessions are not offered
    expect(step(first.snapshot, cmd.register(99, ['A']), at(2)).decision.reason).toBe(
      'WORKSHOP_CANCELLED',
    );
    expect(step(first.snapshot, cmd.tick(), at(2)).decision.metrics.offersCreated).toBe(0);

    const done = run(first.snapshot, first.decision.continuation!, at(2));
    expect(done.decisions.length).toBeGreaterThan(1);
    for (const decision of done.decisions) {
      expect(estimateCommitItems(decision)).toBeLessThanOrEqual(90);
    }
    expect(done.snapshot.workshop.status).toBe('CANCELLED');
    expect(done.snapshot.workshop.nextDueAt).toBeUndefined();
    expect(done.snapshot.registrations).toEqual([]);
    expect(done.snapshot.offers).toEqual([]);
    expect(done.snapshot.sessions.map((x) => [x.status, x.held, x.confirmed])).toEqual([
      ['CANCELLED', 0, 0],
      ['CANCELLED', 0, 0],
    ]);
    const notified = [first.decision, ...done.decisions].flatMap((d) =>
      d.notifications.map((n) => n.userId),
    );
    expect(new Set(notified).size).toBe(45);
    expect(notified).toHaveLength(45);
    // a tick in between only drains (no expiry notifications for a workshop being cancelled)
    const mid = step(first.snapshot, cmd.tick('TIMER'), at(60));
    expect(mid.decision.metrics.offersExpired).toBe(0);
    expect(mid.decision.notifications.every((n) => n.kind === 'WORKSHOP_CANCELLED')).toBe(true);
  });

  it('stops the workshop drain before a dangling offer or the session flip when the budget is out', () => {
    const s = registerMany(
      makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] }),
      [1],
      ['A'],
      at(0),
    );
    const crafted = structuredClone(s);
    crafted.registrations = []; // u1's offer dangles
    // META 1 + CMD 1 fit, the dangling offer (3) does not
    const first = step(crafted, cmd.cancelWorkshop(), at(1), { maxItemsPerDecision: 2 });
    expect(first.snapshot.workshop.status).toBe('CANCELLING');
    expect(first.snapshot.offers).toHaveLength(1);
    expect(first.decision.continuation).toBeDefined();
    // the dangling offer fits (2+1 session) but flipping the other session (1 more) does not
    const second = step(first.snapshot, cmd.reallocate(), at(1), { maxItemsPerDecision: 5 });
    expect(second.snapshot.offers).toEqual([]);
    expect(second.snapshot.workshop.status).toBe('CANCELLING');
    expect(second.decision.continuation).toBeDefined();
    const done = run(second.snapshot, cmd.reallocate(), at(1));
    expect(done.snapshot.workshop.status).toBe('CANCELLED');
    expect(done.snapshot.sessions.map((x) => x.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('releases dangling offers of a cancelled workshop (corrupted snapshot)', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const crafted = structuredClone(s);
    crafted.registrations = [];
    const r = run(crafted, cmd.cancelWorkshop(), at(1));
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_OFFER')).toMatchObject({
      offer: { status: 'REVOKED' },
    });
    expect(r.snapshot.workshop.status).toBe('CANCELLED');
    expect(r.snapshot.offers).toEqual([]);
  });
});

describe('CLOSE_REGISTRATION / OPEN_REGISTRATION', () => {
  it('toggles the status, rejects no-op toggles and keeps serving the queue while closed', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const closed = run(s, cmd.close(), at(1));
    expect(closed.decision.status).toBe('APPLIED');
    expect(closed.decision.resultForCommand).toEqual({ offersCreated: 0 });
    expect(closed.snapshot.workshop.status).toBe('CLOSED');
    expect(closed.decision.writes).toEqual([
      expect.objectContaining({ kind: 'PUT_WORKSHOP_STATE', status: 'CLOSED', version: 3 }),
    ]);
    expect(run(closed.snapshot, cmd.close(), at(2)).decision).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_STATE',
    });
    // u1 accepts while closed; u1 cancels later and u2 is still relayed the seat.
    const accepted = run(closed.snapshot, cmd.accept(1, offerOf(s, 1)!.id), at(2));
    expect(accepted.decision.status).toBe('APPLIED');
    const relayed = run(accepted.snapshot, cmd.cancel(1), at(3));
    expect(offerOf(relayed.snapshot, 2)).toBeDefined();
    const opened = run(relayed.snapshot, cmd.open(), at(4));
    expect(opened.snapshot.workshop.status).toBe('OPEN');
    expect(run(opened.snapshot, cmd.open(), at(5)).decision.reason).toBe('INVALID_STATE');
  });
});
