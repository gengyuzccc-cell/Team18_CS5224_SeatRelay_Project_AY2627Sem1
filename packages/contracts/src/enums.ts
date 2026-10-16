import { z } from 'zod';

/**
 * Every string-literal union of the domain is declared exactly once here, as a readonly
 * const array (for iteration / UI pickers), a zod enum (for validation) and a TS type.
 */

export const WORKSHOP_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const;
export const WorkshopStatusSchema = z.enum(WORKSHOP_STATUSES);
export type WorkshopStatus = (typeof WORKSHOP_STATUSES)[number];

export const WORKSHOP_MODES = ['UNIFIED', 'PER_SESSION'] as const;
export const WorkshopModeSchema = z.enum(WORKSHOP_MODES);
export type WorkshopMode = (typeof WORKSHOP_MODES)[number];

export const SESSION_STATUSES = ['OPEN', 'CANCELLED'] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const REGISTRATION_STATUSES = [
  'QUEUED',
  'OFFERED',
  'CONFIRMED',
  'CANCELLED',
  'ENDED',
] as const;
export const RegistrationStatusSchema = z.enum(REGISTRATION_STATUSES);
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const END_REASONS = ['CUTOFF', 'NO_ACCEPTABLE_SESSION', 'WORKSHOP_CANCELLED'] as const;
export const EndReasonSchema = z.enum(END_REASONS);
export type EndReason = (typeof END_REASONS)[number];

export const OFFER_STATUSES = ['OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'] as const;
export const OfferStatusSchema = z.enum(OFFER_STATUSES);
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const COMMAND_STATUSES = ['ACCEPTED', 'APPLIED', 'REJECTED'] as const;
export const CommandStatusSchema = z.enum(COMMAND_STATUSES);
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const NOTIFICATION_KINDS = [
  'OFFER',
  'CONFIRMED',
  'EXPIRED',
  'DECLINED',
  'REVOKED',
  'SESSION_CANCELLED',
  'WORKSHOP_CANCELLED',
  'ENDED',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const BACKFILL_CAUSES = [
  'EXPIRED',
  'DECLINED',
  'CANCELLED_CONFIRMED',
  'CANCELLED_OFFER',
  'CAPACITY_UP',
  'SESSION_CANCELLED',
] as const;
export const BackfillCauseSchema = z.enum(BACKFILL_CAUSES);
export type BackfillCause = (typeof BACKFILL_CAUSES)[number];

/** Fault-injection flags (plan §2.4); honoured by the worker only when ALLOW_FAULT_FLAGS=true. */
export const FAULT_FLAGS = ['BEFORE_COMMIT', 'AFTER_COMMIT', 'TIMER_SEND'] as const;
export const FaultFlagSchema = z.enum(FAULT_FLAGS);
export type FaultFlag = (typeof FAULT_FLAGS)[number];

export const PARTICIPANT_COMMAND_TYPES = [
  'REGISTER',
  'ACCEPT_OFFER',
  'DECLINE_OFFER',
  'CANCEL_REGISTRATION',
] as const;
export type ParticipantCommandType = (typeof PARTICIPANT_COMMAND_TYPES)[number];

/** Organiser commands: org membership (C7) is checked by the API layer, not by the engine. */
export const ORGANIZER_COMMAND_TYPES = [
  'SET_CAPACITY',
  'CANCEL_SESSION',
  'CANCEL_WORKSHOP',
  'CLOSE_REGISTRATION',
  'OPEN_REGISTRATION',
] as const;
export type OrganizerCommandType = (typeof ORGANIZER_COMMAND_TYPES)[number];

export const USER_COMMAND_TYPES = [
  ...PARTICIPANT_COMMAND_TYPES,
  ...ORGANIZER_COMMAND_TYPES,
] as const;
export const UserCommandTypeSchema = z.enum(USER_COMMAND_TYPES);
export type UserCommandType = (typeof USER_COMMAND_TYPES)[number];

/** Internal commands: no commandId, no CommandResult, naturally idempotent. */
export const INTERNAL_COMMAND_TYPES = ['TICK', 'REALLOCATE'] as const;
export type InternalCommandType = (typeof INTERNAL_COMMAND_TYPES)[number];

export const COMMAND_TYPES = [...USER_COMMAND_TYPES, ...INTERNAL_COMMAND_TYPES] as const;
export const CommandTypeSchema = z.enum(COMMAND_TYPES);
export type CommandType = (typeof COMMAND_TYPES)[number];

/** Where a TICK came from; lets the worker report `SweepLateExpiries` (plan §1.2). */
export const TICK_SOURCES = ['TIMER', 'SWEEP'] as const;
export const TickSourceSchema = z.enum(TICK_SOURCES);
export type TickSource = (typeof TICK_SOURCES)[number];

/** Deterministic rejection reasons produced by `decide()` (and FORBIDDEN by the service). */
export const REJECT_REASONS = [
  'WORKSHOP_NOT_OPEN',
  'WORKSHOP_CANCELLED',
  'ALREADY_REGISTERED',
  'NOT_REGISTERED',
  'NO_ACCEPTABLE_SESSION',
  'SESSION_NOT_FOUND',
  'SESSION_CANCELLED',
  'OFFER_NOT_FOUND',
  'OFFER_NOT_YOURS',
  'OFFER_EXPIRED',
  'OFFER_NOT_ACTIVE',
  'INVALID_STATE',
  'CAPACITY_BELOW_USAGE',
  'INVALID_CAPACITY',
  'UNKNOWN_SESSION_IN_PREFERENCES',
  'DUPLICATE_SESSION_IN_PREFERENCES',
  'PER_SESSION_REQUIRES_ONE_SESSION',
  'FORBIDDEN',
] as const;
export const RejectReasonSchema = z.enum(REJECT_REASONS);
export type RejectReason = (typeof REJECT_REASONS)[number];
