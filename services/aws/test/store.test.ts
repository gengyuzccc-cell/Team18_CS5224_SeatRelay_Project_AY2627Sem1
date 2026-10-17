import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
  type CancellationReason,
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { UserCommand } from '@seatrelay/contracts';
import {
  addSeconds,
  decide,
  estimateCommitItems,
  type Change,
  type WorkshopSnapshot,
} from '@seatrelay/core';
import { materializeNotification, type CommitArgs } from '@seatrelay/service';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  commandResultItem,
  dueMarkerItem,
  historyOfferItem,
  liveOfferItem,
  liveRegistrationItem,
  notificationItem,
  organizationItem,
  orgMemberItem,
  pendingBackfillItem,
  sessionItem,
  uniqueMarkerItem,
  workshopItem,
  type Item,
} from '../src/adapters/dynamo/mapping';
import {
  DEFAULT_TRANSIENT_RETRIES,
  DynamoWorkshopStore,
  MAX_TRANSACTION_ITEMS,
  TransactionTooLargeError,
  UniqueMarkerConflictError,
} from '../src/adapters/dynamo/store';
import {
  CMD_ID,
  T0,
  WS,
  backfill,
  commandResult,
  notification,
  offer,
  organization,
  registration,
  session1,
  session2,
  workshop,
} from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
const TABLE = 'seatrelay-test';
const T1 = addSeconds(T0, 90);

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Backoff sleeps requested by the store under test (never actually waited for). */
let sleeps: number[] = [];

function newStore(): DynamoWorkshopStore {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-southeast-1' }));
  return new DynamoWorkshopStore(doc, TABLE, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
}

const MARKER_CONDITION = 'attribute_not_exists(PK) OR #seq = :seq0';

function sentTransaction(): TransactItem[] {
  const calls = ddb.commandCalls(TransactWriteCommand);
  expect(calls).toHaveLength(1);
  return calls[0]!.args[0].input.TransactItems ?? [];
}

function opOf(item: TransactItem): 'Put' | 'Update' | 'Delete' | 'ConditionCheck' {
  if (item.Put !== undefined) return 'Put';
  if (item.Update !== undefined) return 'Update';
  if (item.Delete !== undefined) return 'Delete';
  return 'ConditionCheck';
}

function skOf(item: TransactItem): string {
  const target =
    item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key ?? item.ConditionCheck?.Key ?? {};
  return String(target.SK);
}

function conditionOf(item: TransactItem): string | undefined {
  return (
    item.Put?.ConditionExpression ??
    item.Update?.ConditionExpression ??
    item.Delete?.ConditionExpression ??
    item.ConditionCheck?.ConditionExpression
  );
}

/** `op SK [condition]` per item: a compact, order-preserving description of a transaction. */
function describeTransaction(items: readonly TransactItem[]): string[] {
  return items.map((item) => {
    const condition = conditionOf(item);
    return `${opOf(item)} ${skOf(item)}${condition === undefined ? '' : ` [${condition}]`}`;
  });
}

/** The worker always loads the snapshot before committing: that read caches the workshop mode. */
async function primedStore(): Promise<DynamoWorkshopStore> {
  ddb.on(QueryCommand).resolvesOnce({
    Items: [workshopItem(workshop), sessionItem(session1), sessionItem(session2)],
  });
  const store = newStore();
  await store.loadSnapshot(WS);
  return store;
}

function freshSnapshot(): WorkshopSnapshot {
  return {
    workshop: structuredClone(workshop),
    sessions: [structuredClone(session1), structuredClone(session2)],
    registrations: [],
    offers: [],
    pendingBackfills: [],
  };
}

/** A real engine decision: Bob registers on an empty workshop and is offered a seat at once. */
function registerDecision() {
  const command: UserCommand = {
    type: 'REGISTER',
    commandId: CMD_ID,
    workshopId: WS,
    actorUserId: 'bob',
    actorEmail: 'bob@example.com',
    actorDisplayName: 'Bob',
    acceptable: ['s1', 's2'],
  };
  let counter = 0;
  const decision = decide(freshSnapshot(), command, { now: T0, newId: () => `id-${++counter}` });
  const notifications = decision.notifications.map((draft, index) =>
    materializeNotification(draft, `n-${index + 1}`, T0),
  );
  const args: CommitArgs = {
    wsId: WS,
    expectedVersion: 0,
    writes: decision.writes,
    notifications,
    commandResult: commandResult({
      status: 'APPLIED',
      settledAt: T0,
      result: decision.resultForCommand,
    }),
  };
  return { decision, args };
}

beforeEach(() => {
  ddb.reset();
  sleeps = [];
});

describe('commit: one TransactWriteItems per decision', () => {
  test('a REGISTER decision becomes META update + DUE marker + CMD + entity puts + notification', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const store = await primedStore();
    const { decision, args } = registerDecision();
    expect(decision.status).toBe('APPLIED');
    expect(decision.writes.map((change) => change.kind)).toEqual([
      'PUT_WORKSHOP_STATE',
      'PUT_SESSION',
      'PUT_REGISTRATION',
      'PUT_OFFER',
    ]);

    await expect(store.commit(args)).resolves.toEqual({ ok: true });

    const items = sentTransaction();
    const expiresAt = addSeconds(T0, 60);
    expect(describeTransaction(items)).toEqual([
      'Update L#META [#version = :expectedVersion]',
      'Put L#DUE',
      'Update META [attribute_not_exists(#pk) OR #status = :accepted]',
      'Put L#S#s1',
      'Put L#R#00000001',
      'Put L#O#id-1 [attribute_not_exists(PK)]',
      `Put L#U#bob [${MARKER_CONDITION}]`,
      `Put N#${T0}#n-1 [attribute_not_exists(PK)]`,
    ]);
    // Every item has the table name and the DUE marker carries the sparse index key.
    for (const item of items) {
      const target = item.Put ?? item.Update ?? item.Delete;
      expect(target?.TableName).toBe(TABLE);
    }
    expect(items[1]?.Put?.Item).toEqual(dueMarkerItem(WS, expiresAt));
    expect(items[3]?.Put?.Item).toMatchObject({ entityType: 'SESSION', id: 's1', held: 1 });
    expect(items[4]?.Put?.Item).toMatchObject({
      entityType: 'REGISTRATION',
      seq: 1,
      status: 'OFFERED',
      currentOfferId: 'id-1',
      GSI1PK: 'U#bob',
      GSI1SK: `WS#${WS}`,
    });
    expect(items[6]?.Put?.Item).toMatchObject({
      entityType: 'UNIQUE_MARKER',
      scope: 'bob',
      seq: 1,
      status: 'OFFERED',
    });
    // R1 (plan §2.2): the marker is written conditionally, created or held by the same seq.
    expect(items[6]?.Put?.ExpressionAttributeNames).toEqual({ '#seq': 'seq' });
    expect(items[6]?.Put?.ExpressionAttributeValues).toEqual({ ':seq0': 1 });
    expect(items[7]?.Put?.Item).toMatchObject({
      entityType: 'NOTIFICATION',
      kind: 'OFFER',
      status: 'PENDING',
      PK: 'U#bob',
    });
    // The adapter writes exactly the engine's estimate plus the DUE marker.
    expect(items).toHaveLength(estimateCommitItems(decision) + 1);
    // No extra read: the mode came from the snapshot load.
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  test('META update touches only engine-owned fields and is conditioned on the snapshot version', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const store = await primedStore();
    const { args } = registerDecision();
    await store.commit({ ...args, expectedVersion: 7 });

    const meta = sentTransaction()[0]?.Update;
    expect(meta?.Key).toEqual({ PK: `WS#${WS}`, SK: 'L#META' });
    expect(meta?.UpdateExpression).toBe(
      'SET #status = :status, #seq = :seq, #version = :version, #updatedAt = :updatedAt, #nextDueAt = :nextDueAt',
    );
    expect(meta?.ConditionExpression).toBe('#version = :expectedVersion');
    expect(meta?.ExpressionAttributeNames).toEqual({
      '#status': 'status',
      '#seq': 'seq',
      '#version': 'version',
      '#updatedAt': 'updatedAt',
      '#nextDueAt': 'nextDueAt',
    });
    expect(meta?.ExpressionAttributeValues).toEqual({
      ':status': 'OPEN',
      ':seq': 1,
      ':version': 1,
      ':updatedAt': T0,
      ':nextDueAt': addSeconds(T0, 60),
      ':expectedVersion': 7,
    });
    const names = Object.values(meta?.ExpressionAttributeNames ?? {});
    expect(names).not.toContain('title');
    expect(names).not.toContain('description');
    expect(names).not.toContain('holdSeconds');
  });

  test('the CommandResult is settled with a status = ACCEPTED (or missing) condition', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const store = await primedStore();
    const { args } = registerDecision();
    await store.commit(args);

    const cmd = sentTransaction()[2]?.Update;
    expect(cmd?.Key).toEqual({ PK: `CMD#${CMD_ID}`, SK: 'META' });
    expect(cmd?.ConditionExpression).toBe('attribute_not_exists(#pk) OR #status = :accepted');
    expect(cmd?.ExpressionAttributeValues).toMatchObject({
      ':accepted': 'ACCEPTED',
      ':status': 'APPLIED',
      ':settledAt': T0,
      ':commandId': CMD_ID,
      ':entityType': 'COMMAND',
      ':result': { offersCreated: 1, registration: expect.objectContaining({ status: 'OFFERED' }) },
    });
    expect(cmd?.UpdateExpression?.startsWith('SET ')).toBe(true);
    expect(cmd?.UpdateExpression).toContain('#commandId = :commandId');
  });

  test('ARCHIVE_* = Delete live + Put history; pending backfills and markers; no DUE marker without nextDueAt', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    ddb.on(GetCommand).resolves({ Item: workshopItem(workshop) }); // mode lookup (UNIFIED)
    const store = newStore();
    const archived = registration({ status: 'CANCELLED', updatedAt: T1 });
    const declined = offer({ status: 'DECLINED', settledAt: T1 });
    const relayed = backfill({
      id: 'bf-old',
      reallocatedAt: T1,
      newOfferId: 'o9',
      newUserId: 'carol',
      latencyMs: 90_000,
    });
    const writes: Change[] = [
      {
        kind: 'PUT_WORKSHOP_STATE',
        workshopId: WS,
        status: 'OPEN',
        seq: 1,
        version: 4,
        updatedAt: T1,
      },
      { kind: 'PUT_SESSION', session: { ...session1, held: 0 } },
      { kind: 'ARCHIVE_REGISTRATION', registration: archived },
      { kind: 'ARCHIVE_OFFER', offer: declined },
      { kind: 'PUT_BACKFILL', record: backfill({ id: 'bf-final' }) },
      { kind: 'PUT_PENDING_BACKFILL', record: backfill({ id: 'bf-pending', releasedAt: T1 }) },
      { kind: 'ARCHIVE_BACKFILL', record: relayed },
    ];
    await expect(
      store.commit({ wsId: WS, expectedVersion: 3, writes, notifications: [] }),
    ).resolves.toEqual({ ok: true });

    const items = sentTransaction();
    expect(describeTransaction(items)).toEqual([
      'Update L#META [#version = :expectedVersion]',
      'Delete L#DUE',
      'Put L#S#s1',
      'Delete L#R#00000001',
      'Put H#R#00000001 [attribute_not_exists(PK)]',
      'Delete L#O#offer-1',
      'Put H#O#offer-1 [attribute_not_exists(PK)]',
      `Put H#BF#${T0}#bf-final [attribute_not_exists(PK)]`,
      `Put L#BF#${T1}#bf-pending`,
      `Delete L#BF#${T0}#bf-old`,
      `Put H#BF#${T0}#bf-old [attribute_not_exists(PK)]`,
      'Delete L#U#bob',
    ]);
    const meta = items[0]?.Update;
    expect(meta?.UpdateExpression).toBe(
      'SET #status = :status, #seq = :seq, #version = :version, #updatedAt = :updatedAt REMOVE #nextDueAt',
    );
    expect(meta?.ExpressionAttributeValues).not.toHaveProperty(':nextDueAt');
    expect(items[4]?.Put?.Item).toEqual({
      ...liveRegistrationItem(archived),
      SK: 'H#R#00000001',
    });
    expect(items[6]?.Put?.Item).toEqual(historyOfferItem(declined));
    expect(items[10]?.Put?.Item).toMatchObject({
      reallocatedAt: T1,
      newOfferId: 'o9',
      latencyMs: 90_000,
    });
    // Conditions only on written items, never a ConditionCheck on an untouched one.
    expect(items.every((item) => opOf(item) !== 'ConditionCheck')).toBe(true);
    for (const item of items) {
      const condition = conditionOf(item);
      if (condition !== undefined) {
        expect(opOf(item)).not.toBe('Delete');
      }
    }
  });

  test('PER_SESSION mode keys the R1 marker per user and session; the mode is read from META once', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    ddb.on(GetCommand).resolves({ Item: workshopItem({ ...workshop, mode: 'PER_SESSION' }) });
    const store = newStore();
    const mine = registration({ acceptable: ['s2'] });
    const other = registration({ seq: 2, acceptable: ['s1'], status: 'CANCELLED' });
    const writes: Change[] = [
      {
        kind: 'PUT_WORKSHOP_STATE',
        workshopId: WS,
        status: 'OPEN',
        seq: 2,
        version: 1,
        updatedAt: T0,
      },
      { kind: 'PUT_REGISTRATION', registration: mine },
      { kind: 'ARCHIVE_REGISTRATION', registration: other },
    ];
    await store.commit({ wsId: WS, expectedVersion: 0, writes, notifications: [] });
    expect(describeTransaction(sentTransaction())).toEqual([
      'Update L#META [#version = :expectedVersion]',
      'Delete L#DUE',
      'Put L#R#00000001',
      'Delete L#R#00000002',
      'Put H#R#00000002 [attribute_not_exists(PK)]',
      `Put L#U#bob#s2 [${MARKER_CONDITION}]`,
      'Delete L#U#bob#s1',
    ]);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(1);

    // Second commit: the mode is cached, no META read.
    ddb.reset();
    ddb.on(TransactWriteCommand).resolves({});
    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: [{ kind: 'PUT_REGISTRATION', registration: mine }],
      notifications: [],
    });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    expect(sentTransaction().map(skOf)).toEqual(['L#R#00000001', 'L#U#bob#s2']);
  });

  test('a rejection with no writes only settles the command (no version condition)', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    const rejected = commandResult({
      status: 'REJECTED',
      reason: 'ALREADY_REGISTERED',
      settledAt: T0,
    });
    await expect(
      store.commit({
        wsId: WS,
        expectedVersion: 5,
        writes: [],
        notifications: [],
        commandResult: rejected,
      }),
    ).resolves.toEqual({ ok: true });
    const items = sentTransaction();
    expect(describeTransaction(items)).toEqual([
      'Update META [attribute_not_exists(#pk) OR #status = :accepted]',
    ]);
    expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':status': 'REJECTED',
      ':reason': 'ALREADY_REGISTERED',
    });
  });

  test('nothing to write and no command result: no request at all', async () => {
    const store = newStore();
    await expect(
      store.commit({ wsId: WS, expectedVersion: 5, writes: [], notifications: [] }),
    ).resolves.toEqual({ ok: true });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  test('a decision that would exceed 100 items is refused before any request', async () => {
    const store = newStore();
    const notifications = Array.from({ length: MAX_TRANSACTION_ITEMS - 1 }, (_, index) =>
      notification({ id: `n-${index}` }),
    );
    const writes: Change[] = [
      {
        kind: 'PUT_WORKSHOP_STATE',
        workshopId: WS,
        status: 'OPEN',
        seq: 1,
        version: 1,
        updatedAt: T0,
      },
    ];
    await expect(
      store.commit({ wsId: WS, expectedVersion: 0, writes, notifications }),
    ).rejects.toBeInstanceOf(TransactionTooLargeError);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('commit: R1 unique marker (plan §2.2)', () => {
  const perSession = { ...workshop, mode: 'PER_SESSION' as const };

  /** A PER_SESSION workshop whose snapshot holds Bob's registration bound to s1, offered. */
  function perSessionSnapshot(): WorkshopSnapshot {
    const held = { ...structuredClone(session1), held: 1 };
    return {
      workshop: { ...structuredClone(perSession), seq: 1, version: 1 },
      sessions: [held, structuredClone(session2)],
      registrations: [
        registration({ acceptable: ['s1'], status: 'OFFERED', currentOfferId: 'offer-1' }),
      ],
      offers: [offer()],
      pendingBackfills: [],
    };
  }

  function itemsOf(snapshot: WorkshopSnapshot): Item[] {
    return [
      workshopItem(snapshot.workshop),
      ...snapshot.sessions.map(sessionItem),
      ...snapshot.registrations.map(liveRegistrationItem),
      ...snapshot.registrations.map((r) => uniqueMarkerItem(snapshot.workshop.mode, r)),
      ...snapshot.offers.map(liveOfferItem),
    ];
  }

  function markerOps(items: readonly TransactItem[]): string[] {
    return describeTransaction(items).filter((line) => line.includes(' L#U#'));
  }

  test('PER_SESSION decline: the engine archives the registration with acceptable [] and the marker of its bound session is deleted', async () => {
    ddb.on(QueryCommand).resolvesOnce({ Items: itemsOf(perSessionSnapshot()) });
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    const snapshot = await store.loadSnapshot(WS);
    const command: UserCommand = {
      type: 'DECLINE_OFFER',
      commandId: CMD_ID,
      workshopId: WS,
      actorUserId: 'bob',
      actorEmail: 'bob@example.com',
      offerId: 'offer-1',
    };
    const decision = decide(snapshot!, command, { now: T0, newId: () => 'x' });
    const archived = decision.writes.find((change) => change.kind === 'ARCHIVE_REGISTRATION');
    // The precondition of the bug: the archived entity no longer names its session.
    expect(archived?.kind === 'ARCHIVE_REGISTRATION' && archived.registration.acceptable).toEqual(
      [],
    );

    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: decision.writes,
      notifications: [],
    });
    expect(markerOps(sentTransaction())).toEqual(['Delete L#U#bob#s1']);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0); // scope came from the snapshot load
  });

  test('PER_SESSION offer expiry (tick-first) deletes the marker of the bound session as well', async () => {
    ddb.on(QueryCommand).resolvesOnce({ Items: itemsOf(perSessionSnapshot()) });
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    const snapshot = await store.loadSnapshot(WS);
    const decision = decide(
      snapshot!,
      { type: 'TICK', workshopId: WS, source: 'TIMER' },
      { now: addSeconds(T0, 61), newId: () => 'x' },
    );
    expect(decision.metrics.offersExpired).toBe(1);
    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: decision.writes,
      notifications: [],
    });
    expect(markerOps(sentTransaction())).toEqual(['Delete L#U#bob#s1']);
  });

  test('without a cached scope the live registration item is read (consistently) for it', async () => {
    ddb.on(GetCommand, { Key: { PK: `WS#${WS}`, SK: 'L#META' } }).resolves({
      Item: workshopItem(perSession),
    });
    ddb.on(GetCommand, { Key: { PK: `WS#${WS}`, SK: 'L#R#00000001' } }).resolves({
      Item: liveRegistrationItem(registration({ acceptable: ['s2'], status: 'OFFERED' })),
    });
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    const ended = registration({
      acceptable: [],
      status: 'ENDED',
      endReason: 'NO_ACCEPTABLE_SESSION',
    });
    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: [{ kind: 'ARCHIVE_REGISTRATION', registration: ended }],
      notifications: [],
    });
    expect(markerOps(sentTransaction())).toEqual(['Delete L#U#bob#s2']);
    const reads = ddb.commandCalls(GetCommand).map((call) => call.args[0].input);
    expect(reads).toContainEqual(
      expect.objectContaining({
        Key: { PK: `WS#${WS}`, SK: 'L#R#00000001' },
        ConsistentRead: true,
      }),
    );
  });

  test('a registration that was never stored live has no marker to delete', async () => {
    ddb.on(GetCommand, { Key: { PK: `WS#${WS}`, SK: 'L#META' } }).resolves({
      Item: workshopItem(perSession),
    });
    ddb.on(GetCommand, { Key: { PK: `WS#${WS}`, SK: 'L#R#00000004' } }).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: [
        {
          kind: 'ARCHIVE_REGISTRATION',
          registration: registration({ seq: 4, acceptable: [], status: 'ENDED' }),
        },
      ],
      notifications: [],
    });
    expect(describeTransaction(sentTransaction())).toEqual([
      'Delete L#R#00000004',
      'Put H#R#00000004 [attribute_not_exists(PK)]',
    ]);
  });

  test('a registration put in the same decision is remembered: its later archive needs no read', async () => {
    ddb.on(GetCommand).resolves({ Item: workshopItem(perSession) });
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    const live = registration({ seq: 7, acceptable: ['s2'] });
    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: [{ kind: 'PUT_REGISTRATION', registration: live }],
      notifications: [],
    });
    ddb.reset();
    ddb.on(TransactWriteCommand).resolves({});
    await store.commit({
      wsId: WS,
      expectedVersion: 2,
      writes: [
        {
          kind: 'ARCHIVE_REGISTRATION',
          registration: { ...live, acceptable: [], status: 'ENDED' },
        },
      ],
      notifications: [],
    });
    expect(markerOps(sentTransaction())).toEqual(['Delete L#U#bob#s2']);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  test('UNIFIED: an expired registration and a re-registration in one decision share one conditional marker put', async () => {
    // Bob's offer expired before his new REGISTER is processed: tick-first ends the old
    // registration (seq 1) and the command creates seq 2 of the same scope.
    const snapshot: WorkshopSnapshot = {
      workshop: { ...structuredClone(workshop), seq: 1, version: 1 },
      sessions: [{ ...structuredClone(session1), held: 1 }, structuredClone(session2)],
      registrations: [
        registration({ acceptable: ['s1'], status: 'OFFERED', currentOfferId: 'offer-1' }),
      ],
      offers: [offer()],
      pendingBackfills: [],
    };
    ddb.on(QueryCommand).resolvesOnce({ Items: itemsOf(snapshot) });
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    const loaded = await store.loadSnapshot(WS);
    const command: UserCommand = {
      type: 'REGISTER',
      commandId: CMD_ID,
      workshopId: WS,
      actorUserId: 'bob',
      actorEmail: 'bob@example.com',
      acceptable: ['s1', 's2'],
    };
    let counter = 0;
    const decision = decide(loaded!, command, {
      now: addSeconds(T0, 120),
      newId: () => `id-${++counter}`,
    });
    expect(decision.status).toBe('APPLIED');
    const kinds = decision.writes.map((change) =>
      change.kind === 'PUT_REGISTRATION' || change.kind === 'ARCHIVE_REGISTRATION'
        ? `${change.kind} ${change.registration.seq}`
        : change.kind,
    );
    expect(kinds).toContain('ARCHIVE_REGISTRATION 1');
    expect(kinds).toContain('PUT_REGISTRATION 2');

    await store.commit({
      wsId: WS,
      expectedVersion: 1,
      writes: decision.writes,
      notifications: [],
    });
    const items = sentTransaction();
    expect(markerOps(items)).toEqual([
      'Put L#U#bob [attribute_not_exists(PK) OR #seq IN (:seq0, :seq1)]',
    ]);
    const marker = items.find((item) => skOf(item) === 'L#U#bob')?.Put;
    expect(marker?.ExpressionAttributeValues).toEqual({ ':seq0': 2, ':seq1': 1 });
    expect(marker?.Item).toMatchObject({ seq: 2, status: 'OFFERED' });
  });

  test('a marker held by another registration fails the commit with UniqueMarkerConflictError (not retried)', async () => {
    const store = await primedStore();
    const { args } = registerDecision();
    const built = await store.buildTransaction(args);
    expect(built.markerIndexes).toHaveLength(1);
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: 'Transaction cancelled',
        CancellationReasons: built.items.map((_, index) =>
          index === built.markerIndexes[0] ? { Code: 'ConditionalCheckFailed' } : { Code: 'None' },
        ),
      }),
    );
    const failure = await store.commit(args).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UniqueMarkerConflictError);
    expect((failure as UniqueMarkerConflictError).markerSk).toBe('L#U#bob');
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});

describe('commit: TransactionCanceledException mapping', () => {
  function cancelled(reasons: CancellationReason[]): TransactionCanceledException {
    return new TransactionCanceledException({
      $metadata: {},
      message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
      CancellationReasons: reasons,
    });
  }

  async function reasonsFor(
    store: DynamoWorkshopStore,
    args: CommitArgs,
    failed: (indexes: { metaIndex: number; commandIndex: number }) => number[],
  ): Promise<CancellationReason[]> {
    const built = await store.buildTransaction(args);
    const failing = new Set(failed(built));
    return built.items.map((_, index) =>
      failing.has(index)
        ? { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' }
        : { Code: 'None' },
    );
  }

  test('CMD condition failed → COMMAND_ALREADY_SETTLED (even when META failed too)', async () => {
    const store = await primedStore();
    const { args } = registerDecision();
    ddb
      .on(TransactWriteCommand)
      .rejects(cancelled(await reasonsFor(store, args, ({ commandIndex }) => [commandIndex])));
    await expect(store.commit(args)).resolves.toEqual({
      ok: false,
      conflict: 'COMMAND_ALREADY_SETTLED',
    });

    ddb.reset();
    ddb
      .on(TransactWriteCommand)
      .rejects(
        cancelled(
          await reasonsFor(store, args, ({ metaIndex, commandIndex }) => [metaIndex, commandIndex]),
        ),
      );
    await expect(store.commit(args)).resolves.toEqual({
      ok: false,
      conflict: 'COMMAND_ALREADY_SETTLED',
    });
  });

  test('META condition failed → VERSION', async () => {
    const store = await primedStore();
    const { args } = registerDecision();
    ddb
      .on(TransactWriteCommand)
      .rejects(cancelled(await reasonsFor(store, args, ({ metaIndex }) => [metaIndex])));
    await expect(store.commit(args)).resolves.toEqual({ ok: false, conflict: 'VERSION' });
  });

  test('any other cancellation reason, or another error, is thrown at once', async () => {
    const store = await primedStore();
    const { args } = registerDecision();
    const built = await store.buildTransaction(args);
    // A new-item condition failed on the offer item (not META, not CMD).
    const offerIndex = built.items.findIndex((item) => skOf(item) === 'L#O#id-1');
    ddb
      .on(TransactWriteCommand)
      .rejects(cancelled(await reasonsFor(store, args, () => [offerIndex])));
    await expect(store.commit(args)).rejects.toThrow(/Transaction cancelled/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);

    // A validation error next to a conflict is not transient.
    ddb.reset();
    ddb.on(TransactWriteCommand).rejects(
      cancelled(
        built.items.map((_, index) => ({
          Code:
            index === built.metaIndex
              ? 'TransactionConflict'
              : index === offerIndex
                ? 'ValidationError'
                : 'None',
        })),
      ),
    );
    await expect(store.commit(args)).rejects.toThrow(/Transaction cancelled/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);

    ddb.reset();
    ddb.on(TransactWriteCommand).rejects(
      Object.assign(new Error('Rate exceeded'), {
        name: 'ProvisionedThroughputExceededException',
      }),
    );
    await expect(store.commit(args)).rejects.toThrow(/Rate exceeded/);
    expect(sleeps).toEqual([]);
  });

  test('a transient cancellation (TransactionConflict) is retried in-process with backoff, nothing re-decided', async () => {
    const store = await primedStore();
    const { args } = registerDecision();
    const built = await store.buildTransaction(args);
    // e.g. a duplicate POST's conditional put on the CMD item while the worker commits.
    const conflict = cancelled(
      built.items.map((_, index) => ({
        Code: index === built.commandIndex ? 'TransactionConflict' : 'None',
      })),
    );
    ddb.on(TransactWriteCommand).rejectsOnce(conflict).resolves({});
    await expect(store.commit(args)).resolves.toEqual({ ok: true });
    const calls = ddb.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[0].input).toEqual(calls[0]!.args[0].input);
    expect(sleeps).toEqual([38]); // 25 ms × 2^0 × (1 + 0.5)

    // A conflict that persists is thrown after the retries (the message is redelivered).
    ddb.reset();
    sleeps = [];
    ddb.on(TransactWriteCommand).rejects(conflict);
    await expect(store.commit(args)).rejects.toThrow(/Transaction cancelled/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(DEFAULT_TRANSIENT_RETRIES + 1);
    expect(sleeps).toEqual([38, 75, 150]);

    // Throttling reasons are transient too; a VERSION conflict found on retry is reported.
    ddb.reset();
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(
        cancelled(
          built.items.map((_, index) => ({
            Code: index === built.metaIndex ? 'ThrottlingError' : 'None',
          })),
        ),
      )
      .rejects(cancelled(await reasonsFor(store, args, ({ metaIndex }) => [metaIndex])));
    await expect(store.commit(args)).resolves.toEqual({ ok: false, conflict: 'VERSION' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });
});

describe('command results (plan §1.3)', () => {
  test('putCommandAccepted: conditional insert with ALL_OLD on failure', async () => {
    ddb.on(PutCommand).resolves({});
    const store = newStore();
    await expect(store.putCommandAccepted(commandResult())).resolves.toEqual({ created: true });
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      TableName: TABLE,
      ConditionExpression: 'attribute_not_exists(PK)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(input.Item).toEqual(commandResultItem(commandResult()));
  });

  test('putCommandAccepted returns the existing record from the exception payload without a second read', async () => {
    const existing = commandResult({
      status: 'APPLIED',
      settledAt: T1,
      result: { offersCreated: 0 },
    });
    const store = newStore();
    // The raw endpoint returns the item in AttributeValue form …
    ddb.on(PutCommand).rejects(
      new ConditionalCheckFailedException({
        $metadata: {},
        message: 'The conditional request failed',
        Item: marshall(commandResultItem(existing)),
      }),
    );
    await expect(store.putCommandAccepted(commandResult())).resolves.toEqual({
      created: false,
      existing,
    });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);

    // … or, translated by the document client, as a native map.
    ddb.reset();
    ddb.on(PutCommand).rejects(
      Object.assign(new ConditionalCheckFailedException({ $metadata: {}, message: 'failed' }), {
        Item: commandResultItem(existing),
      }),
    );
    await expect(store.putCommandAccepted(commandResult())).resolves.toEqual({
      created: false,
      existing,
    });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  test('putCommandAccepted falls back to a consistent read when the payload has no item', async () => {
    const existing = commandResult({ status: 'REJECTED', reason: 'NOT_REGISTERED', settledAt: T1 });
    ddb
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'failed' }));
    ddb.on(GetCommand).resolves({ Item: commandResultItem(existing) });
    const store = newStore();
    await expect(store.putCommandAccepted(commandResult())).resolves.toEqual({
      created: false,
      existing,
    });
    const get = ddb.commandCalls(GetCommand)[0]!.args[0].input;
    expect(get).toMatchObject({ Key: { PK: `CMD#${CMD_ID}`, SK: 'META' }, ConsistentRead: true });
  });

  test('putCommandAccepted rethrows anything but a condition failure', async () => {
    ddb.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    await expect(newStore().putCommandAccepted(commandResult())).rejects.toThrow('boom');
  });

  test('deleteCommandIfAccepted deletes on status = ACCEPTED and ignores a failed condition', async () => {
    ddb
      .on(DeleteCommand)
      .resolvesOnce({})
      .rejectsOnce(new ConditionalCheckFailedException({ $metadata: {}, message: 'failed' }));
    const store = newStore();
    await store.deleteCommandIfAccepted(CMD_ID);
    await store.deleteCommandIfAccepted(CMD_ID);
    const input = ddb.commandCalls(DeleteCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      Key: { PK: `CMD#${CMD_ID}`, SK: 'META' },
      ConditionExpression: '#status = :accepted',
      ExpressionAttributeValues: { ':accepted': 'ACCEPTED' },
    });
    ddb
      .on(DeleteCommand)
      .rejects(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    await expect(store.deleteCommandIfAccepted(CMD_ID)).rejects.toThrow('down');
  });

  test('putCommandAccepted retries a TransactionConflictException (the worker is settling that CMD item)', async () => {
    const conflict = Object.assign(new Error('Transaction is ongoing for the item'), {
      name: 'TransactionConflictException',
    });
    ddb.on(PutCommand).rejectsOnce(conflict).resolves({});
    const store = newStore();
    await expect(store.putCommandAccepted(commandResult())).resolves.toEqual({ created: true });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(2);
    expect(sleeps).toEqual([38]);

    // A conflict that outlasts the retries falls back to the consistent read of the record.
    ddb.reset();
    const settled = commandResult({ status: 'APPLIED', settledAt: T1 });
    ddb.on(PutCommand).rejects(conflict);
    ddb.on(GetCommand).resolves({ Item: commandResultItem(settled) });
    await expect(store.putCommandAccepted(commandResult())).resolves.toEqual({
      created: false,
      existing: settled,
    });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(DEFAULT_TRANSIENT_RETRIES + 1);

    // … and rethrows when there is no record to return.
    ddb.reset();
    ddb.on(PutCommand).rejects(conflict);
    ddb.on(GetCommand).resolves({});
    await expect(store.putCommandAccepted(commandResult())).rejects.toThrow(/ongoing/);
  });

  test('deleteCommandIfAccepted and updateWorkshopInfo retry a TransactionConflictException', async () => {
    const conflict = Object.assign(new Error('Transaction is ongoing for the item'), {
      name: 'TransactionConflictException',
    });
    ddb.on(DeleteCommand).rejectsOnce(conflict).resolves({});
    ddb
      .on(UpdateCommand)
      .rejectsOnce(conflict)
      .resolves({ Attributes: workshopItem({ ...workshop, title: 'New' }) });
    const store = newStore();
    await store.deleteCommandIfAccepted(CMD_ID);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(2);
    await expect(
      store.updateWorkshopInfo(WS, { title: 'New', updatedAt: T1 }),
    ).resolves.toMatchObject({ title: 'New' });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  test('getCommandResult is a consistent GetItem', async () => {
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: commandResultItem(commandResult()) })
      .resolvesOnce({});
    const store = newStore();
    await expect(store.getCommandResult(CMD_ID)).resolves.toEqual(commandResult());
    await expect(store.getCommandResult('missing')).resolves.toBeUndefined();
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });
});

describe('snapshot and point reads', () => {
  test('loadSnapshot: consistent Query of the live prefix, paginated, classified by entityType', async () => {
    const first = registration({ seq: 1, status: 'OFFERED', currentOfferId: 'offer-1' });
    const second = registration({ seq: 2, userId: 'carol', email: 'carol@example.com' });
    const older = backfill({ id: 'bf-a', releasedAt: T0 });
    const newer = backfill({ id: 'bf-b', releasedAt: T1 });
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          dueMarkerItem(WS, T1),
          workshopItem({ ...workshop, nextDueAt: T1, version: 3 }),
          sessionItem(session1),
        ],
        LastEvaluatedKey: { PK: `WS#${WS}`, SK: 'L#S#s1' },
      })
      .resolvesOnce({
        Items: [
          sessionItem(session2),
          liveRegistrationItem(second),
          liveRegistrationItem(first),
          uniqueMarkerItem('UNIFIED', first),
          liveOfferItem(offer()),
          pendingBackfillItem(newer),
          pendingBackfillItem(older),
        ],
      });
    const store = newStore();
    const snapshot = await store.loadSnapshot(WS);
    expect(snapshot).toEqual({
      workshop: { ...workshop, nextDueAt: T1, version: 3 },
      sessions: [session1, session2],
      registrations: [first, second],
      offers: [offer()],
      pendingBackfills: [older, newer],
    });
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input).toMatchObject({
      TableName: TABLE,
      ConsistentRead: true,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `WS#${WS}`, ':prefix': 'L#' },
    });
    expect(calls[0]!.args[0].input.ExclusiveStartKey).toBeUndefined();
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: `WS#${WS}`, SK: 'L#S#s1' });
  });

  test('loadSnapshot is undefined for an unknown workshop', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await expect(newStore().loadSnapshot('nope')).resolves.toBeUndefined();
  });

  test('getArchivedOffer reads H#O#{offerId}', async () => {
    const expired = offer({ status: 'EXPIRED', settledAt: T1 });
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: historyOfferItem(expired) })
      .resolvesOnce({});
    const store = newStore();
    await expect(store.getArchivedOffer(WS, 'offer-1')).resolves.toEqual(expired);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({
      PK: `WS#${WS}`,
      SK: 'H#O#offer-1',
    });
    await expect(store.getArchivedOffer(WS, 'offer-2')).resolves.toBeUndefined();
  });

  test('updateWorkshopInfo writes title/description/updatedAt only', async () => {
    const updated = { ...workshop, title: 'New title', updatedAt: T1 };
    ddb
      .on(UpdateCommand)
      .resolvesOnce({ Attributes: workshopItem(updated) })
      .rejectsOnce(new ConditionalCheckFailedException({ $metadata: {}, message: 'failed' }));
    const store = newStore();
    await expect(
      store.updateWorkshopInfo(WS, { title: 'New title', updatedAt: T1 }),
    ).resolves.toEqual(updated);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      Key: { PK: `WS#${WS}`, SK: 'L#META' },
      UpdateExpression: 'SET #updatedAt = :updatedAt, #title = :title',
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    });
    expect(Object.values(input.ExpressionAttributeNames ?? {})).toEqual(['updatedAt', 'title']);
    await expect(
      store.updateWorkshopInfo('missing', { description: 'x', updatedAt: T1 }),
    ).resolves.toBeUndefined();
  });
});

describe('read models', () => {
  test('listDueWorkshops: DUE index query bounded by now#~, confirmed by a consistent META read', async () => {
    const now = T1;
    const dueWorkshop = { ...workshop, id: 'ws-due', nextDueAt: T0 };
    const laggingWorkshop = { ...workshop, id: 'ws-lag', nextDueAt: addSeconds(T1, 600) };
    ddb.on(QueryCommand).resolves({
      Items: [dueMarkerItem('ws-due', T0), dueMarkerItem('ws-lag', T0)],
    });
    ddb.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [workshopItem(laggingWorkshop), workshopItem(dueWorkshop)] },
    });
    const store = newStore();
    await expect(store.listDueWorkshops(now)).resolves.toEqual([dueWorkshop]);
    const query = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(query).toMatchObject({
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :due AND #sk <= :max',
      ExpressionAttributeValues: { ':due': 'DUE', ':max': `${now}#~` },
    });
    const batch = ddb.commandCalls(BatchGetCommand)[0]!.args[0].input;
    expect(batch.RequestItems?.[TABLE]).toEqual({
      Keys: [
        { PK: 'WS#ws-due', SK: 'L#META' },
        { PK: 'WS#ws-lag', SK: 'L#META' },
      ],
      ConsistentRead: true,
    });
  });

  test('listDueWorkshops with no due marker makes no further read', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await expect(newStore().listDueWorkshops(T0)).resolves.toEqual([]);
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  test('listRegistrationsForUser queries GSI1 U#{userId} → WS# (live and history)', async () => {
    const live = registration();
    const archived = registration({
      seq: 4,
      workshopId: 'ws-2',
      status: 'ENDED',
      endReason: 'CUTOFF',
    });
    ddb.on(QueryCommand).resolves({
      Items: [
        liveRegistrationItem(live),
        { ...liveRegistrationItem(archived), SK: 'H#R#00000004' },
        orgMemberItem('org-1', 'bob', T0), // never returned by this prefix, but filtered anyway
      ],
    });
    await expect(newStore().listRegistrationsForUser('bob')).resolves.toEqual([live, archived]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      IndexName: 'GSI1',
      ExpressionAttributeValues: { ':pk': 'U#bob', ':prefix': 'WS#' },
    });
  });

  test('listOrganizationsForUser: membership index then BatchGet of the ORG items', async () => {
    ddb.on(QueryCommand).resolves({ Items: [orgMemberItem('org-1', 'alice', T0)] });
    ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [organizationItem(organization)] } });
    await expect(newStore().listOrganizationsForUser('alice')).resolves.toEqual([organization]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      IndexName: 'GSI1',
      ExpressionAttributeValues: { ':pk': 'U#alice', ':prefix': 'ORG#' },
    });
  });

  test('listHistory and listBackfills read the history prefixes (backfills also the live pending ones)', async () => {
    const archivedRegistration = registration({ status: 'CANCELLED' });
    const settledOffer = offer({ status: 'ACCEPTED', settledAt: T1 });
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ ...liveRegistrationItem(archivedRegistration), SK: 'H#R#00000001' }],
      })
      .resolvesOnce({ Items: [historyOfferItem(settledOffer)] });
    const store = newStore();
    await expect(store.listHistory(WS)).resolves.toEqual({
      registrations: [archivedRegistration],
      offers: [settledOffer],
    });
    const prefixes = ddb
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[':prefix']);
    expect(prefixes).toEqual(['H#R#', 'H#O#']);

    ddb.reset();
    const final = backfill({ id: 'bf-final', releasedAt: T0 });
    const pending = backfill({ id: 'bf-pending', releasedAt: T1 });
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ ...pendingBackfillItem(final), SK: `H#BF#${T0}#bf-final` }] })
      .resolvesOnce({ Items: [pendingBackfillItem(pending)] });
    await expect(store.listBackfills(WS)).resolves.toEqual([final, pending]);
  });

  test('listArchivedOffersOfUser queries only H#O# of the workshop, filtered on userId, all pages', async () => {
    const first = offer({ id: 'offer-1', status: 'EXPIRED', settledAt: T1 });
    const second = offer({ id: 'offer-2', status: 'REVOKED', settledAt: T1 });
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [historyOfferItem(first)],
        LastEvaluatedKey: { PK: `WS#${WS}`, SK: 'H#O#offer-1' },
      })
      .resolvesOnce({ Items: [historyOfferItem(second)] });
    await expect(newStore().listArchivedOffersOfUser(WS, first.userId)).resolves.toEqual([
      first,
      second,
    ]);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      FilterExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK', '#userId': 'userId' },
      ExpressionAttributeValues: { ':pk': `WS#${WS}`, ':prefix': 'H#O#', ':userId': first.userId },
      // the registration came from GSI1: the offer of the same transaction must be visible
      ConsistentRead: true,
    });
    expect(calls[0]!.args[0].input.IndexName).toBeUndefined();
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({
      PK: `WS#${WS}`,
      SK: 'H#O#offer-1',
    });
  });

  test('listNotificationsOfUserSince reads the user’s N# items from that time on, consistently, filtered on the workshop', async () => {
    const cancelled = notification({ kind: 'SESSION_CANCELLED', createdAt: T1 });
    ddb.on(QueryCommand).resolvesOnce({ Items: [notificationItem(cancelled)] });
    await expect(newStore().listNotificationsOfUserSince('bob', WS, T1)).resolves.toEqual([
      cancelled,
    ]);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      FilterExpression: '#workshopId = :workshopId',
      ExpressionAttributeValues: {
        ':pk': 'U#bob',
        ':from': `N#${T1}`,
        ':to': 'N#~',
        ':workshopId': WS,
      },
      // the registration came from GSI1: the notifications of the same transaction must be visible
      ConsistentRead: true,
    });
    // every notification of that time sorts inside the range (`N#{createdAt}#{id}`)
    expect(`N#${T1}#n-1` >= `N#${T1}` && `N#${T1}#n-1` <= 'N#~').toBe(true);
    expect(calls[0]!.args[0].input.IndexName).toBeUndefined();
  });

  test('markNotificationRead sets readAt once and returns undefined for someone else’s notification', async () => {
    const mine = notification();
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [notificationItem(mine)] })
      .resolvesOnce({ Items: [] });
    ddb.on(UpdateCommand).resolves({ Attributes: notificationItem({ ...mine, readAt: T1 }) });
    const store = newStore();
    await expect(store.markNotificationRead('bob', 'n-1', T1)).resolves.toEqual({
      ...mine,
      readAt: T1,
    });
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { PK: 'U#bob', SK: `N#${T0}#n-1` },
      UpdateExpression: 'SET #readAt = if_not_exists(#readAt, :readAt)',
    });
    await expect(store.markNotificationRead('carol', 'n-1', T1)).resolves.toBeUndefined();
  });

  test('createOrganization and createWorkshop insert with attribute_not_exists on the META item', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const store = newStore();
    await store.createOrganization(organization);
    await store.createWorkshop(workshop, [session1, session2]);
    const calls = ddb.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    expect(describeTransaction(calls[0]!.args[0].input.TransactItems ?? [])).toEqual([
      'Put META [attribute_not_exists(PK)]',
      'Put M#alice',
    ]);
    expect(describeTransaction(calls[1]!.args[0].input.TransactItems ?? [])).toEqual([
      'Put L#META [attribute_not_exists(PK)]',
      'Put L#S#s1',
      'Put L#S#s2',
    ]);
  });
});
