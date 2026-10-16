import { describe, expect, it } from 'vitest';
import {
  boundSessionId,
  holdScopeKey,
  queuePosition,
  queueScopeKey,
  registrationConflicts,
  registrationScopeKey,
  requiresSingleSession,
} from '../src/index';
import { at, cmd, makeSnapshot, offerOf, registerMany, run } from './helpers';

const perSession = () =>
  makeSnapshot({ mode: 'PER_SESSION', sessions: [{ id: 'A' }, { id: 'B', capacity: 2 }] });

describe('PER_SESSION mode', () => {
  it('requires exactly one session per registration', () => {
    const r = run(perSession(), cmd.register(1, ['A', 'B']), at(0));
    expect(r.decision).toMatchObject({
      status: 'REJECTED',
      reason: 'PER_SESSION_REQUIRES_ONE_SESSION',
    });
  });

  it('lets the same user hold registrations in several sessions (duplicate holds) but not twice in one', () => {
    let s = registerMany(perSession(), [1], ['A'], at(0));
    s = registerMany(s, [1], ['B'], at(0));
    expect(s.registrations.map((r) => [r.userId, r.seq, r.acceptable[0], r.status])).toEqual([
      ['u1', 1, 'A', 'OFFERED'],
      ['u1', 2, 'B', 'OFFERED'],
    ]);
    const dup = run(s, cmd.register(1, ['A']), at(1));
    expect(dup.decision).toMatchObject({ status: 'REJECTED', reason: 'ALREADY_REGISTERED' });
    // accepting both is allowed: no cross-session constraint in the baseline
    const a = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1));
    const b = run(a.snapshot, cmd.accept(1, a.snapshot.offers[0]!.id), at(1));
    expect(b.snapshot.registrations.map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('keeps independent FIFO queues and queue positions per session', () => {
    let s = registerMany(perSession(), [1, 2, 3], ['A'], at(0)); // u1 holds A; u2,u3 queued in A
    s = registerMany(s, [4, 5, 6], ['B'], at(0)); // u4,u5 hold B; u6 queued in B
    const reg = (n: number) => s.registrations.find((r) => r.userId === `u${n}`)!;
    expect(queuePosition('PER_SESSION', s.registrations, reg(2))).toBe(1);
    expect(queuePosition('PER_SESSION', s.registrations, reg(3))).toBe(2);
    expect(queuePosition('PER_SESSION', s.registrations, reg(6))).toBe(1);
    expect(queuePosition('PER_SESSION', s.registrations, reg(1))).toBeUndefined();
    const r = run(s, cmd.register(7, ['B']), at(1));
    expect(r.decision.resultForCommand?.registration?.queuePosition).toBe(2);
  });

  it('declining the single session ends the registration; the seat relays within that session', () => {
    const s = registerMany(perSession(), [1, 2], ['A'], at(0));
    const r = run(s, cmd.decline(1, offerOf(s, 1)!.id), at(1));
    expect(r.decision.resultForCommand?.registration).toMatchObject({
      status: 'ENDED',
      endReason: 'NO_ACCEPTABLE_SESSION',
    });
    expect(offerOf(r.snapshot, 2)?.sessionId).toBe('A');
  });

  it('CANCEL_REGISTRATION with sessionId cancels only that session; without it, all of mine', () => {
    let s = registerMany(perSession(), [1], ['A'], at(0));
    s = registerMany(s, [1], ['B'], at(0));
    const one = run(s, cmd.cancel(1, 'A'), at(1));
    expect(one.snapshot.registrations.map((r) => r.acceptable[0])).toEqual(['B']);
    expect(run(s, cmd.cancel(1, 'Z'), at(1)).decision.reason).toBe('NOT_REGISTERED');
    const all = run(s, cmd.cancel(1), at(1));
    expect(all.snapshot.registrations).toEqual([]);
    expect(all.decision.resultForCommand?.registration?.seq).toBe(1);
  });

  it('ignores the sessionId filter in UNIFIED mode', () => {
    const s = registerMany(makeSnapshot(), [1], ['A', 'B'], at(0));
    const r = run(s, cmd.cancel(1, 'Z'), at(1));
    expect(r.decision.status).toBe('APPLIED');
    expect(r.snapshot.registrations).toEqual([]);
  });

  it('exposes the mode strategy helpers', () => {
    const reg = { userId: 'u1', acceptable: ['A', 'B'] };
    expect(requiresSingleSession('PER_SESSION')).toBe(true);
    expect(requiresSingleSession('UNIFIED')).toBe(false);
    expect(boundSessionId(reg)).toBe('A');
    expect(boundSessionId({ acceptable: [] })).toBe('');
    expect(queueScopeKey('UNIFIED', reg)).toBe('*');
    expect(queueScopeKey('PER_SESSION', reg)).toBe('A');
    expect(registrationScopeKey('UNIFIED', reg)).toBe('u1');
    expect(registrationScopeKey('PER_SESSION', reg)).toBe('u1#A');
    expect(holdScopeKey('UNIFIED', 'u1', 'B')).toBe('u1');
    expect(holdScopeKey('PER_SESSION', 'u1', 'B')).toBe('u1#B');
    expect(registrationConflicts('UNIFIED', reg, 'u2', ['A'])).toBe(false);
    expect(registrationConflicts('UNIFIED', reg, 'u1', ['C'])).toBe(true);
    expect(registrationConflicts('PER_SESSION', reg, 'u1', ['B'])).toBe(false);
    expect(registrationConflicts('PER_SESSION', reg, 'u1', ['A'])).toBe(true);
  });
});
