import { describe, expect, it } from 'vitest';
import {
  byRelease,
  cutoffFor,
  distinctConfirmedUsers,
  findOffer,
  findSession,
  freeSeats,
  isAllocatable,
  isLiveRegistrationStatus,
  isPastCutoff,
  liveRegistrationsOf,
  newSnapshot,
  newWorkshop,
  parseIso,
  queueLength,
  queuePosition,
  registrationSummary,
} from '../src/index';
import {
  T0,
  at,
  cmd,
  makeSession,
  makeSnapshot,
  offerOf,
  regOf,
  registerMany,
  run,
} from './helpers';

describe('snapshot helpers', () => {
  it('computes free seats, cut-off and allocatability', () => {
    const session = makeSession({ id: 'A', capacity: 3, startsInMinutes: 60 });
    expect(session.cutoffAt).toBe(at(30));
    expect(cutoffFor(at(60))).toBe(at(30));
    expect(freeSeats({ capacity: 3, confirmed: 1, held: 1 })).toBe(1);
    expect(isPastCutoff(session, parseIso(at(29)))).toBe(false);
    expect(isPastCutoff(session, parseIso(at(30)))).toBe(true);
    expect(isAllocatable(session, parseIso(at(0)))).toBe(true);
    expect(isAllocatable({ ...session, held: 3 }, parseIso(at(0)))).toBe(false);
    expect(isAllocatable({ ...session, status: 'CANCELLED' }, parseIso(at(0)))).toBe(false);
    expect(isAllocatable(session, parseIso(at(30)))).toBe(false);
    expect(isLiveRegistrationStatus('QUEUED')).toBe(true);
    expect(isLiveRegistrationStatus('ENDED')).toBe(false);
  });

  it('finds sessions / offers / registrations and counts queues', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    let s = registerMany(s0, [1, 2], ['A'], at(0)); // u1 holds A, u2 queued
    s = registerMany(s, [3], ['B', 'A'], at(0)); // u3 holds B
    s = registerMany(s, [4], ['B'], at(0)); // u4 queued for B only
    expect(findSession(s, 'A')?.held).toBe(1);
    expect(findSession(s, 'Z')).toBeUndefined();
    expect(findOffer(s, offerOf(s, 1)!.id)?.userId).toBe('u1');
    expect(findOffer(s, 'nope')).toBeUndefined();
    expect(liveRegistrationsOf(s, 'u2').map((r) => r.seq)).toEqual([2]);
    expect(liveRegistrationsOf(s, 'u9')).toEqual([]);
    expect(queueLength(s.registrations)).toBe(2);
    expect(queueLength(s.registrations, 'A')).toBe(1);
    expect(queueLength(s.registrations, 'B')).toBe(1);
    expect(queuePosition('UNIFIED', s.registrations, regOf(s, 4)!)).toBe(2);
    expect(queuePosition('UNIFIED', s.registrations, regOf(s, 1)!)).toBeUndefined();
    const confirmed = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot;
    expect(distinctConfirmedUsers(confirmed.registrations)).toBe(1);
    expect(distinctConfirmedUsers(s.registrations)).toBe(0);
  });

  it('summarises a registration for the public view', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const offered = regOf(s, 1)!;
    expect(registrationSummary('UNIFIED', s.registrations, s.offers, offered)).toEqual({
      status: 'OFFERED',
      seq: 1,
      acceptable: ['A'],
      currentOffer: { id: offerOf(s, 1)!.id, sessionId: 'A', expiresAt: at(10) },
    });
    expect(registrationSummary('UNIFIED', s.registrations, [], offered)).toEqual({
      status: 'OFFERED',
      seq: 1,
      acceptable: ['A'],
    });
    expect(registrationSummary('UNIFIED', s.registrations, s.offers, regOf(s, 2)!)).toEqual({
      status: 'QUEUED',
      seq: 2,
      acceptable: ['A'],
      queuePosition: 1,
    });
  });

  it('orders backfill records by release time, then id', () => {
    const record = (id: string, releasedAt: string) => ({
      id,
      workshopId: 'ws1',
      sessionId: 'A',
      releasedAt,
      cause: 'EXPIRED' as const,
    });
    expect(byRelease(record('b', at(1)), record('a', at(2)))).toBeLessThan(0);
    expect(byRelease(record('b', at(1)), record('a', at(1)))).toBeGreaterThan(0);
    expect(byRelease(record('a', at(1)), record('b', at(1)))).toBeLessThan(0);
    expect(byRelease(record('a', at(1)), record('a', at(1)))).toBe(0);
  });

  it('builds fresh workshops and snapshots with defaults', () => {
    const workshop = newWorkshop({ id: 'w', orgId: 'o', title: 'T', createdAt: T0 });
    expect(workshop).toMatchObject({
      status: 'OPEN',
      mode: 'UNIFIED',
      holdSeconds: 900,
      description: '',
      seq: 0,
      version: 0,
      updatedAt: T0,
    });
    const snapshot = newSnapshot(workshop, [makeSession({ id: 'A' })]);
    expect(snapshot.registrations).toEqual([]);
    expect(snapshot.offers).toEqual([]);
    expect(snapshot.pendingBackfills).toEqual([]);
  });
});

describe('internal guards', () => {
  it('mustGet throws on a corrupted reference', async () => {
    const { mustGet } = await import('../src/state');
    expect(mustGet(new Map([['a', 1]]), 'a', 'thing')).toBe(1);
    expect(() => mustGet(new Map<string, number>(), 'zz', 'session')).toThrow(/missing session zz/);
    expect(() => mustGet(new Map<string, number>(), undefined, 'offer')).toThrow(/missing offer/);
  });
});
