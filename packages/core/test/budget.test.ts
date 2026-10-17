import { describe, expect, it } from 'vitest';
import {
  COMMIT_ITEM_COST,
  DEFAULT_DECISION_LIMITS,
  MAX_ITEMS_PER_DECISION,
  UNIT_ITEM_COST,
  checkInvariants,
  estimateCommitItems,
  type Decision,
  type WorkshopSnapshot,
} from '../src/index';
import {
  at,
  cmd,
  makeSnapshot,
  offerOf,
  regOf,
  registerMany,
  run,
  step,
  writeHistogram,
} from './helpers';

/**
 * The item budget (plan §2.3: one commit = one DynamoDB `TransactWriteItems` of at most 100
 * items). Every decision at the default limits must stay at or below MAX_ITEMS_PER_DECISION
 * under the pessimistic `COMMIT_ITEM_COST` mapping, notifications and CommandResult included,
 * whatever the shape of the workshop; the remainder is drained by the continuation chain.
 */

const DYNAMODB_TRANSACTION_LIMIT = 100;

function expectWithinBudget(decision: Decision, budget = MAX_ITEMS_PER_DECISION): void {
  expect(estimateCommitItems(decision)).toBeLessThanOrEqual(budget);
  expect(estimateCommitItems(decision)).toBeLessThan(DYNAMODB_TRANSACTION_LIMIT);
}

/** Probe scenario (a): 5 sessions, 15 holders listing one session each, 30 queued listing all. */
function fiveSessionsScenario(): WorkshopSnapshot {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const s0 = makeSnapshot({
    holdSeconds: 60,
    sessions: ids.map((id) => ({ id, capacity: 3 })),
  });
  let s = s0;
  let n = 1;
  for (const id of ids) {
    s = registerMany(s, [n, n + 1, n + 2], [id], at(0)); // 3 holders per session
    n += 3;
  }
  const queued = Array.from({ length: 30 }, (_, i) => 16 + i);
  s = registerMany(s, queued, ids, at(0));
  expect(s.offers).toHaveLength(15);
  expect(s.registrations.filter((r) => r.status === 'QUEUED')).toHaveLength(30);
  return s;
}

/** Probe scenario (c), the backfill-latency experiment: 1 session cap 100, 100 holders, 50 waiting. */
function massExpiryScenario(): WorkshopSnapshot {
  const s0 = makeSnapshot({ holdSeconds: 60, sessions: [{ id: 'A', capacity: 100 }, { id: 'B' }] });
  const holders = Array.from({ length: 100 }, (_, i) => i + 1);
  const waiting = Array.from({ length: 50 }, (_, i) => 101 + i);
  let s = registerMany(s0, holders, ['A'], at(0));
  s = run(s, cmd.register(999, ['B']), at(0)).snapshot; // B is taken
  s = run(s, cmd.accept(999, offerOf(s, 999)!.id), at(0)).snapshot;
  s = registerMany(s, waiting, ['A'], at(0));
  expect(s.offers).toHaveLength(100);
  return s;
}

describe('item budget (DynamoDB 100-item transaction)', () => {
  it('documents the mapping and the defaults', () => {
    expect(MAX_ITEMS_PER_DECISION).toBe(90);
    expect(DEFAULT_DECISION_LIMITS.maxItemsPerDecision).toBe(MAX_ITEMS_PER_DECISION);
    expect(COMMIT_ITEM_COST).toEqual({
      PUT_WORKSHOP_STATE: 1,
      PUT_SESSION: 1,
      PUT_REGISTRATION: 2,
      ARCHIVE_REGISTRATION: 3,
      PUT_OFFER: 1,
      ARCHIVE_OFFER: 2,
      PUT_BACKFILL: 1,
      PUT_PENDING_BACKFILL: 1,
      ARCHIVE_BACKFILL: 2,
    });
    expect(UNIT_ITEM_COST.EXPIRY).toBe(8);
    expect(UNIT_ITEM_COST.OFFER).toBe(7);
    const decision = step(makeSnapshot(), cmd.register(1, ['A']), at(0)).decision;
    // META 1 + session 1 + registration 2 + offer 1 + notification 1 + CMD 1
    expect(estimateCommitItems(decision)).toBe(7);
  });

  it('a mass expiry wave with a waiting queue (5 sessions) stays within budget in every decision', () => {
    const s = fiveSessionsScenario();
    const r = run(s, cmd.tick('TIMER'), at(1)); // every hold expires at +60 s
    expect(r.decisions.length).toBeGreaterThan(1);
    let expired = 0;
    let created = 0;
    for (const decision of r.decisions) {
      expectWithinBudget(decision);
      expect(decision.metrics.offersExpired).toBeLessThanOrEqual(12);
      expect(decision.metrics.offersCreated).toBeLessThanOrEqual(12);
      expired += decision.metrics.offersExpired;
      created += decision.metrics.offersCreated;
    }
    expect(expired).toBe(15);
    expect(created).toBe(15);
    expect(r.snapshot.registrations.filter((x) => x.status === 'OFFERED')).toHaveLength(15);
    expect(r.snapshot.pendingBackfills).toEqual([]);
    // the same wave handled by a user REGISTER (tick-first + its own writes)
    const viaRegister = run(s, cmd.register(50, ['A']), at(1));
    for (const decision of viaRegister.decisions) {
      expectWithinBudget(decision);
    }
    expect(viaRegister.decision.status).toBe('APPLIED');
  });

  it('the backfill-latency experiment shape (100 offers expiring, 50 waiting) stays within budget', () => {
    const s = massExpiryScenario();
    const r = run(s, cmd.tick('TIMER'), at(1));
    expect(r.decisions.length).toBeGreaterThanOrEqual(9);
    for (const decision of r.decisions) {
      expectWithinBudget(decision);
      expect(decision.writes.length).toBeLessThanOrEqual(90);
    }
    const expired = r.decisions.reduce((n, d) => n + d.metrics.offersExpired, 0);
    const created = r.decisions.reduce((n, d) => n + d.metrics.offersCreated, 0);
    expect(expired).toBe(100);
    expect(created).toBe(50);
    // every waiting participant got a seat and every relayed release is attributed once
    const relayed = r.decisions
      .flatMap((d) => d.backfills)
      .filter((b) => b.newUserId !== undefined);
    expect(relayed).toHaveLength(50);
    expect(new Set(relayed.map((b) => b.id)).size).toBe(50);
    expect(r.decisions.flatMap((d) => d.metrics.backfillLatenciesMs)).toHaveLength(50);
    // the 50 releases nobody waited for are closed, none is left pending
    expect(r.snapshot.pendingBackfills).toEqual([]);
    expect(checkInvariants(r.snapshot, at(1)).ok).toBe(true);
    // REGISTER / CANCEL_REGISTRATION landing in the same wave
    for (const command of [cmd.register(500, ['A']), cmd.cancel(101), cmd.cancel(1)]) {
      const chain = run(s, command, at(1));
      expect(chain.decision.status).toBe('APPLIED');
      for (const decision of chain.decisions) {
        expectWithinBudget(decision);
      }
    }
  });

  it('single-session registrations whose expiry ends them (ARCHIVE_REGISTRATION per expiry) stay within budget', () => {
    // 12 CONFIRMED in B, 12 hold A with fallback B, 12 queued for A: the reviewer's shape, plus
    // the worse variant where the expiring holders list only A and are archived.
    const s0 = makeSnapshot({
      holdSeconds: 600,
      sessions: [
        { id: 'A', capacity: 12 },
        { id: 'B', capacity: 12 },
      ],
    });
    const holdersA = Array.from({ length: 12 }, (_, i) => i + 1);
    const holdersB = Array.from({ length: 12 }, (_, i) => 13 + i);
    const queued = Array.from({ length: 12 }, (_, i) => 25 + i);
    let s = registerMany(s0, holdersB, ['B'], at(0));
    for (const n of holdersB) {
      s = run(s, cmd.accept(n, offerOf(s, n)!.id), at(0)).snapshot;
    }
    s = registerMany(s, holdersA, ['A'], at(0));
    s = registerMany(s, queued, ['A'], at(0));
    for (const command of [cmd.tick('TIMER'), cmd.register(99, ['A', 'B']), cmd.cancel(13)]) {
      const chain = run(s, command, at(10));
      expect(chain.decisions.reduce((n, d) => n + d.metrics.offersExpired, 0)).toBe(12);
      for (const decision of chain.decisions) {
        expectWithinBudget(decision);
      }
    }
  });

  it('a PER_SESSION cancel-all of five registrations fits even after a full tick-first', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const s0 = makeSnapshot({
      mode: 'PER_SESSION',
      holdSeconds: 60,
      sessions: ids.map((id) => ({ id, capacity: 4 })),
    });
    let s = s0;
    for (const id of ids) {
      s = registerMany(s, [1, 2, 3, 4], [id], at(0)); // u1..u4 hold every session (dup holds)
      s = registerMany(s, [5, 6, 7, 8, 9], [id], at(0)); // queued everywhere
    }
    expect(s.offers).toHaveLength(20);
    const r = run(s, cmd.cancel(1), at(1)); // all 20 offers are due; u1 leaves everything
    expect(r.decision.status).toBe('APPLIED');
    for (const decision of r.decisions) {
      expectWithinBudget(decision);
    }
    expect(regOf(r.snapshot, 1)).toBeUndefined();
  });

  it('cut-off endings of a long queue are bounded too (sweep at cut-off with 50 QUEUED)', () => {
    const s0 = makeSnapshot({
      holdSeconds: 1800,
      sessions: [{ id: 'A', startsInMinutes: 40 }, { id: 'B' }],
    });
    let s = registerMany(s0, [1], ['A', 'B'], at(0)); // holds A until its cut-off (+10)
    s = run(s, cmd.register(2, ['B']), at(0)).snapshot; // holds B until +30
    const waiting = Array.from({ length: 50 }, (_, i) => 3 + i);
    s = registerMany(s, waiting, ['A'], at(0)); // queued for A only; A cut-off at +10
    const r = run(s, cmd.tick('SWEEP'), at(10));
    expect(r.decisions.length).toBeGreaterThan(1);
    for (const decision of r.decisions) {
      expectWithinBudget(decision);
    }
    expect(r.snapshot.registrations.map((x) => x.seq)).toEqual([1, 2]); // u1 re-queued for B
    expect(
      r.decisions.flatMap((d) => d.notifications).filter((n) => n.kind === 'ENDED'),
    ).toHaveLength(50);
  });

  it('closing many leftover pending releases is itself budget-bounded', () => {
    // 100 offers expire with nobody waiting: the releases accumulate as pending items along
    // the chain and are closed at its end, in steps that respect the budget.
    const s0 = makeSnapshot({
      holdSeconds: 60,
      sessions: [{ id: 'A', capacity: 100 }, { id: 'B' }],
    });
    const holders = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = registerMany(s0, holders, ['A'], at(0));
    const r = run(s, cmd.tick('TIMER'), at(1));
    for (const decision of r.decisions) {
      expectWithinBudget(decision);
    }
    const histogram = writeHistogram(r.decisions[r.decisions.length - 1]!);
    expect(histogram['ARCHIVE_BACKFILL']).toBeGreaterThan(0);
    expect(r.snapshot.pendingBackfills).toEqual([]);
    expect(r.snapshot.registrations).toEqual([]);
    expect(r.snapshot.workshop.nextDueAt).toBeUndefined();
    const closed = r.decisions
      .flatMap((d) => d.writes)
      .filter((w) => w.kind === 'ARCHIVE_BACKFILL' || w.kind === 'PUT_BACKFILL');
    expect(closed).toHaveLength(100);
  });

  it('exposes the budget as a caller-provided limit', () => {
    const s = fiveSessionsScenario();
    const tight = step(s, cmd.tick(), at(1), { maxItemsPerDecision: 20 });
    expect(estimateCommitItems(tight.decision)).toBeLessThanOrEqual(20);
    expect(tight.decision.continuation).toBeDefined();
    const none = step(s, cmd.tick(), at(1), { maxItemsPerDecision: 0 });
    expect(none.decision.metrics.offersExpired).toBe(0);
    expect(none.decision.continuation).toBeDefined();
    // the chain still converges with a tight budget
    const chain = run(s, cmd.tick(), at(1), { maxItemsPerDecision: 20 });
    expect(chain.snapshot.offers).toHaveLength(15);
  });
});

describe('nextDueAt while a continuation is pending', () => {
  it('is `now` so that the sweep finishes a lost continuation chain', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B', capacity: 1 }] });
    const s = registerMany(s0, [1, 2, 3, 4, 5], ['A'], at(0)); // u1 holds, 4 queued
    const first = step(s, cmd.setCapacity('A', 10), at(5), { maxOffersPerDecision: 2 });
    expect(first.decision.continuation).toMatchObject({ type: 'REALLOCATE' });
    expect(first.decision.writes[0]).toMatchObject({
      kind: 'PUT_WORKSHOP_STATE',
      nextDueAt: at(5),
    });
    // a sweep tick (what listDueWorkshops would enqueue) completes the work on its own
    const swept = run(first.snapshot, cmd.tick('SWEEP'), at(10), { maxOffersPerDecision: 2 });
    expect(swept.decisions.reduce((n, d) => n + d.metrics.offersCreated, 0)).toBe(2);
    expect(swept.snapshot.registrations.filter((r) => r.status === 'QUEUED')).toEqual([]);
    expect(swept.snapshot.workshop.nextDueAt).toBe(at(15)); // earliest live expiry, not `now`
  });

  it('compares the stored nextDueAt by instant, not by string', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const stored = structuredClone(s);
    stored.workshop.nextDueAt = '2026-11-03T06:10:00Z'; // same instant, no milliseconds
    const idle = step(stored, cmd.tick('TIMER'), at(5));
    expect(idle.decision.writes).toEqual([]);
  });
});
