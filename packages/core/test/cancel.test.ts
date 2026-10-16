import { describe, expect, it } from 'vitest';
import { at, cmd, makeSnapshot, offerOf, regOf, registerMany, run, sessionOf } from './helpers';

describe('CANCEL_REGISTRATION (R6)', () => {
  it('from QUEUED: archives as CANCELLED without a backfill record', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0)); // u2 queued
    const r = run(s, cmd.cancel(2), at(1));
    expect(r.decision.resultForCommand?.registration).toEqual({
      status: 'CANCELLED',
      seq: 2,
      acceptable: ['A'],
    });
    expect(r.decision.backfills).toEqual([]);
    expect(r.decision.notifications).toEqual([]);
    expect(r.snapshot.registrations.map((x) => x.seq)).toEqual([1]);
  });

  it('from OFFERED: revokes the offer and relays the seat (CANCELLED_OFFER, latency 0)', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const offer = offerOf(s, 1)!;
    const r = run(s, cmd.cancel(1), at(3));
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_OFFER')).toMatchObject({
      offer: { id: offer.id, status: 'REVOKED', settledAt: at(3) },
    });
    expect(offerOf(r.snapshot, 2)?.sessionId).toBe('A');
    expect(r.decision.backfills).toEqual([
      expect.objectContaining({
        cause: 'CANCELLED_OFFER',
        releasedAt: at(3),
        newUserId: 'u2',
        latencyMs: 0,
      }),
    ]);
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({ held: 1, confirmed: 0 });
  });

  it('from CONFIRMED: releases the confirmed seat (CANCELLED_CONFIRMED)', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const confirmed = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot;
    expect(sessionOf(confirmed, 'A')).toMatchObject({ confirmed: 1, held: 0 });
    const r = run(confirmed, cmd.cancel(1), at(2));
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({ confirmed: 0, held: 1 });
    expect(offerOf(r.snapshot, 2)).toBeDefined();
    expect(r.decision.backfills).toEqual([
      expect.objectContaining({ cause: 'CANCELLED_CONFIRMED', newUserId: 'u2', latencyMs: 0 }),
    ]);
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_REGISTRATION')).toMatchObject({
      registration: { status: 'CANCELLED', seq: 1, confirmedSessionId: 'A' },
    });
  });

  it('rejects NOT_REGISTERED when the user has no live registration', () => {
    const r = run(makeSnapshot(), cmd.cancel(9), at(0));
    expect(r.decision).toMatchObject({ status: 'REJECTED', reason: 'NOT_REGISTERED' });
    expect(r.decision.writes).toEqual([]);
  });

  it('re-registering after a cancel gets a new seq at the back of the queue', () => {
    const s = registerMany(makeSnapshot(), [1, 2, 3], ['A'], at(0));
    const cancelled = run(s, cmd.cancel(2), at(1)).snapshot;
    const r = run(cancelled, cmd.register(2, ['A']), at(2));
    expect(regOf(r.snapshot, 2)).toMatchObject({ seq: 4, status: 'QUEUED' });
    expect(r.decision.resultForCommand?.registration?.queuePosition).toBe(2); // behind u3
    expect(r.snapshot.workshop.seq).toBe(4);
  });
});
