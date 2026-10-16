import {
  isInternalCommand,
  type BackfillRecord,
  type Command,
  type CommandResultPayload,
  type RejectReason,
} from '@seatrelay/contracts';
import { allocate } from './allocate';
import { applyCommand, type ApplyResult } from './apply';
import type { Change } from './changes';
import { registrationSummary, type WorkshopSnapshot } from './snapshot';
import {
  createWorkState,
  liveOffers,
  liveRegistrations,
  seedPendingReleases,
  touchedBackfills,
  type DecideContext,
  type NotificationDraft,
  type OfferTimer,
  type WorkState,
} from './state';
import { tickFirst } from './tick';
import { minIso, parseIso } from './time';

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
  /** Backfill records created in this decision (also present in `writes` as PUT_BACKFILL). */
  backfills: BackfillRecord[];
  /** REALLOCATE when a per-decision limit left expiries or allocations to do. */
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
 *  3. allocate: relay free seats to QUEUED registrations in seq/preference order;
 *  4. recompute `nextDueAt` and bump the workshop version.
 *
 * Deterministic for a given `(snapshot, command, ctx)`; the input snapshot is never mutated.
 */
export function decide(snapshot: WorkshopSnapshot, command: Command, ctx: DecideContext): Decision {
  const st = createWorkState(snapshot, ctx);
  if (command.type === 'REALLOCATE') {
    seedPendingReleases(st, command.pendingBackfills, command.pendingCapacityUp);
  }

  tickFirst(st);

  const outcome: ApplyResult =
    st.workshop.status === 'CANCELLED' && command.type !== 'TICK'
      ? { ok: false, reason: 'WORKSHOP_CANCELLED' }
      : applyCommand(st, command);

  if (st.workshop.status !== 'CANCELLED') {
    allocate(st);
  }

  const internal = isInternalCommand(command);
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

/** REALLOCATE carrying the releases of this decision that still wait for a taker. */
function buildContinuation(st: WorkState): Command {
  const continuation: Command = { type: 'REALLOCATE', workshopId: st.workshop.id };
  const pendingBackfills = st.backfills.filter(
    (record) =>
      record.reallocatedAt === undefined && st.sessions.get(record.sessionId)?.status === 'OPEN',
  );
  if (pendingBackfills.length > 0) {
    continuation.pendingBackfills = structuredClone(pendingBackfills);
  }
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
 * that still has QUEUED or OFFERED demand)`; undefined when nothing is pending. The sweep
 * (every 5 min) ticks workshops whose nextDueAt has passed: the safety net behind the timers.
 */
export function computeNextDueAt(st: WorkState): string | undefined {
  let due: string | undefined;
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
    entityWrites.push({ kind: 'PUT_BACKFILL', record });
  }

  const nextDueAt = computeNextDueAt(st);
  const changed =
    entityWrites.length > 0 || st.workshopStateDirty || nextDueAt !== snapshot.workshop.nextDueAt;
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
