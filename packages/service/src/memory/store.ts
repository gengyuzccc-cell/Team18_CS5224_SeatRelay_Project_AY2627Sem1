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
} from '@seatrelay/contracts';
import { byRelease, compareIso, type Change, type WorkshopSnapshot } from '@seatrelay/core';
import type {
  CommitArgs,
  CommitResult,
  PutCommandAcceptedResult,
  WorkshopHistory,
  WorkshopInfoPatch,
  WorkshopStore,
} from '../ports';

/** One `WS#` partition: live items (snapshot) and history items, as in the single table. */
interface WorkshopPartition {
  workshop: Workshop;
  sessions: Map<string, Session>;
  live: Map<number, Registration>;
  historyRegistrations: Registration[];
  liveOffers: Map<string, Offer>;
  historyOffers: Offer[];
  /** Every backfill record (pending and final); the pending ones are also live items. */
  backfills: Map<string, BackfillRecord>;
  pendingBackfillIds: Set<string>;
  attendance: Map<string, Attendance>;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory implementation with the same semantics as the DynamoDB/Postgres adapters:
 * `commit` is atomic, conditioned on the workshop version (only when something is written)
 * and on the command record being missing or still ACCEPTED. Every value is deep-copied on
 * the way in and out, so callers never share mutable state with the store.
 *
 * `beforeCommit` is a test hook invoked at the start of `commit` (before the condition
 * checks); use it with `bumpVersion()` to simulate a concurrent writer.
 */
export class InMemoryWorkshopStore implements WorkshopStore {
  private readonly organizations = new Map<string, Organization>();
  private readonly partitions = new Map<string, WorkshopPartition>();
  private readonly commandResults = new Map<string, CommandResult>();
  private readonly notifications = new Map<string, Notification[]>();

  beforeCommit?: (args: CommitArgs) => void | Promise<void>;
  commits = 0;

  /* ---------- organisations ---------- */

  async createOrganization(organization: Organization): Promise<void> {
    if (this.organizations.has(organization.id)) {
      throw new Error(`organization ${organization.id} already exists`);
    }
    this.organizations.set(organization.id, clone(organization));
  }

  async getOrganization(orgId: string): Promise<Organization | undefined> {
    const organization = this.organizations.get(orgId);
    return organization === undefined ? undefined : clone(organization);
  }

  async listOrganizationsForUser(userId: string): Promise<Organization[]> {
    return [...this.organizations.values()]
      .filter((organization) => organization.members.includes(userId))
      .sort((a, b) => compareIso(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1))
      .map(clone);
  }

  async addMember(orgId: string, userId: string): Promise<Organization | undefined> {
    const organization = this.organizations.get(orgId);
    if (organization === undefined) {
      return undefined;
    }
    if (!organization.members.includes(userId)) {
      organization.members.push(userId);
    }
    return clone(organization);
  }

  /* ---------- workshops ---------- */

  async createWorkshop(workshop: Workshop, sessions: readonly Session[]): Promise<void> {
    if (this.partitions.has(workshop.id)) {
      throw new Error(`workshop ${workshop.id} already exists`);
    }
    this.partitions.set(workshop.id, {
      workshop: clone(workshop),
      sessions: new Map(sessions.map((session) => [session.id, clone(session)])),
      live: new Map(),
      historyRegistrations: [],
      liveOffers: new Map(),
      historyOffers: [],
      backfills: new Map(),
      pendingBackfillIds: new Set(),
      attendance: new Map(),
    });
  }

  async updateWorkshopInfo(wsId: string, patch: WorkshopInfoPatch): Promise<Workshop | undefined> {
    const partition = this.partitions.get(wsId);
    if (partition === undefined) {
      return undefined;
    }
    if (patch.title !== undefined) {
      partition.workshop.title = patch.title;
    }
    if (patch.description !== undefined) {
      partition.workshop.description = patch.description;
    }
    partition.workshop.updatedAt = patch.updatedAt;
    return clone(partition.workshop);
  }

  async listWorkshopsForOrg(orgId: string): Promise<Workshop[]> {
    return [...this.partitions.values()]
      .map((partition) => partition.workshop)
      .filter((workshop) => workshop.orgId === orgId)
      .sort((a, b) => compareIso(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1))
      .map(clone);
  }

  async getWorkshop(wsId: string): Promise<Workshop | undefined> {
    const partition = this.partitions.get(wsId);
    return partition === undefined ? undefined : clone(partition.workshop);
  }

  async listSessions(wsId: string): Promise<Session[]> {
    const partition = this.partitions.get(wsId);
    return partition === undefined ? [] : [...partition.sessions.values()].map(clone);
  }

  /* ---------- worker ---------- */

  async loadSnapshot(wsId: string): Promise<WorkshopSnapshot | undefined> {
    const partition = this.partitions.get(wsId);
    if (partition === undefined) {
      return undefined;
    }
    return clone({
      workshop: partition.workshop,
      sessions: [...partition.sessions.values()],
      registrations: [...partition.live.values()].sort((a, b) => a.seq - b.seq),
      offers: [...partition.liveOffers.values()],
      pendingBackfills: [...partition.pendingBackfillIds]
        .map((id) => partition.backfills.get(id)!)
        .sort(byRelease),
    });
  }

  async getArchivedOffer(wsId: string, offerId: string): Promise<Offer | undefined> {
    const offer = this.partitions
      .get(wsId)
      ?.historyOffers.find((candidate) => candidate.id === offerId);
    return offer === undefined ? undefined : clone(offer);
  }

  async commit(args: CommitArgs): Promise<CommitResult> {
    if (this.beforeCommit !== undefined) {
      await this.beforeCommit(args);
    }
    const partition = this.partitions.get(args.wsId);
    if (partition === undefined) {
      throw new Error(`workshop ${args.wsId} does not exist`);
    }
    // Condition on the command record first: an already settled command is acked (C3) even
    // if the workshop moved on.
    if (args.commandResult !== undefined) {
      const existing = this.commandResults.get(args.commandResult.commandId);
      if (existing !== undefined && existing.status !== 'ACCEPTED') {
        return { ok: false, conflict: 'COMMAND_ALREADY_SETTLED' };
      }
    }
    // The META item is written iff there is at least one write (PUT_WORKSHOP_STATE is first).
    if (args.writes.length > 0 && partition.workshop.version !== args.expectedVersion) {
      return { ok: false, conflict: 'VERSION' };
    }
    for (const change of args.writes) {
      applyChange(partition, change);
    }
    for (const notification of args.notifications) {
      const list = this.notifications.get(notification.userId) ?? [];
      list.push(clone(notification));
      this.notifications.set(notification.userId, list);
    }
    if (args.commandResult !== undefined) {
      this.commandResults.set(args.commandResult.commandId, clone(args.commandResult));
    }
    this.commits += 1;
    return { ok: true };
  }

  /** Test helper: simulates a concurrent writer bumping the optimistic-lock version. */
  bumpVersion(wsId: string): void {
    const partition = this.partitions.get(wsId);
    if (partition === undefined) {
      throw new Error(`workshop ${wsId} does not exist`);
    }
    partition.workshop.version += 1;
  }

  /* ---------- command results ---------- */

  async putCommandAccepted(record: CommandResult): Promise<PutCommandAcceptedResult> {
    const existing = this.commandResults.get(record.commandId);
    if (existing !== undefined) {
      return { created: false, existing: clone(existing) };
    }
    this.commandResults.set(record.commandId, clone(record));
    return { created: true };
  }

  async deleteCommandIfAccepted(commandId: string): Promise<void> {
    const existing = this.commandResults.get(commandId);
    if (existing !== undefined && existing.status === 'ACCEPTED') {
      this.commandResults.delete(commandId);
    }
  }

  async getCommandResult(commandId: string): Promise<CommandResult | undefined> {
    const existing = this.commandResults.get(commandId);
    return existing === undefined ? undefined : clone(existing);
  }

  /* ---------- read models ---------- */

  async listRegistrationsForUser(userId: string): Promise<Registration[]> {
    const mine: Registration[] = [];
    for (const partition of this.partitions.values()) {
      for (const registration of partition.live.values()) {
        if (registration.userId === userId) {
          mine.push(clone(registration));
        }
      }
      for (const registration of partition.historyRegistrations) {
        if (registration.userId === userId) {
          mine.push(clone(registration));
        }
      }
    }
    return mine;
  }

  async listNotificationsForUser(userId: string): Promise<Notification[]> {
    return (this.notifications.get(userId) ?? []).map(clone);
  }

  async markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<Notification | undefined> {
    const notification = (this.notifications.get(userId) ?? []).find(
      (candidate) => candidate.id === notificationId,
    );
    if (notification === undefined) {
      return undefined;
    }
    if (notification.readAt === undefined) {
      notification.readAt = readAt;
    }
    return clone(notification);
  }

  async listBackfills(wsId: string): Promise<BackfillRecord[]> {
    const partition = this.partitions.get(wsId);
    return partition === undefined ? [] : [...partition.backfills.values()].map(clone);
  }

  async listHistory(wsId: string): Promise<WorkshopHistory> {
    const partition = this.partitions.get(wsId);
    if (partition === undefined) {
      return { registrations: [], offers: [] };
    }
    return clone({
      registrations: partition.historyRegistrations,
      offers: partition.historyOffers,
    });
  }

  async putAttendance(record: Attendance): Promise<void> {
    const partition = this.partitions.get(record.workshopId);
    if (partition === undefined) {
      throw new Error(`workshop ${record.workshopId} does not exist`);
    }
    partition.attendance.set(record.userId, clone(record));
  }

  async listAttendance(wsId: string): Promise<Attendance[]> {
    const partition = this.partitions.get(wsId);
    return partition === undefined ? [] : [...partition.attendance.values()].map(clone);
  }

  async listDueWorkshops(now: string): Promise<Workshop[]> {
    return [...this.partitions.values()]
      .map((partition) => partition.workshop)
      .filter(
        (workshop) => workshop.nextDueAt !== undefined && compareIso(workshop.nextDueAt, now) <= 0,
      )
      .map(clone);
  }

  /** Test helper: all stored notifications. */
  allNotifications(): Notification[] {
    return [...this.notifications.values()].flat().map(clone);
  }
}

function applyChange(partition: WorkshopPartition, change: Change): void {
  switch (change.kind) {
    case 'PUT_WORKSHOP_STATE': {
      const workshop = partition.workshop;
      workshop.status = change.status;
      workshop.seq = change.seq;
      workshop.version = change.version;
      workshop.updatedAt = change.updatedAt;
      if (change.nextDueAt === undefined) {
        delete workshop.nextDueAt;
      } else {
        workshop.nextDueAt = change.nextDueAt;
      }
      break;
    }
    case 'PUT_SESSION':
      partition.sessions.set(change.session.id, clone(change.session));
      break;
    case 'PUT_REGISTRATION':
      partition.live.set(change.registration.seq, clone(change.registration));
      break;
    case 'ARCHIVE_REGISTRATION':
      partition.live.delete(change.registration.seq);
      partition.historyRegistrations.push(clone(change.registration));
      break;
    case 'PUT_OFFER':
      partition.liveOffers.set(change.offer.id, clone(change.offer));
      break;
    case 'ARCHIVE_OFFER':
      partition.liveOffers.delete(change.offer.id);
      partition.historyOffers.push(clone(change.offer));
      break;
    case 'PUT_PENDING_BACKFILL':
      partition.backfills.set(change.record.id, clone(change.record));
      partition.pendingBackfillIds.add(change.record.id);
      break;
    case 'PUT_BACKFILL':
    case 'ARCHIVE_BACKFILL':
      partition.backfills.set(change.record.id, clone(change.record));
      partition.pendingBackfillIds.delete(change.record.id);
      break;
  }
}
