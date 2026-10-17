import type {
  Attendance,
  BackfillRecord,
  Command,
  CommandResult,
  Notification,
  Offer,
  Organization,
  Registration,
  Session,
  Workshop,
} from '@seatrelay/contracts';
import type { Change, OfferTimer, WorkshopSnapshot } from '@seatrelay/core';

/**
 * Ports of the application layer (CONVENTIONS §5). `services/aws` implements them on
 * DynamoDB + SQS, `services/local` on Postgres + in-process loops, and `src/memory` in memory
 * for tests. Adapters map data 1:1 and never run business logic: every rule lives in `core`
 * (the engine) or in this package (API behaviours, worker orchestration).
 */

/* ---------- storage ---------- */

/**
 * Title/description only: the API edits them synchronously, outside the worker lock.
 * `updatedAt` is set along with them (a plain attribute write that is not conditioned on the
 * optimistic-lock version; the engine's `PUT_WORKSHOP_STATE` writes the same attribute).
 */
export interface WorkshopInfoPatch {
  title?: string;
  description?: string;
  updatedAt: string;
}

export type CommitConflict = 'VERSION' | 'COMMAND_ALREADY_SETTLED';

export type CommitResult = { ok: true } | { ok: false; conflict: CommitConflict };

/**
 * One atomic commit of a decision (plan §2.3: a single `TransactWriteItems` / one SQL
 * transaction).
 *
 * - `writes` are applied in order. `PUT_WORKSHOP_STATE` (always first when present) updates
 *   only the engine-owned fields (`status`, `seq`, `version`, `nextDueAt`, `updatedAt`) and is
 *   conditioned on the stored `version === expectedVersion`; a failed condition is the
 *   `VERSION` conflict. Nothing is conditioned on items that are not written. `ARCHIVE_*`
 *   deletes the live item and puts the history item. `PUT_BACKFILL` puts a final (history)
 *   record; `PUT_PENDING_BACKFILL` upserts a live pending record (returned by `loadSnapshot`
 *   as `pendingBackfills`, e.g. DynamoDB `L#BF#{releasedAt}#{id}`); `ARCHIVE_BACKFILL` deletes
 *   the live pending record and puts the history one.
 * - `notifications` are stored as-is (already full entities with status PENDING); the notifier
 *   picks them up from storage (DynamoDB Streams INSERT filter / Postgres poll).
 * - `commandResult`, present for user commands, is the full settled record. It is written on
 *   the condition that the stored record is missing or still `ACCEPTED`; a failed condition is
 *   the `COMMAND_ALREADY_SETTLED` conflict (the message is a redelivery: ack it, C3).
 *   When both conditions fail, `COMMAND_ALREADY_SETTLED` is reported.
 * - Internal commands (TICK / REALLOCATE) commit without `commandResult`.
 * - An empty `writes` list with a `commandResult` (a deterministic rejection with no tick-first
 *   effect) only settles the command and needs no version condition.
 *
 * Item budget: the engine keeps every decision within `MAX_ITEMS_PER_DECISION` (90) items
 * counted with core's `COMMIT_ITEM_COST` (PUT_* 1, PUT_REGISTRATION 2, ARCHIVE_OFFER 2,
 * ARCHIVE_REGISTRATION 3, ARCHIVE_BACKFILL 2), plus one item per notification and one for the
 * CommandResult (`estimateCommitItems(decision)`), so that a DynamoDB adapter that writes the
 * plan §2.3 items — including an R1 uniqueness marker per registration write — never exceeds
 * the 100-item transaction. Such a marker must be keyed per registration scope
 * (`L#U#{userId}` in UNIFIED, `L#U#{userId}#{sessionId}` in PER_SESSION, i.e. core's
 * `registrationScopeKey`): a PER_SESSION cancel-all archives several registrations of one user
 * in one commit and a transaction may touch one item only once.
 *
 * DUE index: the sweep key (DynamoDB sparse `GSI1PK='DUE'`) is derived solely from the presence
 * of `nextDueAt` in `PUT_WORKSHOP_STATE`, whatever the workshop status (CLOSED workshops still
 * have expiring offers; a CANCELLING workshop keeps `nextDueAt = now` until its drain is done).
 */
export interface CommitArgs {
  wsId: string;
  expectedVersion: number;
  writes: readonly Change[];
  notifications: readonly Notification[];
  commandResult?: CommandResult;
}

export type PutCommandAcceptedResult =
  { created: true } | { created: false; existing: CommandResult };

/** Archived (settled) registrations and offers of one workshop. */
export interface WorkshopHistory {
  registrations: Registration[];
  offers: Offer[];
}

export interface WorkshopStore {
  /* organisations */
  createOrganization(organization: Organization): Promise<void>;
  getOrganization(orgId: string): Promise<Organization | undefined>;
  listOrganizationsForUser(userId: string): Promise<Organization[]>;
  /** Idempotent; returns the updated organisation or undefined when it does not exist. */
  addMember(orgId: string, userId: string): Promise<Organization | undefined>;

  /* workshops (synchronous REST writes, plan §2.2) */
  createWorkshop(workshop: Workshop, sessions: readonly Session[]): Promise<void>;
  /** Writes title/description only; must never touch engine-owned fields (see CommitArgs). */
  updateWorkshopInfo(wsId: string, patch: WorkshopInfoPatch): Promise<Workshop | undefined>;
  listWorkshopsForOrg(orgId: string): Promise<Workshop[]>;
  getWorkshop(wsId: string): Promise<Workshop | undefined>;
  listSessions(wsId: string): Promise<Session[]>;

  /* worker */
  /**
   * Consistent read of the live items only (workshop, sessions, live registrations, live
   * offers, pending backfill records). Never `settledOffers`: the worker adds that itself.
   */
  loadSnapshot(wsId: string): Promise<WorkshopSnapshot | undefined>;
  /**
   * One archived (settled) offer by id (DynamoDB GetItem `H#O#{offerId}`, Postgres by primary
   * key). The worker reads it for an ACCEPT_OFFER / DECLINE_OFFER whose offer is no longer live,
   * so that the engine answers OFFER_EXPIRED / OFFER_NOT_ACTIVE instead of OFFER_NOT_FOUND
   * whichever message (the timer tick or the user's answer) was processed first.
   */
  getArchivedOffer(wsId: string, offerId: string): Promise<Offer | undefined>;
  commit(args: CommitArgs): Promise<CommitResult>;

  /* command results (plan §1.3) */
  /** Conditional insert (`attribute_not_exists`); returns the existing record when present. */
  putCommandAccepted(record: CommandResult): Promise<PutCommandAcceptedResult>;
  /** Deletes the record only while its status is still ACCEPTED (enqueue failure rollback). */
  deleteCommandIfAccepted(commandId: string): Promise<void>;
  /** Consistent read (the browser polls it). */
  getCommandResult(commandId: string): Promise<CommandResult | undefined>;

  /* read models */
  /** Live and archived registrations of a user across workshops. */
  listRegistrationsForUser(userId: string): Promise<Registration[]>;
  listNotificationsForUser(userId: string): Promise<Notification[]>;
  /**
   * The notifications of one user in one workshop created at or after `since`, strongly
   * consistent: what the decision that ended a registration told the participant, so that
   * `GET /me/registrations` can name the session whose cancellation ended it (no engine field
   * records that). Read only when the workshop has a cancelled session. DynamoDB: one query of
   * the user's `N#` items from `since` on, with a `workshopId` filter; Postgres: `notifications`
   * by user, workshop and time.
   */
  listNotificationsOfUserSince(
    userId: string,
    wsId: string,
    since: string,
  ): Promise<Notification[]>;
  /** Sets `readAt`; undefined when the notification does not exist or belongs to someone else. */
  markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<Notification | undefined>;
  /** Every backfill record of the workshop, pending (live) and final (history). */
  listBackfills(wsId: string): Promise<BackfillRecord[]>;
  /** Archived registrations/offers (dashboard history, CSV export, attendance eligibility). */
  listHistory(wsId: string): Promise<WorkshopHistory>;
  /**
   * The archived (settled) offers of one user in one workshop: how that user's CANCELLED/ENDED
   * registrations ended (`GET /me/registrations`). Narrower than `listHistory`: no archived
   * registrations, and only this user's offers are returned. DynamoDB: one strongly consistent
   * query of the `H#O#` prefix with a `userId` filter (1 RRU per 4 KB, twice the eventually
   * consistent rate; the filtered-out items are still read and billed, since offers are keyed
   * by offerId), so that an offer archived in the same transaction as a registration the GSI
   * already lists as ended is never missing; Postgres: `offers_history` by workshop and user.
   */
  listArchivedOffersOfUser(wsId: string, userId: string): Promise<Offer[]>;
  putAttendance(record: Attendance): Promise<void>;
  listAttendance(wsId: string): Promise<Attendance[]>;
  /**
   * Workshops whose `nextDueAt <= now` (sweep safety net, plan §1.2). `nextDueAt` is only set
   * while something is pending (live offers, waiting demand before a cut-off, or a continuation
   * chain in progress), whatever the workshop status, so a sparse index keyed on it is exactly
   * this query.
   */
  listDueWorkshops(now: string): Promise<Workshop[]>;
}

/* ---------- messaging ---------- */

/**
 * FIFO per workshop: message group = `workshopId`, dedup id = `commandDedupId(command)`
 * (`commandId` for user commands, `tick#offerId#expiresAt` for timer ticks) or a fresh UUID.
 * A duplicate dedup id inside the queue's deduplication window (SQS: 5 minutes) is dropped,
 * which is what makes re-enqueueing a still-ACCEPTED command on an idempotent re-POST safe.
 */
export interface CommandQueue {
  enqueue(command: Command): Promise<void>;
}

/**
 * One expiry timer per new offer (plan §1.2). Called BEFORE the commit; a timer whose decision
 * never commits produces a harmless no-op TICK.
 */
export interface TimerScheduler {
  schedule(wsId: string, timers: readonly OfferTimer[]): Promise<void>;
}

/* ---------- environment ---------- */

export interface Clock {
  /** ISO-8601 UTC with milliseconds. */
  now(): string;
}

export interface IdGen {
  /** UUID v4 in production. */
  newId(): string;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Custom metric names (CONVENTIONS §7); namespace `SeatRelay`, low-cardinality dimensions only. */
export const METRIC_NAMES = [
  'CommandSettledLatency',
  'BackfillLatency',
  'OffersCreated',
  'OffersExpired',
  'SweepLateExpiries',
  'NotificationFailures',
  'MetaConflictRetries',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export type MetricUnit = 'Milliseconds' | 'Count';

export interface MetricsSink {
  emit(name: MetricName, value: number, unit?: MetricUnit): void;
}

/** Optional: resolves an email address to a userId (`POST /orgs/{orgId}/members` by email). */
export interface UserDirectory {
  findUserIdByEmail(email: string): Promise<string | undefined>;
}

/* ---------- port bundles ---------- */

export interface WorkerPorts {
  store: WorkshopStore;
  queue: CommandQueue;
  timers: TimerScheduler;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
  metrics: MetricsSink;
}

export interface ApiPorts {
  store: WorkshopStore;
  queue: CommandQueue;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
  userDirectory?: UserDirectory;
}
