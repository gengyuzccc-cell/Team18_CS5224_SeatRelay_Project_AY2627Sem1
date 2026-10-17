import type { Offer } from '@seatrelay/contracts';
import { notifyEnded, notifyExpired } from './notifications';
import { canStillBeWaitedFor } from './snapshot';
import {
  UNIT_ITEM_COST,
  addBackfill,
  archiveRegistration,
  dropSessionFromRegistration,
  fitsBudget,
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
 *
 * Both steps are bounded by the expiry count and by the item budget, keeping `reserve` items
 * free for the command that follows; what is left over is done by the REALLOCATE continuation.
 * A workshop being cancelled (or cancelled) skips tick-first: its drain revokes everything.
 */
export function tickFirst(st: WorkState, reserve = 0): void {
  if (st.workshop.status === 'CANCELLING' || st.workshop.status === 'CANCELLED') {
    return;
  }
  expireDueOffers(st, reserve);
  endCutoffRegistrations(st, reserve);
}

function dueOffers(st: WorkState): Offer[] {
  return liveOffers(st)
    .filter((offer) => parseIso(offer.expiresAt) <= st.nowMs)
    .sort((a, b) => parseIso(a.expiresAt) - parseIso(b.expiresAt) || (a.id < b.id ? -1 : 1));
}

function expireDueOffers(st: WorkState, reserve: number): void {
  for (const offer of dueOffers(st)) {
    if (
      st.offersExpired >= st.limits.maxExpiriesPerDecision ||
      !fitsBudget(st, UNIT_ITEM_COST.EXPIRY, reserve)
    ) {
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

function endCutoffRegistrations(st: WorkState, reserve: number): void {
  for (const registration of liveRegistrations(st)) {
    if (registration.status !== 'QUEUED') {
      continue;
    }
    const stillPossible = registration.acceptable.some((sessionId) => {
      const session = st.sessions.get(sessionId);
      return session !== undefined && canStillBeWaitedFor(session, st.nowMs);
    });
    if (stillPossible) {
      continue;
    }
    if (!fitsBudget(st, UNIT_ITEM_COST.CUTOFF_END, reserve)) {
      st.continuationNeeded = true;
      return;
    }
    archiveRegistration(st, registration, 'ENDED', 'CUTOFF');
    notifyEnded(st, registration, 'CUTOFF');
  }
}
