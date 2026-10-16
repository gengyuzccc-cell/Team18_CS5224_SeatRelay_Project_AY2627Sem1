import { describe, expect, it } from 'vitest';
import { applyChanges, type Change } from '../src/index';
import { T0, at, makeSession, makeSnapshot } from './helpers';

describe('applyChanges', () => {
  it('upserts, archives and never mutates the input', () => {
    const snapshot = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    const frozen = structuredClone(snapshot);
    const registration = {
      workshopId: 'ws1',
      userId: 'u1',
      email: 'u1@example.com',
      seq: 2,
      acceptable: ['A'],
      status: 'QUEUED' as const,
      createdAt: T0,
      updatedAt: T0,
    };
    const earlier = { ...registration, seq: 1, userId: 'u0', email: 'u0@example.com' };
    const offer = {
      id: 'o1',
      workshopId: 'ws1',
      sessionId: 'A',
      userId: 'u1',
      registrationSeq: 2,
      status: 'OFFERED' as const,
      createdAt: T0,
      expiresAt: at(10),
    };
    const writes: Change[] = [
      {
        kind: 'PUT_WORKSHOP_STATE',
        workshopId: 'ws1',
        status: 'CLOSED',
        seq: 2,
        version: 1,
        nextDueAt: at(10),
        updatedAt: at(1),
      },
      { kind: 'PUT_SESSION', session: { ...makeSession({ id: 'A', capacity: 5 }), held: 1 } },
      { kind: 'PUT_SESSION', session: makeSession({ id: 'C', capacity: 2 }) },
      { kind: 'PUT_REGISTRATION', registration },
      { kind: 'PUT_REGISTRATION', registration: earlier },
      { kind: 'PUT_OFFER', offer },
      { kind: 'PUT_OFFER', offer: { ...offer, expiresAt: at(11) } },
      {
        kind: 'PUT_BACKFILL',
        record: { id: 'b1', workshopId: 'ws1', sessionId: 'A', releasedAt: T0, cause: 'DECLINED' },
      },
    ];
    const next = applyChanges(snapshot, writes);
    expect(snapshot).toStrictEqual(frozen);
    expect(next.workshop).toMatchObject({
      status: 'CLOSED',
      seq: 2,
      version: 1,
      nextDueAt: at(10),
    });
    expect(next.sessions.map((s) => s.id)).toEqual(['A', 'B', 'C']);
    expect(next.sessions[0]).toMatchObject({ capacity: 5, held: 1 });
    expect(next.registrations.map((r) => r.seq)).toEqual([1, 2]);
    expect(next.offers).toHaveLength(1);
    expect(next.offers[0]?.expiresAt).toBe(at(11));

    const archived = applyChanges(next, [
      { kind: 'ARCHIVE_REGISTRATION', registration: { ...registration, status: 'CANCELLED' } },
      { kind: 'ARCHIVE_OFFER', offer: { ...offer, status: 'REVOKED' } },
      {
        kind: 'PUT_WORKSHOP_STATE',
        workshopId: 'ws1',
        status: 'OPEN',
        seq: 2,
        version: 2,
        updatedAt: at(2),
      },
    ]);
    expect(archived.registrations.map((r) => r.seq)).toEqual([1]);
    expect(archived.offers).toEqual([]);
    expect(archived.workshop.nextDueAt).toBeUndefined();
    expect('nextDueAt' in archived.workshop).toBe(false);
  });
});
