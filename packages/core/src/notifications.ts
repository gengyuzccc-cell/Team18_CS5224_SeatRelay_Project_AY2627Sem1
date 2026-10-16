import type { EndReason, Offer, Registration, Session } from '@seatrelay/contracts';
import { notify, type WorkState } from './state';

/** Human-readable notification texts (email subject/body and in-app title/body). */

function sessionLabel(session: Session): string {
  return `"${session.title}" (starts ${session.startsAt})`;
}

function outcomeSentence(outcome: 'QUEUED' | 'ENDED'): string {
  return outcome === 'QUEUED'
    ? 'You keep your place in the queue for your other acceptable sessions.'
    : 'No acceptable session remains, so your registration has ended.';
}

export function notifyOffer(
  st: WorkState,
  registration: Registration,
  offer: Offer,
  session: Session,
): void {
  notify(
    st,
    registration,
    'OFFER',
    `Seat offered: ${session.title}`,
    `A seat in ${sessionLabel(session)} of "${st.workshop.title}" is held for you until ` +
      `${offer.expiresAt}. Accept it before then or it will be released to the next person in the queue.`,
    offer.id,
  );
}

export function notifyConfirmed(
  st: WorkState,
  registration: Registration,
  offer: Offer,
  session: Session,
): void {
  notify(
    st,
    registration,
    'CONFIRMED',
    `Seat confirmed: ${session.title}`,
    `Your seat in ${sessionLabel(session)} of "${st.workshop.title}" is confirmed.`,
    offer.id,
  );
}

export function notifyExpired(
  st: WorkState,
  registration: Registration,
  offer: Offer,
  session: Session,
  outcome: 'QUEUED' | 'ENDED',
): void {
  notify(
    st,
    registration,
    'EXPIRED',
    `Offer expired: ${session.title}`,
    `Your held seat in ${sessionLabel(session)} of "${st.workshop.title}" was released at ` +
      `${offer.expiresAt} because it was not accepted in time. ${outcomeSentence(outcome)}`,
    offer.id,
  );
}

export function notifyDeclined(
  st: WorkState,
  registration: Registration,
  offer: Offer,
  session: Session,
  outcome: 'QUEUED' | 'ENDED',
): void {
  notify(
    st,
    registration,
    'DECLINED',
    `Offer declined: ${session.title}`,
    `You declined the seat in ${sessionLabel(session)} of "${st.workshop.title}". ` +
      outcomeSentence(outcome),
    offer.id,
  );
}

export function notifyRevoked(
  st: WorkState,
  registration: Registration,
  offer: Offer,
  session: Session,
  outcome: 'QUEUED' | 'ENDED',
): void {
  notify(
    st,
    registration,
    'REVOKED',
    `Session cancelled: ${session.title}`,
    `The organiser cancelled ${sessionLabel(session)} of "${st.workshop.title}", so the seat ` +
      `held for you was withdrawn. ${outcomeSentence(outcome)}`,
    offer.id,
  );
}

export function notifySessionCancelled(
  st: WorkState,
  registration: Registration,
  session: Session,
  outcome: 'QUEUED' | 'ENDED',
): void {
  notify(
    st,
    registration,
    'SESSION_CANCELLED',
    `Session cancelled: ${session.title}`,
    `The organiser cancelled ${sessionLabel(session)} of "${st.workshop.title}". ` +
      outcomeSentence(outcome),
  );
}

export function notifyWorkshopCancelled(
  st: WorkState,
  target: Pick<Registration, 'userId' | 'email'>,
): void {
  notify(
    st,
    target,
    'WORKSHOP_CANCELLED',
    `Workshop cancelled: ${st.workshop.title}`,
    `The organiser cancelled "${st.workshop.title}". All registrations and held seats were released.`,
  );
}

export function notifyEnded(st: WorkState, registration: Registration, reason: EndReason): void {
  notify(
    st,
    registration,
    'ENDED',
    `Registration ended: ${st.workshop.title}`,
    `Your registration for "${st.workshop.title}" has ended (${reason}): every session you ` +
      'could attend has passed its registration cut-off.',
  );
}
