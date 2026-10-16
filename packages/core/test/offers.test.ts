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
  step,
} from './helpers';

describe('ACCEPT_OFFER', () => {
  it('confirms the held seat and notifies the participant', () => {
    const s1 = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const offer = offerOf(s1, 1)!;
    const r = run(s1, cmd.accept(1, offer.id), at(1));
    expect(r.decision.status).toBe('APPLIED');
    expect(r.decision.resultForCommand).toEqual({
      offersCreated: 0,
      registration: { status: 'CONFIRMED', seq: 1, acceptable: ['A'], confirmedSessionId: 'A' },
    });
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({ confirmed: 1, held: 0 });
    expect(r.snapshot.offers).toEqual([]);
    expect(regOf(r.snapshot, 1)).toMatchObject({ status: 'CONFIRMED', confirmedSessionId: 'A' });
    expect(regOf(r.snapshot, 1)?.currentOfferId).toBeUndefined();
    expect(r.decision.writes).toEqual([
      expect.objectContaining({ kind: 'PUT_WORKSHOP_STATE', version: 2 }),
      expect.objectContaining({ kind: 'PUT_SESSION' }),
      expect.objectContaining({ kind: 'PUT_REGISTRATION' }),
      { kind: 'ARCHIVE_OFFER', offer: { ...offer, status: 'ACCEPTED', settledAt: at(1) } },
    ]);
    expect(r.decision.notifications).toEqual([
      expect.objectContaining({ kind: 'CONFIRMED', userId: 'u1', offerId: offer.id }),
    ]);
    expect(r.snapshot.workshop.nextDueAt).toBeUndefined();
  });

  it('R4: expiresAt = min(now + holdSeconds, cutoffAt)', () => {
    const s0 = makeSnapshot({
      holdSeconds: 600,
      sessions: [{ id: 'A', startsInMinutes: 35 }, { id: 'B' }],
    });
    const r = run(s0, cmd.register(1, ['A']), at(0));
    expect(offerOf(r.snapshot, 1)?.expiresAt).toBe(at(5)); // cut-off at +5 wins over +10
    const r2 = run(makeSnapshot({ holdSeconds: 60 }), cmd.register(1, ['A']), at(0));
    expect(offerOf(r2.snapshot, 1)?.expiresAt).toBe(at(1));
  });

  it('rejects OFFER_NOT_FOUND, OFFER_NOT_YOURS and OFFER_EXPIRED (even without a tick)', () => {
    const s1 = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const offer = offerOf(s1, 1)!;
    expect(run(s1, cmd.accept(1, 'nope'), at(1)).decision).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_FOUND',
    });
    expect(run(s1, cmd.accept(2, offer.id), at(1)).decision).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_YOURS',
    });
    // Accept arrives after expiresAt: tick-first expires the offer in the same decision, the
    // seat is relayed to u2 and the accept is rejected. The write set is NOT empty.
    const late = run(s1, cmd.accept(1, offer.id), at(10));
    expect(late.decision).toMatchObject({ status: 'REJECTED', reason: 'OFFER_EXPIRED' });
    expect(late.decision.metrics.offersExpired).toBe(1);
    expect(offerOf(late.snapshot, 2)?.sessionId).toBe('A');
    expect(late.snapshot.workshop.version).toBe(3);
    // Not-yours is checked before expiry, so a stranger learns nothing about the offer.
    expect(run(s1, cmd.accept(2, offer.id), at(10)).decision.reason).toBe('OFFER_NOT_YOURS');
    // An expired offer referenced by DECLINE is rejected the same way.
    expect(run(s1, cmd.decline(1, offer.id), at(10)).decision.reason).toBe('OFFER_EXPIRED');
  });

  it('rejects OFFER_NOT_ACTIVE for a settled offer left in the live set', () => {
    const s1 = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const crafted = structuredClone(s1);
    crafted.offers[0]!.status = 'ACCEPTED';
    const r = step(crafted, cmd.accept(1, crafted.offers[0]!.id), at(1));
    expect(r.decision).toMatchObject({ status: 'REJECTED', reason: 'OFFER_NOT_ACTIVE' });
  });

  it('rejects INVALID_STATE when the registration or session disagrees with the offer', () => {
    const s1 = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const offerId = offerOf(s1, 1)!.id;

    const queued = structuredClone(s1);
    queued.registrations[0]!.status = 'QUEUED';
    expect(step(queued, cmd.accept(1, offerId), at(1)).decision.reason).toBe('INVALID_STATE');

    const mismatch = structuredClone(s1);
    mismatch.registrations[0]!.currentOfferId = 'other';
    expect(step(mismatch, cmd.accept(1, offerId), at(1)).decision.reason).toBe('INVALID_STATE');

    const cancelled = structuredClone(s1);
    cancelled.sessions[0]!.status = 'CANCELLED';
    expect(step(cancelled, cmd.decline(1, offerId), at(1)).decision.reason).toBe('INVALID_STATE');

    const orphan = structuredClone(s1);
    orphan.registrations = [];
    expect(step(orphan, cmd.accept(1, offerId), at(1)).decision.reason).toBe('INVALID_STATE');
  });
});

describe('DECLINE_OFFER', () => {
  it('R5: drops the session, re-queues with the same seq and re-allocates in the same decision', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    const s1 = registerMany(s0, [1, 2], ['A', 'B'], at(0)); // u1 holds A, u2 holds B
    const s2 = run(s1, cmd.register(3, ['B', 'A']), at(1)).snapshot; // u3 queued
    const offerA = offerOf(s2, 1)!;
    const r = run(s2, cmd.decline(1, offerA.id), at(2));
    expect(r.decision.status).toBe('APPLIED');
    // u1 (seq 1) dropped A, only B remains which is held by u2 -> QUEUED position 1 (seq order).
    expect(r.decision.resultForCommand?.registration).toEqual({
      status: 'QUEUED',
      seq: 1,
      acceptable: ['B'],
      queuePosition: 1,
    });
    // u3 prefers B (held) then A (just freed) -> gets A; backfill DECLINED relayed with 0 latency.
    expect(offerOf(r.snapshot, 3)?.sessionId).toBe('A');
    expect(r.decision.backfills).toEqual([
      {
        id: expect.any(String),
        workshopId: 'ws1',
        sessionId: 'A',
        releasedAt: at(2),
        cause: 'DECLINED',
        reallocatedAt: at(2),
        newOfferId: offerOf(r.snapshot, 3)?.id,
        newUserId: 'u3',
        latencyMs: 0,
      },
    ]);
    expect(r.decision.metrics.backfillLatenciesMs).toEqual([0]);
    expect(r.decision.notifications.map((n) => [n.kind, n.userId])).toEqual([
      ['DECLINED', 'u1'],
      ['OFFER', 'u3'],
    ]);
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_OFFER')).toMatchObject({
      offer: { id: offerA.id, status: 'DECLINED', settledAt: at(2) },
    });
  });

  it('R5: declining the last acceptable session ends the registration (NO_ACCEPTABLE_SESSION)', () => {
    const s1 = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const r = run(s1, cmd.decline(1, offerOf(s1, 1)!.id), at(1));
    expect(r.decision.resultForCommand?.registration).toEqual({
      status: 'ENDED',
      seq: 1,
      acceptable: [],
      endReason: 'NO_ACCEPTABLE_SESSION',
    });
    expect(r.snapshot.registrations).toEqual([]);
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_REGISTRATION')).toMatchObject({
      registration: { status: 'ENDED', endReason: 'NO_ACCEPTABLE_SESSION', seq: 1 },
    });
    expect(r.decision.notifications[0]?.body).toMatch(/registration has ended/);
    // The seat is free but nobody waits: the backfill record stays pending.
    expect(r.decision.backfills[0]?.reallocatedAt).toBeUndefined();
    expect(sessionOf(r.snapshot, 'A')).toMatchObject({ held: 0, confirmed: 0 });
  });
});

describe('post-command cut-off', () => {
  it('a decline whose remaining sessions all passed cut-off ends the registration with CUTOFF', () => {
    // B cut-off at +10; a 30 min hold keeps the A offer alive at +15
    const s0 = makeSnapshot({
      holdSeconds: 1800,
      sessions: [{ id: 'A' }, { id: 'B', startsInMinutes: 40 }],
    });
    const s = registerMany(s0, [1], ['A', 'B'], at(0)); // holds A
    const r = run(s, cmd.decline(1, offerOf(s, 1)!.id), at(15));
    expect(r.decision.resultForCommand?.registration).toMatchObject({
      status: 'ENDED',
      endReason: 'CUTOFF',
      acceptable: ['B'],
    });
    expect(r.snapshot.registrations).toEqual([]);
    expect(r.snapshot.workshop.nextDueAt).toBeUndefined();
  });

  it('a session cancellation that leaves only past-cut-off fallbacks ends the confirmed participant with CUTOFF', () => {
    const s0 = makeSnapshot({
      holdSeconds: 1800,
      sessions: [{ id: 'A' }, { id: 'B', startsInMinutes: 40 }],
    });
    let s = registerMany(s0, [1], ['A', 'B'], at(0));
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot;
    const r = run(s, cmd.cancelSession('A'), at(15));
    expect(r.decision.writes.find((w) => w.kind === 'ARCHIVE_REGISTRATION')).toMatchObject({
      registration: { seq: 1, status: 'ENDED', endReason: 'CUTOFF' },
    });
    expect(r.decision.notifications.map((n) => n.kind)).toEqual(['SESSION_CANCELLED']);
  });
});
