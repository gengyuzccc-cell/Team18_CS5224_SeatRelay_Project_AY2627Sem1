import type {
  AcceptOfferCommand,
  CancelRegistrationCommand,
  CancelSessionCommand,
  Command,
  DeclineOfferCommand,
  Offer,
  Registration,
  RegisterCommand,
  RejectReason,
  Session,
  SetCapacityCommand,
} from '@seatrelay/contracts';
import { notifyConfirmed, notifyDeclined } from './notifications';
import { registrationConflicts, requiresSingleSession } from './perSession';
import { isPastCutoff } from './snapshot';
import {
  addBackfill,
  archiveRegistration,
  dropSessionFromRegistration,
  liveRegistrations,
  mustGet,
  settleOffer,
  touchRegistration,
  touchSession,
  touchWorkshop,
  type WorkState,
} from './state';
import { parseIso } from './time';

/**
 * Step 2 of a decision: apply one command to the working state (after tick-first).
 * Returns the registration the command concerns (for the command result) or a reject reason.
 *
 * Authorisation of organiser commands (SET_CAPACITY, CANCEL_SESSION, CANCEL_WORKSHOP,
 * CLOSE/OPEN_REGISTRATION) is NOT done here: the API layer checks org membership (C7) before
 * accepting the command, and the worker may settle a non-member's command as
 * REJECTED(FORBIDDEN). The engine only knows the workshop partition.
 */
export type ApplyResult =
  { ok: true; registration?: Registration } | { ok: false; reason: RejectReason };

const applied = (registration?: Registration): ApplyResult =>
  registration === undefined ? { ok: true } : { ok: true, registration };
const rejected = (reason: RejectReason): ApplyResult => ({ ok: false, reason });

export function applyCommand(st: WorkState, command: Command): ApplyResult {
  switch (command.type) {
    case 'TICK':
    case 'REALLOCATE':
      return applied();
    case 'REGISTER':
      return register(st, command);
    case 'ACCEPT_OFFER':
      return acceptOffer(st, command);
    case 'DECLINE_OFFER':
      return declineOffer(st, command);
    case 'CANCEL_REGISTRATION':
      return cancelRegistration(st, command);
    case 'SET_CAPACITY':
      return setCapacity(st, command);
    case 'CANCEL_SESSION':
      return cancelSession(st, command);
    case 'CANCEL_WORKSHOP':
      return cancelWorkshop(st);
    case 'CLOSE_REGISTRATION':
      return setWorkshopStatus(st, 'CLOSED');
    case 'OPEN_REGISTRATION':
      return setWorkshopStatus(st, 'OPEN');
  }
}

/**
 * Worst-case storage items the command's own writes may add (under `COMMIT_ITEM_COST`), so
 * that tick-first leaves room for them. Organiser cancels only flip a status here: their
 * drain is budget-bounded on its own. A rejected command costs nothing.
 */
export function commandItemReserve(st: WorkState, command: Command): number {
  switch (command.type) {
    case 'REGISTER':
      return 2; // PUT_REGISTRATION
    case 'ACCEPT_OFFER':
      return 6; // ARCHIVE_OFFER 2 + session 1 + PUT_REGISTRATION 2 + notification 1
    case 'DECLINE_OFFER':
      return 8; // ARCHIVE_OFFER 2 + session 1 + PUT_BACKFILL 1 + registration 3 + notification 1
    case 'CANCEL_REGISTRATION':
      // per registration: ARCHIVE_OFFER 2 + session 1 + PUT_BACKFILL 1 + ARCHIVE_REGISTRATION 3
      return registrationsToCancel(st, command).length * 7;
    case 'SET_CAPACITY':
    case 'CANCEL_SESSION':
      return 1; // PUT_SESSION
    default:
      return 0;
  }
}

/* ---------- participant commands ---------- */

function register(st: WorkState, command: RegisterCommand): ApplyResult {
  if (st.workshop.status !== 'OPEN') {
    return rejected('WORKSHOP_NOT_OPEN');
  }
  if (requiresSingleSession(st.mode) && command.acceptable.length !== 1) {
    return rejected('PER_SESSION_REQUIRES_ONE_SESSION');
  }
  if (new Set(command.acceptable).size !== command.acceptable.length) {
    return rejected('DUPLICATE_SESSION_IN_PREFERENCES');
  }
  const sessions: Session[] = [];
  for (const sessionId of command.acceptable) {
    const session = st.sessions.get(sessionId);
    if (session === undefined) {
      return rejected('UNKNOWN_SESSION_IN_PREFERENCES');
    }
    sessions.push(session);
  }
  // Sessions that can never be offered (cancelled, being cancelled, past cut-off: R4) are
  // dropped silently, so a live registration only lists sessions it can still get and the
  // per-session queue lengths count real demand.
  const acceptable = sessions.filter(
    (session) => session.status === 'OPEN' && !isPastCutoff(session, st.nowMs),
  );
  if (acceptable.length === 0) {
    return rejected('NO_ACCEPTABLE_SESSION');
  }
  const acceptableIds = acceptable.map((session) => session.id);
  for (const existing of st.registrations.values()) {
    if (registrationConflicts(st.mode, existing, command.actorUserId, acceptableIds)) {
      return rejected('ALREADY_REGISTERED'); // R1
    }
  }

  st.workshop.seq += 1; // R2: seq = FIFO order as seen by the single-writer worker
  touchWorkshop(st);
  const registration: Registration = {
    workshopId: st.workshop.id,
    userId: command.actorUserId,
    email: command.actorEmail,
    seq: st.workshop.seq,
    acceptable: acceptableIds,
    status: 'QUEUED',
    createdAt: st.now,
    updatedAt: st.now,
  };
  if (command.actorDisplayName !== undefined) {
    registration.displayName = command.actorDisplayName;
  }
  st.registrations.set(registration.seq, registration);
  touchRegistration(st, registration);
  return applied(registration);
}

type OfferLookup =
  | { ok: true; offer: Offer; registration: Registration; session: Session }
  | { ok: false; reason: RejectReason };

/**
 * Shared validation of ACCEPT_OFFER / DECLINE_OFFER. The reason is the same whichever message
 * arrived first (plan §4 "Expiry race"): an offer expired by an earlier tick is found among the
 * snapshot's `settledOffers` and answered with OFFER_EXPIRED, exactly like one that tick-first
 * expired in this decision or one that is merely past `expiresAt`.
 */
function lookupOwnLiveOffer(st: WorkState, offerId: string, actorUserId: string): OfferLookup {
  const offer =
    st.offers.get(offerId) ?? st.archivedOffers.find((archived) => archived.id === offerId);
  if (offer === undefined) {
    return lookupSettledOffer(st, offerId, actorUserId);
  }
  if (offer.userId !== actorUserId) {
    return { ok: false, reason: 'OFFER_NOT_YOURS' };
  }
  if (offer.status === 'EXPIRED') {
    return { ok: false, reason: 'OFFER_EXPIRED' }; // tick-first expired it in this decision
  }
  if (offer.status !== 'OFFERED') {
    return { ok: false, reason: 'OFFER_NOT_ACTIVE' }; // a settled offer in the live set
  }
  // The direct time check covers an offer left live by the per-decision expiry limit:
  // an ACCEPT after expiresAt never wins.
  if (parseIso(offer.expiresAt) <= st.nowMs) {
    return { ok: false, reason: 'OFFER_EXPIRED' };
  }
  const registration = st.registrations.get(offer.registrationSeq);
  const session = mustGet(st.sessions, offer.sessionId, 'session');
  if (session.status !== 'OPEN') {
    return { ok: false, reason: 'SESSION_CANCELLED' }; // the drain revokes it shortly
  }
  if (
    registration === undefined ||
    registration.status !== 'OFFERED' ||
    registration.currentOfferId !== offer.id
  ) {
    return { ok: false, reason: 'INVALID_STATE' };
  }
  return { ok: true, offer, registration, session };
}

/** An offer that is no longer live: history, if the service loaded it (ownership checked first). */
function lookupSettledOffer(st: WorkState, offerId: string, actorUserId: string): OfferLookup {
  const offer = st.settledOffers.find((candidate) => candidate.id === offerId);
  if (offer === undefined) {
    return { ok: false, reason: 'OFFER_NOT_FOUND' };
  }
  if (offer.userId !== actorUserId) {
    return { ok: false, reason: 'OFFER_NOT_YOURS' };
  }
  if (
    offer.status === 'EXPIRED' ||
    (offer.status === 'OFFERED' && parseIso(offer.expiresAt) <= st.nowMs)
  ) {
    return { ok: false, reason: 'OFFER_EXPIRED' };
  }
  return { ok: false, reason: 'OFFER_NOT_ACTIVE' }; // ACCEPTED / DECLINED / REVOKED
}

function acceptOffer(st: WorkState, command: AcceptOfferCommand): ApplyResult {
  const found = lookupOwnLiveOffer(st, command.offerId, command.actorUserId);
  if (!found.ok) {
    return found;
  }
  const { offer, registration, session } = found;
  settleOffer(st, offer, 'ACCEPTED');
  session.confirmed += 1;
  touchSession(st, session);
  registration.status = 'CONFIRMED';
  delete registration.currentOfferId;
  registration.confirmedSessionId = session.id;
  touchRegistration(st, registration);
  notifyConfirmed(st, registration, offer, session);
  return applied(registration);
}

function declineOffer(st: WorkState, command: DeclineOfferCommand): ApplyResult {
  const found = lookupOwnLiveOffer(st, command.offerId, command.actorUserId);
  if (!found.ok) {
    return found;
  }
  const { offer, registration, session } = found;
  settleOffer(st, offer, 'DECLINED');
  addBackfill(st, session.id, 'DECLINED', st.now);
  const outcome = dropSessionFromRegistration(st, registration, session.id); // R5
  notifyDeclined(st, registration, offer, session, outcome);
  return applied(registration);
}

/** The actor's live registrations a CANCEL_REGISTRATION concerns (all, or one in PER_SESSION). */
function registrationsToCancel(st: WorkState, command: CancelRegistrationCommand): Registration[] {
  let mine = liveRegistrations(st).filter(
    (registration) => registration.userId === command.actorUserId,
  );
  if (st.mode === 'PER_SESSION' && command.sessionId !== undefined) {
    mine = mine.filter((registration) => registration.acceptable[0] === command.sessionId);
  }
  return mine;
}

function cancelRegistration(st: WorkState, command: CancelRegistrationCommand): ApplyResult {
  const mine = registrationsToCancel(st, command);
  if (mine.length === 0) {
    return rejected('NOT_REGISTERED');
  }
  for (const registration of mine) {
    cancelOne(st, registration);
  }
  return applied(mine[0]);
}

/** R6: leave from any live status, releasing a held or confirmed seat for backfill. */
function cancelOne(st: WorkState, registration: Registration): void {
  if (registration.status === 'OFFERED') {
    const offer = mustGet(st.offers, registration.currentOfferId, 'offer');
    settleOffer(st, offer, 'REVOKED');
    addBackfill(st, offer.sessionId, 'CANCELLED_OFFER', st.now);
  } else if (registration.status === 'CONFIRMED') {
    const session = mustGet(st.sessions, registration.confirmedSessionId, 'session');
    session.confirmed -= 1;
    touchSession(st, session);
    addBackfill(st, session.id, 'CANCELLED_CONFIRMED', st.now);
  }
  archiveRegistration(st, registration, 'CANCELLED');
}

/* ---------- organiser commands ---------- */

function lookupOpenSession(st: WorkState, sessionId: string): Session | RejectReason {
  const session = st.sessions.get(sessionId);
  if (session === undefined) {
    return 'SESSION_NOT_FOUND';
  }
  if (session.status !== 'OPEN') {
    return 'SESSION_CANCELLED'; // CANCELLED, or CANCELLING with its drain still pending
  }
  return session;
}

function setCapacity(st: WorkState, command: SetCapacityCommand): ApplyResult {
  const session = lookupOpenSession(st, command.sessionId);
  if (typeof session === 'string') {
    return rejected(session);
  }
  if (!Number.isInteger(command.capacity) || command.capacity < 1) {
    return rejected('INVALID_CAPACITY');
  }
  if (command.capacity < session.confirmed + session.held) {
    return rejected('CAPACITY_BELOW_USAGE'); // R7
  }
  const added = command.capacity - session.capacity;
  session.capacity = command.capacity;
  touchSession(st, session);
  if (added > 0) {
    st.pendingCapacityUp.set(session.id, added); // one SET_CAPACITY per decision
  }
  return applied();
}

/**
 * The session stops being offered at once (status CANCELLING); its held and confirmed seats
 * and every preference list that names it are drained by `drainCancellations()` in this and,
 * if the item budget runs out, the following decisions; the status becomes CANCELLED when
 * nothing references the session any more.
 */
function cancelSession(st: WorkState, command: CancelSessionCommand): ApplyResult {
  const session = lookupOpenSession(st, command.sessionId);
  if (typeof session === 'string') {
    return rejected(session);
  }
  session.status = 'CANCELLING';
  touchSession(st, session);
  return applied();
}

/**
 * The workshop stops accepting user commands at once (status CANCELLING, rejected with
 * WORKSHOP_CANCELLED); every live registration and offer is archived by the drain, in seq
 * order and within the item budget, and the workshop and its sessions become CANCELLED when
 * nothing is left.
 */
function cancelWorkshop(st: WorkState): ApplyResult {
  st.workshop.status = 'CANCELLING';
  touchWorkshop(st);
  return applied();
}

function setWorkshopStatus(st: WorkState, status: 'OPEN' | 'CLOSED'): ApplyResult {
  if (st.workshop.status === status) {
    return rejected('INVALID_STATE');
  }
  st.workshop.status = status;
  touchWorkshop(st);
  return applied();
}
