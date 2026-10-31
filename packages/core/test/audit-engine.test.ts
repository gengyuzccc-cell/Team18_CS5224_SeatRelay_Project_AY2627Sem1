import type { Command, Registration, Session, WorkshopMode } from '@seatrelay/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  addMs,
  addSeconds,
  applyChanges,
  checkInvariants,
  decide,
  estimateCommitItems,
  isAllocatable,
  isStillOpenForAllocation,
  minIso,
  newSession,
  newWorkshop,
  parseIso,
  type DecideContext,
  type Decision,
  type DecisionLimits,
  type WorkshopSnapshot,
} from '../src/index';
import {
  T0,
  UUID,
  WS,
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
} from './helpers';

/**
 * Adversarial audit of the engine (rules R1–R7, constraints C1–C7, the action budget and the
 * continuation chain). Two parts:
 *
 *  1. deterministic scenarios the rule tests do not cover: holds spanning the cut-off, commands
 *     after the cut-off, capacity reduced to the usage while a continuation still carries
 *     capacity-up seats, a session cancelled with offers outstanding (and the stale ACCEPT that
 *     follows), re-registration after a decline, duplicate ticks inside a budget-overflow chain,
 *     a cancelled workshop hit by duplicate continuations, clock skew;
 *  2. a second model-based property test that differs from `property.test.ts` in what it
 *     generates (the clock may go backwards, user commands are replayed as duplicates, ticks and
 *     continuations are duplicated inside the chain) and in what it checks after EVERY decision:
 *     R2/R3 on every new offer, R7 on every confirmed seat, and that a duplicate of an applied
 *     user command is observably the same as an internal TICK on the same state.
 */

const nowOf = (iso: string) => parseIso(iso);

function allocatableAfter(session: Session | undefined, now: string): boolean {
  return session !== undefined && isAllocatable(session, nowOf(now));
}

/* ------------------------------------------------------------------ scenarios */

describe('audit: holds spanning the cut-off (R4)', () => {
  it('an offer created just before the cut-off expires exactly at it; ACCEPT 1 ms before wins, at it loses', () => {
    // A starts at +35 min, so its cut-off is at +5 min.
    const s0 = makeSnapshot({ holdSeconds: 600, sessions: [{ id: 'A', startsInMinutes: 35 }, { id: 'B' }] });
    const cutoff = at(5);
    const s1 = run(s0, cmd.register(1, ['A']), addMs(cutoff, -1)).snapshot;
    const offer = offerOf(s1, 1)!;
    expect(offer.expiresAt).toBe(cutoff);
    // Accept at expiresAt itself: expired by tick-first (expiresAt <= now), seat released.
    const late = run(s1, cmd.accept(1, offer.id), cutoff);
    expect(late.decision.status).toBe('REJECTED');
    expect(late.decision.reason).toBe('OFFER_EXPIRED');
    expect(sessionOf(late.snapshot, 'A')).toMatchObject({ held: 0, confirmed: 0 });
    // The registration listed only A: R5 drops the expired session first, so it ends with
    // NO_ACCEPTABLE_SESSION (the hold ran out), not CUTOFF (which is for queued waits).
    expect(regOf(late.snapshot, 1)).toBeUndefined();
    const ended = late.decision.writes.find((w) => w.kind === 'ARCHIVE_REGISTRATION');
    expect(ended?.kind === 'ARCHIVE_REGISTRATION' && ended.registration.endReason).toBe(
      'NO_ACCEPTABLE_SESSION',
    );
    expect(late.decision.notifications.map((n) => n.kind)).toEqual(['EXPIRED']);
    // Accept 1 ms before: confirmed; the confirmed seat survives the cut-off (R7).
    const early = run(s1, cmd.accept(1, offer.id), addMs(cutoff, -1));
    expect(early.decision.status).toBe('APPLIED');
    const after = run(early.snapshot, cmd.tick('SWEEP'), at(60));
    expect(regOf(after.snapshot, 1)).toMatchObject({ status: 'CONFIRMED', confirmedSessionId: 'A' });
    expect(after.decision.writes).toEqual([]);
  });

  it('after every cut-off: REGISTER, ACCEPT, DECLINE are rejected; a confirmed participant may still leave and the seat is never relayed', () => {
    const s0 = makeSnapshot({
      holdSeconds: 60,
      sessions: [{ id: 'A', startsInMinutes: 35, capacity: 1 }, { id: 'B', startsInMinutes: 35, capacity: 1 }],
    });
    let s = registerMany(s0, [1, 2, 3], ['A', 'B'], at(0)); // 1→A, 2→B, 3 queued
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(0)).snapshot;
    const offer2 = offerOf(s, 2)!;
    // Cut-off at +5: 2's hold (expires +1) was renewed? No: it expired at +1 and was re-offered
    // to 3 at the tick; walk the timeline explicitly.
    s = run(s, cmd.tick('TIMER'), at(1)).snapshot; // 2's offer expired → 3 gets B
    expect(regOf(s, 2)).toMatchObject({ status: 'QUEUED', acceptable: ['A'] });
    expect(offerOf(s, 3)?.sessionId).toBe('B');
    const past = at(6); // every cut-off passed
    const r = run(s, cmd.tick('SWEEP'), past);
    // 3's hold on B expired at +2; 3 then listed only A (full) → stays QUEUED until the cut-off → ENDED(CUTOFF).
    expect(r.snapshot.registrations.map((x) => [x.userId, x.status])).toEqual([['u1', 'CONFIRMED']]);
    expect(run(r.snapshot, cmd.register(4, ['A', 'B']), past).decision.reason).toBe('NO_ACCEPTABLE_SESSION');
    expect(run(r.snapshot, cmd.accept(2, offer2.id), past).decision.reason).toBe('OFFER_EXPIRED');
    expect(run(r.snapshot, cmd.decline(2, offer2.id), past).decision.reason).toBe('OFFER_EXPIRED');
    // R6 after the cut-off: the confirmed participant can leave; the seat is released but nobody can take it.
    const left = run(r.snapshot, cmd.cancel(1), past);
    expect(left.decision.status).toBe('APPLIED');
    expect(sessionOf(left.snapshot, 'A')).toMatchObject({ confirmed: 0, held: 0 });
    expect(left.decision.backfills).toEqual([
      expect.objectContaining({ cause: 'CANCELLED_CONFIRMED', sessionId: 'A' }),
    ]);
    expect(left.decision.backfills[0]?.reallocatedAt).toBeUndefined();
    expect(left.snapshot.pendingBackfills).toEqual([]); // closed, never relayed
    expect(left.snapshot.workshop.nextDueAt).toBeUndefined();
    // Raising the capacity after the cut-off is accepted but can never offer anything.
    const raised = run(left.snapshot, cmd.setCapacity('A', 5), past);
    expect(raised.decision.status).toBe('APPLIED');
    expect(raised.decision.metrics.offersCreated).toBe(0);
    expect(raised.decision.continuation).toBeUndefined();
  });
});

describe('audit: capacity changes (R7, C1)', () => {
  it('capacity lowered to exactly confirmed + held is applied; below it is rejected; a later release then fills only the free seats', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 3 }, { id: 'B', capacity: 1 }] });
    let s = registerMany(s0, [1, 2, 3, 4, 5], ['A'], at(0)); // 1,2,3 hold A; 4,5 queued
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(0)).snapshot;
    expect(sessionOf(s, 'A')).toMatchObject({ confirmed: 1, held: 2 });
    expect(run(s, cmd.setCapacity('A', 2), at(0)).decision.reason).toBe('CAPACITY_BELOW_USAGE');
    const exact = run(s, cmd.setCapacity('A', 3), at(0));
    expect(exact.decision.status).toBe('APPLIED');
    expect(exact.decision.metrics.offersCreated).toBe(0);
    // 2 declines: one seat free under the new capacity → exactly one relay (to 4, the lowest seq).
    const declined = run(exact.snapshot, cmd.decline(2, offerOf(exact.snapshot, 2)!.id), at(1));
    expect(declined.decision.metrics.offersCreated).toBe(1);
    expect(offerOf(declined.snapshot, 4)).toBeDefined();
    expect(regOf(declined.snapshot, 5)?.status).toBe('QUEUED');
    expect(sessionOf(declined.snapshot, 'A')).toMatchObject({ capacity: 3, confirmed: 1, held: 2 });
  });

  it('a continuation carrying capacity-up seats never over-allocates after the capacity was lowered again (C1)', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 1 }, { id: 'B', capacity: 1 }] });
    let s = registerMany(s0, Array.from({ length: 20 }, (_, i) => i + 1), ['A'], at(0));
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(0)).snapshot;
    s = run(s, cmd.cancel(2), at(0)).snapshot; // 2 held B? no: B is not in the list; 2 was queued
    // Raise A to 20: 12 offers at most in the first decision, the rest in a continuation.
    const first = step(s, cmd.setCapacity('A', 20), at(1));
    expect(first.decision.metrics.offersCreated).toBe(12);
    expect(first.decision.continuation).toMatchObject({
      type: 'REALLOCATE',
      pendingCapacityUp: [{ sessionId: 'A', seats: 19 - 12 }],
    });
    expectHardInvariants(first.snapshot, at(1));
    // Interleaved before the continuation: the organiser lowers A to its exact usage (1 + 12).
    const lowered = step(first.snapshot, cmd.setCapacity('A', 13), at(1));
    expect(lowered.decision.status).toBe('APPLIED');
    // The continuation still carries 7 capacity-up seats: it must find none free.
    const cont = step(lowered.snapshot, first.decision.continuation!, at(1));
    expect(cont.decision.metrics.offersCreated).toBe(0);
    expect(cont.decision.backfills).toEqual([]);
    expect(cont.decision.continuation).toBeUndefined();
    const session = sessionOf(cont.snapshot, 'A');
    expect(session.confirmed + session.held).toBeLessThanOrEqual(session.capacity);
    expect(checkInvariants(cont.snapshot, at(1)).violations).toEqual([]);
  });

  it('R7: no automatic command ever moves a CONFIRMED participant (ticks, capacity down/up, other users leaving)', () => {
    const s0 = makeSnapshot({ holdSeconds: 60, sessions: [{ id: 'A', capacity: 2 }, { id: 'B', capacity: 1 }] });
    let s = registerMany(s0, [1, 2, 3, 4], ['A', 'B'], at(0));
    s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(0)).snapshot;
    const before = regOf(s, 1)!;
    const commands: [Command, string][] = [
      [cmd.tick('TIMER'), at(2)], // every other hold expires and is relayed
      [cmd.setCapacity('A', 1), at(2)], // rejected: 1 confirmed + holds... depends; either way 1 untouched
      [cmd.setCapacity('A', 5), at(2)],
      [cmd.cancel(2), at(3)],
      [cmd.decline(3, offerOf(s, 3)?.id ?? 'none'), at(3)],
      [cmd.close(), at(4)],
      [cmd.open(), at(4)],
      [cmd.tick('SWEEP'), at(60)],
    ];
    for (const [command, now] of commands) {
      s = run(s, command, now).snapshot;
      expect(regOf(s, 1)).toMatchObject({
        status: 'CONFIRMED',
        confirmedSessionId: before.confirmedSessionId,
        seq: before.seq,
      });
    }
  });
});

describe('audit: session cancelled with offers outstanding', () => {
  it('revokes the holds, re-queues the holders ahead of everyone (same seq), ends those with nothing left, and answers the stale ACCEPT deterministically', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 2 }, { id: 'B', capacity: 1 }] });
    // 1: A only; 2: A then B; 3: B only; 4: A then B (queued: A full after 1,2); 5: B only (queued).
    let s = registerMany(s0, [1], ['A'], at(0));
    s = registerMany(s, [2], ['A', 'B'], at(0));
    s = registerMany(s, [3], ['B'], at(0));
    s = registerMany(s, [4], ['A', 'B'], at(0));
    s = registerMany(s, [5], ['B'], at(0));
    expect(offerOf(s, 1)?.sessionId).toBe('A');
    expect(offerOf(s, 2)?.sessionId).toBe('A');
    expect(offerOf(s, 3)?.sessionId).toBe('B');
    expect(regOf(s, 4)?.status).toBe('QUEUED');
    expect(regOf(s, 5)?.status).toBe('QUEUED');
    const offer1 = offerOf(s, 1)!;
    const offer2 = offerOf(s, 2)!;
    const r = run(s, cmd.cancelSession('A'), at(1));
    expect(r.decision.status).toBe('APPLIED');
    const final = r.snapshot;
    expect(sessionOf(final, 'A').status).toBe('CANCELLED');
    expect(sessionOf(final, 'A')).toMatchObject({ held: 0, confirmed: 0 });
    // 1 listed only A: ended. 2 keeps seq 2 and B; B is full (3 holds it) → QUEUED at the front.
    expect(regOf(final, 1)).toBeUndefined();
    expect(regOf(final, 2)).toMatchObject({ status: 'QUEUED', seq: 2, acceptable: ['B'] });
    expect(regOf(final, 4)).toMatchObject({ status: 'QUEUED', seq: 4, acceptable: ['B'] });
    expect(regOf(final, 5)).toMatchObject({ status: 'QUEUED', seq: 5, acceptable: ['B'] });
    // Nobody lists A any more, and no offer references it.
    expect(final.registrations.every((x) => !x.acceptable.includes('A'))).toBe(true);
    expect(final.offers.every((o) => o.sessionId !== 'A')).toBe(true);
    // The stale ACCEPT of a revoked offer: OFFER_NOT_ACTIVE (settled), never confirms anything.
    const stale = run(final, cmd.accept(2, offer2.id), at(2));
    expect(stale.decision.status).toBe('REJECTED');
    expect(stale.decision.reason).toBe('OFFER_NOT_ACTIVE');
    expect(run(final, cmd.accept(1, offer1.id), at(2)).decision.reason).toBe('OFFER_NOT_ACTIVE');
    // 3 declines B: the seat goes to 2 (seq 2) before 4 and 5 (R2 after displacement).
    const declined = run(stale.snapshot, cmd.decline(3, offerOf(stale.snapshot, 3)!.id), at(3));
    expect(offerOf(declined.snapshot, 2)?.sessionId).toBe('B');
    expect(regOf(declined.snapshot, 4)?.status).toBe('QUEUED');
  });

  it('an ACCEPT that arrives while the session drain is still pending is rejected with SESSION_CANCELLED and the seat is still released', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 30 }, { id: 'B', capacity: 1 }] });
    const s = registerMany(s0, Array.from({ length: 30 }, (_, i) => i + 1), ['A'], at(0));
    expect(s.offers).toHaveLength(30);
    // A tiny budget leaves the drain pending after the CANCEL_SESSION decision.
    const limits = { maxItemsPerDecision: 20 };
    const first = step(s, cmd.cancelSession('A'), at(1), limits);
    expect(first.decision.continuation).toBeDefined();
    expect(sessionOf(first.snapshot, 'A').status).toBe('CANCELLING');
    const stillLive = first.snapshot.offers[0]!;
    const accept = step(first.snapshot, cmd.accept(stillLive.userId.slice(1), stillLive.id), at(1), limits);
    expect(accept.decision.status).toBe('REJECTED');
    expect(accept.decision.reason).toBe('SESSION_CANCELLED');
    expectHardInvariants(accept.snapshot, at(1));
    // Let the chain finish: everything referencing A is gone and every holder was told once.
    const done = run(accept.snapshot, cmd.reallocate(), at(1), limits);
    expect(sessionOf(done.snapshot, 'A')).toMatchObject({ status: 'CANCELLED', held: 0, confirmed: 0 });
    expect(done.snapshot.registrations).toEqual([]);
    expect(done.snapshot.offers).toEqual([]);
  });
});

describe('audit: re-registration (R6) and decline (R5)', () => {
  it('a participant whose last session was declined may register again and joins the back of the queue for the very session declined', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 1 }, { id: 'B', capacity: 1 }] });
    let s = registerMany(s0, [1, 2, 3], ['A'], at(0)); // 1 holds A; 2, 3 queued
    const declined = run(s, cmd.decline(1, offerOf(s, 1)!.id), at(1));
    expect(declined.decision.resultForCommand?.registration).toMatchObject({
      status: 'ENDED',
      endReason: 'NO_ACCEPTABLE_SESSION',
    });
    expect(offerOf(declined.snapshot, 2)?.sessionId).toBe('A');
    s = declined.snapshot;
    const again = run(s, cmd.register(1, ['A']), at(2));
    expect(again.decision.status).toBe('APPLIED');
    expect(regOf(again.snapshot, 1)).toMatchObject({ status: 'QUEUED', seq: 4 });
    expect(again.decision.resultForCommand?.registration?.queuePosition).toBe(2); // behind 3
    // 2 declines: the seat goes to 3 (seq 3), not back to 1 (seq 4).
    const next = run(again.snapshot, cmd.decline(2, offerOf(again.snapshot, 2)!.id), at(3));
    expect(offerOf(next.snapshot, 3)).toBeDefined();
    expect(regOf(next.snapshot, 1)?.status).toBe('QUEUED');
  });

  it('a decline is rejected (OFFER_NOT_ACTIVE) once the same offer was declined; the seat is relayed once', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 1 }, { id: 'B' }] });
    const s = registerMany(s0, [1, 2, 3], ['A'], at(0));
    const offer = offerOf(s, 1)!;
    const once = run(s, cmd.decline(1, offer.id), at(1));
    const twice = run(once.snapshot, cmd.decline(1, offer.id), at(1));
    expect(twice.decision.status).toBe('REJECTED');
    expect(twice.decision.reason).toBe('OFFER_NOT_ACTIVE');
    expect(twice.decision.writes).toEqual([]);
    expect(sessionOf(twice.snapshot, 'A')).toMatchObject({ held: 1, confirmed: 0 });
    expect(offerOf(twice.snapshot, 2)).toBeDefined();
    expect(regOf(twice.snapshot, 3)?.status).toBe('QUEUED');
  });
});

describe('audit: the action budget overflow path with duplicates', () => {
  it('a mass expiry (100 holds, 60 waiting) hit by duplicate ticks and an interleaved command converges, relays every seat once and stays in budget', () => {
    const s0 = makeSnapshot({ holdSeconds: 60, sessions: [{ id: 'A', capacity: 100 }, { id: 'B', capacity: 1 }] });
    const holders = Array.from({ length: 100 }, (_, i) => i + 1);
    const waiting = Array.from({ length: 60 }, (_, i) => 101 + i);
    let s = registerMany(s0, holders, ['A'], at(0));
    s = registerMany(s, waiting, ['A'], at(0));
    expect(s.offers).toHaveLength(100);
    const now = at(2); // every hold expired at +1
    const queue: Command[] = [cmd.tick('TIMER'), cmd.tick('TIMER')]; // the duplicate timer tick
    let decisions = 0;
    let created = 0;
    let expired = 0;
    let interleaved = false;
    while (queue.length > 0) {
      const command = queue.shift()!;
      const r = step(s, command, now);
      decisions += 1;
      expect(estimateCommitItems(r.decision)).toBeLessThanOrEqual(90);
      expect(r.decision.metrics.offersCreated).toBeLessThanOrEqual(12);
      expect(r.decision.metrics.offersExpired).toBeLessThanOrEqual(12);
      created += r.decision.metrics.offersCreated;
      expired += r.decision.metrics.offersExpired;
      s = r.snapshot;
      expectHardInvariants(s, now);
      if (r.decision.continuation !== undefined) {
        if (!interleaved) {
          interleaved = true;
          queue.push(cmd.register(200, ['A'])); // a user command already queued behind the chain
          queue.push(cmd.tick('SWEEP')); // and a sweep tick
        }
        queue.push(r.decision.continuation);
      }
      expect(decisions).toBeLessThan(200);
    }
    expect(expired).toBe(100);
    expect(created).toBe(61); // 60 waiting + the interleaved registrant
    expect(checkInvariants(s, now).violations).toEqual([]);
    expect(s.pendingBackfills).toEqual([]);
    expect(sessionOf(s, 'A')).toMatchObject({ held: 61, confirmed: 0 });
    expect(s.registrations.filter((x) => x.status === 'QUEUED')).toEqual([]);
    expect(s.workshop.nextDueAt).toBe(addSeconds(now, 60));
  });

  it('a cancelled workshop hit by duplicate continuations and late user commands ends with no live items and one notice per user', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 20 }, { id: 'B', capacity: 20 }] });
    const users = Array.from({ length: 50 }, (_, i) => i + 1);
    let s = registerMany(s0, users, ['A', 'B'], at(0));
    const now = at(1);
    const queue: Command[] = [cmd.cancelWorkshop(), cmd.cancelWorkshop()];
    const notified = new Map<string, number>();
    let guard = 0;
    while (queue.length > 0) {
      const command = queue.shift()!;
      const r = step(s, command, now);
      expect(estimateCommitItems(r.decision)).toBeLessThanOrEqual(90);
      for (const n of r.decision.notifications) {
        if (n.kind === 'WORKSHOP_CANCELLED') {
          notified.set(n.userId, (notified.get(n.userId) ?? 0) + 1);
        }
      }
      s = r.snapshot;
      expectHardInvariants(s, now);
      if (r.decision.continuation !== undefined) {
        queue.push(r.decision.continuation, r.decision.continuation, cmd.register(99, ['A']), cmd.accept(1, 'id-x'));
      }
      expect(++guard).toBeLessThan(100);
    }
    expect(s.workshop.status).toBe('CANCELLED');
    expect(s.registrations).toEqual([]);
    expect(s.offers).toEqual([]);
    expect(s.sessions.every((x) => x.status === 'CANCELLED' && x.held === 0 && x.confirmed === 0)).toBe(true);
    expect(s.workshop.nextDueAt).toBeUndefined();
    expect([...notified.values()].every((count) => count === 1)).toBe(true);
    expect(notified.size).toBe(50);
    expect(run(s, cmd.open(), now).decision.reason).toBe('WORKSHOP_CANCELLED');
    expect(run(s, cmd.tick('SWEEP'), now).decision.writes).toEqual([]);
  });
});

describe('audit: clock skew between decisions', () => {
  it('a decision whose server time is earlier than the previous one keeps every invariant and never shortens or lengthens a hold', () => {
    const s0 = makeSnapshot({ holdSeconds: 120, sessions: [{ id: 'A', capacity: 1 }, { id: 'B', capacity: 1 }] });
    let s = registerMany(s0, [1, 2, 3], ['A', 'B'], at(10)); // 1→A, 2→B at +10
    // A tick from a worker whose clock is 3 minutes behind: nothing is due, no writes.
    const behind = run(s, cmd.tick('TIMER'), at(7));
    expect(behind.decision.writes).toEqual([]);
    // A registration processed with the earlier clock: its offer would have to wait (both full).
    s = run(s, cmd.register(4, ['A']), at(7)).snapshot;
    // 2 declines at the earlier clock: the relayed offer expires 120 s after THAT clock.
    const declined = run(s, cmd.decline(2, offerOf(s, 2)!.id), at(7));
    const relayed = offerOf(declined.snapshot, 3)!;
    expect(relayed.createdAt).toBe(at(7));
    expect(relayed.expiresAt).toBe(addSeconds(at(7), 120));
    // Back on the later clock, 1's hold (created +10) is still alive at +11 and dead at +12.
    expect(run(declined.snapshot, cmd.accept(1, offerOf(s, 1)!.id), at(11)).decision.status).toBe('APPLIED');
    expect(run(declined.snapshot, cmd.accept(1, offerOf(s, 1)!.id), at(12)).decision.reason).toBe('OFFER_EXPIRED');
    for (const now of [at(7), at(11), at(12), at(5)]) {
      expect(checkInvariants(run(declined.snapshot, cmd.tick('SWEEP'), now).snapshot, now).violations).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------ property test */

const sessionArb = fc.record({
  capacity: fc.integer({ min: 1, max: 5 }),
  startOffsetMin: fc.integer({ min: 32, max: 20 * 60 }),
});

const setupArb = fc.record({
  mode: fc.constantFrom<WorkshopMode>('UNIFIED', 'PER_SESSION'),
  holdSeconds: fc.integer({ min: 30, max: 600 }),
  sessions: fc.array(sessionArb, { minLength: 2, maxLength: 5 }),
  nUsers: fc.integer({ min: 1, max: 25 }),
  maxOffers: fc.integer({ min: 1, max: 12 }),
  maxExpiries: fc.integer({ min: 1, max: 12 }),
  maxItems: fc.integer({ min: 40, max: 90 }),
});

type Kind =
  | 'REGISTER'
  | 'ACCEPT'
  | 'DECLINE'
  | 'CANCEL'
  | 'SET_CAPACITY'
  | 'CANCEL_SESSION'
  | 'CANCEL_WORKSHOP'
  | 'CLOSE'
  | 'OPEN'
  | 'TICK'
  | 'REALLOCATE';

const kindArb: fc.Arbitrary<Kind> = fc.oneof(
  { arbitrary: fc.constant<Kind>('REGISTER'), weight: 30 },
  { arbitrary: fc.constant<Kind>('ACCEPT'), weight: 14 },
  { arbitrary: fc.constant<Kind>('DECLINE'), weight: 8 },
  { arbitrary: fc.constant<Kind>('CANCEL'), weight: 8 },
  { arbitrary: fc.constant<Kind>('SET_CAPACITY'), weight: 8 },
  { arbitrary: fc.constant<Kind>('CANCEL_SESSION'), weight: 3 },
  { arbitrary: fc.constant<Kind>('CANCEL_WORKSHOP'), weight: 1 },
  { arbitrary: fc.constant<Kind>('CLOSE'), weight: 2 },
  { arbitrary: fc.constant<Kind>('OPEN'), weight: 2 },
  { arbitrary: fc.constant<Kind>('TICK'), weight: 12 },
  { arbitrary: fc.constant<Kind>('REALLOCATE'), weight: 3 },
);

const stepArb = fc.record({
  /** The clock may go backwards by up to 3 minutes (skew between workers) or forward by up to 40. */
  dtSeconds: fc.integer({ min: -180, max: 40 * 60 }),
  kind: kindArb,
  u: fc.nat({ max: 1_000 }),
  k: fc.nat({ max: 1_000 }),
  s: fc.nat({ max: 1_000 }),
  cap: fc.integer({ min: 0, max: 8 }),
  prefs: fc.array(fc.nat({ max: 1_000 }), { minLength: 1, maxLength: 5 }),
});

type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never;
type Setup = ArbValue<typeof setupArb>;
type Step = ArbValue<typeof stepArb> & { last?: boolean };

function buildSnapshot(setup: Setup): WorkshopSnapshot {
  const workshop = newWorkshop({
    id: WS,
    orgId: 'org',
    title: 'Audit workshop',
    mode: setup.mode,
    holdSeconds: setup.holdSeconds,
    createdAt: T0,
  });
  const sessions = setup.sessions.map((spec, index) =>
    newSession({
      id: `S${index}`,
      workshopId: WS,
      title: `Session ${index}`,
      startsAt: addMinutes(T0, spec.startOffsetMin),
      capacity: spec.capacity,
    }),
  );
  return { workshop, sessions, registrations: [], offers: [], pendingBackfills: [] };
}

const actor = (n: number) => ({
  commandId: UUID,
  workshopId: WS,
  actorUserId: `u${n}`,
  actorEmail: `u${n}@example.com`,
});

function toCommand(step: Step, setup: Setup, snapshot: WorkshopSnapshot): Command {
  const n = step.u % setup.nUsers;
  const sessionIds = snapshot.sessions.map((session) => session.id);
  const pick = (index: number) => sessionIds[index % sessionIds.length]!;
  switch (step.kind) {
    case 'REGISTER': {
      const acceptable =
        setup.mode === 'PER_SESSION' ? [pick(step.prefs[0]!)] : [...new Set(step.prefs.map(pick))];
      return { type: 'REGISTER', ...actor(n), acceptable };
    }
    case 'ACCEPT':
    case 'DECLINE': {
      const offers = [...snapshot.offers].sort((a, b) => (a.id < b.id ? -1 : 1));
      const settled = snapshot.settledOffers ?? [];
      const offer =
        step.k % 9 === 0 && settled.length > 0
          ? settled[step.k % settled.length]
          : offers[step.k % Math.max(1, offers.length)];
      const offerId = offer?.id ?? `missing-${step.k}`;
      const owner = offer === undefined || step.k % 17 === 0 ? n : Number(offer.userId.slice(1));
      return step.kind === 'ACCEPT'
        ? { type: 'ACCEPT_OFFER', ...actor(owner), offerId }
        : { type: 'DECLINE_OFFER', ...actor(owner), offerId };
    }
    case 'CANCEL':
      return step.k % 3 === 0
        ? { type: 'CANCEL_REGISTRATION', ...actor(n), sessionId: pick(step.s) }
        : { type: 'CANCEL_REGISTRATION', ...actor(n) };
    case 'SET_CAPACITY':
      return { type: 'SET_CAPACITY', ...actor(999), sessionId: pick(step.s), capacity: step.cap };
    case 'CANCEL_SESSION':
      return { type: 'CANCEL_SESSION', ...actor(999), sessionId: pick(step.s) };
    case 'CANCEL_WORKSHOP':
      return step.last
        ? { type: 'CANCEL_WORKSHOP', ...actor(999) }
        : { type: step.k % 2 === 0 ? 'CLOSE_REGISTRATION' : 'OPEN_REGISTRATION', ...actor(999) };
    case 'CLOSE':
      return { type: 'CLOSE_REGISTRATION', ...actor(999) };
    case 'OPEN':
      return { type: 'OPEN_REGISTRATION', ...actor(999) };
    case 'TICK':
      return { type: 'TICK', workshopId: WS, source: step.k % 2 === 0 ? 'SWEEP' : 'TIMER' };
    case 'REALLOCATE':
      return { type: 'REALLOCATE', workshopId: WS };
  }
}

function makeCtx(now: string, limits: DecisionLimits, start: number): DecideContext {
  let counter = 0;
  return { now, newId: () => `o${start}-${++counter}`, limits };
}

function hardViolations(snapshot: WorkshopSnapshot, now: string) {
  return checkInvariants(snapshot, now).violations.filter((v) => v.code !== 'NO_STARVATION');
}

/** The snapshot minus the fields a no-op write legitimately changes (version, updatedAt). */
function comparable(snapshot: WorkshopSnapshot): unknown {
  const { version: _v, updatedAt: _u, ...workshop } = snapshot.workshop;
  return {
    workshop,
    sessions: snapshot.sessions,
    registrations: snapshot.registrations,
    offers: snapshot.offers,
    pendingBackfills: snapshot.pendingBackfills,
  };
}

/**
 * R2/R3 on every new offer of a decision: the taker is the lowest seq among the QUEUED
 * registrations that could take the session (nobody with a lower seq still waits for it), and
 * the session is the first of the taker's preferences that could be offered (every preferred
 * session is not allocatable after the decision: seats are only consumed by allocation).
 */
function assertOfferOrder(decision: Decision, after: WorkshopSnapshot, now: string, what: string): void {
  const sessionById = new Map(after.sessions.map((session) => [session.id, session]));
  for (const write of decision.writes) {
    if (write.kind !== 'PUT_OFFER') {
      continue;
    }
    const offer = write.offer;
    const taker = after.registrations.find((r) => r.seq === offer.registrationSeq);
    if (taker === undefined) {
      throw new Error(`${what}: offer ${offer.id} has no live registration`);
    }
    expect(taker.acceptable, `${what}: offered a session the taker did not list`).toContain(offer.sessionId);
    const session = sessionById.get(offer.sessionId)!;
    expect(session.status, `${what}: offered a non-OPEN session`).toBe('OPEN');
    expect(nowOf(session.cutoffAt), `${what}: offered past cut-off`).toBeGreaterThan(nowOf(now));
    expect(offer.expiresAt).toBe(minIso(addSeconds(now, after.workshop.holdSeconds), session.cutoffAt));
    const overtaken = after.registrations.find(
      (r) => r.status === 'QUEUED' && r.seq < taker.seq && r.acceptable.includes(offer.sessionId),
    );
    expect(
      overtaken,
      `${what}: seq ${taker.seq} got ${offer.sessionId} while seq ${overtaken?.seq} (lower) still waits for it (R2)`,
    ).toBeUndefined();
    for (const preferred of taker.acceptable) {
      if (preferred === offer.sessionId) {
        break;
      }
      expect(
        allocatableAfter(sessionById.get(preferred), now),
        `${what}: seq ${taker.seq} got ${offer.sessionId} although preferred ${preferred} has a free seat (R3)`,
      ).toBe(false);
    }
  }
}

/**
 * R7 on every confirmed seat: between two decisions a CONFIRMED registration keeps its seat
 * unless its owner cancelled, the organiser cancelled that session, or the workshop is being
 * cancelled.
 */
function assertConfirmedKept(
  before: WorkshopSnapshot,
  after: WorkshopSnapshot,
  command: Command,
  what: string,
): void {
  const workshopCancelled = after.workshop.status === 'CANCELLING' || after.workshop.status === 'CANCELLED';
  for (const was of before.registrations) {
    if (was.status !== 'CONFIRMED') {
      continue;
    }
    const session = after.sessions.find((s) => s.id === was.confirmedSessionId);
    const sessionCancelled = session === undefined || session.status !== 'OPEN';
    const ownCancel =
      command.type === 'CANCEL_REGISTRATION' &&
      command.actorUserId === was.userId &&
      (command.sessionId === undefined ||
        before.workshop.mode === 'UNIFIED' ||
        was.acceptable[0] === command.sessionId);
    const now = after.registrations.find((r) => r.seq === was.seq);
    const kept =
      now !== undefined && now.status === 'CONFIRMED' && now.confirmedSessionId === was.confirmedSessionId;
    if (!kept && !workshopCancelled && !sessionCancelled && !ownCancel) {
      throw new Error(
        `${what}: confirmed registration ${was.seq} (${was.userId}, ${was.confirmedSessionId}) was moved by ${command.type}: ${JSON.stringify(now)}`,
      );
    }
  }
}

function assertDecisionShape(decision: Decision, limits: DecisionLimits, before: WorkshopSnapshot): void {
  expect(decision.metrics.offersCreated).toBeLessThanOrEqual(limits.maxOffersPerDecision);
  expect(decision.metrics.offersExpired).toBeLessThanOrEqual(limits.maxExpiriesPerDecision);
  expect(estimateCommitItems(decision), 'commit over the item budget').toBeLessThanOrEqual(
    limits.maxItemsPerDecision,
  );
  expect(decision.timers).toHaveLength(decision.metrics.offersCreated);
  const stateWrites = decision.writes.filter((w) => w.kind === 'PUT_WORKSHOP_STATE');
  if (decision.writes.length > 0) {
    expect(stateWrites).toHaveLength(1);
    expect(decision.writes[0]?.kind).toBe('PUT_WORKSHOP_STATE');
    expect(stateWrites[0]?.kind === 'PUT_WORKSHOP_STATE' && stateWrites[0].version).toBe(
      before.workshop.version + 1,
    );
  }
}

function assertSettled(snapshot: WorkshopSnapshot, now: string): void {
  const nowMs = nowOf(now);
  expect(snapshot.pendingBackfills, 'pending releases left after the chain').toEqual([]);
  expect(snapshot.workshop.status).not.toBe('CANCELLING');
  expect(snapshot.sessions.some((session) => session.status === 'CANCELLING')).toBe(false);
  for (const offer of snapshot.offers) {
    expect(nowOf(offer.expiresAt), `due offer ${offer.id} left live`).toBeGreaterThan(nowMs);
    expect(nowOf(offer.expiresAt) - nowOf(offer.createdAt)).toBeLessThanOrEqual(
      snapshot.workshop.holdSeconds * 1000,
    );
  }
  for (const registration of snapshot.registrations) {
    if (registration.status === 'QUEUED') {
      const alive = registration.acceptable.some((id) => {
        const session = snapshot.sessions.find((candidate) => candidate.id === id);
        return session !== undefined && isStillOpenForAllocation(session, nowMs);
      });
      expect(alive, `registration ${registration.seq} should have ended at cut-off`).toBe(true);
    }
  }
}

function withSettledOffers(previous: WorkshopSnapshot, next: WorkshopSnapshot, decision: Decision): WorkshopSnapshot {
  const settled = [
    ...(previous.settledOffers ?? []),
    ...decision.writes.flatMap((write) => (write.kind === 'ARCHIVE_OFFER' ? [write.offer] : [])),
  ].slice(-40);
  if (settled.length > 0) {
    next.settledOffers = settled;
  }
  return next;
}

const scriptArb = fc
  .oneof(
    { arbitrary: fc.integer({ min: 1, max: 40 }), weight: 3 },
    { arbitrary: fc.integer({ min: 41, max: 160 }), weight: 1 },
  )
  .chain((length) => fc.array(stepArb, { minLength: length, maxLength: length }));

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('audit: adversarial property test (skewed clock, duplicate commands, duplicate ticks and continuations)', () => {
  it('keeps R2/R3/R7, every invariant and the budget; a duplicate of an applied user command behaves like a TICK', async () => {
    let steps = 0;
    let replays = 0;
    let duplicates = 0;
    let backwards = 0;
    await fc.assert(
      fc.asyncProperty(setupArb, scriptArb, async (setup, script) => {
        const limits: DecisionLimits = {
          maxOffersPerDecision: setup.maxOffers,
          maxExpiriesPerDecision: setup.maxExpiries,
          maxItemsPerDecision: setup.maxItems,
        };
        let snapshot = buildSnapshot(setup);
        let now = T0;
        let idSeed = 0;
        for (const [index, drawn] of script.entries()) {
          steps += 1;
          if (steps % 50 === 0) {
            await yieldToEventLoop();
          }
          const step: Step = { ...drawn, last: index >= script.length - 5 };
          const next = addSeconds(now, step.dtSeconds);
          if (nowOf(next) < nowOf(now)) {
            backwards += 1;
          }
          now = nowOf(next) < nowOf(T0) ? T0 : next;
          const queue: Command[] = [toCommand(step, setup, snapshot)];
          let guard = 0;
          while (queue.length > 0) {
            const command = queue.shift()!;
            const before = snapshot;
            const ctx = makeCtx(now, limits, ++idSeed);
            const decision = decide(snapshot, command, ctx);
            const what = `step ${index} ${command.type} at ${now}`;
            assertDecisionShape(decision, limits, before);
            snapshot = withSettledOffers(before, applyChanges(before, decision.writes), decision);
            const hard = hardViolations(snapshot, now);
            if (hard.length > 0) {
              throw new Error(`${what}: ${JSON.stringify(hard)}`);
            }
            assertOfferOrder(decision, snapshot, now, what);
            assertConfirmedKept(before, snapshot, command, what);

            // A duplicate delivery of an APPLIED user command (same commandId re-POSTed after
            // the dedup window, or a redelivery the service failed to recognise) must be
            // observably a no-op: the same state as an internal TICK on this snapshot, and a
            // deterministic rejection unless the command is naturally idempotent (SET_CAPACITY).
            if (decision.status === 'APPLIED' && command.type !== 'TICK' && command.type !== 'REALLOCATE') {
              replays += 1;
              const replay = decide(snapshot, command, makeCtx(now, limits, idSeed + 100_000));
              const tick = decide(snapshot, { type: 'TICK', workshopId: WS }, makeCtx(now, limits, idSeed + 100_000));
              const afterReplay = applyChanges(snapshot, replay.writes);
              const afterTick = applyChanges(snapshot, tick.writes);
              expect(comparable(afterReplay), `${what}: replayed command changed the state`).toEqual(
                comparable(afterTick),
              );
              if (command.type !== 'SET_CAPACITY') {
                expect(replay.status, `${what}: replay was not rejected`).toBe('REJECTED');
              }
              expect(replay.continuation === undefined).toBe(tick.continuation === undefined);
            }

            if (decision.continuation !== undefined) {
              if (step.k % 3 === 0) {
                duplicates += 1;
                queue.push(decision.continuation); // delivered twice
              }
              if (step.k % 4 === 0) {
                now = addSeconds(now, step.s % 61);
                queue.push(command.type === 'TICK' ? command : toCommand({ ...step, kind: 'TICK' }, setup, snapshot));
              }
              queue.push(decision.continuation);
            }
            if (++guard > 500) {
              throw new Error('continuation chain did not converge');
            }
          }
          const report = checkInvariants(snapshot, now);
          if (!report.ok) {
            throw new Error(`step ${index} (${step.kind}) at ${now}: ${JSON.stringify(report.violations)}`);
          }
          assertSettled(snapshot, now);
        }
      }),
      { numRuns: 800 },
    );
    expect(replays).toBeGreaterThan(0);
    expect(duplicates).toBeGreaterThan(0);
    expect(backwards).toBeGreaterThan(0);
    console.log(`audit property: ${steps} steps, ${replays} replays, ${duplicates} duplicate continuations, ${backwards} backward clock moves`);
  });
});

/* ------------------------------------------------- PER_SESSION specifics */

describe('audit: PER_SESSION cancel-all with holds in several sessions', () => {
  it('releases every held and confirmed seat of the user and relays each one in the same decision', () => {
    const s0 = makeSnapshot({
      mode: 'PER_SESSION',
      sessions: [{ id: 'A', capacity: 1 }, { id: 'B', capacity: 1 }, { id: 'C', capacity: 1 }],
    });
    let s = s0;
    for (const id of ['A', 'B', 'C']) {
      s = run(s, cmd.register(1, [id]), at(0)).snapshot; // u1 holds A, B, C (duplicate holds)
      s = run(s, cmd.register(2, [id]), at(0)).snapshot; // u2 queued in each
    }
    const holdA = s.offers.find((o) => o.sessionId === 'A' && o.userId === 'u1')!;
    s = run(s, cmd.accept(1, holdA.id), at(0)).snapshot;
    expect(s.registrations.filter((r) => r.userId === 'u1').map((r) => r.status).sort()).toEqual([
      'CONFIRMED',
      'OFFERED',
      'OFFERED',
    ]);
    const r = run(s, cmd.cancel(1), at(1));
    expect(r.decision.status).toBe('APPLIED');
    expect(r.decision.backfills.map((b) => b.cause).sort()).toEqual([
      'CANCELLED_CONFIRMED',
      'CANCELLED_OFFER',
      'CANCELLED_OFFER',
    ]);
    expect(r.decision.backfills.every((b) => b.newUserId === 'u2')).toBe(true);
    expect(r.snapshot.registrations.filter((x) => x.userId === 'u1')).toEqual([]);
    expect(r.snapshot.offers.map((o) => o.userId)).toEqual(['u2', 'u2', 'u2']);
    expect(estimateCommitItems(r.decision)).toBeLessThanOrEqual(90);
  });
});

/* ------------------------------------------------------ registration shape */

describe('audit: registration lists', () => {
  it('a registration keeps only sessions it can still get; a hold is never created for a session outside the list', () => {
    const s0 = makeSnapshot({
      sessions: [{ id: 'A', capacity: 1 }, { id: 'B', capacity: 1 }, { id: 'C', startsInMinutes: 35 }],
    });
    let s = run(s0, cmd.cancelSession('B'), at(0)).snapshot;
    const r = run(s, cmd.register(1, ['C', 'B', 'A']), at(6)); // B cancelled, C past cut-off at +5
    expect(r.decision.status).toBe('APPLIED');
    expect(regOf(r.snapshot, 1)).toMatchObject({ status: 'OFFERED', acceptable: ['A'] });
    s = r.snapshot;
    // The organiser raises C after its cut-off: still never offered.
    const raised = run(s, cmd.setCapacity('C', 10), at(6));
    expect(raised.decision.status).toBe('APPLIED');
    expect(raised.snapshot.offers.every((o) => o.sessionId === 'A')).toBe(true);
  });
});

/* ---------------------------------------------------- helpers smoke check */

describe('audit: harness sanity', () => {
  it('the comparable() projection ignores only version and updatedAt', () => {
    const s = makeSnapshot();
    const bumped: WorkshopSnapshot = {
      ...s,
      workshop: { ...s.workshop, version: 7, updatedAt: at(9) },
    };
    expect(comparable(bumped)).toEqual(comparable(s));
    const changed: WorkshopSnapshot = { ...s, workshop: { ...s.workshop, status: 'CLOSED' } };
    expect(comparable(changed)).not.toEqual(comparable(s));
    const registration: Registration = {
      workshopId: WS,
      userId: 'u1',
      email: 'u1@example.com',
      seq: 1,
      acceptable: ['A'],
      status: 'QUEUED',
      createdAt: T0,
      updatedAt: T0,
    };
    expect(comparable({ ...s, registrations: [registration] })).not.toEqual(comparable(s));
  });
});
