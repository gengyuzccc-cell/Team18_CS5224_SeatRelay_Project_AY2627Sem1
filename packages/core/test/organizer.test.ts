import { describe, expect, it } from 'vitest';
import {
  at,
  cmd,
  makeSnapshot,
  offerOf,
  regOf,
  registerMany,
  run,
  sessionOf,
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
    // already-cancelled sessions are left alone
    const partly = run(makeSnapshot(), cmd.cancelSession('A'), at(0)).snapshot;
    const r2 = run(partly, cmd.cancelWorkshop(), at(1));
    expect(writesOfKind(r2.decision, 'PUT_SESSION')).toBe(1);
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
