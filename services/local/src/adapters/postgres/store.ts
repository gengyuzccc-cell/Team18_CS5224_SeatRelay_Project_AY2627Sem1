import type {
  Attendance,
  BackfillRecord,
  CommandResult,
  Notification,
  Offer,
  Organization,
  Registration,
  Session,
  Workshop,
  WorkshopMode,
} from '@seatrelay/contracts';
import { registrationScopeKey, type Change, type WorkshopSnapshot } from '@seatrelay/core';
import type {
  CommitArgs,
  CommitConflict,
  CommitResult,
  PutCommandAcceptedResult,
  WorkshopHistory,
  WorkshopInfoPatch,
  WorkshopStore,
} from '@seatrelay/service';
import type pg from 'pg';
import {
  atomic,
  epochSecondsToIso,
  int,
  iso,
  isoOrUndefined,
  orUndefined,
  type Executor,
  type Queryable,
} from './db';

/**
 * PostgreSQL implementation of the `WorkshopStore` port (plan §2.7). Pure data mapping: every
 * `Change` of a decision maps 1:1 onto one row operation; no business rule lives here.
 *
 * The store is bound to an executor: the pool for API requests, or the worker's transaction
 * client (`bind(client)`), in which case `loadSnapshot` and `commit` run inside that
 * transaction, serialised per workshop by the worker's advisory lock.
 */
export class PostgresWorkshopStore implements WorkshopStore {
  constructor(private readonly executor: Executor) {}

  /** The same store on another executor (the worker binds it to its transaction client). */
  bind(client: pg.PoolClient): PostgresWorkshopStore {
    return new PostgresWorkshopStore(client);
  }

  /* ---------- organisations ---------- */

  async createOrganization(organization: Organization): Promise<void> {
    await atomic(this.executor, async (client) => {
      await client.query(
        `INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES ($1, $2, $3, $4)`,
        [organization.id, organization.name, organization.ownerUserId, organization.createdAt],
      );
      const members = [...new Set([organization.ownerUserId, ...organization.members])];
      for (const [index, userId] of members.entries()) {
        await client.query(
          `INSERT INTO org_members (org_id, user_id, added_at)
           VALUES ($1, $2, $3::timestamptz + ($4::int * interval '1 millisecond'))
           ON CONFLICT DO NOTHING`,
          [organization.id, userId, organization.createdAt, index],
        );
      }
    });
  }

  async getOrganization(orgId: string): Promise<Organization | undefined> {
    const result = await this.executor.query<OrganizationRow>(
      `${ORGANIZATION_SELECT} WHERE o.id = $1 GROUP BY o.id`,
      [orgId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toOrganization(row);
  }

  async listOrganizationsForUser(userId: string): Promise<Organization[]> {
    const result = await this.executor.query<OrganizationRow>(
      `${ORGANIZATION_SELECT}
       WHERE o.id IN (SELECT org_id FROM org_members WHERE user_id = $1)
       GROUP BY o.id
       ORDER BY o.created_at, o.id`,
      [userId],
    );
    return result.rows.map(toOrganization);
  }

  async addMember(orgId: string, userId: string): Promise<Organization | undefined> {
    await this.executor.query(
      `INSERT INTO org_members (org_id, user_id)
       SELECT $1::text, $2::text WHERE EXISTS (SELECT 1 FROM organizations WHERE id = $1::text)
       ON CONFLICT DO NOTHING`,
      [orgId, userId],
    );
    return this.getOrganization(orgId);
  }

  /* ---------- workshops ---------- */

  async createWorkshop(workshop: Workshop, sessions: readonly Session[]): Promise<void> {
    await atomic(this.executor, async (client) => {
      await client.query(
        `INSERT INTO workshops
           (id, org_id, title, description, status, mode, hold_seconds, seq, version, next_due_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          workshop.id,
          workshop.orgId,
          workshop.title,
          workshop.description,
          workshop.status,
          workshop.mode,
          workshop.holdSeconds,
          workshop.seq,
          workshop.version,
          workshop.nextDueAt ?? null,
          workshop.createdAt,
          workshop.updatedAt,
        ],
      );
      for (const session of sessions) {
        await putSession(client, session);
      }
    });
  }

  async updateWorkshopInfo(wsId: string, patch: WorkshopInfoPatch): Promise<Workshop | undefined> {
    const result = await this.executor.query<WorkshopRow>(
      `UPDATE workshops
         SET title = COALESCE($2, title),
             description = COALESCE($3, description),
             updated_at = $4
       WHERE id = $1
       RETURNING *`,
      [wsId, patch.title ?? null, patch.description ?? null, patch.updatedAt],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toWorkshop(row);
  }

  async listWorkshopsForOrg(orgId: string): Promise<Workshop[]> {
    const result = await this.executor.query<WorkshopRow>(
      `SELECT * FROM workshops WHERE org_id = $1 ORDER BY created_at, id`,
      [orgId],
    );
    return result.rows.map(toWorkshop);
  }

  async getWorkshop(wsId: string): Promise<Workshop | undefined> {
    const result = await this.executor.query<WorkshopRow>(
      `SELECT * FROM workshops WHERE id = $1`,
      [wsId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toWorkshop(row);
  }

  async listSessions(wsId: string): Promise<Session[]> {
    const result = await this.executor.query<SessionRow>(
      `SELECT * FROM sessions WHERE workshop_id = $1 ORDER BY starts_at, id`,
      [wsId],
    );
    return result.rows.map(toSession);
  }

  /* ---------- worker ---------- */

  /**
   * Live items only, read in one REPEATABLE READ transaction when on the pool (a consistent
   * snapshot, plan §2.3); inside the worker's transaction the reads are already consistent.
   */
  async loadSnapshot(wsId: string): Promise<WorkshopSnapshot | undefined> {
    return atomic(
      this.executor,
      async (client) => {
        const workshop = await client.query<WorkshopRow>(`SELECT * FROM workshops WHERE id = $1`, [
          wsId,
        ]);
        const row = workshop.rows[0];
        if (row === undefined) {
          return undefined;
        }
        // One query at a time: a single connection cannot run them concurrently (pg queues
        // and deprecates overlapping calls).
        const sessions = await client.query<SessionRow>(
          `SELECT * FROM sessions WHERE workshop_id = $1 ORDER BY starts_at, id`,
          [wsId],
        );
        const registrations = await client.query<RegistrationRow>(
          `SELECT * FROM registrations WHERE workshop_id = $1 ORDER BY seq`,
          [wsId],
        );
        const offers = await client.query<OfferRow>(
          `SELECT * FROM offers WHERE workshop_id = $1 ORDER BY created_at, id`,
          [wsId],
        );
        const pending = await client.query<BackfillRow>(
          `SELECT * FROM backfill_records WHERE workshop_id = $1 AND pending ORDER BY released_at, id`,
          [wsId],
        );
        return {
          workshop: toWorkshop(row),
          sessions: sessions.rows.map(toSession),
          registrations: registrations.rows.map(toRegistration),
          offers: offers.rows.map(toOffer),
          pendingBackfills: pending.rows.map(toBackfill),
        };
      },
      'REPEATABLE READ',
      true,
    );
  }

  async getArchivedOffer(wsId: string, offerId: string): Promise<Offer | undefined> {
    const result = await this.executor.query<OfferRow>(
      `SELECT * FROM offers_history WHERE workshop_id = $1 AND id = $2`,
      [wsId, offerId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toOffer(row);
  }

  /**
   * One SQL transaction (a SAVEPOINT inside the worker's transaction):
   *  1. the CommandResult is settled only while still ACCEPTED (0 rows → COMMAND_ALREADY_SETTLED);
   *  2. the workshop row is locked and its version compared (≠ expected → VERSION);
   *  3. every change becomes one row operation (archives before puts, so a seq/offer that is
   *     archived and re-created in the same decision never trips the live unique indexes);
   *  4. notifications are inserted PENDING for the notifier loop.
   * A conflict rolls everything back and is reported; nothing else is conditioned.
   */
  async commit(args: CommitArgs): Promise<CommitResult> {
    try {
      await atomic(this.executor, async (client) => {
        if (args.commandResult !== undefined) {
          const settled = await upsertCommandResult(client, args.commandResult, true);
          if (settled === 0) {
            throw new CommitConflictSignal('COMMAND_ALREADY_SETTLED');
          }
        }
        if (args.writes.length > 0) {
          const locked = await client.query<{ mode: WorkshopMode; version: number }>(
            `SELECT mode, version FROM workshops WHERE id = $1 FOR UPDATE`,
            [args.wsId],
          );
          const workshop = locked.rows[0];
          if (workshop === undefined) {
            throw new Error(`workshop ${args.wsId} does not exist`);
          }
          if (workshop.version !== args.expectedVersion) {
            throw new CommitConflictSignal('VERSION');
          }
          for (const change of orderWrites(args.writes)) {
            await applyChange(client, workshop.mode, args.expectedVersion, change);
          }
        }
        for (const notification of args.notifications) {
          await insertNotification(client, notification);
        }
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof CommitConflictSignal) {
        return { ok: false, conflict: error.conflict };
      }
      throw error;
    }
  }

  /* ---------- command results (plan §1.3) ---------- */

  async putCommandAccepted(record: CommandResult): Promise<PutCommandAcceptedResult> {
    const inserted = await upsertCommandResult(this.executor, record, false);
    if (inserted > 0) {
      return { created: true };
    }
    const existing = await this.getCommandResult(record.commandId);
    if (existing === undefined) {
      // Deleted between the insert and the read (a concurrent 503 rollback): try once more.
      const retried = await upsertCommandResult(this.executor, record, false);
      if (retried > 0) {
        return { created: true };
      }
      throw new Error(`command ${record.commandId}: conditional insert raced`);
    }
    return { created: false, existing };
  }

  async deleteCommandIfAccepted(commandId: string): Promise<void> {
    await this.executor.query(
      `DELETE FROM command_results WHERE command_id = $1 AND status = 'ACCEPTED'`,
      [commandId],
    );
  }

  async getCommandResult(commandId: string): Promise<CommandResult | undefined> {
    const result = await this.executor.query<CommandResultRow>(
      `SELECT * FROM command_results WHERE command_id = $1`,
      [commandId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toCommandResult(row);
  }

  /* ---------- read models ---------- */

  async listRegistrationsForUser(userId: string): Promise<Registration[]> {
    const result = await this.executor.query<RegistrationRow>(
      `SELECT workshop_id, seq, user_id, email, display_name, acceptable, status, end_reason,
              current_offer_id, confirmed_session_id, created_at, updated_at
         FROM registrations WHERE user_id = $1
       UNION ALL
       SELECT workshop_id, seq, user_id, email, display_name, acceptable, status, end_reason,
              current_offer_id, confirmed_session_id, created_at, updated_at
         FROM registrations_history WHERE user_id = $1
       ORDER BY updated_at DESC, seq DESC`,
      [userId],
    );
    return result.rows.map(toRegistration);
  }

  async listNotificationsForUser(userId: string): Promise<Notification[]> {
    const result = await this.executor.query<NotificationRow>(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id`,
      [userId],
    );
    return result.rows.map(toNotification);
  }

  async listNotificationsOfUserSince(
    userId: string,
    wsId: string,
    since: string,
  ): Promise<Notification[]> {
    const result = await this.executor.query<NotificationRow>(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND workshop_id = $2 AND created_at >= $3::timestamptz
       ORDER BY created_at, id`,
      [userId, wsId, since],
    );
    return result.rows.map(toNotification);
  }

  async markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<Notification | undefined> {
    const result = await this.executor.query<NotificationRow>(
      `UPDATE notifications SET read_at = COALESCE(read_at, $3::timestamptz)
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
      [userId, notificationId, readAt],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toNotification(row);
  }

  async listBackfills(wsId: string): Promise<BackfillRecord[]> {
    const result = await this.executor.query<BackfillRow>(
      `SELECT * FROM backfill_records WHERE workshop_id = $1 ORDER BY released_at, id`,
      [wsId],
    );
    return result.rows.map(toBackfill);
  }

  async listHistory(wsId: string): Promise<WorkshopHistory> {
    const registrations = await this.executor.query<RegistrationRow>(
      `SELECT * FROM registrations_history WHERE workshop_id = $1 ORDER BY seq`,
      [wsId],
    );
    const offers = await this.executor.query<OfferRow>(
      `SELECT * FROM offers_history WHERE workshop_id = $1 ORDER BY created_at, id`,
      [wsId],
    );
    return {
      registrations: registrations.rows.map(toRegistration),
      offers: offers.rows.map(toOffer),
    };
  }

  async listArchivedOffersOfUser(wsId: string, userId: string): Promise<Offer[]> {
    const result = await this.executor.query<OfferRow>(
      `SELECT * FROM offers_history WHERE workshop_id = $1 AND user_id = $2 ORDER BY created_at, id`,
      [wsId, userId],
    );
    return result.rows.map(toOffer);
  }

  async putAttendance(record: Attendance): Promise<void> {
    await this.executor.query(
      `INSERT INTO attendance (workshop_id, user_id, attended, marked_at, marked_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workshop_id, user_id)
       DO UPDATE SET attended = EXCLUDED.attended, marked_at = EXCLUDED.marked_at, marked_by = EXCLUDED.marked_by`,
      [record.workshopId, record.userId, record.attended, record.markedAt, record.markedBy],
    );
  }

  async listAttendance(wsId: string): Promise<Attendance[]> {
    const result = await this.executor.query<AttendanceRow>(
      `SELECT * FROM attendance WHERE workshop_id = $1 ORDER BY user_id`,
      [wsId],
    );
    return result.rows.map(toAttendance);
  }

  async listDueWorkshops(now: string): Promise<Workshop[]> {
    const result = await this.executor.query<WorkshopRow>(
      `SELECT * FROM workshops WHERE next_due_at IS NOT NULL AND next_due_at <= $1::timestamptz
       ORDER BY next_due_at, id`,
      [now],
    );
    return result.rows.map(toWorkshop);
  }
}

/* ---------- commit internals ---------- */

class CommitConflictSignal extends Error {
  constructor(readonly conflict: CommitConflict) {
    super(`commit conflict: ${conflict}`);
    this.name = 'CommitConflictSignal';
  }
}

const WRITE_ORDER: Readonly<Record<Change['kind'], number>> = Object.freeze({
  PUT_WORKSHOP_STATE: 0,
  PUT_SESSION: 1,
  ARCHIVE_REGISTRATION: 2,
  ARCHIVE_OFFER: 3,
  ARCHIVE_BACKFILL: 4,
  PUT_REGISTRATION: 5,
  PUT_OFFER: 6,
  PUT_BACKFILL: 7,
  PUT_PENDING_BACKFILL: 8,
});

/** Stable sort: deletes of live rows before inserts, so unique indexes never see a transient duplicate. */
function orderWrites(writes: readonly Change[]): Change[] {
  return writes
    .map((change, index) => ({ change, index }))
    .sort(
      (a, b) =>
        WRITE_ORDER[a.change.kind] - WRITE_ORDER[b.change.kind] || a.index - b.index,
    )
    .map((entry) => entry.change);
}

async function applyChange(
  client: Queryable,
  mode: WorkshopMode,
  expectedVersion: number,
  change: Change,
): Promise<void> {
  switch (change.kind) {
    case 'PUT_WORKSHOP_STATE': {
      const updated = await client.query(
        `UPDATE workshops
           SET status = $2, seq = $3, version = $4, next_due_at = $5, updated_at = $6
         WHERE id = $1 AND version = $7`,
        [
          change.workshopId,
          change.status,
          change.seq,
          change.version,
          change.nextDueAt ?? null,
          change.updatedAt,
          expectedVersion,
        ],
      );
      if (updated.rowCount === 0) {
        throw new CommitConflictSignal('VERSION');
      }
      return;
    }
    case 'PUT_SESSION':
      await putSession(client, change.session);
      return;
    case 'PUT_REGISTRATION':
      await putRegistration(client, mode, change.registration);
      return;
    case 'ARCHIVE_REGISTRATION':
      await archiveRegistration(client, change.registration);
      return;
    case 'PUT_OFFER':
      await putOffer(client, change.offer);
      return;
    case 'ARCHIVE_OFFER':
      await archiveOffer(client, change.offer);
      return;
    case 'PUT_BACKFILL':
    case 'ARCHIVE_BACKFILL':
      await putBackfill(client, change.record, false);
      return;
    case 'PUT_PENDING_BACKFILL':
      await putBackfill(client, change.record, true);
      return;
  }
}

async function putSession(client: Queryable, session: Session): Promise<void> {
  await client.query(
    `INSERT INTO sessions (id, workshop_id, title, starts_at, cutoff_at, capacity, confirmed, held, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, cutoff_at = EXCLUDED.cutoff_at,
       capacity = EXCLUDED.capacity, confirmed = EXCLUDED.confirmed, held = EXCLUDED.held,
       status = EXCLUDED.status`,
    [
      session.id,
      session.workshopId,
      session.title,
      session.startsAt,
      session.cutoffAt,
      session.capacity,
      session.confirmed,
      session.held,
      session.status,
    ],
  );
}

function registrationValues(registration: Registration): unknown[] {
  return [
    registration.workshopId,
    registration.seq,
    registration.userId,
    registration.email,
    registration.displayName ?? null,
    JSON.stringify(registration.acceptable),
    registration.status,
    registration.endReason ?? null,
    registration.currentOfferId ?? null,
    registration.confirmedSessionId ?? null,
    registration.createdAt,
    registration.updatedAt,
  ];
}

async function putRegistration(
  client: Queryable,
  mode: WorkshopMode,
  registration: Registration,
): Promise<void> {
  await client.query(
    `INSERT INTO registrations
       (workshop_id, seq, user_id, email, display_name, acceptable, status, end_reason,
        current_offer_id, confirmed_session_id, created_at, updated_at, scope_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (workshop_id, seq) DO UPDATE SET
       user_id = EXCLUDED.user_id, email = EXCLUDED.email, display_name = EXCLUDED.display_name,
       acceptable = EXCLUDED.acceptable, status = EXCLUDED.status, end_reason = EXCLUDED.end_reason,
       current_offer_id = EXCLUDED.current_offer_id, confirmed_session_id = EXCLUDED.confirmed_session_id,
       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, scope_key = EXCLUDED.scope_key`,
    [...registrationValues(registration), registrationScopeKey(mode, registration)],
  );
}

async function archiveRegistration(client: Queryable, registration: Registration): Promise<void> {
  await client.query(`DELETE FROM registrations WHERE workshop_id = $1 AND seq = $2`, [
    registration.workshopId,
    registration.seq,
  ]);
  await client.query(
    `INSERT INTO registrations_history
       (workshop_id, seq, user_id, email, display_name, acceptable, status, end_reason,
        current_offer_id, confirmed_session_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (workshop_id, seq) DO UPDATE SET
       acceptable = EXCLUDED.acceptable, status = EXCLUDED.status, end_reason = EXCLUDED.end_reason,
       current_offer_id = EXCLUDED.current_offer_id, confirmed_session_id = EXCLUDED.confirmed_session_id,
       updated_at = EXCLUDED.updated_at, archived_at = now()`,
    registrationValues(registration),
  );
}

function offerValues(offer: Offer): unknown[] {
  return [
    offer.id,
    offer.workshopId,
    offer.sessionId,
    offer.userId,
    offer.registrationSeq,
    offer.status,
    offer.createdAt,
    offer.expiresAt,
    offer.settledAt ?? null,
  ];
}

async function putOffer(client: Queryable, offer: Offer): Promise<void> {
  await client.query(
    `INSERT INTO offers (id, workshop_id, session_id, user_id, registration_seq, status, created_at, expires_at, settled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       session_id = EXCLUDED.session_id, user_id = EXCLUDED.user_id,
       registration_seq = EXCLUDED.registration_seq, status = EXCLUDED.status,
       created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, settled_at = EXCLUDED.settled_at`,
    offerValues(offer),
  );
}

async function archiveOffer(client: Queryable, offer: Offer): Promise<void> {
  await client.query(`DELETE FROM offers WHERE id = $1`, [offer.id]);
  await client.query(
    `INSERT INTO offers_history (id, workshop_id, session_id, user_id, registration_seq, status, created_at, expires_at, settled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status, settled_at = EXCLUDED.settled_at, archived_at = now()`,
    offerValues(offer),
  );
}

async function putBackfill(client: Queryable, record: BackfillRecord, pending: boolean): Promise<void> {
  await client.query(
    `INSERT INTO backfill_records
       (id, workshop_id, session_id, released_at, cause, reallocated_at, new_offer_id, new_user_id, latency_ms, pending)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       reallocated_at = EXCLUDED.reallocated_at, new_offer_id = EXCLUDED.new_offer_id,
       new_user_id = EXCLUDED.new_user_id, latency_ms = EXCLUDED.latency_ms, pending = EXCLUDED.pending`,
    [
      record.id,
      record.workshopId,
      record.sessionId,
      record.releasedAt,
      record.cause,
      record.reallocatedAt ?? null,
      record.newOfferId ?? null,
      record.newUserId ?? null,
      record.latencyMs ?? null,
      pending,
    ],
  );
}

/**
 * Conditional write of a CommandResult. `settle = false` (API): insert only when absent
 * (`attribute_not_exists`). `settle = true` (worker): insert, or update the settled fields of
 * a record that is still ACCEPTED. Returns the number of rows written (0 = condition failed).
 */
async function upsertCommandResult(
  client: Queryable,
  record: CommandResult,
  settle: boolean,
): Promise<number> {
  const conflict = settle
    ? `DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, result = EXCLUDED.result,
                     settled_at = EXCLUDED.settled_at
       WHERE command_results.status = 'ACCEPTED'`
    : 'DO NOTHING';
  const result = await client.query(
    `INSERT INTO command_results
       (command_id, type, actor_user_id, workshop_id, status, reason, result, accepted_at, settled_at, ttl, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     ON CONFLICT (command_id) ${conflict}`,
    [
      record.commandId,
      record.type,
      record.actorUserId,
      record.workshopId,
      record.status,
      record.reason ?? null,
      record.result === undefined ? null : JSON.stringify(record.result),
      record.acceptedAt,
      record.settledAt ?? null,
      record.ttl,
      epochSecondsToIso(record.ttl),
    ],
  );
  return result.rowCount ?? 0;
}

async function insertNotification(client: Queryable, notification: Notification): Promise<void> {
  await client.query(
    `INSERT INTO notifications
       (id, user_id, email, workshop_id, kind, offer_id, title, body, status, attempts, created_at, read_at, ttl, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO NOTHING`,
    [
      notification.id,
      notification.userId,
      notification.email,
      notification.workshopId,
      notification.kind,
      notification.offerId ?? null,
      notification.title,
      notification.body,
      notification.status,
      notification.attempts,
      notification.createdAt,
      notification.readAt ?? null,
      notification.ttl,
      epochSecondsToIso(notification.ttl),
    ],
  );
}

/* ---------- row types and mappers ---------- */

const ORGANIZATION_SELECT = `
  SELECT o.id, o.name, o.owner_user_id, o.created_at,
         COALESCE(
           array_agg(m.user_id ORDER BY (m.user_id <> o.owner_user_id), m.added_at, m.user_id)
             FILTER (WHERE m.user_id IS NOT NULL),
           '{}'
         ) AS members
    FROM organizations o
    LEFT JOIN org_members m ON m.org_id = o.id`;

interface OrganizationRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: Date;
  members: string[];
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    members: row.members,
    createdAt: iso(row.created_at),
  };
}

interface WorkshopRow {
  id: string;
  org_id: string;
  title: string;
  description: string;
  status: Workshop['status'];
  mode: WorkshopMode;
  hold_seconds: number;
  seq: number;
  version: number;
  next_due_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toWorkshop(row: WorkshopRow): Workshop {
  const workshop: Workshop = {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    description: row.description,
    status: row.status,
    mode: row.mode,
    holdSeconds: row.hold_seconds,
    seq: row.seq,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  const nextDueAt = isoOrUndefined(row.next_due_at);
  if (nextDueAt !== undefined) {
    workshop.nextDueAt = nextDueAt;
  }
  return workshop;
}

interface SessionRow {
  id: string;
  workshop_id: string;
  title: string;
  starts_at: Date;
  cutoff_at: Date;
  capacity: number;
  confirmed: number;
  held: number;
  status: Session['status'];
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    workshopId: row.workshop_id,
    title: row.title,
    startsAt: iso(row.starts_at),
    cutoffAt: iso(row.cutoff_at),
    capacity: row.capacity,
    confirmed: row.confirmed,
    held: row.held,
    status: row.status,
  };
}

interface RegistrationRow {
  workshop_id: string;
  seq: number;
  user_id: string;
  email: string;
  display_name: string | null;
  acceptable: string[];
  status: Registration['status'];
  end_reason: Registration['endReason'] | null;
  current_offer_id: string | null;
  confirmed_session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRegistration(row: RegistrationRow): Registration {
  const registration: Registration = {
    workshopId: row.workshop_id,
    userId: row.user_id,
    email: row.email,
    seq: row.seq,
    acceptable: [...row.acceptable],
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  const displayName = orUndefined(row.display_name);
  if (displayName !== undefined) {
    registration.displayName = displayName;
  }
  const endReason = orUndefined(row.end_reason);
  if (endReason !== undefined) {
    registration.endReason = endReason;
  }
  const currentOfferId = orUndefined(row.current_offer_id);
  if (currentOfferId !== undefined) {
    registration.currentOfferId = currentOfferId;
  }
  const confirmedSessionId = orUndefined(row.confirmed_session_id);
  if (confirmedSessionId !== undefined) {
    registration.confirmedSessionId = confirmedSessionId;
  }
  return registration;
}

interface OfferRow {
  id: string;
  workshop_id: string;
  session_id: string;
  user_id: string;
  registration_seq: number;
  status: Offer['status'];
  created_at: Date;
  expires_at: Date;
  settled_at: Date | null;
}

function toOffer(row: OfferRow): Offer {
  const offer: Offer = {
    id: row.id,
    workshopId: row.workshop_id,
    sessionId: row.session_id,
    userId: row.user_id,
    registrationSeq: row.registration_seq,
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
  const settledAt = isoOrUndefined(row.settled_at);
  if (settledAt !== undefined) {
    offer.settledAt = settledAt;
  }
  return offer;
}

interface BackfillRow {
  id: string;
  workshop_id: string;
  session_id: string;
  released_at: Date;
  cause: BackfillRecord['cause'];
  reallocated_at: Date | null;
  new_offer_id: string | null;
  new_user_id: string | null;
  latency_ms: number | null;
  pending: boolean;
}

function toBackfill(row: BackfillRow): BackfillRecord {
  const record: BackfillRecord = {
    id: row.id,
    workshopId: row.workshop_id,
    sessionId: row.session_id,
    releasedAt: iso(row.released_at),
    cause: row.cause,
  };
  const reallocatedAt = isoOrUndefined(row.reallocated_at);
  if (reallocatedAt !== undefined) {
    record.reallocatedAt = reallocatedAt;
  }
  const newOfferId = orUndefined(row.new_offer_id);
  if (newOfferId !== undefined) {
    record.newOfferId = newOfferId;
  }
  const newUserId = orUndefined(row.new_user_id);
  if (newUserId !== undefined) {
    record.newUserId = newUserId;
  }
  const latencyMs = orUndefined(row.latency_ms);
  if (latencyMs !== undefined) {
    record.latencyMs = latencyMs;
  }
  return record;
}

interface CommandResultRow {
  command_id: string;
  type: CommandResult['type'];
  actor_user_id: string;
  workshop_id: string;
  status: CommandResult['status'];
  reason: CommandResult['reason'] | null;
  result: CommandResult['result'] | null;
  accepted_at: Date;
  settled_at: Date | null;
  ttl: string | number;
}

function toCommandResult(row: CommandResultRow): CommandResult {
  const record: CommandResult = {
    commandId: row.command_id,
    type: row.type,
    actorUserId: row.actor_user_id,
    workshopId: row.workshop_id,
    status: row.status,
    acceptedAt: iso(row.accepted_at),
    ttl: int(row.ttl),
  };
  const reason = orUndefined(row.reason);
  if (reason !== undefined) {
    record.reason = reason;
  }
  const result = orUndefined(row.result);
  if (result !== undefined) {
    record.result = result;
  }
  const settledAt = isoOrUndefined(row.settled_at);
  if (settledAt !== undefined) {
    record.settledAt = settledAt;
  }
  return record;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  email: string;
  workshop_id: string;
  kind: Notification['kind'];
  offer_id: string | null;
  title: string;
  body: string;
  status: Notification['status'];
  attempts: number;
  created_at: Date;
  read_at: Date | null;
  ttl: string | number;
}

export function toNotification(row: NotificationRow): Notification {
  const notification: Notification = {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    workshopId: row.workshop_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
    ttl: int(row.ttl),
  };
  const offerId = orUndefined(row.offer_id);
  if (offerId !== undefined) {
    notification.offerId = offerId;
  }
  const readAt = isoOrUndefined(row.read_at);
  if (readAt !== undefined) {
    notification.readAt = readAt;
  }
  return notification;
}

interface AttendanceRow {
  workshop_id: string;
  user_id: string;
  attended: boolean;
  marked_at: Date;
  marked_by: string;
}

function toAttendance(row: AttendanceRow): Attendance {
  return {
    workshopId: row.workshop_id,
    userId: row.user_id,
    attended: row.attended,
    markedAt: iso(row.marked_at),
    markedBy: row.marked_by,
  };
}
