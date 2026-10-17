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
 * `WorkshopStore` on the single table of plan §2.3.
 *
 * - `loadSnapshot`: one consistent Query of the live prefix, paginated.
 * - `commit`: ONE `TransactWriteItems`. The META item gets a partial Update of the engine-owned
 *   fields only, conditioned on `version = expectedVersion`; the CommandResult is written on the
 *   condition that it is missing or still ACCEPTED; new history/offer/notification items use
 *   `attribute_not_exists`; conditions are never placed on items that are not written.
 *   `TransactionCanceledException` is mapped by `CancellationReasons[i].Code`: the CMD item →
 *   `COMMAND_ALREADY_SETTLED`, the META item → `VERSION`, anything else is thrown.
 * - Read models use GetItem/Query (GSI1 for the per-user and per-organisation lists).
 *
 * The R1 unique marker is keyed per registration scope, which depends on the workshop mode;
 * the mode is remembered from the last read of the workshop (the worker always loads the
 * snapshot before committing) and read from META otherwise.
 */
export class DynamoWorkshopStore implements WorkshopStore {
  private readonly modes = new Map<string, WorkshopMode>();

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

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
      const output = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: workshopKey(wsId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
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
    registrations.sort(bySeq);
    pendingBackfills.sort(byRelease);
    return { workshop, sessions, registrations, offers, pendingBackfills };
  }

  async getArchivedOffer(wsId: string, offerId: string): Promise<Offer | undefined> {
    const item = await this.getItem(historyOfferKey(wsId, offerId));
    return item === undefined ? undefined : toOffer(item);
  }

  async commit(args: CommitArgs): Promise<CommitResult> {
    const { items, metaIndex, commandIndex } = await this.buildTransaction(args);
    if (items.length === 0) {
      return { ok: true };
    }
    if (items.length > MAX_TRANSACTION_ITEMS) {
      throw new TransactionTooLargeError(args.wsId, items.length);
    }
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return { ok: true };
    } catch (error) {
      if (isTransactionCanceled(error)) {
        const reasons = cancellationReasons(error);
        if (conditionFailedAt(reasons, commandIndex)) {
          return { ok: false, conflict: 'COMMAND_ALREADY_SETTLED' };
        }
        if (conditionFailedAt(reasons, metaIndex)) {
          return { ok: false, conflict: 'VERSION' };
        }
      }
      throw error;
    }
  }

  /** Exposed for tests: the exact transaction a commit sends. */
  async buildTransaction(
    args: CommitArgs,
  ): Promise<{ items: TransactItem[]; metaIndex: number; commandIndex: number }> {
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
    const mode = needsMode ? await this.resolveMode(wsId) : undefined;
    const markers = new Map<string, TransactItem>();
    const markerKeyOf = (registration: Registration): ItemKey =>
      uniqueMarkerKey(wsId, registrationScopeKey(mode ?? 'UNIFIED', registration));

    for (const change of args.writes) {
      switch (change.kind) {
        case 'PUT_WORKSHOP_STATE':
          break;
        case 'PUT_SESSION':
          items.push(put(sessionItem(change.session)));
          break;
        case 'PUT_REGISTRATION': {
          items.push(put(liveRegistrationItem(change.registration)));
          const key = markerKeyOf(change.registration);
          markers.set(key.SK, put(uniqueMarkerItem(mode ?? 'UNIFIED', change.registration)));
          break;
        }
        case 'ARCHIVE_REGISTRATION': {
          items.push(del(liveRegistrationKey(wsId, change.registration.seq)));
          items.push(put(historyRegistrationItem(change.registration), NEW_ITEM));
          const key = markerKeyOf(change.registration);
          if (!markers.has(key.SK)) {
            markers.set(key.SK, del(key));
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
    items.push(...markers.values());

    // 4. Notifications: new items with entityType NOTIFICATION (the stream filter of the notifier).
    for (const notification of args.notifications) {
      items.push(put(notificationItem(notification), NEW_ITEM));
    }
    return { items, metaIndex, commandIndex };
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

  async putCommandAccepted(record: CommandResult): Promise<PutCommandAcceptedResult> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: commandResultItem(record),
          ConditionExpression: 'attribute_not_exists(PK)',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return { created: true };
    } catch (error) {
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
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: commandKey(commandId),
          ConditionExpression: '#status = :accepted',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':accepted': 'ACCEPTED' },
        }),
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
