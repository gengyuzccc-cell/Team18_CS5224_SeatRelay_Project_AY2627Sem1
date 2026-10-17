import type {
  BackfillCause,
  CommandResultView,
  EndReason,
  RegistrationSummary,
  RejectReason,
  SessionView,
  UserCommandType,
} from '@seatrelay/contracts';
import { serverNow } from '../util/serverClock';
import { formatCountdown, msUntil } from '../util/time';

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

export const END_REASON_TEXT: Record<EndReason, string> = {
  CUTOFF: 'the registration cut-off passed before a seat became free',
  NO_ACCEPTABLE_SESSION: 'none of your acceptable sessions could still be joined',
  WORKSHOP_CANCELLED: 'the workshop was cancelled',
};

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

/**
 * Status of a past registration in the "Past" list: the same human copy as the status card
 * ("ended: none of your acceptable sessions could still be joined"), never the raw enum.
 */
export function pastStatusText(
  registration: Pick<RegistrationSummary, 'status' | 'endReason'>,
): string {
  const status = registration.status.toLowerCase();
  return registration.endReason === undefined
    ? status
    : `${status}: ${END_REASON_TEXT[registration.endReason]}`;
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

/** "Session 2 seat is held for you — confirm within 14:59" / "Queued, position 3" / … */
export function describeRegistration(
  registration: RegistrationSummary,
  sessions: readonly SessionView[],
  now: number = serverNow(),
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
      return 'Your registration is cancelled.';
    case 'ENDED':
      return `Your registration ended: ${registration.endReason === undefined ? 'no seat could be allocated' : END_REASON_TEXT[registration.endReason]}.`;
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
      message: describeRegistration(registration, sessions, now),
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
