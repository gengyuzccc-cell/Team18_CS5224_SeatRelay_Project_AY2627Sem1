import type {
  Attendance,
  BackfillRecord,
  CommandResult,
  CommandResultView,
  ConfirmedEntry,
  DashboardView,
  MyRegistrationView,
  Notification,
  NotificationView,
  OfferedEntry,
  QueueEntry,
  Registration,
  Session,
  SessionView,
  Workshop,
  WorkshopPublic,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import {
  compareIso,
  freeSeats,
  liveRegistrationsOf,
  queueLength,
  queuePosition,
  registrationSummary,
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

/** GET /me/registrations entries for one workshop (live or archived registrations of the user). */
export function myRegistrationViews(
  snapshot: WorkshopSnapshot,
  registrations: readonly Registration[],
): MyRegistrationView[] {
  const workshop = toWorkshopPublic(snapshot.workshop);
  const sessions = sessionViews(snapshot);
  return registrations.map((registration) => ({
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
    },
  }));
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
 * Distinct users who ever held a CONFIRMED seat: live CONFIRMED registrations plus every
 * archived ACCEPTED offer (a confirmation always settles its offer as ACCEPTED, so history
 * keeps the fact even after a cancellation or a cancelled session).
 */
export function distinctParticipantsServed(
  snapshot: WorkshopSnapshot,
  history: WorkshopHistory,
): number {
  const users = new Set<string>();
  for (const registration of snapshot.registrations) {
    if (registration.status === 'CONFIRMED') {
      users.add(registration.userId);
    }
  }
  for (const offer of history.offers) {
    if (offer.status === 'ACCEPTED') {
      users.add(offer.userId);
    }
  }
  return users.size;
}

/** GET /orgs/{orgId}/workshops/{wsId}/dashboard */
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

  const sortedBackfills = [...backfills].sort(
    (a, b) => compareIso(a.releasedAt, b.releasedAt) || (a.id < b.id ? -1 : 1),
  );
  const sortedAttendance = [...attendance].sort((a, b) => (a.userId < b.userId ? -1 : 1));

  return {
    workshop,
    sessions: sessionViews(snapshot),
    queue,
    offered,
    confirmed,
    backfills: sortedBackfills,
    distinctParticipantsServed: distinctParticipantsServed(snapshot, history),
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
