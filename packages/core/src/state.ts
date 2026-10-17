import type {
  BackfillCause,
  BackfillRecord,
  EndReason,
  NotificationKind,
  Offer,
  OfferStatus,
  Registration,
  RegistrationStatus,
  Session,
  Workshop,
  WorkshopMode,
} from '@seatrelay/contracts';
import { COMMAND_RESULT_ITEM_COST, COMMIT_ITEM_COST, NOTIFICATION_ITEM_COST } from './changes';
import { canStillBeWaitedFor, cloneSnapshot, type WorkshopSnapshot } from './snapshot';
import { diffMs, parseIso, toIso } from './time';

/** Notification to be stored by the committing adapter (the notifier sends it). */
export interface NotificationDraft {
  userId: string;
  email: string;
  workshopId: string;
  kind: NotificationKind;
  offerId?: string;
  title: string;
  body: string;
}

/** One expiry timer per new offer (plan §1.2); scheduled before commit, extra ticks are harmless. */
export interface OfferTimer {
  offerId: string;
  expiresAt: string;
}

/**
 * Per-decision bounds. `maxItemsPerDecision` is the one that keeps a commit inside the storage
 * transaction limit (DynamoDB: 100 items, counted with `COMMIT_ITEM_COST` + notifications +
 * the CommandResult); the offer and expiry counts are the plan §2.2 ceilings on top of it.
 * Whatever a limit leaves undone is carried over by a `REALLOCATE` continuation.
 */
export interface DecisionLimits {
  /** Plan §2.2: at most 12 new offers per command. */
  maxOffersPerDecision: number;
  /** Offers expired by tick-first per decision; the rest expire in the continuation. */
  maxExpiriesPerDecision: number;
  /**
   * Storage items one commit may need (`estimateCommitItems`). Every bounded step (expiries,
   * cut-off endings, cancellation drains, allocations, pending-record closing) stops before
   * crossing it and the remainder is carried over by the continuation.
   */
  maxItemsPerDecision: number;
}

export const MAX_OFFERS_PER_DECISION = 12;
export const MAX_EXPIRIES_PER_DECISION = 12;
/** DynamoDB allows 100 items per transaction; 10 are left for adapter-specific extras. */
export const MAX_ITEMS_PER_DECISION = 90;

export const DEFAULT_DECISION_LIMITS: Readonly<DecisionLimits> = Object.freeze({
  maxOffersPerDecision: MAX_OFFERS_PER_DECISION,
  maxExpiriesPerDecision: MAX_EXPIRIES_PER_DECISION,
  maxItemsPerDecision: MAX_ITEMS_PER_DECISION,
});

/**
 * Worst-case item cost of one unit of each bounded step, under `COMMIT_ITEM_COST` (every unit
 * may also dirty one session; the first touch of a session is included here):
 *
 * - expiry: ARCHIVE_OFFER 2 + session 1 + PUT_BACKFILL 1 + ARCHIVE_REGISTRATION 3 + notification 1;
 * - offer: PUT_OFFER 1 + session 1 + PUT_REGISTRATION 2 + notification 1 + ARCHIVE_BACKFILL 2
 *   (relaying a pending record of the snapshot);
 * - cut-off ending: ARCHIVE_REGISTRATION 3 + notification 1;
 * - session drain, revoked offer: ARCHIVE_OFFER 2 + session 1 + PUT_BACKFILL 1 + registration 3
 *   + notification 1; other registration listing the session: session 1 + PUT_BACKFILL 1 +
 *   registration 3 + notification 1;
 * - workshop drain, one registration: ARCHIVE_OFFER 2 + session 1 + ARCHIVE_REGISTRATION 3 +
 *   notification 1;
 * - dangling offer (corrupted snapshot): ARCHIVE_OFFER 2 + session 1.
 */
export const UNIT_ITEM_COST = Object.freeze({
  EXPIRY: 8,
  OFFER: 7,
  CUTOFF_END: 4,
  DRAIN_SESSION_OFFER: 8,
  DRAIN_SESSION_REGISTRATION: 6,
  DRAIN_WORKSHOP_REGISTRATION: 7,
  DANGLING_OFFER: 3,
});

export interface DecideContext {
  /** Server time (ISO UTC). Everything time-related is decided against this value. */
  now: string;
  /** Fresh unique id per call (UUID v4 in production); called in a deterministic order. */
  newId: () => string;
  limits?: Partial<DecisionLimits>;
}

/**
 * Mutable working copy of a snapshot plus bookkeeping of what changed. Private to the engine:
 * `decide()` creates it from a deep copy of the input snapshot and turns it into a `Decision`.
 */
export interface WorkState {
  /** `ctx.now` in canonical form (ISO UTC with milliseconds). */
  readonly now: string;
  readonly nowMs: number;
  readonly newId: () => string;
  readonly limits: DecisionLimits;
  readonly mode: WorkshopMode;
  readonly workshop: Workshop;
  readonly sessionOrder: readonly string[];
  readonly sessions: Map<string, Session>;
  /** Live registrations by seq. */
  readonly registrations: Map<number, Registration>;
  /** Live offers by id. */
  readonly offers: Map<string, Offer>;
  /** Archived offers the command refers to (`WorkshopSnapshot.settledOffers`); read-only. */
  readonly settledOffers: readonly Offer[];

  workshopStateDirty: boolean;
  readonly dirtySessions: Set<string>;
  readonly dirtyRegistrations: Set<number>;
  readonly archivedRegistrations: Registration[];
  readonly newOfferIds: string[];
  readonly archivedOffers: Offer[];
  /**
   * Backfill records known to this decision, oldest release first: the snapshot's pending
   * records (still waiting for a taker) followed by the ones created here.
   */
  readonly backfills: BackfillRecord[];
  /** Ids of the records that came with the snapshot (live pending items). */
  readonly snapshotBackfillIds: Set<string>;
  /** Ids of backfill records created, relayed or closed in this decision (the ones written). */
  readonly touchedBackfillIds: Set<string>;
  /** Pending records closed in this decision without a taker (final, never relayed). */
  readonly closedBackfillIds: Set<string>;
  /** Seats added by SET_CAPACITY (this decision or carried over) not yet taken, per session. */
  readonly pendingCapacityUp: Map<string, number>;
  readonly notifications: NotificationDraft[];
  readonly timers: OfferTimer[];
  readonly backfillLatenciesMs: number[];
  offersCreated: number;
  offersExpired: number;
  /** Set when a limit stopped the work; the decision then carries a REALLOCATE continuation. */
  continuationNeeded: boolean;
}

export function createWorkState(snapshot: WorkshopSnapshot, ctx: DecideContext): WorkState {
  const copy = cloneSnapshot(snapshot);
  const nowMs = parseIso(ctx.now);
  return {
    now: toIso(nowMs),
    nowMs,
    newId: ctx.newId,
    limits: { ...DEFAULT_DECISION_LIMITS, ...ctx.limits },
    mode: copy.workshop.mode,
    workshop: copy.workshop,
    sessionOrder: copy.sessions.map((session) => session.id),
    sessions: new Map(copy.sessions.map((session) => [session.id, session])),
    registrations: new Map(
      copy.registrations.map((registration) => [registration.seq, registration]),
    ),
    offers: new Map(copy.offers.map((offer) => [offer.id, offer])),
    settledOffers: copy.settledOffers ?? [],
    workshopStateDirty: false,
    dirtySessions: new Set(),
    dirtyRegistrations: new Set(),
    archivedRegistrations: [],
    newOfferIds: [],
    archivedOffers: [],
    backfills: copy.pendingBackfills.filter((record) => record.reallocatedAt === undefined),
    snapshotBackfillIds: new Set(copy.pendingBackfills.map((record) => record.id)),
    touchedBackfillIds: new Set(),
    closedBackfillIds: new Set(),
    pendingCapacityUp: new Map(),
    notifications: [],
    timers: [],
    backfillLatenciesMs: [],
    offersCreated: 0,
    offersExpired: 0,
    continuationNeeded: false,
  };
}

/** Lookup that must succeed by construction (e.g. an offer's session). */
export function mustGet<K, V>(map: Map<K, V>, key: K | undefined, what: string): V {
  const value = key === undefined ? undefined : map.get(key);
  if (value === undefined) {
    throw new Error(`Corrupted snapshot: missing ${what} ${String(key)}`);
  }
  return value;
}

export function liveRegistrations(st: WorkState): Registration[] {
  return [...st.registrations.values()].sort((a, b) => a.seq - b.seq);
}

export function liveOffers(st: WorkState): Offer[] {
  return [...st.offers.values()];
}

/* ---------- item budget ---------- */

/**
 * Items the commit of the work done so far would need (the same formula as
 * `estimateCommitItems` applied to the writes this state will produce; the CommandResult is
 * always counted, which over-estimates internal commands by one, on the safe side).
 */
export function estimateItems(st: WorkState): number {
  let items = COMMIT_ITEM_COST.PUT_WORKSHOP_STATE + COMMAND_RESULT_ITEM_COST;
  items += st.dirtySessions.size * COMMIT_ITEM_COST.PUT_SESSION;
  items += st.dirtyRegistrations.size * COMMIT_ITEM_COST.PUT_REGISTRATION;
  items += st.archivedRegistrations.length * COMMIT_ITEM_COST.ARCHIVE_REGISTRATION;
  items += st.newOfferIds.length * COMMIT_ITEM_COST.PUT_OFFER;
  items += st.archivedOffers.length * COMMIT_ITEM_COST.ARCHIVE_OFFER;
  for (const id of st.touchedBackfillIds) {
    items += st.snapshotBackfillIds.has(id)
      ? COMMIT_ITEM_COST.ARCHIVE_BACKFILL
      : COMMIT_ITEM_COST.PUT_BACKFILL;
  }
  items += st.notifications.length * NOTIFICATION_ITEM_COST;
  return items;
}

/**
 * Whether one more unit costing at most `unitCost` items fits in the budget, keeping
 * `reserve` items free (tick-first keeps the command's own worst case free).
 */
export function fitsBudget(st: WorkState, unitCost: number, reserve = 0): boolean {
  return estimateItems(st) + unitCost + reserve <= st.limits.maxItemsPerDecision;
}

/* ---------- mutations ---------- */

export function touchSession(st: WorkState, session: Session): void {
  st.dirtySessions.add(session.id);
}

export function touchRegistration(st: WorkState, registration: Registration): void {
  registration.updatedAt = st.now;
  st.dirtyRegistrations.add(registration.seq);
}

export function touchWorkshop(st: WorkState): void {
  st.workshopStateDirty = true;
}

/** Moves a live registration to history with its final status. */
export function archiveRegistration(
  st: WorkState,
  registration: Registration,
  status: Extract<RegistrationStatus, 'CANCELLED' | 'ENDED'>,
  endReason?: EndReason,
): void {
  registration.status = status;
  if (endReason !== undefined) {
    registration.endReason = endReason;
  }
  delete registration.currentOfferId;
  registration.updatedAt = st.now;
  st.registrations.delete(registration.seq);
  st.dirtyRegistrations.delete(registration.seq);
  st.archivedRegistrations.push(registration);
}

/** Settles a live offer (ACCEPTED/DECLINED/EXPIRED/REVOKED), releasing its held seat. */
export function settleOffer(
  st: WorkState,
  offer: Offer,
  status: Exclude<OfferStatus, 'OFFERED'>,
): void {
  offer.status = status;
  offer.settledAt = st.now;
  st.offers.delete(offer.id);
  st.archivedOffers.push(offer);
  const session = mustGet(st.sessions, offer.sessionId, 'session');
  session.held -= 1;
  touchSession(st, session);
}

/**
 * Removes a session from a registration's preferences after an EXPIRED/DECLINED/REVOKED offer,
 * a cancelled confirmed seat or a cancelled session (R5). Returns the registration's new state:
 * back to QUEUED (keeping its seq), ENDED(NO_ACCEPTABLE_SESSION) when nothing is left, or
 * ENDED(CUTOFF) when every remaining session has passed its cut-off (nothing could ever be
 * offered again and no timer would fire for it).
 */
export function dropSessionFromRegistration(
  st: WorkState,
  registration: Registration,
  sessionId: string,
): 'QUEUED' | 'ENDED' {
  registration.acceptable = registration.acceptable.filter((id) => id !== sessionId);
  delete registration.currentOfferId;
  delete registration.confirmedSessionId;
  if (registration.acceptable.length === 0) {
    archiveRegistration(st, registration, 'ENDED', 'NO_ACCEPTABLE_SESSION');
    return 'ENDED';
  }
  const stillPossible = registration.acceptable.some((id) => {
    const session = st.sessions.get(id);
    return session !== undefined && canStillBeWaitedFor(session, st.nowMs);
  });
  if (!stillPossible) {
    archiveRegistration(st, registration, 'ENDED', 'CUTOFF');
    return 'ENDED';
  }
  registration.status = 'QUEUED';
  touchRegistration(st, registration);
  return 'QUEUED';
}

export function addBackfill(
  st: WorkState,
  sessionId: string,
  cause: BackfillCause,
  releasedAt: string,
): BackfillRecord {
  const record: BackfillRecord = {
    id: st.newId(),
    workshopId: st.workshop.id,
    sessionId,
    releasedAt,
    cause,
  };
  st.backfills.push(record);
  st.touchedBackfillIds.add(record.id);
  return record;
}

/** Marks a pending backfill record as relayed to `offer` and records its latency. */
export function fillBackfill(st: WorkState, record: BackfillRecord, offer: Offer): void {
  record.reallocatedAt = st.now;
  record.newOfferId = offer.id;
  record.newUserId = offer.userId;
  record.latencyMs = Math.max(0, diffMs(st.now, record.releasedAt));
  st.touchedBackfillIds.add(record.id);
  st.backfillLatenciesMs.push(record.latencyMs);
}

/** Backfill records created, relayed or closed in this decision, oldest release first. */
export function touchedBackfills(st: WorkState): BackfillRecord[] {
  return st.backfills.filter((record) => st.touchedBackfillIds.has(record.id));
}

/** A record written by this decision is final unless it still waits for a taker. */
export function isBackfillSettled(st: WorkState, record: BackfillRecord): boolean {
  return record.reallocatedAt !== undefined || st.closedBackfillIds.has(record.id);
}

/** Seeds the capacity-up seats carried by a REALLOCATE continuation (see contracts). */
export function seedPendingCapacityUp(
  st: WorkState,
  pendingCapacityUp: readonly { sessionId: string; seats: number }[] | undefined,
): void {
  for (const { sessionId, seats } of pendingCapacityUp ?? []) {
    st.pendingCapacityUp.set(sessionId, (st.pendingCapacityUp.get(sessionId) ?? 0) + seats);
  }
}

export function notify(
  st: WorkState,
  target: Pick<Registration, 'userId' | 'email'>,
  kind: NotificationKind,
  title: string,
  body: string,
  offerId?: string,
): void {
  const draft: NotificationDraft = {
    userId: target.userId,
    email: target.email,
    workshopId: st.workshop.id,
    kind,
    title,
    body,
  };
  if (offerId !== undefined) {
    draft.offerId = offerId;
  }
  st.notifications.push(draft);
}
