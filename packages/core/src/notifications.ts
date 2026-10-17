import {
  CUTOFF_BEFORE_START_SECONDS,
  type EndReason,
  type Offer,
  type Registration,
  type Session,
} from '@seatrelay/contracts';
import { formatDisplayTime } from './displayTime';
import { notify, type WorkState } from './state';

/**
 * Human-readable notification texts (e-mail subject/body and in-app title/body). Times are
 * written for people (`formatDisplayTime`, e.g. `Wed 21 Oct 2026, 10:00 SGT`), and every ending
 * says in plain words what happened and what the participant can still do.
 */

const CUTOFF_TEXT = `the registration cut-off (${CUTOFF_BEFORE_START_SECONDS / 60} minutes before the start)`;

/**
 * Who gets a released seat. Conditional on purpose: a release only becomes an offer when an
 * acceptable registration is queued; otherwise the backfill record waits for a taker.
 */
const NEXT_PERSON = 'the next person waiting, if there is one';

function sessionLabel(session: Session): string {
  return `"${session.title}" (starts ${formatDisplayTime(session.startsAt)})`;
}

/**
 * Title of the notice that the organiser cancelled a session (SESSION_CANCELLED, and REVOKED for
 * a held seat in it). The service matches it against the workshop's sessions to tell which
 * cancellation ended a registration (`GET /me/registrations`), so both sides use this function.
 */
export function sessionCancelledTitle(session: Pick<Session, 'title'>): string {
  return `Session cancelled: ${session.title}`;
}

/**
 * What a released hold or a lost session means for the registration (R5): back in the queue for
 * the other chosen sessions, or ended because nothing is left / everything left is past cut-off.
 * PER_SESSION: a registration is for one session only, so it is that registration that ended;
 * the participant's registrations for other sessions are not affected (never "the last session").
 */
function outcomeSentence(
  st: WorkState,
  registration: Registration,
  outcome: 'QUEUED' | 'ENDED',
): string {
  if (outcome === 'QUEUED') {
    return 'You keep your place in the queue for the other sessions you chose.';
  }
  if (st.mode === 'PER_SESSION') {
    return (
      'Your registration for this session has ended; any registrations you have for other ' +
      'sessions are not affected. If registration is still open you can register for this ' +
      'session again on the workshop page; you will join the end of its queue.'
    );
  }
  return registration.endReason === 'CUTOFF'
    ? `The other sessions you chose are past ${CUTOFF_TEXT}, so your registration has ended.`
    : 'That was the last session you had chosen, so your registration has ended. If registration ' +
        'is still open you can register again on the workshop page; you will join the end of the queue.';
}

/** Why a registration ended, for `notifyEnded` (the tick ends QUEUED registrations at cut-off). */
const ENDED_BECAUSE: Record<EndReason, string> = {
  CUTOFF: `${CUTOFF_TEXT} passed for every session you had chosen before a seat became free for you`,
  NO_ACCEPTABLE_SESSION: 'no session you had chosen is left',
  WORKSHOP_CANCELLED: 'the organiser cancelled the workshop',
};

/** `ENDED_BECAUSE`, but PER_SESSION names the one session of the registration (not "every"). */
function endedBecause(st: WorkState, registration: Registration, reason: EndReason): string {
  const sessionId = registration.acceptable[0];
  const session = sessionId === undefined ? undefined : st.sessions.get(sessionId);
  if (st.mode !== 'PER_SESSION' || reason !== 'CUTOFF' || session === undefined) {
    return ENDED_BECAUSE[reason];
  }
  return `${CUTOFF_TEXT} passed for ${sessionLabel(session)} before a seat became free for you`;
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
      `${formatDisplayTime(offer.expiresAt)}. Accept it before then, or it will be released for ` +
      `${NEXT_PERSON}.`,
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
    `Your hold on a seat in ${sessionLabel(session)} of "${st.workshop.title}" expired at ` +
      `${formatDisplayTime(offer.expiresAt)} because it was not accepted in time, so the seat ` +
      `is free again for ${NEXT_PERSON}. ${outcomeSentence(st, registration, outcome)}`,
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
    `You declined the seat held for you in ${sessionLabel(session)} of "${st.workshop.title}", ` +
      `so it is free again for ${NEXT_PERSON}. ${outcomeSentence(st, registration, outcome)}`,
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
    sessionCancelledTitle(session),
    `The organiser cancelled ${sessionLabel(session)} of "${st.workshop.title}", so the seat ` +
      `held for you there was withdrawn. ${outcomeSentence(st, registration, outcome)}`,
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
    sessionCancelledTitle(session),
    `The organiser cancelled ${sessionLabel(session)} of "${st.workshop.title}". ` +
      outcomeSentence(st, registration, outcome),
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
    `The organiser cancelled "${st.workshop.title}". Your registration has ended, and any seat ` +
      'held or confirmed for you was released.',
  );
}

export function notifyEnded(st: WorkState, registration: Registration, reason: EndReason): void {
  notify(
    st,
    registration,
    'ENDED',
    `Registration ended: ${st.workshop.title}`,
    `Your registration for "${st.workshop.title}" has ended: ${endedBecause(st, registration, reason)}.`,
  );
}
