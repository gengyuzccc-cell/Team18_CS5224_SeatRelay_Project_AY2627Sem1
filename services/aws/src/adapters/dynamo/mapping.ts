import {
  AttendanceSchema,
  BackfillRecordSchema,
  CommandResultSchema,
  NotificationSchema,
  OfferSchema,
  OrganizationSchema,
  RegistrationSchema,
  SessionSchema,
  WorkshopSchema,
  type Attendance,
  type BackfillRecord,
  type CommandResult,
  type Notification,
  type Offer,
  type Organization,
  type Registration,
  type Session,
  type Workshop,
  type WorkshopMode,
} from '@seatrelay/contracts';
import { registrationScopeKey } from '@seatrelay/core';
import {
  attendanceKey,
  commandKey,
  dueGsi,
  dueMarkerKey,
  historyBackfillKey,
  historyOfferKey,
  historyRegistrationKey,
  liveOfferKey,
  liveRegistrationKey,
  notificationKey,
  orgKey,
  orgMemberKey,
  orgMembershipGsi,
  pendingBackfillKey,
  registrationGsi,
  sessionKey,
  uniqueMarkerKey,
  workshopGsi,
  workshopKey,
  type EntityType,
} from './keys';

/**
 * Entity ⇄ item mapping, 1:1 and without business logic (CONVENTIONS §4). Every item carries
 * `entityType` (the notifier's stream filter matches on it, and the snapshot query classifies
 * live items by it). Reading back parses with the contracts schema, which strips the key and
 * index attributes and validates what was stored.
 */
export type Item = Record<string, unknown>;

export function entityTypeOf(item: Item): EntityType | undefined {
  const value = item.entityType;
  return typeof value === 'string' ? (value as EntityType) : undefined;
}

/* ---------- organisations ---------- */

export function organizationItem(organization: Organization): Item {
  return { ...orgKey(organization.id), entityType: 'ORGANIZATION', ...organization };
}

export function toOrganization(item: Item): Organization {
  return OrganizationSchema.parse(item);
}

export function orgMemberItem(orgId: string, userId: string, since: string): Item {
  return {
    ...orgMemberKey(orgId, userId),
    ...orgMembershipGsi(orgId, userId),
    entityType: 'ORG_MEMBER',
    orgId,
    userId,
    since,
  };
}

/* ---------- workshops ---------- */

export function workshopItem(workshop: Workshop): Item {
  return {
    ...workshopKey(workshop.id),
    ...workshopGsi(workshop.orgId, workshop.createdAt),
    entityType: 'WORKSHOP',
    ...workshop,
  };
}

export function toWorkshop(item: Item): Workshop {
  return WorkshopSchema.parse(item);
}

/** Sparse DUE marker; present only while `nextDueAt` is set on the workshop. */
export function dueMarkerItem(wsId: string, nextDueAt: string): Item {
  return {
    ...dueMarkerKey(wsId),
    ...dueGsi(nextDueAt, wsId),
    entityType: 'DUE_MARKER',
    workshopId: wsId,
    nextDueAt,
  };
}

export function sessionItem(session: Session): Item {
  return { ...sessionKey(session.workshopId, session.id), entityType: 'SESSION', ...session };
}

export function toSession(item: Item): Session {
  return SessionSchema.parse(item);
}

/* ---------- registrations ---------- */

export function liveRegistrationItem(registration: Registration): Item {
  return {
    ...liveRegistrationKey(registration.workshopId, registration.seq),
    ...registrationGsi(registration.userId, registration.workshopId),
    entityType: 'REGISTRATION',
    ...registration,
  };
}

export function historyRegistrationItem(registration: Registration): Item {
  return {
    ...historyRegistrationKey(registration.workshopId, registration.seq),
    ...registrationGsi(registration.userId, registration.workshopId),
    entityType: 'REGISTRATION',
    ...registration,
  };
}

export function toRegistration(item: Item): Registration {
  return RegistrationSchema.parse(item);
}

/** R1 marker of a live registration, keyed by core's registration scope (mode-dependent). */
export function uniqueMarkerItem(mode: WorkshopMode, registration: Registration): Item {
  const scope = registrationScopeKey(mode, registration);
  return {
    ...uniqueMarkerKey(registration.workshopId, scope),
    entityType: 'UNIQUE_MARKER',
    workshopId: registration.workshopId,
    userId: registration.userId,
    scope,
    seq: registration.seq,
    status: registration.status,
  };
}

/* ---------- offers ---------- */

export function liveOfferItem(offer: Offer): Item {
  return { ...liveOfferKey(offer.workshopId, offer.id), entityType: 'OFFER', ...offer };
}

export function historyOfferItem(offer: Offer): Item {
  return { ...historyOfferKey(offer.workshopId, offer.id), entityType: 'OFFER', ...offer };
}

export function toOffer(item: Item): Offer {
  return OfferSchema.parse(item);
}

/* ---------- backfill records ---------- */

export function pendingBackfillItem(record: BackfillRecord): Item {
  return {
    ...pendingBackfillKey(record.workshopId, record.releasedAt, record.id),
    entityType: 'BACKFILL',
    ...record,
  };
}

export function historyBackfillItem(record: BackfillRecord): Item {
  return {
    ...historyBackfillKey(record.workshopId, record.releasedAt, record.id),
    entityType: 'BACKFILL',
    ...record,
  };
}

export function toBackfillRecord(item: Item): BackfillRecord {
  return BackfillRecordSchema.parse(item);
}

/* ---------- attendance ---------- */

export function attendanceItem(record: Attendance): Item {
  return { ...attendanceKey(record.workshopId, record.userId), entityType: 'ATTENDANCE', ...record };
}

export function toAttendance(item: Item): Attendance {
  return AttendanceSchema.parse(item);
}

/* ---------- command results ---------- */

export function commandResultItem(record: CommandResult): Item {
  return { ...commandKey(record.commandId), entityType: 'COMMAND', ...record };
}

export function toCommandResult(item: Item): CommandResult {
  return CommandResultSchema.parse(item);
}

/* ---------- notifications ---------- */

export function notificationItem(notification: Notification): Item {
  return {
    ...notificationKey(notification.userId, notification.createdAt, notification.id),
    entityType: 'NOTIFICATION',
    ...notification,
  };
}

export function toNotification(item: Item): Notification {
  return NotificationSchema.parse(item);
}
