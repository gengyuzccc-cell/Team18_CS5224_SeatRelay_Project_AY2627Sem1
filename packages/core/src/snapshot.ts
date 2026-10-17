import type {
  BackfillRecord,
  Offer,
  Registration,
  RegistrationStatus,
  RegistrationSummary,
  Session,
  Workshop,
  WorkshopMode,
} from '@seatrelay/contracts';
import { queueScopeKey } from './perSession';
import { compareIso, parseIso } from './time';

/**
 * The live state of one workshop as loaded by the worker (plan §2.3: `Query PK=WS#… AND
 * begins_with(SK,'L#')`). Archived registrations/offers are never part of it, with one
 * exception: `settledOffers` is a per-command augmentation (see below), not stored state.
 */
export interface WorkshopSnapshot {
  workshop: Workshop;
  sessions: Session[];
  /** Live registrations only: QUEUED | OFFERED | CONFIRMED. */
  registrations: Registration[];
  /** Live offers only: OFFERED. */
  offers: Offer[];
  /**
   * Seat releases that still wait for a taker while a REALLOCATE continuation is pending
   * (`reallocatedAt` undefined, session OPEN). They are live items so that whichever decision
   * relays the seat next (a timer tick, a user command or the continuation) attributes it.
   * Empty outside a continuation chain. Oldest release first.
   */
  pendingBackfills: BackfillRecord[];
  /**
   * Optional: archived (settled) offers the command refers to, loaded by the service for an
   * ACCEPT_OFFER / DECLINE_OFFER whose offer is no longer live (one point read). The engine
   * uses them only to answer OFFER_EXPIRED / OFFER_NOT_ACTIVE instead of OFFER_NOT_FOUND once a
   * timer tick has already archived the offer; they are never written back.
   */
  settledOffers?: Offer[];
}

export const LIVE_REGISTRATION_STATUSES: readonly RegistrationStatus[] = [
  'QUEUED',
  'OFFERED',
  'CONFIRMED',
];

export function isLiveRegistrationStatus(status: RegistrationStatus): boolean {
  return LIVE_REGISTRATION_STATUSES.includes(status);
}

export function cloneSnapshot(snapshot: WorkshopSnapshot): WorkshopSnapshot {
  return structuredClone(snapshot);
}

/** `capacity − confirmed − held` (may be negative on a corrupted snapshot; C1 flags that). */
export function freeSeats(session: Pick<Session, 'capacity' | 'confirmed' | 'held'>): number {
  return session.capacity - session.confirmed - session.held;
}

export function isPastCutoff(session: Pick<Session, 'cutoffAt'>, nowMs: number): boolean {
  return nowMs >= parseIso(session.cutoffAt);
}

/** OPEN, before cutoff and with a free seat: the only sessions `allocate()` may offer. */
export function isAllocatable(session: Session, nowMs: number): boolean {
  return session.status === 'OPEN' && !isPastCutoff(session, nowMs) && freeSeats(session) > 0;
}

/** OPEN and before cutoff (regardless of free seats): a session a QUEUED registration may wait for. */
export function isStillOpenForAllocation(session: Session, nowMs: number): boolean {
  return session.status === 'OPEN' && !isPastCutoff(session, nowMs);
}

/**
 * A session that still justifies a QUEUED registration listing it: OPEN before cut-off, or
 * CANCELLING (never offered again, but the pending drain removes it from the preference list
 * with a SESSION_CANCELLED notice, so the registration is not ended with CUTOFF meanwhile).
 */
export function canStillBeWaitedFor(session: Session, nowMs: number): boolean {
  return (
    (session.status === 'OPEN' || session.status === 'CANCELLING') && !isPastCutoff(session, nowMs)
  );
}

export function bySeq(a: Pick<Registration, 'seq'>, b: Pick<Registration, 'seq'>): number {
  return a.seq - b.seq;
}

/** Backfill records oldest release first (ties by id): the FIFO relay order. */
export function byRelease(a: BackfillRecord, b: BackfillRecord): number {
  return compareIso(a.releasedAt, b.releasedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function findSession(snapshot: WorkshopSnapshot, sessionId: string): Session | undefined {
  return snapshot.sessions.find((session) => session.id === sessionId);
}

export function findOffer(snapshot: WorkshopSnapshot, offerId: string): Offer | undefined {
  return snapshot.offers.find((offer) => offer.id === offerId);
}

/** Live registrations of a user, lowest seq first (at most one in UNIFIED mode). */
export function liveRegistrationsOf(snapshot: WorkshopSnapshot, userId: string): Registration[] {
  return snapshot.registrations
    .filter((registration) => registration.userId === userId)
    .sort(bySeq);
}

/**
 * 1-based queue position of a QUEUED registration; `undefined` for any other status.
 * UNIFIED: 1 + number of QUEUED registrations with a lower seq.
 * PER_SESSION: the same, counted within that registration's session.
 */
export function queuePosition(
  mode: WorkshopMode,
  registrations: readonly Registration[],
  registration: Registration,
): number | undefined {
  if (registration.status !== 'QUEUED') {
    return undefined;
  }
  const scope = queueScopeKey(mode, registration);
  let ahead = 0;
  for (const other of registrations) {
    if (
      other.status === 'QUEUED' &&
      other.seq < registration.seq &&
      queueScopeKey(mode, other) === scope
    ) {
      ahead += 1;
    }
  }
  return ahead + 1;
}

/** Number of QUEUED registrations; with `sessionId`, only those that list it as acceptable. */
export function queueLength(registrations: readonly Registration[], sessionId?: string): number {
  let count = 0;
  for (const registration of registrations) {
    if (
      registration.status === 'QUEUED' &&
      (sessionId === undefined || registration.acceptable.includes(sessionId))
    ) {
      count += 1;
    }
  }
  return count;
}

/** Distinct userIds currently holding a CONFIRMED seat (dashboard "distinct participants served"). */
export function distinctConfirmedUsers(registrations: readonly Registration[]): number {
  const users = new Set<string>();
  for (const registration of registrations) {
    if (registration.status === 'CONFIRMED') {
      users.add(registration.userId);
    }
  }
  return users.size;
}

/**
 * Participant-facing summary of one registration (public view `me`, command results,
 * `GET /me/registrations`). `confirmedSessionId` is reported only while the seat is held
 * (status CONFIRMED): a CANCELLED/ENDED registration holds no seat even though the archived
 * entity keeps the session it once had.
 */
export function registrationSummary(
  mode: WorkshopMode,
  registrations: readonly Registration[],
  offers: readonly Offer[],
  registration: Registration,
): RegistrationSummary {
  const summary: RegistrationSummary = {
    status: registration.status,
    seq: registration.seq,
    acceptable: [...registration.acceptable],
  };
  if (registration.status === 'QUEUED') {
    summary.queuePosition = queuePosition(mode, registrations, registration);
  }
  if (registration.status === 'OFFERED') {
    const offer = offers.find((candidate) => candidate.id === registration.currentOfferId);
    if (offer !== undefined) {
      summary.currentOffer = {
        id: offer.id,
        sessionId: offer.sessionId,
        expiresAt: offer.expiresAt,
      };
    }
  }
  if (registration.status === 'CONFIRMED' && registration.confirmedSessionId !== undefined) {
    summary.confirmedSessionId = registration.confirmedSessionId;
  }
  if (registration.endReason !== undefined) {
    summary.endReason = registration.endReason;
  }
  return summary;
}
