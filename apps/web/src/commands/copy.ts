import {
  CUTOFF_BEFORE_START_SECONDS,
  type BackfillCause,
  type CommandResultView,
  type EndReason,
  type MyRegistrationView,
  type RegistrationSummary,
  type RejectReason,
  type SessionView,
  type UserCommandType,
  type WorkshopMode,
} from '@seatrelay/contracts';
import { serverNow } from '../util/serverClock';
import { formatCountdown, formatMoment, msUntil } from '../util/time';

/** Human-readable copy for everything the engine can answer (plan §1.3 toasts, §2.6). */

export const REJECT_REASON_TEXT: Record<RejectReason, string> = {
  WORKSHOP_NOT_OPEN: 'Registration for this workshop is closed.',
  WORKSHOP_CANCELLED: 'This workshop has been cancelled.',
  ALREADY_REGISTERED: 'You already have a registration here.',
  NOT_REGISTERED: 'You have no registration to act on.',
  NO_ACCEPTABLE_SESSION: 'None of the sessions you accept can still be joined.',
  SESSION_NOT_FOUND: 'That session does not exist.',
  SESSION_CANCELLED: 'That session has been cancelled.',
  OFFER_NOT_FOUND: 'That offer no longer exists.',
  OFFER_NOT_YOURS: 'That offer belongs to someone else.',
  OFFER_EXPIRED: 'The offer expired before your answer arrived.',
  OFFER_NOT_ACTIVE: 'That offer is no longer active.',
  INVALID_STATE: 'This action is not possible in the current state.',
  CAPACITY_BELOW_USAGE: 'Capacity cannot go below the seats already confirmed or held.',
  INVALID_CAPACITY: 'Capacity must be at least 1.',
  UNKNOWN_SESSION_IN_PREFERENCES: 'One of the chosen sessions does not belong to this workshop.',
  DUPLICATE_SESSION_IN_PREFERENCES: 'A session was listed twice in your preferences.',
  PER_SESSION_REQUIRES_ONE_SESSION: 'Pick exactly one session in per-session mode.',
  FORBIDDEN: 'You are not allowed to do that.',
};

const CUTOFF_TEXT = `the registration cut-off (${CUTOFF_BEFORE_START_SECONDS / 60} minutes before the start)`;

/**
 * Why a registration ended, when nothing more is known (a poll result, an old entry). With the
 * ending from `GET /me/registrations`, `describeEnding` says exactly what happened instead.
 * UNIFIED wording; `endReasonText` gives the PER_SESSION one.
 */
export const END_REASON_TEXT: Record<EndReason, string> = {
  CUTOFF: `${CUTOFF_TEXT} passed for every session you had chosen before a seat became free for you`,
  NO_ACCEPTABLE_SESSION:
    'none of the sessions you had chosen is left: you declined or let expire the seat held for ' +
    'you in the last one, or the organiser cancelled it',
  WORKSHOP_CANCELLED: 'the organiser cancelled the workshop',
};

/**
 * PER_SESSION: a registration is for one session, and the participant may hold registrations
 * for other sessions, so the reason is about this session only (never "every" or "the last").
 */
const PER_SESSION_END_REASON_TEXT: Record<EndReason, string> = {
  CUTOFF: `${CUTOFF_TEXT} passed for this session before a seat became free for you`,
  NO_ACCEPTABLE_SESSION:
    'you declined or let expire the seat held for you in this session, or the organiser ' +
    'cancelled it',
  WORKSHOP_CANCELLED: END_REASON_TEXT.WORKSHOP_CANCELLED,
};

export function endReasonText(endReason: EndReason, mode: WorkshopMode = 'UNIFIED'): string {
  return mode === 'PER_SESSION'
    ? PER_SESSION_END_REASON_TEXT[endReason]
    : END_REASON_TEXT[endReason];
}

/**
 * Who gets a released seat. Conditional on purpose: a release becomes an offer only when an
 * acceptable registration is queued; otherwise the backfill record waits for a taker.
 */
const FREE_AGAIN = 'free again for the next person waiting, if there is one';

/** After a cancellation whose ending is not known yet (toast, card before the list catches up). */
export const CANCELLED_RELEASE_TEXT =
  'If you held or had a confirmed seat, it is free again for the next person waiting.';

/** The line under an ended registration that can be started again (plan R2: new seq). */
export const REGISTER_AGAIN_TEXT = 'You can register again; you will join the end of the queue.';

export const BACKFILL_CAUSE_TEXT: Record<BackfillCause, string> = {
  EXPIRED: 'offer expired',
  DECLINED: 'offer declined',
  CANCELLED_CONFIRMED: 'confirmed seat cancelled',
  CANCELLED_OFFER: 'held seat cancelled',
  CAPACITY_UP: 'capacity increased',
  SESSION_CANCELLED: 'session cancelled',
};

export const COMMAND_TYPE_TEXT: Record<UserCommandType, string> = {
  REGISTER: 'Registration',
  ACCEPT_OFFER: 'Accept',
  DECLINE_OFFER: 'Decline',
  CANCEL_REGISTRATION: 'Cancellation',
  SET_CAPACITY: 'Capacity change',
  CANCEL_SESSION: 'Session cancellation',
  CANCEL_WORKSHOP: 'Workshop cancellation',
  CLOSE_REGISTRATION: 'Close registration',
  OPEN_REGISTRATION: 'Open registration',
};

/** A registration as `GET /me/registrations` lists it (with `ending` once it is archived). */
export type ListedRegistration = MyRegistrationView['registration'];

export interface EndingCopy {
  /** One line for lists: `ended: your hold on Session 2 expired`. */
  summary: string;
  /** Full sentences for the status card: what happened, when, and what it means. */
  detail: string;
}

/**
 * What losing the session meant for the rest of the registration (R5). PER_SESSION: only this
 * session's registration ended (registrations for other sessions are not affected).
 */
function afterLosingSession(endReason: EndReason | undefined, mode: WorkshopMode): string {
  if (mode === 'PER_SESSION') {
    return 'Your registration for this session has ended.';
  }
  switch (endReason) {
    case 'NO_ACCEPTABLE_SESSION':
      return 'That was the last session you had chosen, so your registration has ended.';
    case 'CUTOFF':
      return `The other sessions you had chosen are past ${CUTOFF_TEXT}, so your registration has ended.`;
    default:
      return 'Your registration has ended.';
  }
}

/**
 * Plain-words copy for a CANCELLED/ENDED registration: what happened (hold expired, declined,
 * cancelled by you or by the organiser, cut-off reached), to which session and when. Uses the
 * `ending` of `GET /me/registrations` when present and degrades to the end reason otherwise
 * (e.g. a poll result shown before the list caught up). `mode` is the workshop's.
 */
export function describeEnding(
  registration: Pick<
    ListedRegistration,
    'status' | 'endReason' | 'updatedAt' | 'acceptable' | 'ending'
  >,
  sessions: readonly SessionView[],
  now: number = serverNow(),
  mode: WorkshopMode = 'UNIFIED',
): EndingCopy {
  const when = (iso: string) => formatMoment(iso, now);
  const ended = when(registration.updatedAt);
  const offer = registration.ending?.offer;
  const offerSession = sessionTitle(sessions, offer?.sessionId);
  const confirmedId = registration.ending?.confirmedSessionId;
  const confirmedSession = sessionTitle(sessions, confirmedId);

  if (registration.status === 'CANCELLED') {
    if (confirmedId !== undefined) {
      return {
        summary: `cancelled: you gave up your seat in ${confirmedSession}`,
        detail: `You gave up your confirmed seat in ${confirmedSession} ${ended}; it is ${FREE_AGAIN}.`,
      };
    }
    // The cancel withdrew a hold (REVOKED), or the hold had expired just before it, in the same
    // decision (tick-first, plan §1.2): then the participant was back in the queue when cancelling.
    if (offer?.status === 'REVOKED') {
      return {
        summary: `cancelled: you gave up the seat held for you in ${offerSession}`,
        detail: `You cancelled your registration ${ended} while a seat in ${offerSession} was held for you; the seat is ${FREE_AGAIN}.`,
      };
    }
    if (offer?.status === 'EXPIRED') {
      return {
        summary: `cancelled: you left the queue after your hold on ${offerSession} expired`,
        detail: `Your hold for ${offerSession} expired ${when(offer.expiresAt)} without being accepted; you then cancelled your registration ${ended} and left the queue.`,
      };
    }
    if (registration.ending === undefined) {
      return {
        summary: 'cancelled by you',
        detail: `You cancelled your registration ${ended}. ${CANCELLED_RELEASE_TEXT}`,
      };
    }
    return offer === undefined
      ? {
          summary: 'cancelled: you left the queue',
          detail: `You cancelled your registration ${ended} and left the queue.`,
        }
      : { summary: 'cancelled by you', detail: `You cancelled your registration ${ended}.` };
  }

  if (registration.status !== 'ENDED') {
    return { summary: registration.status.toLowerCase(), detail: '' };
  }

  if (registration.endReason === 'WORKSHOP_CANCELLED') {
    const released =
      confirmedId !== undefined
        ? ` Your confirmed seat in ${confirmedSession} was released.`
        : offer?.status === 'REVOKED'
          ? ` The seat held for you in ${offerSession} was withdrawn.`
          : offer?.status === 'EXPIRED'
            ? ` Your hold for ${offerSession} had already expired ${when(offer.expiresAt)}.`
            : '';
    return {
      summary: 'ended: the organiser cancelled the workshop',
      detail: `The organiser cancelled this workshop ${ended}, so your registration has ended.${released}`,
    };
  }

  // The organiser cancelled the session that ended it (the server names it only then): the
  // rest of the registration was gone or past the cut-off, and a confirmed seat there is lost.
  const cancelledId = registration.ending?.cancelledSessionId;
  if (cancelledId !== undefined) {
    const cancelled = sessionTitle(sessions, cancelledId);
    const after = afterLosingSession(registration.endReason, mode);
    return confirmedId === cancelledId
      ? {
          summary: `ended: the organiser cancelled ${cancelled}, where your seat was confirmed`,
          detail: `The organiser cancelled ${cancelled} ${ended}, so you lost your confirmed seat in it. ${after}`,
        }
      : {
          summary: `ended: the organiser cancelled ${cancelled}`,
          detail: `The organiser cancelled ${cancelled} ${ended}. ${after}`,
        };
  }

  if (offer?.status === 'EXPIRED') {
    return {
      summary: `ended: your hold on ${offerSession} expired`,
      detail: `Your hold for ${offerSession} expired ${when(offer.expiresAt)} without being accepted — the seat is ${FREE_AGAIN}. ${afterLosingSession(registration.endReason, mode)}`,
    };
  }
  if (offer?.status === 'DECLINED') {
    return {
      summary: `ended: you declined ${offerSession}`,
      detail: `You declined the seat held for you in ${offerSession} ${when(offer.settledAt)} — it is ${FREE_AGAIN}. ${afterLosingSession(registration.endReason, mode)}`,
    };
  }
  if (offer?.status === 'REVOKED') {
    return {
      summary: `ended: the organiser cancelled ${offerSession}`,
      detail: `The organiser cancelled ${offerSession} ${when(offer.settledAt)} while a seat in it was held for you. ${afterLosingSession(registration.endReason, mode)}`,
    };
  }

  if (registration.endReason === 'CUTOFF') {
    // The tick ended a queued registration at the cut-off (an organiser cancellation that left
    // only past-cut-off sessions is named above, as `cancelledSessionId`).
    const chosen =
      registration.acceptable.length > 0
        ? registration.acceptable.map((id) => sessionTitle(sessions, id)).join(', ')
        : mode === 'PER_SESSION'
          ? 'this session'
          : 'every session you had chosen';
    return {
      summary: 'ended: the registration cut-off passed before a seat became free',
      detail: `${capitalise(CUTOFF_TEXT)} passed for ${chosen} before a seat became free for you, so your registration has ended (${ended}).`,
    };
  }
  if (registration.endReason === 'NO_ACCEPTABLE_SESSION') {
    if (registration.ending === undefined) {
      return {
        summary:
          mode === 'PER_SESSION'
            ? 'ended: you no longer hold or wait for a seat in this session'
            : 'ended: none of the sessions you had chosen is left',
        detail: `Your registration has ended ${ended}: ${endReasonText('NO_ACCEPTABLE_SESSION', mode)}.`,
      };
    }
    // Known ending with no offer and no named session: the organiser cancelled the session
    // itself (whether the participant was queued for it or had a confirmed seat in it).
    return mode === 'PER_SESSION'
      ? {
          summary: 'ended: the organiser cancelled your session',
          detail: `The organiser cancelled the session you had registered for ${ended}. ${afterLosingSession(registration.endReason, mode)}`,
        }
      : {
          summary: 'ended: the organiser cancelled your last session',
          detail: `The organiser cancelled the last session you had chosen ${ended}, so your registration has ended.`,
        };
  }
  return { summary: 'ended', detail: `Your registration has ended ${ended}.` };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Status of a past registration in the "Past" list: plain words, never the raw enum. */
export function pastStatusText(
  registration: Pick<
    ListedRegistration,
    'status' | 'endReason' | 'updatedAt' | 'acceptable' | 'ending'
  >,
  sessions: readonly SessionView[],
  mode: WorkshopMode,
): string {
  return describeEnding(registration, sessions, undefined, mode).summary;
}

export function rejectReasonText(reason: RejectReason | undefined): string {
  return reason === undefined ? 'The request was rejected.' : REJECT_REASON_TEXT[reason];
}

export function sessionTitle(
  sessions: readonly SessionView[],
  sessionId: string | undefined,
): string {
  if (sessionId === undefined) {
    return 'a session';
  }
  return sessions.find((session) => session.id === sessionId)?.title ?? 'a session';
}

/**
 * "Session 2 seat is held for you — confirm within 14:59" / "Queued, position 3" / … The
 * command that produced the state (when known) makes an ending specific: a DECLINE_OFFER that
 * ended the registration was the participant's own decline. It does not claim the declined
 * session was the last one: an organiser cancellation drained in the same decision can have
 * removed the last one after the decline put the participant back in the queue.
 */
export function describeRegistration(
  registration: RegistrationSummary,
  sessions: readonly SessionView[],
  now: number = serverNow(),
  commandType?: UserCommandType,
  mode: WorkshopMode = 'UNIFIED',
): string {
  switch (registration.status) {
    case 'OFFERED': {
      const offer = registration.currentOffer;
      const title = sessionTitle(sessions, offer?.sessionId);
      const remaining =
        offer === undefined ? undefined : formatCountdown(msUntil(offer.expiresAt, now));
      return remaining === undefined
        ? `A seat in ${title} is held for you.`
        : `A seat in ${title} is held for you — confirm within ${remaining}.`;
    }
    case 'QUEUED':
      return registration.queuePosition === undefined
        ? 'You are in the queue.'
        : `You are queued at position ${registration.queuePosition}.`;
    case 'CONFIRMED':
      return `Your seat in ${sessionTitle(sessions, registration.confirmedSessionId)} is confirmed.`;
    case 'CANCELLED':
      // The result does not say what was held (the status card does, once the list has `ending`).
      return `Your registration is cancelled. ${CANCELLED_RELEASE_TEXT}`;
    case 'ENDED':
      if (commandType === 'DECLINE_OFFER') {
        return mode === 'UNIFIED' && registration.endReason === 'NO_ACCEPTABLE_SESSION'
          ? 'You declined the seat. No session you had chosen is left, so your registration has ended.'
          : `You declined the seat. ${afterLosingSession(registration.endReason, mode)}`;
      }
      return registration.endReason === undefined
        ? 'Your registration has ended.'
        : `Your registration has ended: ${endReasonText(registration.endReason, mode)}.`;
    default:
      return 'Updated.';
  }
}

export interface SettledCopy {
  kind: 'success' | 'error';
  title: string;
  message: string;
}

/** Toast copy once `GET /commands/{id}` is terminal; distinct from "request received". */
export function describeSettled(
  view: CommandResultView,
  sessions: readonly SessionView[],
  now: number = serverNow(),
  mode: WorkshopMode = 'UNIFIED',
): SettledCopy {
  if (view.status === 'REJECTED') {
    return {
      kind: 'error',
      title: `${COMMAND_TYPE_TEXT[view.type]} rejected`,
      message: rejectReasonText(view.reason),
    };
  }
  const registration = view.result?.registration;
  if (registration !== undefined) {
    return {
      kind: 'success',
      title: `${COMMAND_TYPE_TEXT[view.type]} applied`,
      message: describeRegistration(registration, sessions, now, view.type, mode),
    };
  }
  const offers = view.result?.offersCreated ?? 0;
  return {
    kind: 'success',
    title: `${COMMAND_TYPE_TEXT[view.type]} applied`,
    message:
      offers > 0 ? `${offers} seat offer${offers === 1 ? '' : 's'} sent to the queue.` : 'Done.',
  };
}
