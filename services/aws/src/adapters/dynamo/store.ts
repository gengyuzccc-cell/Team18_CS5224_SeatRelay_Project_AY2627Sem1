import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
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
import { byRelease, bySeq, compareIso, type Change, type WorkshopSnapshot } from '@seatrelay/core';
import type {
  CommitArgs,
  CommitResult,
  PutCommandAcceptedResult,
  WorkshopHistory,
  WorkshopInfoPatch,
  WorkshopStore,
} from '@seatrelay/service';
import {
  cancellationReasons,
  conditionFailedAt,
  conditionFailureItem,
  isConditionalCheckFailed,
  isTransactionCanceled,
  isTransactionConflict,
  isTransientCancellation,
} from './errors';
import {
  ATTENDANCE_PREFIX,
  DUE_GSI_PK,
  GSI1_NAME,
  GSI1_ORG_PREFIX,
  GSI1_WORKSHOP_PREFIX,
  HISTORY_BACKFILL_PREFIX,
  HISTORY_OFFER_PREFIX,
  HISTORY_REGISTRATION_PREFIX,
  LIVE_PREFIX,
  NOTIFICATION_PREFIX,
  PENDING_BACKFILL_PREFIX,
  SESSION_PREFIX,
  commandKey,
  dueGsiUpperBound,
  dueMarkerKey,
  historyOfferKey,
  liveOfferKey,
  liveRegistrationKey,
  notificationKey,
  orgKey,
  orgPk,
  pendingBackfillKey,
  uniqueMarkerKey,
  userPk,
  workshopKey,
  workshopPk,
  type ItemKey,
} from './keys';
import {
  attendanceItem,
  commandResultItem,
  dueMarkerItem,
  entityTypeOf,
  historyBackfillItem,
  historyOfferItem,
  historyRegistrationItem,
  liveOfferItem,
  liveRegistrationItem,
  notificationItem,
  orgMemberItem,
  organizationItem,
  pendingBackfillItem,
  sessionItem,
  toAttendance,
  toBackfillRecord,
  toCommandResult,
  toNotification,
  toOffer,
  toOrganization,
  toRegistration,
  toSession,
  toWorkshop,
  uniqueMarkerItem,
  workshopItem,
  type Item,
} from './mapping';
import { registrationScopeKey } from '@seatrelay/core';

/** DynamoDB's hard limit on `TransactWriteItems`. */
export const MAX_TRANSACTION_ITEMS = 100;
const BATCH_GET_LIMIT = 100;

/** In-process retries of a write rejected for a transient reason (plan §2.4). */
export const DEFAULT_TRANSIENT_RETRIES = 3;
/** First backoff step; attempt n waits `base * 2^n * (1 + random)` ms. */
export const TRANSIENT_BACKOFF_BASE_MS = 25;

export interface DynamoWorkshopStoreOptions {
  /**
   * Retries of a transaction cancelled only by transient reasons (`TransactionConflict`,
   * throttling) and of single-item writes rejected with `TransactionConflictException`.
   * Default 3.
   */
  transientRetries?: number;
  /** Backoff sleep (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export class TransactionTooLargeError extends Error {
  constructor(
    readonly wsId: string,
    readonly items: number,
  ) {
    super(
      `commit of workshop ${wsId} needs ${items} transaction items, more than the DynamoDB limit of ${MAX_TRANSACTION_ITEMS}; the engine must split the decision`,
    );
    this.name = 'TransactionTooLargeError';
  }
}

/**
 * The R1 uniqueness marker of a registration scope is held by another registration (plan §2.2:
 * the marker is written conditionally). The engine never produces this under the META lock, so
 * it means storage and engine disagree; the commit is not applied and the message is retried
 * and eventually dead-lettered (DLQ alarm) instead of silently breaking R1.
 */
export class UniqueMarkerConflictError extends Error {
  constructor(
    readonly wsId: string,
    readonly markerSk: string,
    cause: unknown,
  ) {
    super(`workshop ${wsId}: R1 unique marker ${markerSk} is held by another registration`, {
      cause,
    });
    this.name = 'UniqueMarkerConflictError';
  }
}

/** One R1 marker touched by a commit: the registration put on it and the seqs it replaces. */
interface MarkerWrite {
  key: ItemKey;
  put?: Registration;
  /** Seqs of registrations of the same scope archived in the same decision. */
  replacedSeqs: number[];
}

/**
 * `WorkshopStore` on the single table of plan §2.3.
 *
 * - `loadSnapshot`: one consistent Query of the live prefix, paginated.
 * - `commit`: ONE `TransactWriteItems`. The META item gets a partial Update of the engine-owned
 *   fields only, conditioned on `version = expectedVersion`; the CommandResult is written on the
 *   condition that it is missing or still ACCEPTED; new history/offer/notification items use
 *   `attribute_not_exists`; conditions are never placed on items that are not written.
 *   `TransactionCanceledException` is mapped by `CancellationReasons[i].Code`: the CMD item →
 *   `COMMAND_ALREADY_SETTLED`, the META item → `VERSION`, an R1 marker →
 *   `UniqueMarkerConflictError`; a cancellation for transient reasons only (`TransactionConflict`,
 *   throttling: nothing was written) is retried in-process with jittered backoff (plan §2.4);
 *   anything else is thrown.
 * - Single-item writes that collide with a transaction on the same item
 *   (`TransactionConflictException`, e.g. a duplicate POST racing the worker on the CMD item)
 *   are retried the same way. The SDK retries neither kind of conflict.
 * - Read models use GetItem/Query (GSI1 for the per-user and per-organisation lists).
 *
 * R1 unique marker (`L#U#{scope}`, plan §2.2): upserted with every registration write on the
 * condition that it is missing or held by the same registration (or by one of the same scope
 * archived in the same decision), deleted when the registration is archived. Its key depends on
 * the workshop mode and, in PER_SESSION, on the bound session. The engine archives a
 * PER_SESSION registration whose session was dropped (decline, expiry, cancelled session) with
 * `acceptable: []`, so the archived entity no longer names its scope: the scope of each live
 * registration is remembered from `loadSnapshot` (the worker always loads before committing)
 * and from the registration puts, and read from the live item otherwise. The mode is
 * remembered the same way and read from META on a miss.
 */
export class DynamoWorkshopStore implements WorkshopStore {
  private readonly modes = new Map<string, WorkshopMode>();
  /** wsId → seq → R1 scope of the live registration with that seq. */
  private readonly liveScopes = new Map<string, Map<number, string>>();
  private readonly transientRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    options: DynamoWorkshopStoreOptions = {},
  ) {
    this.transientRetries = Math.max(0, options.transientRetries ?? DEFAULT_TRANSIENT_RETRIES);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  private backoffMs(attempt: number): number {
    return Math.round(TRANSIENT_BACKOFF_BASE_MS * 2 ** attempt * (1 + this.random()));
  }

  /** Sends a single-item write, retrying while it collides with a transaction on that item. */
  private async sendRetryingConflicts<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (attempt >= this.transientRetries || !isTransactionConflict(error)) {
          throw error;
        }
        await this.sleep(this.backoffMs(attempt));
      }
    }
  }

  /* ---------- low-level helpers ---------- */

  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
    const items: Item[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          ...input,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      items.push(...((output.Items ?? []) as Item[]));
      exclusiveStartKey = output.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  private queryPartition(pk: string, skPrefix: string, consistent = false): Promise<Item[]> {
    return this.queryAll({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': pk, ':prefix': skPrefix },
      ConsistentRead: consistent,
    });
  }

  private async getItem(key: ItemKey, consistent = true): Promise<Item | undefined> {
    const output = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: key, ConsistentRead: consistent }),
    );
    return output.Item as Item | undefined;
  }

  /** BatchGetItem in chunks of 100, re-requesting unprocessed keys; result order is unspecified. */
  private async batchGet(keys: readonly ItemKey[], consistent = true): Promise<Item[]> {
    const items: Item[] = [];
    for (let start = 0; start < keys.length; start += BATCH_GET_LIMIT) {
      let pending: ItemKey[] = keys.slice(start, start + BATCH_GET_LIMIT);
      let rounds = 0;
      while (pending.length > 0) {
        const output = await this.doc.send(
          new BatchGetCommand({
            RequestItems: { [this.table]: { Keys: pending, ConsistentRead: consistent } },
          }),
        );
        items.push(...((output.Responses?.[this.table] ?? []) as Item[]));
        pending = (output.UnprocessedKeys?.[this.table]?.Keys ?? []) as ItemKey[];
        if (pending.length > 0 && ++rounds > 5) {
          throw new Error(`BatchGetItem left ${pending.length} keys unprocessed after 5 rounds`);
        }
      }
    }
    return items;
  }

  private rememberMode(workshop: Workshop): Workshop {
    this.modes.set(workshop.id, workshop.mode);
    return workshop;
  }

  private async resolveMode(wsId: string): Promise<WorkshopMode> {
    const cached = this.modes.get(wsId);
    if (cached !== undefined) {
      return cached;
    }
    const workshop = await this.getWorkshop(wsId);
    if (workshop === undefined) {
      throw new Error(`workshop ${wsId} does not exist`);
    }
    return workshop.mode;
  }

  private scopesOf(wsId: string): Map<number, string> {
    let scopes = this.liveScopes.get(wsId);
    if (scopes === undefined) {
      scopes = new Map();
      this.liveScopes.set(wsId, scopes);
    }
    return scopes;
  }

  /**
   * R1 scope the archived registration had while it was live, or undefined when it was never
   * stored live (then no marker was written for it). UNIFIED scopes are the userId. A
   * PER_SESSION registration keeps its single session until the engine drops it, which empties
   * `acceptable` right before archiving; the live scope is then taken from the cache filled by
   * `loadSnapshot` and registration puts, or from the live item itself.
   */
  private async liveScopeOf(
    wsId: string,
    mode: WorkshopMode,
    registration: Registration,
  ): Promise<string | undefined> {
    if (mode !== 'PER_SESSION' || registration.acceptable.length > 0) {
      return registrationScopeKey(mode, registration);
    }
    const cached = this.liveScopes.get(wsId)?.get(registration.seq);
    if (cached !== undefined) {
      return cached;
    }
    const item = await this.getItem(liveRegistrationKey(wsId, registration.seq));
    if (item === undefined) {
      return undefined;
    }
    const live = toRegistration(item);
    return live.acceptable.length > 0 ? registrationScopeKey(mode, live) : undefined;
  }

  /* ---------- organisations ---------- */

  async createOrganization(organization: Organization): Promise<void> {
    const members = new Set([organization.ownerUserId, ...organization.members]);
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: organizationItem(organization),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...[...members].map((userId) => ({
            Put: {
              TableName: this.table,
              Item: orgMemberItem(organization.id, userId, organization.createdAt),
            },
          })),
        ],
      }),
    );
  }

  async getOrganization(orgId: string): Promise<Organization | undefined> {
    const item = await this.getItem(orgKey(orgId));
    return item === undefined ? undefined : toOrganization(item);
  }

  async listOrganizationsForUser(userId: string): Promise<Organization[]> {
    const memberships = await this.queryAll({
      IndexName: GSI1_NAME,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'GSI1PK', '#sk': 'GSI1SK' },
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': GSI1_ORG_PREFIX },
    });
    const orgIds = [...new Set(memberships.map((item) => String(item.orgId)))];
    const items = await this.batchGet(orgIds.map(orgKey));
    return items
      .map(toOrganization)
      .filter((organization) => organization.members.includes(userId))
      .sort((a, b) => compareIso(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1));
  }

  async addMember(orgId: string, userId: string): Promise<Organization | undefined> {
    const organization = await this.getOrganization(orgId);
    if (organization === undefined) {
      return undefined;
    }
    if (organization.members.includes(userId)) {
      return organization;
    }
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: orgKey(orgId),
                UpdateExpression: 'SET #members = list_append(#members, :new)',
                ConditionExpression: 'attribute_exists(PK) AND NOT contains(#members, :userId)',
                ExpressionAttributeNames: { '#members': 'members' },
                ExpressionAttributeValues: { ':new': [userId], ':userId': userId },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: orgMemberItem(orgId, userId, new Date().toISOString()),
              },
            },
          ],
        }),
      );
    } catch (error) {
      // A concurrent add of the same member: idempotent, fall through to the re-read.
      if (!(isTransactionCanceled(error) && conditionFailedAt(cancellationReasons(error), 0))) {
        throw error;
      }
    }
    return this.getOrganization(orgId);
  }

  /* ---------- workshops ---------- */

  async createWorkshop(workshop: Workshop, sessions: readonly Session[]): Promise<void> {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: workshopItem(workshop),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...sessions.map((session) => ({
            Put: { TableName: this.table, Item: sessionItem(session) },
          })),
        ],
      }),
    );
    this.rememberMode(workshop);
  }

  async updateWorkshopInfo(wsId: string, patch: WorkshopInfoPatch): Promise<Workshop | undefined> {
    const sets = ['#updatedAt = :updatedAt'];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = { ':updatedAt': patch.updatedAt };
    if (patch.title !== undefined) {
      sets.push('#title = :title');
      names['#title'] = 'title';
      values[':title'] = patch.title;
    }
    if (patch.description !== undefined) {
      sets.push('#description = :description');
      names['#description'] = 'description';
      values[':description'] = patch.description;
    }
    try {
      const output = await this.sendRetryingConflicts(() =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: workshopKey(wsId),
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        ),
      );
      return this.rememberMode(toWorkshop(output.Attributes as Item));
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async listWorkshopsForOrg(orgId: string): Promise<Workshop[]> {
    const items = await this.queryAll({
      IndexName: GSI1_NAME,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'GSI1PK', '#sk': 'GSI1SK' },
      ExpressionAttributeValues: { ':pk': orgPk(orgId), ':prefix': GSI1_WORKSHOP_PREFIX },
    });
    return items
      .filter((item) => entityTypeOf(item) === 'WORKSHOP')
      .map((item) => this.rememberMode(toWorkshop(item)))
      .sort((a, b) => compareIso(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1));
  }

  async getWorkshop(wsId: string): Promise<Workshop | undefined> {
    const item = await this.getItem(workshopKey(wsId));
    return item === undefined ? undefined : this.rememberMode(toWorkshop(item));
  }

  async listSessions(wsId: string): Promise<Session[]> {
    const items = await this.queryPartition(workshopPk(wsId), SESSION_PREFIX, true);
    return items.map(toSession);
  }

  /* ---------- worker ---------- */

  async loadSnapshot(wsId: string): Promise<WorkshopSnapshot | undefined> {
    const items = await this.queryPartition(workshopPk(wsId), LIVE_PREFIX, true);
    let workshop: Workshop | undefined;
    const sessions: Session[] = [];
    const registrations: Registration[] = [];
    const offers: Offer[] = [];
    const pendingBackfills: BackfillRecord[] = [];
    for (const item of items) {
      switch (entityTypeOf(item)) {
        case 'WORKSHOP':
          workshop = toWorkshop(item);
          break;
        case 'SESSION':
          sessions.push(toSession(item));
          break;
        case 'REGISTRATION':
          registrations.push(toRegistration(item));
          break;
        case 'OFFER':
          offers.push(toOffer(item));
          break;
        case 'BACKFILL':
          pendingBackfills.push(toBackfillRecord(item));
          break;
        default:
          break; // UNIQUE_MARKER, DUE_MARKER: adapter-internal items
      }
    }
    if (workshop === undefined) {
      return undefined;
    }
    this.rememberMode(workshop);
    const mode = workshop.mode;
    this.liveScopes.set(
      wsId,
      new Map(
        registrations.map((registration) => [
          registration.seq,
          registrationScopeKey(mode, registration),
        ]),
      ),
    );
    registrations.sort(bySeq);
    pendingBackfills.sort(byRelease);
    return { workshop, sessions, registrations, offers, pendingBackfills };
  }

  async getArchivedOffer(wsId: string, offerId: string): Promise<Offer | undefined> {
    const item = await this.getItem(historyOfferKey(wsId, offerId));
    return item === undefined ? undefined : toOffer(item);
  }

  async commit(args: CommitArgs): Promise<CommitResult> {
    const { items, metaIndex, commandIndex, markerIndexes } = await this.buildTransaction(args);
    if (items.length === 0) {
      return { ok: true };
    }
    if (items.length > MAX_TRANSACTION_ITEMS) {
      throw new TransactionTooLargeError(args.wsId, items.length);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
        return { ok: true };
      } catch (error) {
        if (!isTransactionCanceled(error)) {
          throw error;
        }
        const reasons = cancellationReasons(error);
        if (conditionFailedAt(reasons, commandIndex)) {
          return { ok: false, conflict: 'COMMAND_ALREADY_SETTLED' };
        }
        if (conditionFailedAt(reasons, metaIndex)) {
          return { ok: false, conflict: 'VERSION' };
        }
        const marker = markerIndexes.find((index) => conditionFailedAt(reasons, index));
        if (marker !== undefined) {
          throw new UniqueMarkerConflictError(
            args.wsId,
            String(items[marker]?.Put?.Item?.SK),
            error,
          );
        }
        // Nothing was written: the identical transaction may be sent again.
        if (attempt < this.transientRetries && isTransientCancellation(reasons)) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw error;
      }
    }
  }

  /** Exposed for tests: the exact transaction a commit sends. */
  async buildTransaction(args: CommitArgs): Promise<{
    items: TransactItem[];
    metaIndex: number;
    commandIndex: number;
    /** Indexes of the conditional R1 marker puts. */
    markerIndexes: number[];
  }> {
    const { wsId } = args;
    const items: TransactItem[] = [];
    let metaIndex = -1;
    let commandIndex = -1;
    const put = (item: Item, condition?: string): TransactItem => ({
      Put: {
        TableName: this.table,
        Item: item,
        ...(condition === undefined ? {} : { ConditionExpression: condition }),
      },
    });
    const del = (key: ItemKey): TransactItem => ({ Delete: { TableName: this.table, Key: key } });
    const NEW_ITEM = 'attribute_not_exists(PK)';

    // 1. META: partial update of the engine-owned fields, optimistic lock on version.
    const workshopState = args.writes.find((change) => change.kind === 'PUT_WORKSHOP_STATE');
    if (workshopState !== undefined) {
      metaIndex = items.length;
      items.push(this.workshopStateUpdate(workshopState, args.expectedVersion));
      items.push(
        workshopState.nextDueAt === undefined
          ? del(dueMarkerKey(wsId))
          : put(dueMarkerItem(wsId, workshopState.nextDueAt)),
      );
    }

    // 2. CommandResult: settles the command unless it was settled already (C3).
    if (args.commandResult !== undefined) {
      commandIndex = items.length;
      items.push(this.commandResultUpdate(args.commandResult));
    }

    // 3. Entity changes. Unique markers are coalesced per key: a registration archived and a
    //    new one of the same scope put in the same decision touch one marker, and a transaction
    //    may touch an item only once, so the Put (the live state) wins over the Delete.
    const needsMode = args.writes.some(
      (change) => change.kind === 'PUT_REGISTRATION' || change.kind === 'ARCHIVE_REGISTRATION',
    );
    const mode = needsMode ? await this.resolveMode(wsId) : 'UNIFIED';
    const markers = new Map<string, MarkerWrite>();
    const markerAt = (scope: string): MarkerWrite => {
      const key = uniqueMarkerKey(wsId, scope);
      let marker = markers.get(key.SK);
      if (marker === undefined) {
        marker = { key, replacedSeqs: [] };
        markers.set(key.SK, marker);
      }
      return marker;
    };

    for (const change of args.writes) {
      switch (change.kind) {
        case 'PUT_WORKSHOP_STATE':
          break;
        case 'PUT_SESSION':
          items.push(put(sessionItem(change.session)));
          break;
        case 'PUT_REGISTRATION': {
          items.push(put(liveRegistrationItem(change.registration)));
          const scope = registrationScopeKey(mode, change.registration);
          this.scopesOf(wsId).set(change.registration.seq, scope);
          markerAt(scope).put = change.registration;
          break;
        }
        case 'ARCHIVE_REGISTRATION': {
          items.push(del(liveRegistrationKey(wsId, change.registration.seq)));
          items.push(put(historyRegistrationItem(change.registration), NEW_ITEM));
          const scope = await this.liveScopeOf(wsId, mode, change.registration);
          if (scope !== undefined) {
            markerAt(scope).replacedSeqs.push(change.registration.seq);
          }
          break;
        }
        case 'PUT_OFFER':
          items.push(put(liveOfferItem(change.offer), NEW_ITEM));
          break;
        case 'ARCHIVE_OFFER':
          items.push(del(liveOfferKey(wsId, change.offer.id)));
          items.push(put(historyOfferItem(change.offer), NEW_ITEM));
          break;
        case 'PUT_BACKFILL':
          items.push(put(historyBackfillItem(change.record), NEW_ITEM));
          break;
        case 'PUT_PENDING_BACKFILL':
          items.push(put(pendingBackfillItem(change.record)));
          break;
        case 'ARCHIVE_BACKFILL':
          items.push(del(pendingBackfillKey(wsId, change.record.releasedAt, change.record.id)));
          items.push(put(historyBackfillItem(change.record), NEW_ITEM));
          break;
      }
    }
    const markerIndexes: number[] = [];
    for (const marker of markers.values()) {
      if (marker.put === undefined) {
        items.push(del(marker.key));
      } else {
        markerIndexes.push(items.length);
        items.push(this.uniqueMarkerPut(mode, marker.put, marker.replacedSeqs));
      }
    }

    // 4. Notifications: new items with entityType NOTIFICATION (the stream filter of the notifier).
    for (const notification of args.notifications) {
      items.push(put(notificationItem(notification), NEW_ITEM));
    }
    return { items, metaIndex, commandIndex, markerIndexes };
  }

  /**
   * R1 (plan §2.2): the marker is created, or updated by the registration that holds it (same
   * seq), or taken over from a registration of the same scope archived in this very decision.
   * Any other holder is a uniqueness violation and fails the transaction.
   */
  private uniqueMarkerPut(
    mode: WorkshopMode,
    registration: Registration,
    replacedSeqs: readonly number[],
  ): TransactItem {
    const seqs = [registration.seq, ...replacedSeqs.filter((seq) => seq !== registration.seq)];
    const values: Record<string, unknown> = {};
    seqs.forEach((seq, index) => {
      values[`:seq${index}`] = seq;
    });
    const allowed =
      seqs.length === 1 ? '#seq = :seq0' : `#seq IN (${Object.keys(values).join(', ')})`;
    return {
      Put: {
        TableName: this.table,
        Item: uniqueMarkerItem(mode, registration),
        ConditionExpression: `attribute_not_exists(PK) OR ${allowed}`,
        ExpressionAttributeNames: { '#seq': 'seq' },
        ExpressionAttributeValues: values,
      },
    };
  }

  private workshopStateUpdate(
    change: Extract<Change, { kind: 'PUT_WORKSHOP_STATE' }>,
    expectedVersion: number,
  ): TransactItem {
    const names: Record<string, string> = {
      '#status': 'status',
      '#seq': 'seq',
      '#version': 'version',
      '#updatedAt': 'updatedAt',
      '#nextDueAt': 'nextDueAt',
    };
    const values: Record<string, unknown> = {
      ':status': change.status,
      ':seq': change.seq,
      ':version': change.version,
      ':updatedAt': change.updatedAt,
      ':expectedVersion': expectedVersion,
    };
    let expression =
      'SET #status = :status, #seq = :seq, #version = :version, #updatedAt = :updatedAt';
    if (change.nextDueAt === undefined) {
      expression += ' REMOVE #nextDueAt';
    } else {
      expression += ', #nextDueAt = :nextDueAt';
      values[':nextDueAt'] = change.nextDueAt;
    }
    return {
      Update: {
        TableName: this.table,
        Key: workshopKey(change.workshopId),
        UpdateExpression: expression,
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    };
  }

  private commandResultUpdate(record: CommandResult): TransactItem {
    const names: Record<string, string> = { '#pk': 'PK', '#status': 'status' };
    const values: Record<string, unknown> = { ':accepted': 'ACCEPTED' };
    const sets: string[] = [];
    const { commandId: _commandId, ...fields } = commandResultItem(record);
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'PK' || field === 'SK' || value === undefined) {
        continue;
      }
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }
    names['#commandId'] = 'commandId';
    values[':commandId'] = record.commandId;
    sets.push('#commandId = :commandId');
    return {
      Update: {
        TableName: this.table,
        Key: commandKey(record.commandId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_not_exists(#pk) OR #status = :accepted',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    };
  }

  /* ---------- command results ---------- */

  /**
   * A duplicate POST can race the worker's transaction on the same CMD item; DynamoDB then
   * rejects the put with `TransactionConflictException`, which is retried with backoff. If the
   * conflict persists, a consistent read returns the record the transaction wrote.
   */
  async putCommandAccepted(record: CommandResult): Promise<PutCommandAcceptedResult> {
    try {
      await this.sendRetryingConflicts(() =>
        this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: commandResultItem(record),
            ConditionExpression: 'attribute_not_exists(PK)',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        ),
      );
      return { created: true };
    } catch (error) {
      if (isTransactionConflict(error)) {
        const existing = await this.getCommandResult(record.commandId);
        if (existing === undefined) {
          throw error;
        }
        return { created: false, existing };
      }
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
      const item = conditionFailureItem(error);
      if (item !== undefined) {
        return { created: false, existing: toCommandResult(item) };
      }
      // Older SDK/endpoint without the returned item: one consistent read.
      const existing = await this.getCommandResult(record.commandId);
      if (existing === undefined) {
        throw error;
      }
      return { created: false, existing };
    }
  }

  async deleteCommandIfAccepted(commandId: string): Promise<void> {
    try {
      await this.sendRetryingConflicts(() =>
        this.doc.send(
          new DeleteCommand({
            TableName: this.table,
            Key: commandKey(commandId),
            ConditionExpression: '#status = :accepted',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':accepted': 'ACCEPTED' },
          }),
        ),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
    }
  }

  async getCommandResult(commandId: string): Promise<CommandResult | undefined> {
    const item = await this.getItem(commandKey(commandId));
    return item === undefined ? undefined : toCommandResult(item);
  }

  /* ---------- read models ---------- */

  async listRegistrationsForUser(userId: string): Promise<Registration[]> {
    const items = await this.queryAll({
      IndexName: GSI1_NAME,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'GSI1PK', '#sk': 'GSI1SK' },
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': GSI1_WORKSHOP_PREFIX },
    });
    return items.filter((item) => entityTypeOf(item) === 'REGISTRATION').map(toRegistration);
  }

  async listNotificationsForUser(userId: string): Promise<Notification[]> {
    const items = await this.queryAll({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': NOTIFICATION_PREFIX },
      ScanIndexForward: false,
    });
    return items.map(toNotification);
  }

  async markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<Notification | undefined> {
    const matches = await this.queryAll({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      FilterExpression: '#id = :id',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK', '#id': 'id' },
      ExpressionAttributeValues: {
        ':pk': userPk(userId),
        ':prefix': NOTIFICATION_PREFIX,
        ':id': notificationId,
      },
    });
    const found = matches[0];
    if (found === undefined) {
      return undefined;
    }
    const notification = toNotification(found);
    if (notification.readAt !== undefined) {
      return notification;
    }
    try {
      const output = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: notificationKey(userId, notification.createdAt, notification.id),
          UpdateExpression: 'SET #readAt = if_not_exists(#readAt, :readAt)',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#readAt': 'readAt' },
          ExpressionAttributeValues: { ':readAt': readAt },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toNotification(output.Attributes as Item);
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return undefined; // expired (TTL) between the query and the update
      }
      throw error;
    }
  }

  async listBackfills(wsId: string): Promise<BackfillRecord[]> {
    const [history, pending] = await Promise.all([
      this.queryPartition(workshopPk(wsId), HISTORY_BACKFILL_PREFIX),
      this.queryPartition(workshopPk(wsId), PENDING_BACKFILL_PREFIX, true),
    ]);
    return [...history, ...pending].map(toBackfillRecord).sort(byRelease);
  }

  async listHistory(wsId: string): Promise<WorkshopHistory> {
    const [registrations, offers] = await Promise.all([
      this.queryPartition(workshopPk(wsId), HISTORY_REGISTRATION_PREFIX),
      this.queryPartition(workshopPk(wsId), HISTORY_OFFER_PREFIX),
    ]);
    return { registrations: registrations.map(toRegistration), offers: offers.map(toOffer) };
  }

  async putAttendance(record: Attendance): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: attendanceItem(record) }));
  }

  async listAttendance(wsId: string): Promise<Attendance[]> {
    const items = await this.queryPartition(workshopPk(wsId), ATTENDANCE_PREFIX);
    return items.map(toAttendance);
  }

  async listDueWorkshops(now: string): Promise<Workshop[]> {
    const markers = await this.queryAll({
      IndexName: GSI1_NAME,
      KeyConditionExpression: '#pk = :due AND #sk <= :max',
      ExpressionAttributeNames: { '#pk': 'GSI1PK', '#sk': 'GSI1SK' },
      ExpressionAttributeValues: { ':due': DUE_GSI_PK, ':max': dueGsiUpperBound(now) },
    });
    const wsIds = [...new Set(markers.map((marker) => String(marker.workshopId)))];
    if (wsIds.length === 0) {
      return [];
    }
    // The index is eventually consistent: confirm against the consistent META read.
    const items = await this.batchGet(wsIds.map(workshopKey));
    return items
      .map((item) => this.rememberMode(toWorkshop(item)))
      .filter(
        (workshop) => workshop.nextDueAt !== undefined && compareIso(workshop.nextDueAt, now) <= 0,
      )
      .sort((a, b) => compareIso(a.nextDueAt ?? now, b.nextDueAt ?? now) || (a.id < b.id ? -1 : 1));
  }
}
