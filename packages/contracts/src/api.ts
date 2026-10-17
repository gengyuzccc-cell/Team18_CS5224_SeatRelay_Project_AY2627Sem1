import { z } from 'zod';
import {
  COMMAND_POLL_AFTER_MS,
  DEFAULT_HOLD_SECONDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_HOLD_SECONDS,
  MAX_ORG_NAME_LENGTH,
  MAX_SESSIONS_PER_WORKSHOP,
  MAX_TITLE_LENGTH,
  MIN_HOLD_SECONDS,
  MIN_SESSIONS_PER_WORKSHOP,
} from './constants';
import {
  CommandStatusSchema,
  NotificationKindSchema,
  NotificationStatusSchema,
  OfferStatusSchema,
  RejectReasonSchema,
  UserCommandTypeSchema,
  WorkshopModeSchema,
} from './enums';
import {
  AttendanceSchema,
  BackfillRecordSchema,
  CommandResultPayloadSchema,
  DisplayNameSchema,
  EmailSchema,
  IdSchema,
  IsoTimestampSchema,
  NonNegativeIntSchema,
  OfferSummarySchema,
  OrganizationSchema,
  PositiveIntSchema,
  RegistrationSummarySchema,
  SessionSchema,
  UuidSchema,
  WorkshopSchema,
} from './entities';

/**
 * Request bodies and response shapes for every route in plan §2.5.
 * Path parameters are plain `IdSchema`; organiser routes additionally check org membership (C7).
 */

/* ---------- request bodies ---------- */

/** Accepts any ISO-8601 datetime (with or without offset) and normalises it to UTC + ms. */
export const IsoDateTimeInputSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const CreateOrgBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_ORG_NAME_LENGTH),
});
export type CreateOrgBody = z.infer<typeof CreateOrgBodySchema>;

export const AddMemberBodySchema = z
  .object({
    userId: IdSchema.optional(),
    email: EmailSchema.optional(),
  })
  .refine((body) => body.userId !== undefined || body.email !== undefined, {
    message: 'Provide userId or email',
  });
export type AddMemberBody = z.infer<typeof AddMemberBodySchema>;

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  startsAt: IsoDateTimeInputSchema,
  capacity: PositiveIntSchema,
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const CreateWorkshopBodySchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).default(''),
  mode: WorkshopModeSchema.default('UNIFIED'),
  holdSeconds: z
    .number()
    .int()
    .min(MIN_HOLD_SECONDS)
    .max(MAX_HOLD_SECONDS)
    .default(DEFAULT_HOLD_SECONDS),
  sessions: z
    .array(CreateSessionInputSchema)
    .min(MIN_SESSIONS_PER_WORKSHOP)
    .max(MAX_SESSIONS_PER_WORKSHOP),
});
export type CreateWorkshopBody = z.infer<typeof CreateWorkshopBodySchema>;
export type CreateWorkshopInput = z.input<typeof CreateWorkshopBodySchema>;

export const PatchWorkshopBodySchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  })
  .refine((body) => body.title !== undefined || body.description !== undefined, {
    message: 'Nothing to update',
  });
export type PatchWorkshopBody = z.infer<typeof PatchWorkshopBodySchema>;

export const AttendanceBodySchema = z.object({ attended: z.boolean() });
export type AttendanceBody = z.infer<typeof AttendanceBodySchema>;

/* ---------- responses ---------- */

export const HealthViewSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  stage: z.string().optional(),
  time: IsoTimestampSchema,
});
export type HealthView = z.infer<typeof HealthViewSchema>;

export const MeViewSchema = z.object({
  userId: IdSchema,
  email: EmailSchema,
  name: DisplayNameSchema.optional(),
  organizations: z.array(OrganizationSchema),
});
export type MeView = z.infer<typeof MeViewSchema>;

/** GET /commands/{id} */
export const CommandResultViewSchema = z.object({
  commandId: UuidSchema,
  type: UserCommandTypeSchema,
  workshopId: IdSchema,
  status: CommandStatusSchema,
  reason: RejectReasonSchema.optional(),
  result: CommandResultPayloadSchema.optional(),
  acceptedAt: IsoTimestampSchema,
  settledAt: IsoTimestampSchema.optional(),
});
export type CommandResultView = z.infer<typeof CommandResultViewSchema>;

/** Workshop without engine-internal counters. */
export const WorkshopPublicSchema = WorkshopSchema.omit({ seq: true, version: true });
export type WorkshopPublic = z.infer<typeof WorkshopPublicSchema>;

export const SessionViewSchema = SessionSchema.extend({
  /** `capacity − confirmed − held` */
  free: NonNegativeIntSchema,
  /** QUEUED registrations that list this session as acceptable. */
  queueLength: NonNegativeIntSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/** GET /workshops/{wsId} */
export const WorkshopPublicViewSchema = z.object({
  workshop: WorkshopPublicSchema,
  sessions: z.array(SessionViewSchema),
  /** Total QUEUED registrations in the workshop. */
  queueLength: NonNegativeIntSchema,
  /** The caller's live registration (lowest seq in PER_SESSION mode), if any. */
  me: RegistrationSummarySchema.optional(),
});
export type WorkshopPublicView = z.infer<typeof WorkshopPublicViewSchema>;

/**
 * The offer that the decision ending a registration settled along with it: `EXPIRED` (the hold
 * ran out), `DECLINED` (the participant declined it) or `REVOKED` (withdrawn because the
 * participant cancelled while holding it, or the organiser cancelled its session or the workshop).
 * `EXPIRED` also appears on a CANCELLED registration or a cancelled workshop when the hold had
 * run out before the command was processed: the decision expires due offers first (tick-first),
 * so the participant was back in the queue when the cancel applied.
 */
export const EndingOfferSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  status: OfferStatusSchema,
  expiresAt: IsoTimestampSchema,
  settledAt: IsoTimestampSchema,
});
export type EndingOffer = z.infer<typeof EndingOfferSchema>;

/**
 * How a CANCELLED/ENDED registration ended, derived from history (no engine field): lets the
 * browser say what happened in plain words ("your hold for Session 2 expired at 14:05"). All
 * fields are absent when no offer was settled with it, no confirmed seat was given up and no
 * session cancellation could be identified as the cause: a queued participant who left, one
 * whose sessions all passed the cut-off, or one whose last session the organiser cancelled when
 * the server could not tell which (losing a session clears the confirmed session, R5). The time
 * it ended is the registration's `updatedAt`.
 */
export const RegistrationEndingSchema = z.object({
  offer: EndingOfferSchema.optional(),
  /**
   * The session whose confirmed seat was released: given up (CANCELLED), the workshop cancelled,
   * or the session itself cancelled by the organiser (then equal to `cancelledSessionId`).
   */
  confirmedSessionId: IdSchema.optional(),
  /**
   * ENDED only: the session whose cancellation by the organiser ended the registration (it was
   * the last session left, or the others are past the cut-off). `offer` is then absent: a hold
   * that expired or was declined earlier in the same decision had put the participant back in
   * the queue, so it did not end the registration.
   */
  cancelledSessionId: IdSchema.optional(),
});
export type RegistrationEnding = z.infer<typeof RegistrationEndingSchema>;

/** GET /me/registrations (one entry per registration, live or archived). */
export const MyRegistrationViewSchema = z.object({
  workshop: WorkshopPublicSchema,
  sessions: z.array(SessionViewSchema),
  registration: RegistrationSummarySchema.extend({
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    /** Present on CANCELLED/ENDED registrations only. */
    ending: RegistrationEndingSchema.optional(),
  }),
});
export type MyRegistrationView = z.infer<typeof MyRegistrationViewSchema>;

/** GET /me/notifications */
export const NotificationViewSchema = z.object({
  id: IdSchema,
  workshopId: IdSchema,
  kind: NotificationKindSchema,
  offerId: IdSchema.optional(),
  title: z.string(),
  body: z.string(),
  status: NotificationStatusSchema,
  createdAt: IsoTimestampSchema,
  readAt: IsoTimestampSchema.optional(),
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

export const QueueEntrySchema = z.object({
  seq: PositiveIntSchema,
  userId: IdSchema,
  email: EmailSchema,
  displayName: DisplayNameSchema.optional(),
  acceptable: z.array(IdSchema),
  status: z.literal('QUEUED'),
  queuePosition: PositiveIntSchema,
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const OfferedEntrySchema = z.object({
  seq: PositiveIntSchema,
  userId: IdSchema,
  email: EmailSchema,
  displayName: DisplayNameSchema.optional(),
  acceptable: z.array(IdSchema),
  status: z.literal('OFFERED'),
  offer: OfferSummarySchema,
});
export type OfferedEntry = z.infer<typeof OfferedEntrySchema>;

export const ConfirmedEntrySchema = z.object({
  seq: PositiveIntSchema,
  userId: IdSchema,
  email: EmailSchema,
  displayName: DisplayNameSchema.optional(),
  status: z.literal('CONFIRMED'),
  sessionId: IdSchema,
  confirmedAt: IsoTimestampSchema,
});
export type ConfirmedEntry = z.infer<typeof ConfirmedEntrySchema>;

export const DashboardCountsSchema = z.object({
  queued: NonNegativeIntSchema,
  offered: NonNegativeIntSchema,
  confirmed: NonNegativeIntSchema,
  backfills: NonNegativeIntSchema,
  backfillsReallocated: NonNegativeIntSchema,
  attended: NonNegativeIntSchema,
});
export type DashboardCounts = z.infer<typeof DashboardCountsSchema>;

/**
 * A backfill record as the dashboard lists it: with the new holder's e-mail and display name
 * (from the registration that received the relayed offer), so the log names people like the
 * queue/offered/confirmed tables do.
 */
export const DashboardBackfillEntrySchema = BackfillRecordSchema.extend({
  newHolderEmail: EmailSchema.optional(),
  newHolderDisplayName: DisplayNameSchema.optional(),
});
export type DashboardBackfillEntry = z.infer<typeof DashboardBackfillEntrySchema>;

/** GET /orgs/{orgId}/workshops/{wsId}/dashboard */
export const DashboardViewSchema = z.object({
  workshop: WorkshopSchema,
  sessions: z.array(SessionViewSchema),
  queue: z.array(QueueEntrySchema),
  offered: z.array(OfferedEntrySchema),
  confirmed: z.array(ConfirmedEntrySchema),
  backfills: z.array(DashboardBackfillEntrySchema),
  /** Distinct userIds holding a CONFIRMED seat (differs from `counts.confirmed` in PER_SESSION mode). */
  distinctParticipantsServed: NonNegativeIntSchema,
  attendance: z.array(AttendanceSchema),
  counts: DashboardCountsSchema,
});
export type DashboardView = z.infer<typeof DashboardViewSchema>;

export const InvariantViolationSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  sessionId: IdSchema.optional(),
  userId: IdSchema.optional(),
});
export type InvariantViolation = z.infer<typeof InvariantViolationSchema>;

/** GET /orgs/{orgId}/workshops/{wsId}/verify */
export const VerifyViewSchema = z.object({
  ok: z.boolean(),
  checkedAt: IsoTimestampSchema,
  violations: z.array(InvariantViolationSchema),
});
export type VerifyView = z.infer<typeof VerifyViewSchema>;

export const WorkshopListViewSchema = z.object({ workshops: z.array(WorkshopSchema) });
export type WorkshopListView = z.infer<typeof WorkshopListViewSchema>;

export const OrganizationViewSchema = OrganizationSchema;
export type OrganizationView = z.infer<typeof OrganizationViewSchema>;

/* ---------- list / envelope views used by the service routes ---------- */

/** GET /me/registrations */
export const MyRegistrationListViewSchema = z.object({
  registrations: z.array(MyRegistrationViewSchema),
});
export type MyRegistrationListView = z.infer<typeof MyRegistrationListViewSchema>;

/** GET /me/notifications */
export const NotificationListViewSchema = z.object({
  notifications: z.array(NotificationViewSchema),
});
export type NotificationListView = z.infer<typeof NotificationListViewSchema>;

/**
 * 202 body of POST /workshops/{wsId}/commands: the `CommandAccepted` fields plus the record's
 * current state, so an idempotent re-POST of an already settled command carries its outcome.
 */
export const CommandAcceptedViewSchema = CommandResultViewSchema.extend({
  href: z.string().min(1),
  pollAfterMs: z.number().int().min(0).default(COMMAND_POLL_AFTER_MS),
});
export type CommandAcceptedView = z.infer<typeof CommandAcceptedViewSchema>;

/**
 * The plan §1.3 name for the 202 body. It is the same schema as `CommandAcceptedViewSchema`:
 * `status` is the record's current state (ACCEPTED on the first POST, APPLIED/REJECTED on an
 * idempotent re-POST of a settled command), never only the literal `ACCEPTED`.
 */
export const CommandAcceptedSchema = CommandAcceptedViewSchema;
export type CommandAccepted = CommandAcceptedView;
