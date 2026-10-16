import type { Offer } from '@seatrelay/contracts';
import { notifyEnded, notifyExpired } from './notifications';
import { isStillOpenForAllocation } from './snapshot';
import {
  addBackfill,
  archiveRegistration,
  dropSessionFromRegistration,
  liveOffers,
  liveRegistrations,
  mustGet,
  settleOffer,
  type WorkState,
} from './state';
import { parseIso } from './time';

/**
 * Tick-first (plan §1.2): before any command is applied, expiry is decided by server time.
 * Every live offer with `expiresAt <= now` is EXPIRED and its seat released; a QUEUED
 * registration whose acceptable sessions have all passed cut-off (or were cancelled) is
 * ENDED(CUTOFF). Late, duplicate or stale timer messages are therefore harmless no-ops, and an
 * ACCEPT after `expiresAt` is rejected even if no timer has arrived yet.
 */
export function tickFirst(st: WorkState): void {
  expireDueOffers(st);
  endCutoffRegistrations(st);
}

function dueOffers(st: WorkState): Offer[] {
  return liveOffers(st)
    .filter((offer) => parseIso(offer.expiresAt) <= st.nowMs)
    .sort((a, b) => parseIso(a.expiresAt) - parseIso(b.expiresAt) || (a.id < b.id ? -1 : 1));
}

function expireDueOffers(st: WorkState): void {
  for (const offer of dueOffers(st)) {
    if (st.offersExpired >= st.limits.maxExpiriesPerDecision) {
      st.continuationNeeded = true;
      return;
    }
    expireOffer(st, offer);
  }
}

export function expireOffer(st: WorkState, offer: Offer): void {
  settleOffer(st, offer, 'EXPIRED');
  st.offersExpired += 1;
  addBackfill(st, offer.sessionId, 'EXPIRED', offer.expiresAt);
  const registration = st.registrations.get(offer.registrationSeq);
  if (registration === undefined) {
    return; // dangling offer in a corrupted snapshot: the seat is released, nothing else to do
  }
  const session = mustGet(st.sessions, offer.sessionId, 'session');
  const outcome = dropSessionFromRegistration(st, registration, offer.sessionId);
  notifyExpired(st, registration, offer, session, outcome);
}

function endCutoffRegistrations(st: WorkState): void {
  for (const registration of liveRegistrations(st)) {
    if (registration.status !== 'QUEUED') {
      continue;
    }
    const stillPossible = registration.acceptable.some((sessionId) => {
      const session = st.sessions.get(sessionId);
      return session !== undefined && isStillOpenForAllocation(session, st.nowMs);
    });
    if (!stillPossible) {
      archiveRegistration(st, registration, 'ENDED', 'CUTOFF');
      notifyEnded(st, registration, 'CUTOFF');
    }
  }
}
