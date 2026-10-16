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
import {
  notifyConfirmed,
  notifyDeclined,
  notifyRevoked,
  notifySessionCancelled,
  notifyWorkshopCancelled,
} from './notifications';
import { registrationConflicts, requiresSingleSession } from './perSession';
import { isPastCutoff } from './snapshot';
import {
  addBackfill,
  archiveRegistration,
  dropSessionFromRegistration,
  liveOffers,
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
  // Cancelled sessions are dropped silently (they never appear in a live registration);
  // sessions past cut-off stay listed but can no longer be offered (R4).
  const acceptable = sessions.filter((session) => session.status === 'OPEN');
  if (acceptable.every((session) => isPastCutoff(session, st.nowMs))) {
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

/** Shared validation of ACCEPT_OFFER / DECLINE_OFFER. */
function lookupOwnLiveOffer(st: WorkState, offerId: string, actorUserId: string): OfferLookup {
  const offer =
    st.offers.get(offerId) ?? st.archivedOffers.find((archived) => archived.id === offerId);
  if (offer === undefined) {
    return { ok: false, reason: 'OFFER_NOT_FOUND' };
  }
  if (offer.userId !== actorUserId) {
    return { ok: false, reason: 'OFFER_NOT_YOURS' };
  }
  // Tick-first already expired due offers (status EXPIRED here); the direct time check covers
  // an offer left live by the per-decision expiry limit. An ACCEPT after expiresAt never wins.
  if (offer.status === 'EXPIRED' || parseIso(offer.expiresAt) <= st.nowMs) {
    return { ok: false, reason: 'OFFER_EXPIRED' };
  }
  if (offer.status !== 'OFFERED') {
    return { ok: false, reason: 'OFFER_NOT_ACTIVE' }; // a settled offer in the live set
  }
  const registration = st.registrations.get(offer.registrationSeq);
  const session = mustGet(st.sessions, offer.sessionId, 'session');
  if (
    registration === undefined ||
    registration.status !== 'OFFERED' ||
    registration.currentOfferId !== offer.id ||
    session.status !== 'OPEN'
  ) {
    return { ok: false, reason: 'INVALID_STATE' };
  }
  return { ok: true, offer, registration, session };
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

function cancelRegistration(st: WorkState, command: CancelRegistrationCommand): ApplyResult {
  let mine = liveRegistrations(st).filter(
    (registration) => registration.userId === command.actorUserId,
  );
  if (st.mode === 'PER_SESSION' && command.sessionId !== undefined) {
    mine = mine.filter((registration) => registration.acceptable[0] === command.sessionId);
  }
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
  if (session.status === 'CANCELLED') {
    return 'SESSION_CANCELLED';
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

function cancelSession(st: WorkState, command: CancelSessionCommand): ApplyResult {
  const session = lookupOpenSession(st, command.sessionId);
  if (typeof session === 'string') {
    return rejected(session);
  }
  // Held seats: offers are withdrawn; their owners return to the queue for other sessions.
  for (const offer of liveOffers(st)) {
    if (offer.sessionId !== session.id) {
      continue;
    }
    settleOffer(st, offer, 'REVOKED');
    addBackfill(st, session.id, 'SESSION_CANCELLED', st.now);
    const registration = mustGet(st.registrations, offer.registrationSeq, 'registration');
    const outcome = dropSessionFromRegistration(st, registration, session.id);
    notifyRevoked(st, registration, offer, session, outcome);
  }
  // Everyone else who listed the session loses it from their preferences.
  for (const registration of liveRegistrations(st)) {
    if (!registration.acceptable.includes(session.id)) {
      continue;
    }
    if (registration.status === 'QUEUED') {
      const outcome = dropSessionFromRegistration(st, registration, session.id);
      notifySessionCancelled(st, registration, session, outcome);
    } else if (registration.confirmedSessionId === session.id) {
      session.confirmed -= 1;
      addBackfill(st, session.id, 'SESSION_CANCELLED', st.now);
      const outcome = dropSessionFromRegistration(st, registration, session.id);
      notifySessionCancelled(st, registration, session, outcome);
    } else {
      // OFFERED or CONFIRMED in another session: the hold is untouched, only the fallback goes.
      registration.acceptable = registration.acceptable.filter((id) => id !== session.id);
      touchRegistration(st, registration);
    }
  }
  session.status = 'CANCELLED';
  touchSession(st, session);
  return applied();
}

function cancelWorkshop(st: WorkState): ApplyResult {
  for (const offer of liveOffers(st)) {
    settleOffer(st, offer, 'REVOKED');
  }
  const notified = new Set<string>();
  for (const registration of liveRegistrations(st)) {
    if (registration.status === 'CONFIRMED') {
      const session = mustGet(st.sessions, registration.confirmedSessionId, 'session');
      session.confirmed -= 1;
      touchSession(st, session);
    }
    archiveRegistration(st, registration, 'ENDED', 'WORKSHOP_CANCELLED');
    if (!notified.has(registration.userId)) {
      notified.add(registration.userId);
      notifyWorkshopCancelled(st, registration);
    }
  }
  for (const session of st.sessions.values()) {
    if (session.status === 'OPEN') {
      session.status = 'CANCELLED';
      touchSession(st, session);
    }
  }
  st.workshop.status = 'CANCELLED';
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
