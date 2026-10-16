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
import { cloneSnapshot, isStillOpenForAllocation, type WorkshopSnapshot } from './snapshot';
import { diffMs, parseIso } from './time';

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
 * Per-decision bounds that keep one commit inside the storage transaction limit
 * (DynamoDB: 100 items). Overflow is carried over by a `REALLOCATE` continuation.
 */
export interface DecisionLimits {
  /** Plan §2.2: at most 12 new offers per command. */
  maxOffersPerDecision: number;
  /** Offers expired by tick-first per decision; the rest expire in the continuation. */
  maxExpiriesPerDecision: number;
}

export const MAX_OFFERS_PER_DECISION = 12;
export const MAX_EXPIRIES_PER_DECISION = 12;

export const DEFAULT_DECISION_LIMITS: Readonly<DecisionLimits> = Object.freeze({
  maxOffersPerDecision: MAX_OFFERS_PER_DECISION,
  maxExpiriesPerDecision: MAX_EXPIRIES_PER_DECISION,
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

  workshopStateDirty: boolean;
  readonly dirtySessions: Set<string>;
  readonly dirtyRegistrations: Set<number>;
  readonly archivedRegistrations: Registration[];
  readonly newOfferIds: string[];
  readonly archivedOffers: Offer[];
  /** Backfill records known to this decision: created here or carried over by a REALLOCATE. */
  readonly backfills: BackfillRecord[];
  /** Ids of backfill records created or updated in this decision (the ones written). */
  readonly touchedBackfillIds: Set<string>;
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
  return {
    now: ctx.now,
    nowMs: parseIso(ctx.now),
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
    workshopStateDirty: false,
    dirtySessions: new Set(),
    dirtyRegistrations: new Set(),
    archivedRegistrations: [],
    newOfferIds: [],
    archivedOffers: [],
    backfills: [],
    touchedBackfillIds: new Set(),
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
    return session !== undefined && isStillOpenForAllocation(session, st.nowMs);
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

/** Backfill records created or updated in this decision, in creation order. */
export function touchedBackfills(st: WorkState): BackfillRecord[] {
  return st.backfills.filter((record) => st.touchedBackfillIds.has(record.id));
}

/** Seeds the pending releases carried by a REALLOCATE continuation (see contracts). */
export function seedPendingReleases(
  st: WorkState,
  pendingBackfills: readonly BackfillRecord[] | undefined,
  pendingCapacityUp: readonly { sessionId: string; seats: number }[] | undefined,
): void {
  for (const record of pendingBackfills ?? []) {
    if (
      record.reallocatedAt === undefined &&
      !st.backfills.some((known) => known.id === record.id)
    ) {
      st.backfills.push(structuredClone(record));
    }
  }
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
