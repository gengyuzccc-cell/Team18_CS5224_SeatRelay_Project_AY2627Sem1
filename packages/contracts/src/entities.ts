import { z } from 'zod';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HOLD_SECONDS,
  MAX_ORG_NAME_LENGTH,
  MAX_SESSIONS_PER_WORKSHOP,
  MAX_TITLE_LENGTH,
  MIN_HOLD_SECONDS,
} from './constants';
import {
  BackfillCauseSchema,
  CommandStatusSchema,
  EndReasonSchema,
  NotificationKindSchema,
  NotificationStatusSchema,
  OfferStatusSchema,
  RegistrationStatusSchema,
  RejectReasonSchema,
  SessionStatusSchema,
  UserCommandTypeSchema,
  WorkshopModeSchema,
  WorkshopStatusSchema,
} from './enums';

/* ---------- primitives ---------- */

/** ISO-8601 UTC with milliseconds, e.g. `2026-11-03T06:00:00.000Z` (CONVENTIONS §3). */
export const IsoTimestampSchema = z.string().datetime({ precision: 3 });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Opaque identifier (UUID v4 in production; any non-empty string in tests/replay). */
export const IdSchema = z.string().min(1).max(128);
export const UuidSchema = z.string().uuid();
export const EmailSchema = z.string().email().max(254);
export const DisplayNameSchema = z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH);
export const NonNegativeIntSchema = z.number().int().min(0);
export const PositiveIntSchema = z.number().int().min(1);
/** Epoch seconds used for DynamoDB TTL. */
export const TtlSchema = z.number().int().min(0);

/* ---------- entities (plan §2.2) ---------- */

export const OrganizationSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(MAX_ORG_NAME_LENGTH),
  ownerUserId: IdSchema,
  /** userIds including the owner (C7 membership check). */
  members: z.array(IdSchema),
  createdAt: IsoTimestampSchema,
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const WorkshopSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
  status: WorkshopStatusSchema,
  mode: WorkshopModeSchema,
  holdSeconds: z.number().int().min(MIN_HOLD_SECONDS).max(MAX_HOLD_SECONDS),
  /** Last assigned registration seq (R2); the worker is the single writer. */
  seq: NonNegativeIntSchema,
  /** Optimistic-lock version of the whole workshop partition (+1 per committed decision). */
  version: NonNegativeIntSchema,
  /** Safety-net sweep key: earliest pending expiry/cutoff; absent when nothing is pending. */
  nextDueAt: IsoTimestampSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type Workshop = z.infer<typeof WorkshopSchema>;

export const SessionSchema = z.object({
  id: IdSchema,
  workshopId: IdSchema,
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  startsAt: IsoTimestampSchema,
  /** `startsAt − 30 min`, fixed at creation (R4). */
  cutoffAt: IsoTimestampSchema,
  capacity: PositiveIntSchema,
  confirmed: NonNegativeIntSchema,
  held: NonNegativeIntSchema,
  status: SessionStatusSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const RegistrationSchema = z.object({
  workshopId: IdSchema,
  userId: IdSchema,
  email: EmailSchema,
  displayName: DisplayNameSchema.optional(),
  /** Queue position key (R2/R3); unique per workshop, assigned by the engine at REGISTER. */
  seq: PositiveIntSchema,
  /** Acceptable sessionIds in preference order; exactly one in PER_SESSION mode. */
  acceptable: z.array(IdSchema).max(MAX_SESSIONS_PER_WORKSHOP),
  status: RegistrationStatusSchema,
  endReason: EndReasonSchema.optional(),
  currentOfferId: IdSchema.optional(),
  confirmedSessionId: IdSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type Registration = z.infer<typeof RegistrationSchema>;

export const OfferSchema = z.object({
  id: IdSchema,
  workshopId: IdSchema,
  sessionId: IdSchema,
  userId: IdSchema,
  registrationSeq: PositiveIntSchema,
  status: OfferStatusSchema,
  createdAt: IsoTimestampSchema,
  /** `min(createdAt + holdSeconds, session.cutoffAt)` (R4). */
  expiresAt: IsoTimestampSchema,
  settledAt: IsoTimestampSchema.optional(),
});
export type Offer = z.infer<typeof OfferSchema>;

/** Offer summary embedded in views and command results. */
export const OfferSummarySchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  expiresAt: IsoTimestampSchema,
});
export type OfferSummary = z.infer<typeof OfferSummarySchema>;

/** The participant-facing state of one registration (public view `me`, command results). */
export const RegistrationSummarySchema = z.object({
  status: RegistrationStatusSchema,
  seq: PositiveIntSchema,
  /** 1-based; present only while QUEUED. */
  queuePosition: PositiveIntSchema.optional(),
  acceptable: z.array(IdSchema),
  currentOffer: OfferSummarySchema.optional(),
  confirmedSessionId: IdSchema.optional(),
  endReason: EndReasonSchema.optional(),
});
export type RegistrationSummary = z.infer<typeof RegistrationSummarySchema>;

/** `CommandResult.result`: what the browser needs to update the UI from the poll alone. */
export const CommandResultPayloadSchema = z.object({
  registration: RegistrationSummarySchema.optional(),
  offersCreated: NonNegativeIntSchema,
});
export type CommandResultPayload = z.infer<typeof CommandResultPayloadSchema>;

export const CommandResultSchema = z.object({
  commandId: UuidSchema,
  type: UserCommandTypeSchema,
  actorUserId: IdSchema,
  workshopId: IdSchema,
  status: CommandStatusSchema,
  reason: RejectReasonSchema.optional(),
  result: CommandResultPayloadSchema.optional(),
  acceptedAt: IsoTimestampSchema,
  settledAt: IsoTimestampSchema.optional(),
  ttl: TtlSchema,
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const NotificationSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  email: EmailSchema,
  workshopId: IdSchema,
  kind: NotificationKindSchema,
  offerId: IdSchema.optional(),
  title: z.string().min(1),
  body: z.string(),
  status: NotificationStatusSchema,
  attempts: NonNegativeIntSchema,
  createdAt: IsoTimestampSchema,
  readAt: IsoTimestampSchema.optional(),
  ttl: TtlSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

export const BackfillRecordSchema = z.object({
  id: IdSchema,
  workshopId: IdSchema,
  sessionId: IdSchema,
  releasedAt: IsoTimestampSchema,
  cause: BackfillCauseSchema,
  reallocatedAt: IsoTimestampSchema.optional(),
  newOfferId: IdSchema.optional(),
  newUserId: IdSchema.optional(),
  /** `reallocatedAt − releasedAt`; present only once reallocated. */
  latencyMs: NonNegativeIntSchema.optional(),
});
export type BackfillRecord = z.infer<typeof BackfillRecordSchema>;

export const AttendanceSchema = z.object({
  workshopId: IdSchema,
  userId: IdSchema,
  attended: z.boolean(),
  markedAt: IsoTimestampSchema,
  markedBy: IdSchema,
});
export type Attendance = z.infer<typeof AttendanceSchema>;
