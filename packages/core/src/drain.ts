import type { Session } from '@seatrelay/contracts';
import { notifyRevoked, notifySessionCancelled, notifyWorkshopCancelled } from './notifications';
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
  touchRegistration,
  touchSession,
  touchWorkshop,
  type WorkState,
} from './state';

/**
 * Organiser cancellations are drained in budget-sized steps (plan §2.3: one commit is one
 * transaction of at most 100 items), so CANCEL_SESSION and CANCEL_WORKSHOP only flip a status
 * and this step, run by every decision after the command was applied, does the work:
 *
 * - a CANCELLING session: revoke its offers (REVOKED, owners back to the queue for their other
 *   sessions), release its confirmed seats, remove it from every preference list, then mark it
 *   CANCELLED once nothing references it;
 * - a CANCELLING workshop: archive every live registration (ENDED, WORKSHOP_CANCELLED) with
 *   its offer revoked, one notification per user per decision, then cancel every session and
 *   mark the workshop CANCELLED.
 *
 * When the budget runs out `continuationNeeded` is set: the REALLOCATE continuation (or the
 * sweep, since `nextDueAt` is `now` meanwhile) finishes the job. Every unit is complete on its
 * own, so a live registration never references an archived offer between two steps.
 */
export function drainCancellations(st: WorkState): void {
  if (st.workshop.status === 'CANCELLING') {
    drainWorkshop(st);
    return;
  }
  for (const sessionId of st.sessionOrder) {
    const session = mustGet(st.sessions, sessionId, 'session');
    if (session.status === 'CANCELLING' && !drainSession(st, session)) {
      return;
    }
  }
}

/** Returns false when the budget stopped the drain before the session could be CANCELLED. */
function drainSession(st: WorkState, session: Session): boolean {
  // Held seats first: offers are withdrawn; their owners return to the queue for other sessions.
  const offers = liveOffers(st)
    .filter((offer) => offer.sessionId === session.id)
    .sort((a, b) => a.registrationSeq - b.registrationSeq || (a.id < b.id ? -1 : 1));
  for (const offer of offers) {
    if (!fitsBudget(st, UNIT_ITEM_COST.DRAIN_SESSION_OFFER)) {
      st.continuationNeeded = true;
      return false;
    }
    settleOffer(st, offer, 'REVOKED');
    addBackfill(st, session.id, 'SESSION_CANCELLED', st.now);
    const registration = st.registrations.get(offer.registrationSeq);
    if (registration !== undefined) {
      const outcome = dropSessionFromRegistration(st, registration, session.id);
      notifyRevoked(st, registration, offer, session, outcome);
    }
  }
  // Everyone else who listed the session loses it from their preferences.
  for (const registration of liveRegistrations(st)) {
    if (!registration.acceptable.includes(session.id)) {
      continue;
    }
    if (!fitsBudget(st, UNIT_ITEM_COST.DRAIN_SESSION_REGISTRATION)) {
      st.continuationNeeded = true;
      return false;
    }
    if (registration.status === 'QUEUED') {
      const outcome = dropSessionFromRegistration(st, registration, session.id);
      notifySessionCancelled(st, registration, session, outcome);
    } else if (registration.confirmedSessionId === session.id) {
      session.confirmed -= 1;
      touchSession(st, session);
      addBackfill(st, session.id, 'SESSION_CANCELLED', st.now);
      const outcome = dropSessionFromRegistration(st, registration, session.id);
      notifySessionCancelled(st, registration, session, outcome);
    } else {
      // OFFERED or CONFIRMED in another session: the hold is untouched, only the fallback goes.
      registration.acceptable = registration.acceptable.filter((id) => id !== session.id);
      touchRegistration(st, registration);
    }
  }
  if (!fitsBudget(st, 1)) {
    st.continuationNeeded = true;
    return false;
  }
  session.status = 'CANCELLED';
  touchSession(st, session);
  return true;
}

function drainWorkshop(st: WorkState): void {
  const notified = new Set<string>();
  for (const registration of liveRegistrations(st)) {
    if (!fitsBudget(st, UNIT_ITEM_COST.DRAIN_WORKSHOP_REGISTRATION)) {
      st.continuationNeeded = true;
      return;
    }
    if (registration.status === 'OFFERED') {
      settleOffer(st, mustGet(st.offers, registration.currentOfferId, 'offer'), 'REVOKED');
    } else if (registration.status === 'CONFIRMED') {
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
  for (const offer of liveOffers(st)) {
    // dangling offers of a corrupted snapshot: release the seats all the same
    if (!fitsBudget(st, UNIT_ITEM_COST.DANGLING_OFFER)) {
      st.continuationNeeded = true;
      return;
    }
    settleOffer(st, offer, 'REVOKED');
  }
  const toCancel = [...st.sessions.values()].filter((session) => session.status !== 'CANCELLED');
  const untouched = toCancel.filter((session) => !st.dirtySessions.has(session.id)).length;
  if (!fitsBudget(st, untouched)) {
    st.continuationNeeded = true;
    return;
  }
  for (const session of toCancel) {
    session.status = 'CANCELLED';
    touchSession(st, session);
  }
  st.workshop.status = 'CANCELLED';
  touchWorkshop(st);
}
