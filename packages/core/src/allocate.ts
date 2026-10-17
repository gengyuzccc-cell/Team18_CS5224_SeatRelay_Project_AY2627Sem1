import type { Offer, Registration, Session } from '@seatrelay/contracts';
import { notifyOffer } from './notifications';
import { isAllocatable } from './snapshot';
import {
  UNIT_ITEM_COST,
  addBackfill,
  fillBackfill,
  fitsBudget,
  liveRegistrations,
  touchRegistration,
  touchSession,
  type WorkState,
} from './state';
import { addSeconds, minIso } from './time';

/**
 * Step 3 of every decision (plan §2.2): scan QUEUED registrations in seq order (R2/R3) and
 * offer each one the first session in its preference order that is OPEN, before cut-off and
 * has a free seat. In PER_SESSION mode every registration lists exactly one session, so the
 * same scan yields independent per-session FIFO queues.
 *
 * At most `limits.maxOffersPerDecision` offers are created and the item budget is never
 * crossed; if more could be, the decision carries a REALLOCATE continuation.
 */
export function allocate(st: WorkState): void {
  for (const registration of liveRegistrations(st)) {
    if (registration.status !== 'QUEUED') {
      continue;
    }
    const session = firstAllocatableSession(st, registration);
    if (session === undefined) {
      continue;
    }
    if (
      st.offersCreated >= st.limits.maxOffersPerDecision ||
      !fitsBudget(st, UNIT_ITEM_COST.OFFER)
    ) {
      st.continuationNeeded = true;
      return;
    }
    createOffer(st, registration, session);
  }
}

export function firstAllocatableSession(
  st: WorkState,
  registration: Registration,
): Session | undefined {
  for (const sessionId of registration.acceptable) {
    const session = st.sessions.get(sessionId);
    if (session !== undefined && isAllocatable(session, st.nowMs)) {
      return session;
    }
  }
  return undefined;
}

/** `expiresAt = min(now + holdSeconds, cutoffAt)` (R4). */
export function offerExpiry(st: WorkState, session: Session): string {
  return minIso(addSeconds(st.now, st.workshop.holdSeconds), session.cutoffAt);
}

export function createOffer(st: WorkState, registration: Registration, session: Session): Offer {
  const offer: Offer = {
    id: st.newId(),
    workshopId: st.workshop.id,
    sessionId: session.id,
    userId: registration.userId,
    registrationSeq: registration.seq,
    status: 'OFFERED',
    createdAt: st.now,
    expiresAt: offerExpiry(st, session),
  };
  st.offers.set(offer.id, offer);
  st.newOfferIds.push(offer.id);
  st.offersCreated += 1;

  session.held += 1;
  touchSession(st, session);

  registration.status = 'OFFERED';
  registration.currentOfferId = offer.id;
  touchRegistration(st, registration);

  st.timers.push({ offerId: offer.id, expiresAt: offer.expiresAt });
  notifyOffer(st, registration, offer, session);
  relaySeat(st, session, offer);
  return offer;
}

/**
 * Attributes the seat just offered to a release that still waits for a taker: first the oldest
 * pending backfill record of the session (those carried by the snapshot from an earlier
 * decision of the continuation chain come before the ones released here), otherwise a seat
 * added by SET_CAPACITY (recorded as CAPACITY_UP only when somebody actually gets it).
 */
function relaySeat(st: WorkState, session: Session, offer: Offer): void {
  const pending = st.backfills.find(
    (record) => record.sessionId === session.id && record.reallocatedAt === undefined,
  );
  if (pending !== undefined) {
    fillBackfill(st, pending, offer);
    return;
  }
  const added = st.pendingCapacityUp.get(session.id) ?? 0;
  if (added > 0) {
    st.pendingCapacityUp.set(session.id, added - 1);
    fillBackfill(st, addBackfill(st, session.id, 'CAPACITY_UP', st.now), offer);
  }
}
