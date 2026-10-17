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

/** Title/description only: the API edits them synchronously, outside the worker lock. */
export interface WorkshopInfoPatch {
  title?: string;
  description?: string;
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
 *   deletes the live item and puts the history item; `PUT_BACKFILL` upserts the record.
 * - `notifications` are stored as-is (already full entities with status PENDING); the notifier
 *   picks them up from storage (DynamoDB Streams INSERT filter / Postgres poll).
 * - `commandResult`, present for user commands, is the full settled record. It is written on
 *   the condition that the stored record is missing or still `ACCEPTED`; a failed condition is
 *   the `COMMAND_ALREADY_SETTLED` conflict (the message is a redelivery: ack it, C3).
 *   When both conditions fail, `COMMAND_ALREADY_SETTLED` is reported.
 * - Internal commands (TICK / REALLOCATE) commit without `commandResult`.
 * - An empty `writes` list with a `commandResult` (a deterministic rejection with no tick-first
 *   effect) only settles the command and needs no version condition.
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
  /** Consistent read of the live items only (workshop, sessions, live registrations, live offers). */
  loadSnapshot(wsId: string): Promise<WorkshopSnapshot | undefined>;
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
  /** Sets `readAt`; undefined when the notification does not exist or belongs to someone else. */
  markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<Notification | undefined>;
  listBackfills(wsId: string): Promise<BackfillRecord[]>;
  /** Archived registrations/offers (dashboard history, CSV export, distinct participants served). */
  listHistory(wsId: string): Promise<WorkshopHistory>;
  putAttendance(record: Attendance): Promise<void>;
  listAttendance(wsId: string): Promise<Attendance[]>;
  /**
   * Workshops whose `nextDueAt <= now` (sweep safety net, plan §1.2). `nextDueAt` is only set
   * while something is pending (live offers or waiting demand before a cut-off), so a sparse
   * index keyed on it is exactly this query.
   */
  listDueWorkshops(now: string): Promise<Workshop[]>;
}

/* ---------- messaging ---------- */

/**
 * FIFO per workshop: message group = `workshopId`, dedup id = `commandDedupId(command)`
 * (`commandId` for user commands, `tick#offerId#expiresAt` for timer ticks) or a fresh UUID.
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
