import type { Command, WorkshopMode } from '@seatrelay/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  addSeconds,
  applyChanges,
  checkInvariants,
  decide,
  estimateCommitItems,
  isStillOpenForAllocation,
  newSession,
  newWorkshop,
  parseIso,
  type DecideContext,
  type Decision,
  type DecisionLimits,
  type WorkshopSnapshot,
} from '../src/index';
import { T0, UUID, WS } from './helpers';

/**
 * Model-based property test (plan §2.2): random command sequences (length ≤ 200) over 2–5
 * sessions and up to 40 users, with random clock advances (0–20 min), random holdSeconds
 * (30–900 s) and random per-decision limits (offers, expiries and the item budget). Each
 * step's continuation chain is run through a FIFO in which another random command may be
 * interleaved (as the real queue does), with the clock moving on. After EVERY committed
 * decision the hard invariants (everything but no-starvation) hold and the commit fits the
 * item budget; after every step's chain the snapshot must satisfy every invariant, contain no
 * due offer, no starving registration, no cut-off-ended queue entry and no pending
 * cancellation drain, and the engine must be pure and deterministic.
 */

const sessionArb = fc.record({
  capacity: fc.integer({ min: 1, max: 6 }),
  startOffsetMin: fc.integer({ min: 35, max: 36 * 60 }),
});

const setupArb = fc.record({
  mode: fc.constantFrom<WorkshopMode>('UNIFIED', 'PER_SESSION'),
  holdSeconds: fc.integer({ min: 30, max: 900 }),
  sessions: fc.array(sessionArb, { minLength: 2, maxLength: 5 }),
  nUsers: fc.integer({ min: 1, max: 40 }),
  maxOffers: fc.integer({ min: 1, max: 12 }),
  maxExpiries: fc.integer({ min: 1, max: 12 }),
  /** 40 leaves exactly room for the largest user command (PER_SESSION cancel-all of 5). */
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
  { arbitrary: fc.constant<Kind>('SET_CAPACITY'), weight: 6 },
  { arbitrary: fc.constant<Kind>('CANCEL_SESSION'), weight: 2 },
  { arbitrary: fc.constant<Kind>('CANCEL_WORKSHOP'), weight: 1 },
  { arbitrary: fc.constant<Kind>('CLOSE'), weight: 2 },
  { arbitrary: fc.constant<Kind>('OPEN'), weight: 2 },
  { arbitrary: fc.constant<Kind>('TICK'), weight: 12 },
  { arbitrary: fc.constant<Kind>('REALLOCATE'), weight: 3 },
);

const stepArb = fc.record({
  dtSeconds: fc.integer({ min: 0, max: 20 * 60 }),
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
    title: 'Property workshop',
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

/** Resolves a random step against the current state into a concrete command. */
function toCommand(step: Step, setup: Setup, snapshot: WorkshopSnapshot): Command {
  const n = step.u % setup.nUsers;
  const sessionIds = snapshot.sessions.map((session) => session.id);
  const pick = (index: number) => sessionIds[index % sessionIds.length]!;
  switch (step.kind) {
    case 'REGISTER': {
      let acceptable: string[];
      if (setup.mode === 'PER_SESSION') {
        acceptable = [pick(step.prefs[0]!)];
        if (step.k % 29 === 0) {
          acceptable.push(pick(step.prefs[0]! + 1)); // PER_SESSION_REQUIRES_ONE_SESSION
        }
      } else {
        acceptable = [...new Set(step.prefs.map(pick))];
        if (step.k % 23 === 0) {
          acceptable.push(acceptable[0]!); // DUPLICATE_SESSION_IN_PREFERENCES
        } else if (step.k % 31 === 0) {
          acceptable.push('ghost'); // UNKNOWN_SESSION_IN_PREFERENCES
        }
      }
      return { type: 'REGISTER', ...actor(n), acceptable };
    }
    case 'ACCEPT':
    case 'DECLINE': {
      // Mostly a live offer answered by its owner; sometimes a missing id, a stranger, or an
      // offer that was settled earlier (the user retrying after the fact).
      const offers = [...snapshot.offers].sort((a, b) => (a.id < b.id ? -1 : 1));
      const settled = snapshot.settledOffers ?? [];
      const offer =
        step.k % 13 === 0
          ? undefined
          : step.k % 7 === 0 && settled.length > 0
            ? settled[step.k % settled.length]
            : offers[step.k % Math.max(1, offers.length)];
      const offerId = offer?.id ?? `missing-${step.k}`;
      const owner = offer === undefined || step.k % 11 === 0 ? n : Number(offer.userId.slice(1));
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
      // absorbing: everything after it is a WORKSHOP_CANCELLED rejection, so keep it for the
      // last steps of a script and turn the earlier draws into a CLOSE/OPEN pair
      return step.last
        ? { type: 'CANCEL_WORKSHOP', ...actor(999) }
        : { type: step.k % 2 === 0 ? 'CLOSE_REGISTRATION' : 'OPEN_REGISTRATION', ...actor(999) };
    case 'CLOSE':
      return { type: 'CLOSE_REGISTRATION', ...actor(999) };
    case 'OPEN':
      return { type: 'OPEN_REGISTRATION', ...actor(999) };
    case 'TICK':
      return step.k % 2 === 0
        ? { type: 'TICK', workshopId: WS, source: 'SWEEP' }
        : { type: 'TICK', workshopId: WS, source: 'TIMER' };
    case 'REALLOCATE':
      return { type: 'REALLOCATE', workshopId: WS };
  }
}

function makeCtx(now: string, limits: DecisionLimits, start: number): DecideContext {
  let counter = 0;
  return { now, newId: () => `o${start}-${++counter}`, limits };
}

/** Invariants that must hold after every committed decision, continuation pending or not. */
function assertHardInvariants(snapshot: WorkshopSnapshot, now: string, what: string): void {
  const report = checkInvariants(snapshot, now);
  const hard = report.violations.filter((violation) => violation.code !== 'NO_STARVATION');
  if (hard.length > 0) {
    throw new Error(`invariants violated after ${what} at ${now}: ${JSON.stringify(hard)}`);
  }
}

/** Post-step assertions that go beyond checkInvariants (which must hold between decisions too). */
function assertSettled(snapshot: WorkshopSnapshot, now: string): void {
  const nowMs = parseIso(now);
  expect(snapshot.pendingBackfills, 'pending releases left after the chain').toEqual([]);
  expect(snapshot.workshop.status).not.toBe('CANCELLING');
  expect(snapshot.sessions.some((session) => session.status === 'CANCELLING')).toBe(false);
  for (const offer of snapshot.offers) {
    expect(parseIso(offer.expiresAt), `due offer ${offer.id} left live`).toBeGreaterThan(nowMs);
    expect(parseIso(offer.expiresAt) - parseIso(offer.createdAt)).toBeLessThanOrEqual(
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
  if (snapshot.workshop.status === 'CANCELLED') {
    expect(snapshot.workshop.nextDueAt).toBeUndefined();
  } else if (snapshot.offers.length > 0) {
    const earliest = snapshot.offers
      .map((offer) => parseIso(offer.expiresAt))
      .sort((a, b) => a - b)[0]!;
    expect(snapshot.workshop.nextDueAt).toBeDefined();
    expect(parseIso(snapshot.workshop.nextDueAt!)).toBeLessThanOrEqual(earliest);
    expect(parseIso(snapshot.workshop.nextDueAt!)).toBeGreaterThan(nowMs);
  }
}

function assertDecisionShape(
  decision: Decision,
  limits: DecisionLimits,
  before: WorkshopSnapshot,
): void {
  expect(decision.metrics.offersCreated).toBeLessThanOrEqual(limits.maxOffersPerDecision);
  expect(decision.metrics.offersExpired).toBeLessThanOrEqual(limits.maxExpiriesPerDecision);
  expect(estimateCommitItems(decision), 'commit over the item budget').toBeLessThanOrEqual(
    limits.maxItemsPerDecision,
  );
  expect(decision.timers).toHaveLength(decision.metrics.offersCreated);
  expect(decision.writes.filter((w) => w.kind === 'PUT_OFFER')).toHaveLength(
    decision.metrics.offersCreated,
  );
  expect(decision.metrics.backfillLatenciesMs.every((ms) => ms >= 0)).toBe(true);
  const stateWrites = decision.writes.filter((w) => w.kind === 'PUT_WORKSHOP_STATE');
  expect(stateWrites.length).toBeLessThanOrEqual(1);
  if (decision.writes.length > 0) {
    expect(stateWrites).toHaveLength(1);
    expect(decision.writes[0]?.kind).toBe('PUT_WORKSHOP_STATE');
    expect(stateWrites[0]?.kind === 'PUT_WORKSHOP_STATE' && stateWrites[0].version).toBe(
      before.workshop.version + 1,
    );
  }
  if (decision.status === 'REJECTED') {
    expect(decision.reason).toBeDefined();
    expect(decision.resultForCommand).toBeUndefined();
  }
  // at most one write per entity
  const keys = decision.writes.map((w) => {
    switch (w.kind) {
      case 'PUT_WORKSHOP_STATE':
        return 'workshop';
      case 'PUT_SESSION':
        return `session:${w.session.id}`;
      case 'PUT_REGISTRATION':
      case 'ARCHIVE_REGISTRATION':
        return `registration:${w.registration.seq}`;
      case 'PUT_OFFER':
      case 'ARCHIVE_OFFER':
        return `offer:${w.offer.id}`;
      case 'PUT_BACKFILL':
      case 'PUT_PENDING_BACKFILL':
      case 'ARCHIVE_BACKFILL':
        return `backfill:${w.record.id}`;
    }
  });
  expect(new Set(keys).size).toBe(keys.length);
}

/** Sequence length: anything up to 200, skewed towards shorter scripts to keep the run fast. */
const scriptArb = fc
  .oneof(
    { arbitrary: fc.integer({ min: 1, max: 40 }), weight: 3 },
    { arbitrary: fc.integer({ min: 41, max: 200 }), weight: 1 },
  )
  .chain((length) => fc.array(stepArb, { minLength: length, maxLength: length }));

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const INTERLEAVE_KINDS: readonly Kind[] = ['REGISTER', 'ACCEPT', 'CANCEL', 'TICK'];

/** What the service does for the next ACCEPT/DECLINE: hand the engine the archived offers. */
function withSettledOffers(
  previous: WorkshopSnapshot,
  next: WorkshopSnapshot,
  decision: Decision,
): WorkshopSnapshot {
  const settled = [
    ...(previous.settledOffers ?? []),
    ...decision.writes.flatMap((write) => (write.kind === 'ARCHIVE_OFFER' ? [write.offer] : [])),
  ].slice(-20);
  if (settled.length > 0) {
    next.settledOffers = settled;
  }
  return next;
}

describe('decide() property test', () => {
  it('keeps every invariant after 2,000 random command sequences', async () => {
    let steps = 0;
    let decisions = 0;
    let continuations = 0;
    let interleaved = 0;
    let longest = 0;
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
        longest = Math.max(longest, script.length);
        for (const [index, drawn] of script.entries()) {
          steps += 1;
          if (steps % 50 === 0) {
            await yieldToEventLoop(); // keep the vitest worker responsive
          }
          const step: Step = { ...drawn, last: index >= script.length - 5 };
          now = addSeconds(now, step.dtSeconds);
          // The workshop's FIFO group: the step's command, then whatever it spawns. A random
          // command may be interleaved before a continuation, like a user command that was
          // already queued when the overflowing decision committed.
          const queue: Command[] = [toCommand(step, setup, snapshot)];
          let guard = 0;
          while (queue.length > 0) {
            const command = queue.shift()!;
            const before = JSON.stringify(snapshot);
            const ctx = makeCtx(now, limits, ++idSeed);
            const decision = decide(snapshot, command, ctx);
            decisions += 1;
            if (JSON.stringify(snapshot) !== before) {
              throw new Error('decide mutated its input snapshot');
            }
            if (steps % 7 === 0) {
              const replay = decide(snapshot, command, makeCtx(now, limits, idSeed));
              if (JSON.stringify(replay) !== JSON.stringify(decision)) {
                throw new Error('decide is not deterministic');
              }
            }
            assertDecisionShape(decision, limits, snapshot);
            snapshot = withSettledOffers(
              snapshot,
              applyChanges(snapshot, decision.writes),
              decision,
            );
            assertHardInvariants(snapshot, now, command.type);
            if (decision.continuation !== undefined) {
              continuations += 1;
              if (step.k % 4 === 0) {
                interleaved += 1;
                now = addSeconds(now, step.s % 121);
                queue.push(
                  toCommand({ ...step, kind: INTERLEAVE_KINDS[step.s % 4]! }, setup, snapshot),
                );
              }
              queue.push(decision.continuation);
            }
            if (++guard > 500) {
              throw new Error('continuation chain did not converge');
            }
          }
          const report = checkInvariants(snapshot, now);
          if (!report.ok) {
            throw new Error(
              `invariants violated after step ${index} (${step.kind}) at ${now}: ${JSON.stringify(report.violations)}`,
            );
          }
          assertSettled(snapshot, now);
        }
      }),
      { numRuns: 2_000 },
    );
    expect(steps).toBeGreaterThan(2_000);
    expect(longest).toBeGreaterThan(150);
    expect(continuations).toBeGreaterThan(0);
    expect(interleaved).toBeGreaterThan(0);
    console.log(
      `property test: 2000 runs, ${steps} steps (longest ${longest}), ${decisions} decisions, ${continuations} continuations, ${interleaved} interleaved commands`,
    );
  });
});
