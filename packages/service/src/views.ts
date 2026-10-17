import type {
  Attendance,
  BackfillRecord,
  CommandResult,
  CommandResultView,
  ConfirmedEntry,
  DashboardBackfillEntry,
  DashboardView,
  MyRegistrationView,
  Notification,
  NotificationView,
  Offer,
  OfferedEntry,
  QueueEntry,
  Registration,
  RegistrationEnding,
  Session,
  SessionView,
  Workshop,
  WorkshopPublic,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import {
  compareIso,
  distinctConfirmedUsers,
  freeSeats,
  liveRegistrationsOf,
  queueLength,
  queuePosition,
  registrationSummary,
  sessionCancelledTitle,
  type WorkshopSnapshot,
} from '@seatrelay/core';
import type { WorkshopHistory } from './ports';

/**
 * Read models built from store data with the core read helpers (plan §2.5). No business
 * decisions are taken here; everything derives from the live snapshot plus history.
 */

/** Sessions in a stable, human order: by start time, then id. */
export function sortedSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => compareIso(a.startsAt, b.startsAt) || (a.id < b.id ? -1 : 1));
}

export function toWorkshopPublic(workshop: Workshop): WorkshopPublic {
  const { seq: _seq, version: _version, ...publicFields } = workshop;
  return publicFields;
}

export function sessionViews(snapshot: WorkshopSnapshot): SessionView[] {
  return sortedSessions(snapshot.sessions).map((session) => ({
    ...session,
    free: Math.max(0, freeSeats(session)),
    queueLength: queueLength(snapshot.registrations, session.id),
  }));
}

/** GET /workshops/{wsId}: public counters plus the caller's own registration when signed in. */
export function workshopPublicView(
  snapshot: WorkshopSnapshot,
  userId?: string,
): WorkshopPublicView {
  const view: WorkshopPublicView = {
    workshop: toWorkshopPublic(snapshot.workshop),
    sessions: sessionViews(snapshot),
    queueLength: queueLength(snapshot.registrations),
  };
  if (userId !== undefined) {
    const mine = liveRegistrationsOf(snapshot, userId)[0];
    if (mine !== undefined) {
      view.me = registrationSummary(
        snapshot.workshop.mode,
        snapshot.registrations,
        snapshot.offers,
        mine,
      );
    }
  }
  return view;
}

export function isArchivedRegistration(registration: Registration): boolean {
  return registration.status === 'CANCELLED' || registration.status === 'ENDED';
}

function isCancelledSession(session: Session): boolean {
  return session.status === 'CANCELLED' || session.status === 'CANCELLING';
}

/**
 * A UNIFIED registration that the organiser's cancellation of a session may have ended: ENDED
 * with CUTOFF or NO_ACCEPTABLE_SESSION while the workshop has a cancelled session that the
 * registration no longer lists (the drain removes the session from `acceptable`, R5).
 */
function mayHaveEndedBySessionCancellation(
  snapshot: WorkshopSnapshot,
  registration: Registration,
): boolean {
  return (
    snapshot.workshop.mode === 'UNIFIED' &&
    registration.status === 'ENDED' &&
    (registration.endReason === 'CUTOFF' || registration.endReason === 'NO_ACCEPTABLE_SESSION') &&
    snapshot.sessions.some(
      (session) => isCancelledSession(session) && !registration.acceptable.includes(session.id),
    )
  );
}

/**
 * Where the user's notifications that `registrationEnding` needs start: the earliest ending of
 * these registrations that a session cancellation may have caused. Undefined when there is none,
 * so a workshop without a cancelled session costs no notification read.
 */
export function endingNoticesSince(
  snapshot: WorkshopSnapshot,
  registrations: readonly Registration[],
): string | undefined {
  return registrations
    .filter((registration) => mayHaveEndedBySessionCancellation(snapshot, registration))
    .map((registration) => registration.updatedAt)
    .sort(compareIso)[0];
}

/**
 * The notifications of the decision that archived `registration`: the user's first ones at or
 * after its `updatedAt`. A decision stamps its notifications once, after deciding (`createdAt`
 * is never before the decision time), and every earlier decision of the workshop committed, so
 * was stamped, before this one read its time.
 */
function decisionNotices(
  registration: Registration,
  notices: readonly Notification[],
): Notification[] {
  const after = notices.filter(
    (notice) =>
      notice.userId === registration.userId &&
      notice.workshopId === registration.workshopId &&
      compareIso(notice.createdAt, registration.updatedAt) >= 0,
  );
  const first = after.map((notice) => notice.createdAt).sort(compareIso)[0];
  return first === undefined
    ? []
    : after.filter((notice) => compareIso(notice.createdAt, first) === 0);
}

/**
 * The session whose cancellation by the organiser ended an ENDED registration, derived (no
 * engine field records the cause). `own` are the registration's archived offers, newest first.
 *
 * - UNIFIED (one live registration per person, so every notification of the decision that
 *   archived it is about this registration): that decision told the participant that the
 *   organiser cancelled a session they had chosen (SESSION_CANCELLED, sent to the queued
 *   participants and confirmed seats of that session; matched by `sessionCancelledTitle`). If
 *   the same decision also expired or took a decline of their hold, that had put them back in
 *   the queue first (tick-first, then the command, then the drain), so the cancellation ended
 *   the registration, not the offer. Of several sessions cancelled in that decision, the one of
 *   the participant's confirmed seat is named, else the last one drained (session order).
 * - PER_SESSION (one session per registration: losing it ends the registration at once): an
 *   ENDED(NO_ACCEPTABLE_SESSION) registration that no offer settled with it explains lost its
 *   session to the organiser; the session is known when an offer of the registration names it.
 */
function cancelledSessionOf(
  snapshot: WorkshopSnapshot,
  registration: Registration,
  own: readonly Offer[],
  notices: readonly Notification[],
): string | undefined {
  const cancelled = snapshot.sessions.filter(isCancelledSession);
  if (snapshot.workshop.mode === 'PER_SESSION') {
    const explained = own.some((offer) => offer.settledAt === registration.updatedAt);
    const sessionId = own[0]?.sessionId;
    return registration.status === 'ENDED' &&
      registration.endReason === 'NO_ACCEPTABLE_SESSION' &&
      !explained &&
      cancelled.some((session) => session.id === sessionId)
      ? sessionId
      : undefined;
  }
  if (!mayHaveEndedBySessionCancellation(snapshot, registration)) {
    return undefined;
  }
  const titles = new Set(
    decisionNotices(registration, notices)
      .filter((notice) => notice.kind === 'SESSION_CANCELLED')
      .map((notice) => notice.title),
  );
  const named = cancelled.filter(
    (session) =>
      !registration.acceptable.includes(session.id) && titles.has(sessionCancelledTitle(session)),
  );
  const latest = own[0];
  const seat =
    latest?.status === 'ACCEPTED'
      ? named.find((session) => session.id === latest.sessionId)
      : undefined;
  return (seat ?? named.at(-1))?.id;
}

/**
 * How a CANCELLED/ENDED registration ended, from history only (no engine field): the offer that
 * the archiving decision settled along with it (same decision time: its `settledAt` equals the
 * registration's `updatedAt`), the session of a confirmed seat that was given up, and, with the
 * live `snapshot` and the user's `notices` of that decision, the session whose cancellation by
 * the organiser ended it (`cancelledSessionOf`; it then replaces the offer as the cause, and its
 * seat is the confirmed one when the participant had accepted it). Undefined for live
 * registrations.
 */
export function registrationEnding(
  registration: Registration,
  settledOffers: readonly Offer[],
  snapshot?: WorkshopSnapshot,
  notices: readonly Notification[] = [],
): RegistrationEnding | undefined {
  if (!isArchivedRegistration(registration)) {
    return undefined;
  }
  const ending: RegistrationEnding = {};
  const own = settledOffers
    .filter(
      (candidate) =>
        candidate.registrationSeq === registration.seq && candidate.userId === registration.userId,
    )
    .sort((a, b) => compareIso(b.createdAt, a.createdAt));
  const cancelledSessionId =
    snapshot === undefined ? undefined : cancelledSessionOf(snapshot, registration, own, notices);
  const offer = own.find((candidate) => candidate.settledAt === registration.updatedAt);
  if (cancelledSessionId !== undefined) {
    ending.cancelledSessionId = cancelledSessionId;
    // Nothing was offered after the accepted offer: the seat was confirmed until the session went.
    if (own[0]?.status === 'ACCEPTED' && own[0].sessionId === cancelledSessionId) {
      ending.confirmedSessionId = cancelledSessionId;
    }
  } else if (offer?.settledAt !== undefined) {
    ending.offer = {
      id: offer.id,
      sessionId: offer.sessionId,
      status: offer.status,
      expiresAt: offer.expiresAt,
      settledAt: offer.settledAt,
    };
  }
  if (registration.confirmedSessionId !== undefined) {
    ending.confirmedSessionId = registration.confirmedSessionId;
  }
  return ending;
}

/**
 * GET /me/registrations entries for one workshop (live or archived registrations of the user).
 * `settledOffers` (archived offers of this workshop that include the user's own, e.g.
 * `listArchivedOffersOfUser`) explains how archived registrations ended; without it no `ending`
 * is given (unknown, which is not the same as "nothing was held"). `notices` are the user's
 * notifications of this workshop from `endingNoticesSince` on (none needed without it).
 */
export function myRegistrationViews(
  snapshot: WorkshopSnapshot,
  registrations: readonly Registration[],
  settledOffers?: readonly Offer[],
  notices: readonly Notification[] = [],
): MyRegistrationView[] {
  const workshop = toWorkshopPublic(snapshot.workshop);
  const sessions = sessionViews(snapshot);
  return registrations.map((registration) => {
    const ending =
      settledOffers === undefined
        ? undefined
        : registrationEnding(registration, settledOffers, snapshot, notices);
    return {
      workshop,
      sessions,
      registration: {
        ...registrationSummary(
          snapshot.workshop.mode,
          snapshot.registrations,
          snapshot.offers,
          registration,
        ),
        createdAt: registration.createdAt,
        updatedAt: registration.updatedAt,
        ...(ending !== undefined ? { ending } : {}),
      },
    };
  });
}

function participantFields(registration: Registration) {
  return {
    seq: registration.seq,
    userId: registration.userId,
    email: registration.email,
    ...(registration.displayName !== undefined ? { displayName: registration.displayName } : {}),
  };
}

/**
 * Backfill records with the new holder's e-mail and display name: from the registration that
 * received the relayed offer (live or archived), else the user's latest registration here.
 */
export function backfillEntries(
  backfills: readonly BackfillRecord[],
  snapshot: WorkshopSnapshot,
  history: WorkshopHistory,
): DashboardBackfillEntry[] {
  const offers = new Map([...history.offers, ...snapshot.offers].map((offer) => [offer.id, offer]));
  const registrations = [...history.registrations, ...snapshot.registrations].sort(
    (a, b) => a.seq - b.seq,
  );
  const bySeq = new Map(registrations.map((registration) => [registration.seq, registration]));
  const latestByUser = new Map(
    registrations.map((registration) => [registration.userId, registration]),
  );
  return backfills.map((record) => {
    if (record.newUserId === undefined) {
      return record;
    }
    const offer = record.newOfferId === undefined ? undefined : offers.get(record.newOfferId);
    const viaOffer = offer === undefined ? undefined : bySeq.get(offer.registrationSeq);
    const holder =
      viaOffer?.userId === record.newUserId ? viaOffer : latestByUser.get(record.newUserId);
    if (holder === undefined) {
      return record;
    }
    return {
      ...record,
      newHolderEmail: holder.email,
      ...(holder.displayName !== undefined ? { newHolderDisplayName: holder.displayName } : {}),
    };
  });
}

/**
 * GET /orgs/{orgId}/workshops/{wsId}/dashboard. `distinctParticipantsServed` is the number of
 * distinct users currently holding a CONFIRMED seat (core's `distinctConfirmedUsers`, the same
 * definition as the replay's `distinct_served`): CONFIRMED registrations stay live past the
 * cut-off, so a finished workshop keeps its count, and someone who cancelled no longer counts.
 * `history` is needed for the confirmation time of each confirmed entry and for the names of
 * the new holders in the backfill log.
 */
export function dashboardView(
  snapshot: WorkshopSnapshot,
  history: WorkshopHistory,
  backfills: readonly BackfillRecord[],
  attendance: readonly Attendance[],
): DashboardView {
  const { workshop, registrations, offers } = snapshot;
  const queue: QueueEntry[] = [];
  const offered: OfferedEntry[] = [];
  const confirmed: ConfirmedEntry[] = [];
  const acceptedOffers = history.offers.filter((offer) => offer.status === 'ACCEPTED');

  for (const registration of [...registrations].sort((a, b) => a.seq - b.seq)) {
    switch (registration.status) {
      case 'QUEUED':
        queue.push({
          ...participantFields(registration),
          acceptable: [...registration.acceptable],
          status: 'QUEUED',
          queuePosition: queuePosition(workshop.mode, registrations, registration) ?? 1,
        });
        break;
      case 'OFFERED': {
        const offer = offers.find((candidate) => candidate.id === registration.currentOfferId);
        if (offer !== undefined) {
          offered.push({
            ...participantFields(registration),
            acceptable: [...registration.acceptable],
            status: 'OFFERED',
            offer: { id: offer.id, sessionId: offer.sessionId, expiresAt: offer.expiresAt },
          });
        }
        break;
      }
      case 'CONFIRMED': {
        const sessionId = registration.confirmedSessionId;
        if (sessionId !== undefined) {
          const accepted = acceptedOffers.find(
            (offer) => offer.registrationSeq === registration.seq && offer.sessionId === sessionId,
          );
          confirmed.push({
            ...participantFields(registration),
            status: 'CONFIRMED',
            sessionId,
            confirmedAt: accepted?.settledAt ?? registration.updatedAt,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const sortedBackfills = backfillEntries(
    [...backfills].sort((a, b) => compareIso(a.releasedAt, b.releasedAt) || (a.id < b.id ? -1 : 1)),
    snapshot,
    history,
  );
  const sortedAttendance = [...attendance].sort((a, b) => (a.userId < b.userId ? -1 : 1));

  return {
    workshop,
    sessions: sessionViews(snapshot),
    queue,
    offered,
    confirmed,
    backfills: sortedBackfills,
    distinctParticipantsServed: distinctConfirmedUsers(registrations),
    attendance: sortedAttendance,
    counts: {
      queued: queue.length,
      offered: offered.length,
      confirmed: confirmed.length,
      backfills: sortedBackfills.length,
      backfillsReallocated: sortedBackfills.filter((record) => record.reallocatedAt !== undefined)
        .length,
      attended: sortedAttendance.filter((record) => record.attended).length,
    },
  };
}

/** GET /commands/{id}: the record without actor/ttl internals. */
export function commandResultView(record: CommandResult): CommandResultView {
  const view: CommandResultView = {
    commandId: record.commandId,
    type: record.type,
    workshopId: record.workshopId,
    status: record.status,
    acceptedAt: record.acceptedAt,
  };
  if (record.reason !== undefined) {
    view.reason = record.reason;
  }
  if (record.result !== undefined) {
    view.result = record.result;
  }
  if (record.settledAt !== undefined) {
    view.settledAt = record.settledAt;
  }
  return view;
}

export function notificationView(notification: Notification): NotificationView {
  const view: NotificationView = {
    id: notification.id,
    workshopId: notification.workshopId,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    status: notification.status,
    createdAt: notification.createdAt,
  };
  if (notification.offerId !== undefined) {
    view.offerId = notification.offerId;
  }
  if (notification.readAt !== undefined) {
    view.readAt = notification.readAt;
  }
  return view;
}
