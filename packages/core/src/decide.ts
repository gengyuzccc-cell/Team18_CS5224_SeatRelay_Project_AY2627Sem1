import {
  isInternalCommand,
  type BackfillRecord,
  type Command,
  type CommandResultPayload,
  type RejectReason,
} from '@seatrelay/contracts';
import { allocate } from './allocate';
import { applyCommand, commandItemReserve, type ApplyResult } from './apply';
import { COMMIT_ITEM_COST, type Change } from './changes';
import { drainCancellations } from './drain';
import { registrationSummary, type WorkshopSnapshot } from './snapshot';
import {
  createWorkState,
  fitsBudget,
  isBackfillSettled,
  liveOffers,
  liveRegistrations,
  seedPendingCapacityUp,
  touchedBackfills,
  type DecideContext,
  type NotificationDraft,
  type OfferTimer,
  type WorkState,
} from './state';
import { tickFirst } from './tick';
import { compareIso, minIso, parseIso } from './time';

export interface DecisionMetrics {
  offersCreated: number;
  offersExpired: number;
  /** Latency of every backfill relayed in this decision (`reallocatedAt − releasedAt`). */
  backfillLatenciesMs: number[];
  /** True when a sweep-originated TICK had to expire an offer (the timer path was late). */
  sweepLate?: boolean;
}

/**
 * The complete outcome of processing one command against one snapshot. The service commits
 * `writes` atomically (plus the CommandResult), stores `notifications`, schedules `timers`
 * before the commit, enqueues `continuation` after it and emits `metrics`.
 */
export interface Decision {
  status: 'APPLIED' | 'REJECTED';
  reason?: RejectReason;
  writes: Change[];
  notifications: NotificationDraft[];
  timers: OfferTimer[];
  /** Backfill records created, relayed or closed in this decision (also present in `writes`). */
  backfills: BackfillRecord[];
  /** REALLOCATE when a per-decision limit left expiries, drains or allocations to do. */
  continuation?: Command;
  metrics: DecisionMetrics;
  /** `CommandResult.result` for user commands that were APPLIED. */
  resultForCommand?: CommandResultPayload;
}

/**
 * The pure domain engine (plan §2.2). Given the live snapshot of a workshop, a command and the
 * server time, computes everything that must happen, without side effects:
 *
 *  1. tick-first: expire every due offer and end registrations whose sessions passed cut-off;
 *  2. apply the command (or reject it with a deterministic reason);
 *  3. drain pending organiser cancellations, then allocate: relay free seats to QUEUED
 *     registrations in seq/preference order;
 *  4. recompute `nextDueAt` and bump the workshop version.
 *
 * Every step is bounded by `ctx.limits` (offers, expiries and the storage item budget); the
 * remainder is carried over by a REALLOCATE continuation. Deterministic for a given
 * `(snapshot, command, ctx)`; the input snapshot is never mutated.
 */
export function decide(snapshot: WorkshopSnapshot, command: Command, ctx: DecideContext): Decision {
  if (command.workshopId !== snapshot.workshop.id) {
    throw new Error(
      `command for workshop ${command.workshopId} applied to the snapshot of ${snapshot.workshop.id}`,
    );
  }
  const st = createWorkState(snapshot, ctx);
  if (command.type === 'REALLOCATE') {
    seedPendingCapacityUp(st, command.pendingCapacityUp);
  }
  const internal = isInternalCommand(command);

  tickFirst(st, internal ? 0 : commandItemReserve(st, command));

  const cancelled = st.workshop.status === 'CANCELLING' || st.workshop.status === 'CANCELLED';
  const outcome: ApplyResult =
    cancelled && !internal
      ? { ok: false, reason: 'WORKSHOP_CANCELLED' }
      : applyCommand(st, command);

  drainCancellations(st);
  if (st.workshop.status === 'OPEN' || st.workshop.status === 'CLOSED') {
    allocate(st);
  }
  finalizeBackfills(st);

  const decision: Decision = {
    status: outcome.ok ? 'APPLIED' : 'REJECTED',
    writes: collectWrites(st, snapshot, outcome.ok && !internal),
    notifications: st.notifications,
    timers: st.timers,
    backfills: touchedBackfills(st),
    metrics: {
      offersCreated: st.offersCreated,
      offersExpired: st.offersExpired,
      backfillLatenciesMs: st.backfillLatenciesMs,
    },
  };
  if (!outcome.ok) {
    decision.reason = outcome.reason;
  }
  if (st.continuationNeeded) {
    decision.continuation = buildContinuation(st);
  }
  if (command.type === 'TICK' && command.source === 'SWEEP' && st.offersExpired > 0) {
    decision.metrics.sweepLate = true;
  }
  if (outcome.ok && !internal) {
    const result: CommandResultPayload = { offersCreated: st.offersCreated };
    if (outcome.registration !== undefined) {
      result.registration = registrationSummary(
        st.mode,
        liveRegistrations(st),
        liveOffers(st),
        outcome.registration,
      );
    }
    decision.resultForCommand = result;
  }
  return decision;
}

/**
 * Decides which unrelayed backfill records stay pending (live items the next decision may
 * still relay) and which are closed as final. A record stays pending only while a
 * continuation is needed and its session is still OPEN; otherwise nobody who could take the
 * seat is waiting, so it is closed without `reallocatedAt`. Closing a record that came with
 * the snapshot costs an ARCHIVE_BACKFILL, so the closing itself is budget-bounded and spills
 * over to the continuation when necessary.
 */
function finalizeBackfills(st: WorkState): void {
  const keepPending = st.continuationNeeded;
  for (const record of st.backfills) {
    if (isBackfillSettled(st, record)) {
      continue;
    }
    if (keepPending && st.sessions.get(record.sessionId)?.status === 'OPEN') {
      continue;
    }
    const cost = st.snapshotBackfillIds.has(record.id) ? COMMIT_ITEM_COST.ARCHIVE_BACKFILL : 0;
    if (!fitsBudget(st, cost)) {
      st.continuationNeeded = true;
      return;
    }
    st.closedBackfillIds.add(record.id);
    st.touchedBackfillIds.add(record.id);
  }
}

/** REALLOCATE carrying the capacity-up seats of this decision that still wait for a taker. */
function buildContinuation(st: WorkState): Command {
  const continuation: Command = { type: 'REALLOCATE', workshopId: st.workshop.id };
  const pendingCapacityUp = [...st.pendingCapacityUp]
    .filter(([, seats]) => seats > 0)
    .map(([sessionId, seats]) => ({ sessionId, seats }));
  if (pendingCapacityUp.length > 0) {
    continuation.pendingCapacityUp = pendingCapacityUp;
  }
  return continuation;
}

/**
 * `nextDueAt = min(earliest live offer expiresAt, earliest future cutoffAt of an OPEN session
 * that still has QUEUED or OFFERED demand)`, and `now` while a continuation is pending so that
 * the sweep (every 5 min) finishes the chain if the enqueued REALLOCATE is lost; undefined when
 * nothing is pending. The sweep ticks workshops whose nextDueAt has passed: the safety net
 * behind the timers.
 */
export function computeNextDueAt(st: WorkState): string | undefined {
  let due: string | undefined = st.continuationNeeded ? st.now : undefined;
  for (const offer of st.offers.values()) {
    due = due === undefined ? offer.expiresAt : minIso(due, offer.expiresAt);
  }
  const demanded = new Set<string>();
  for (const registration of st.registrations.values()) {
    if (registration.status !== 'CONFIRMED') {
      for (const sessionId of registration.acceptable) {
        demanded.add(sessionId);
      }
    }
  }
  for (const session of st.sessions.values()) {
    if (
      session.status === 'OPEN' &&
      demanded.has(session.id) &&
      parseIso(session.cutoffAt) > st.nowMs
    ) {
      due = due === undefined ? session.cutoffAt : minIso(due, session.cutoffAt);
    }
  }
  return due;
}

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return compareIso(a, b) === 0;
}

/**
 * One change per touched entity, in a stable order. The workshop state is written when
 * anything changed or when a user command was applied (a rejected command with no tick-first
 * effect produces no writes and no version bump).
 */
function collectWrites(st: WorkState, snapshot: WorkshopSnapshot, applied: boolean): Change[] {
  const entityWrites: Change[] = [];
  for (const sessionId of st.sessionOrder) {
    if (st.dirtySessions.has(sessionId)) {
      entityWrites.push({ kind: 'PUT_SESSION', session: st.sessions.get(sessionId)! });
    }
  }
  for (const registration of liveRegistrations(st)) {
    if (st.dirtyRegistrations.has(registration.seq)) {
      entityWrites.push({ kind: 'PUT_REGISTRATION', registration });
    }
  }
  for (const registration of st.archivedRegistrations) {
    entityWrites.push({ kind: 'ARCHIVE_REGISTRATION', registration });
  }
  for (const offerId of st.newOfferIds) {
    entityWrites.push({ kind: 'PUT_OFFER', offer: st.offers.get(offerId)! });
  }
  for (const offer of st.archivedOffers) {
    entityWrites.push({ kind: 'ARCHIVE_OFFER', offer });
  }
  for (const record of touchedBackfills(st)) {
    if (st.snapshotBackfillIds.has(record.id)) {
      entityWrites.push({ kind: 'ARCHIVE_BACKFILL', record }); // relayed or closed: to history
    } else if (isBackfillSettled(st, record)) {
      entityWrites.push({ kind: 'PUT_BACKFILL', record });
    } else {
      entityWrites.push({ kind: 'PUT_PENDING_BACKFILL', record }); // waits for the continuation
    }
  }

  const nextDueAt = computeNextDueAt(st);
  const changed =
    entityWrites.length > 0 ||
    st.workshopStateDirty ||
    !sameInstant(nextDueAt, snapshot.workshop.nextDueAt);
  if (!changed && !applied) {
    return [];
  }
  const workshopWrite: Change = {
    kind: 'PUT_WORKSHOP_STATE',
    workshopId: st.workshop.id,
    status: st.workshop.status,
    seq: st.workshop.seq,
    version: snapshot.workshop.version + 1,
    updatedAt: st.now,
  };
  if (nextDueAt !== undefined) {
    workshopWrite.nextDueAt = nextDueAt;
  }
  return [workshopWrite, ...entityWrites];
}
