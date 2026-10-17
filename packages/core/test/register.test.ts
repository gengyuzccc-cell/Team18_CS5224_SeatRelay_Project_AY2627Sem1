import { describe, expect, it } from 'vitest';
import { decide, queueLength } from '../src/index';
import {
  T0,
  UUID,
  WS,
  at,
  cmd,
  makeCtx,
  makeSnapshot,
  offerOf,
  regOf,
  registerMany,
  run,
  step,
  user,
} from './helpers';

describe('REGISTER', () => {
  it('R2/R3: assigns seq in FIFO order and offers the first free session in preference order', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });

    const r1 = run(s0, cmd.register(1, ['A', 'B']), at(0));
    expect(r1.decision.status).toBe('APPLIED');
    expect(r1.decision.resultForCommand).toEqual({
      offersCreated: 1,
      registration: {
        status: 'OFFERED',
        seq: 1,
        acceptable: ['A', 'B'],
        currentOffer: { id: offerOf(r1.snapshot, 1)!.id, sessionId: 'A', expiresAt: at(10) },
      },
    });
    expect(r1.snapshot.workshop).toMatchObject({ seq: 1, version: 1, nextDueAt: at(10) });
    expect(r1.decision.writes[0]).toMatchObject({
      kind: 'PUT_WORKSHOP_STATE',
      workshopId: WS,
      status: 'OPEN',
      seq: 1,
      version: 1,
      nextDueAt: at(10),
      updatedAt: at(0),
    });
    expect(r1.decision.writes.map((w) => w.kind)).toEqual([
      'PUT_WORKSHOP_STATE',
      'PUT_SESSION',
      'PUT_REGISTRATION',
      'PUT_OFFER',
    ]);
    const offerId = offerOf(r1.snapshot, 1)!.id;
    expect(r1.decision.timers).toEqual([{ offerId, expiresAt: at(10) }]);
    expect(r1.decision.notifications).toEqual([
      expect.objectContaining({ kind: 'OFFER', userId: 'u1', email: 'u1@example.com', offerId }),
    ]);
    expect(r1.decision.backfills).toEqual([]);
    expect(r1.decision.metrics).toEqual({
      offersCreated: 1,
      offersExpired: 0,
      backfillLatenciesMs: [],
    });

    // Second user also prefers A: A is held, so B is offered.
    const r2 = run(r1.snapshot, cmd.register(2, ['A', 'B']), at(1));
    expect(offerOf(r2.snapshot, 2)?.sessionId).toBe('B');
    expect(regOf(r2.snapshot, 2)?.seq).toBe(2);

    // Third and fourth users queue in seq order with 1-based positions.
    const r3 = run(r2.snapshot, cmd.register(3, ['A']), at(2));
    expect(r3.decision.resultForCommand?.registration).toMatchObject({
      status: 'QUEUED',
      seq: 3,
      queuePosition: 1,
    });
    expect(r3.decision.metrics.offersCreated).toBe(0);
    const r4 = run(r3.snapshot, cmd.register(4, ['B', 'A']), at(2));
    expect(r4.decision.resultForCommand?.registration?.queuePosition).toBe(2);
    expect(r4.snapshot.registrations.map((r) => [r.seq, r.status])).toEqual([
      [1, 'OFFERED'],
      [2, 'OFFERED'],
      [3, 'QUEUED'],
      [4, 'QUEUED'],
    ]);
  });

  it('R1: a user with a live registration cannot register again (ALREADY_REGISTERED)', () => {
    const s1 = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const again = run(s1, cmd.register(1, ['B']), at(1));
    expect(again.decision).toMatchObject({ status: 'REJECTED', reason: 'ALREADY_REGISTERED' });
    expect(again.decision.writes).toEqual([]);
    expect(again.decision.resultForCommand).toBeUndefined();
    expect(again.snapshot.workshop.version).toBe(1);
  });

  it('rejects WORKSHOP_NOT_OPEN while registration is closed', () => {
    const closed = run(makeSnapshot(), cmd.close(), at(0)).snapshot;
    const r = run(closed, cmd.register(1, ['A']), at(1));
    expect(r.decision).toMatchObject({ status: 'REJECTED', reason: 'WORKSHOP_NOT_OPEN' });
    expect(r.decision.writes).toEqual([]);
  });

  it('rejects WORKSHOP_CANCELLED for every user command on a cancelled workshop', () => {
    const cancelled = run(makeSnapshot(), cmd.cancelWorkshop(), at(0)).snapshot;
    for (const command of [
      cmd.register(1, ['A']),
      cmd.accept(1, 'x'),
      cmd.decline(1, 'x'),
      cmd.cancel(1),
      cmd.setCapacity('A', 3),
      cmd.cancelSession('A'),
      cmd.cancelWorkshop(),
      cmd.close(),
      cmd.open(),
    ]) {
      const r = run(cancelled, command, at(1));
      expect(r.decision).toMatchObject({ status: 'REJECTED', reason: 'WORKSHOP_CANCELLED' });
      expect(r.decision.writes).toEqual([]);
    }
    // internal commands are harmless no-ops once the drain is complete
    for (const command of [cmd.tick(), cmd.reallocate()]) {
      const r = run(cancelled, command, at(1));
      expect(r.decision.status).toBe('APPLIED');
      expect(r.decision.writes).toEqual([]);
    }
  });

  it('rejects malformed preference lists', () => {
    const s0 = makeSnapshot();
    expect(run(s0, cmd.register(1, ['A', 'A']), at(0)).decision).toMatchObject({
      status: 'REJECTED',
      reason: 'DUPLICATE_SESSION_IN_PREFERENCES',
    });
    expect(run(s0, cmd.register(1, ['A', 'Z']), at(0)).decision).toMatchObject({
      status: 'REJECTED',
      reason: 'UNKNOWN_SESSION_IN_PREFERENCES',
    });
  });

  it('drops cancelled sessions from the preferences and rejects NO_ACCEPTABLE_SESSION when nothing is left', () => {
    const noA = run(makeSnapshot(), cmd.cancelSession('A'), at(0)).snapshot;
    const r = run(noA, cmd.register(1, ['A', 'B']), at(1));
    expect(r.decision.status).toBe('APPLIED');
    expect(regOf(r.snapshot, 1)?.acceptable).toEqual(['B']);

    const onlyA = run(noA, cmd.register(2, ['A']), at(1));
    expect(onlyA.decision).toMatchObject({ status: 'REJECTED', reason: 'NO_ACCEPTABLE_SESSION' });
  });

  it('rejects NO_ACCEPTABLE_SESSION when every session has passed its cut-off', () => {
    const s0 = makeSnapshot({
      sessions: [
        { id: 'A', startsInMinutes: 40 },
        { id: 'B', startsInMinutes: 50 },
      ],
    });
    // cut-offs are at +10 and +20 minutes
    const r = run(s0, cmd.register(1, ['A', 'B']), at(20));
    expect(r.decision).toMatchObject({ status: 'REJECTED', reason: 'NO_ACCEPTABLE_SESSION' });
  });

  it('drops a past-cut-off session from the preferences (it can never be offered, R4)', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', startsInMinutes: 40 }, { id: 'B' }] });
    const r = run(s0, cmd.register(1, ['A', 'B']), at(15)); // A cut-off (+10) has passed
    expect(regOf(r.snapshot, 1)?.acceptable).toEqual(['B']);
    expect(r.decision.resultForCommand?.registration?.acceptable).toEqual(['B']);
    expect(offerOf(r.snapshot, 1)?.sessionId).toBe('B');
    // a second registrant who only lists A queues nowhere: the A queue length stays 0
    const s2 = run(r.snapshot, cmd.register(2, ['A']), at(15));
    expect(s2.decision.reason).toBe('NO_ACCEPTABLE_SESSION');
    expect(queueLength(r.snapshot.registrations, 'A')).toBe(0);
  });

  it('throws on a command/snapshot workshop mismatch (a routing bug, not a reject reason)', () => {
    expect(() =>
      decide(makeSnapshot(), { type: 'TICK', workshopId: 'other-ws' }, makeCtx(at(0))),
    ).toThrow(/other-ws/);
  });

  it('normalises `now` so every emitted timestamp is canonical (ISO UTC with milliseconds)', () => {
    const decision = decide(
      makeSnapshot(),
      cmd.register(1, ['A']),
      makeCtx('2026-11-03T06:00:00Z'),
    );
    const registration = decision.writes.find((w) => w.kind === 'PUT_REGISTRATION');
    expect(registration?.kind === 'PUT_REGISTRATION' && registration.registration.createdAt).toBe(
      T0,
    );
    expect(decision.writes[0]).toMatchObject({ kind: 'PUT_WORKSHOP_STATE', updatedAt: T0 });
    expect(decision.timers[0]?.expiresAt).toBe(at(10));
  });

  it('stores the display name and email from the JWT identity', () => {
    const r = run(
      makeSnapshot(),
      {
        type: 'REGISTER',
        commandId: UUID,
        workshopId: WS,
        actorUserId: user(1),
        actorEmail: 'alice@example.com',
        actorDisplayName: 'Alice',
        acceptable: ['A'],
      },
      at(0),
    );
    expect(regOf(r.snapshot, 1)).toMatchObject({
      displayName: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('is deterministic and never mutates the input snapshot', () => {
    const s0 = registerMany(makeSnapshot(), [1, 2, 3], ['A', 'B'], at(0));
    const a = decide(s0, cmd.register(4, ['B']), makeCtx(at(5), undefined, 100));
    const b = decide(s0, cmd.register(4, ['B']), makeCtx(at(5), undefined, 100));
    expect(a).toEqual(b);
    const { decision } = step(s0, cmd.register(4, ['B']), at(5));
    expect({ ...decision, writes: [] }).toEqual({ ...a, writes: [] });
    expect(decision.writes.map((w) => w.kind)).toEqual(a.writes.map((w) => w.kind));
  });
});
