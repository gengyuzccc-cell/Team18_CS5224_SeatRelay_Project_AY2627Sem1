/**
 * Integration tests of `DynamoWorkshopStore` against DynamoDB Local (opt-in: they run only when
 * `DYNAMODB_LOCAL_ENDPOINT` is set, e.g.
 *
 *   docker run --rm -d -p 8000:8000 amazon/dynamodb-local:2.5.4 -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 pnpm --filter @seatrelay/aws test:ddb-local
 *
 * They drive the real `processCommand` and check what the unit tests (aws-sdk-client-mock)
 * cannot: that the condition expressions are accepted and evaluated by DynamoDB, that the live
 * prefix holds exactly the live state (no orphan R1 markers), and that the adapter matches the
 * in-memory reference store command by command. `FUZZ_SEEDS` / `FUZZ_STEPS` scale the
 * differential run.
 */
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Command, Registration, UserCommand, WorkshopMode } from '@seatrelay/contracts';
import {
  addMinutes,
  addSeconds,
  newSession,
  newWorkshop,
  registrationScopeKey,
  type WorkshopSnapshot,
} from '@seatrelay/core';
import {
  InMemoryCommandQueue,
  InMemoryTimerScheduler,
  InMemoryWorkshopStore,
  ManualClock,
  SequentialIdGen,
  acceptedCommandResult,
  noopMetrics,
  processCommand,
  silentLogger,
  type ProcessCommandResult,
  type WorkerPorts,
  type WorkshopStore,
} from '@seatrelay/service';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DynamoWorkshopStore, UniqueMarkerConflictError } from '../src/adapters/dynamo/store';

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const TABLE = `seatrelay-it-${Date.now()}`;
const T0 = '2026-11-03T06:00:00.000Z';
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 3);
const STEPS = Number(process.env.FUZZ_STEPS ?? 50);

const raw = new DynamoDBClient({
  endpoint: ENDPOINT ?? 'http://localhost:8000',
  region: 'ap-southeast-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
// Same marshalling options as production (src/lib/clients.ts).
const doc = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  unmarshallOptions: { wrapNumbers: false },
});

/* ---------- fixtures ---------- */

interface Side {
  store: WorkshopStore;
  ports: WorkerPorts & {
    queue: InMemoryCommandQueue;
    timers: InMemoryTimerScheduler;
    clock: ManualClock;
  };
}

function side(store: WorkshopStore, idPrefix: string): Side {
  return {
    store,
    ports: {
      store,
      queue: new InMemoryCommandQueue(),
      timers: new InMemoryTimerScheduler(),
      clock: new ManualClock(T0),
      ids: new SequentialIdGen(idPrefix),
      logger: silentLogger,
      metrics: noopMetrics,
    },
  };
}

interface Workshop {
  run: string;
  wsId: string;
  organiser: string;
  users: string[];
  sessionIds: string[];
}

async function createWorkshop(
  stores: readonly WorkshopStore[],
  mode: WorkshopMode,
  capacities: readonly number[] = [1, 1],
): Promise<Workshop> {
  const run = randomUUID().slice(0, 8);
  const wsId = `ws-${run}`;
  const organiser = `${run}-org`;
  const workshop = newWorkshop({
    id: wsId,
    orgId: `org-${run}`,
    title: 'Integration',
    holdSeconds: 60,
    createdAt: T0,
    mode,
  });
  const sessions = capacities.map((capacity, index) =>
    newSession({
      id: `${run}-s${index + 1}`,
      workshopId: wsId,
      title: `Session ${index + 1}`,
      startsAt: addMinutes(T0, 120 + 60 * index),
      capacity,
    }),
  );
  for (const store of stores) {
    await store.createOrganization({
      id: workshop.orgId,
      name: 'Org',
      ownerUserId: organiser,
      members: [organiser],
      createdAt: T0,
    });
    await store.createWorkshop(structuredClone(workshop), structuredClone(sessions));
  }
  return {
    run,
    wsId,
    organiser,
    users: Array.from({ length: 8 }, (_, index) => `${run}-u${index + 1}`),
    sessionIds: sessions.map((session) => session.id),
  };
}

function userCommand(
  ws: Workshop,
  actor: string,
  body: Record<string, unknown> & { type: UserCommand['type'] },
): UserCommand {
  return {
    commandId: randomUUID(),
    workshopId: ws.wsId,
    actorUserId: actor,
    actorEmail: `${actor}@example.com`,
    ...body,
  } as UserCommand;
}

/** API intake + worker: ACCEPTED record, processCommand, then every continuation it queued. */
async function run(target: Side, command: Command): Promise<string[]> {
  const outcomes: string[] = [];
  if ('commandId' in command) {
    await target.store.putCommandAccepted(acceptedCommandResult(command, target.ports.clock.now()));
  }
  let next: Command | undefined = structuredClone(command);
  while (next !== undefined) {
    const result: ProcessCommandResult = await processCommand(target.ports, next);
    outcomes.push(
      `${next.type}:${result.outcome}${result.decision?.reason === undefined ? '' : `(${result.decision.reason})`}`,
    );
    next = target.ports.queue.dequeue();
  }
  return outcomes;
}

async function liveItems(wsId: string, prefix = 'L#'): Promise<Record<string, unknown>[]> {
  const output = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `WS#${wsId}`, ':prefix': prefix },
      ConsistentRead: true,
    }),
  );
  return (output.Items ?? []) as Record<string, unknown>[];
}

/** The R1 markers stored for the workshop must be exactly one per live registration scope. */
async function expectMarkersMatchLiveRegistrations(
  wsId: string,
  mode: WorkshopMode,
  registrations: readonly Registration[],
): Promise<void> {
  const markers = (await liveItems(wsId, 'L#U#'))
    .map((item) => `${String(item.SK)} seq=${String(item.seq)} ${String(item.status)}`)
    .sort();
  const expected = registrations
    .map((r) => `L#U#${registrationScopeKey(mode, r)} seq=${r.seq} ${r.status}`)
    .sort();
  expect(markers).toEqual(expected);
}

function normalise(snapshot: WorkshopSnapshot | undefined): unknown {
  if (snapshot === undefined) {
    return undefined;
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    workshop: snapshot.workshop,
    sessions: [...snapshot.sessions].sort(byId),
    registrations: [...snapshot.registrations].sort((a, b) => a.seq - b.seq),
    offers: [...snapshot.offers].sort(byId),
    pendingBackfills: [...snapshot.pendingBackfills].sort(byId),
  };
}

/** mulberry32: a small seeded PRNG so a failing seed can be replayed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- tests ---------- */

describe.skipIf(ENDPOINT === undefined)('DynamoWorkshopStore on DynamoDB Local', () => {
  beforeAll(async () => {
    await raw.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        // Same keys and index as templates/app.yaml.
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
  });

  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: TABLE }));
  });

  describe('PER_SESSION: archived registrations leave no R1 marker behind', () => {
    test('DECLINE_OFFER', async () => {
      const store = new DynamoWorkshopStore(doc, TABLE);
      const ws = await createWorkshop([store], 'PER_SESSION');
      const target = side(store, ws.run);
      const [alice] = ws.users;
      const [sA] = ws.sessionIds;
      await run(target, userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA] }));
      expect((await liveItems(ws.wsId, 'L#U#')).map((item) => item.SK)).toEqual([
        `L#U#${alice}#${sA}`,
      ]);
      const snapshot = await store.loadSnapshot(ws.wsId);
      const offerId = snapshot!.offers[0]!.id;
      expect(
        await run(target, userCommand(ws, alice!, { type: 'DECLINE_OFFER', offerId })),
      ).toEqual(['DECLINE_OFFER:APPLIED']);
      expect(await liveItems(ws.wsId, 'L#U#')).toEqual([]);
      expect((await liveItems(ws.wsId)).map((item) => item.entityType).sort()).toEqual([
        'SESSION',
        'SESSION',
        'WORKSHOP',
      ]);

      // Re-registering for the same session passes the conditional marker write.
      expect(
        await run(target, userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA] })),
      ).toEqual(['REGISTER:APPLIED']);
      const after = await store.loadSnapshot(ws.wsId);
      await expectMarkersMatchLiveRegistrations(ws.wsId, 'PER_SESSION', after!.registrations);
    });

    test('offer expiry (timer TICK)', async () => {
      const store = new DynamoWorkshopStore(doc, TABLE);
      const ws = await createWorkshop([store], 'PER_SESSION');
      const target = side(store, ws.run);
      const [alice, bob] = ws.users;
      const [sA] = ws.sessionIds;
      await run(target, userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA] }));
      await run(target, userCommand(ws, bob!, { type: 'REGISTER', acceptable: [sA] }));
      target.ports.clock.set(addSeconds(T0, 61));
      const ticks = target.ports.timers.dueTicks(target.ports.clock.now());
      expect(ticks).toHaveLength(1);
      expect(await run(target, ticks[0]!)).toEqual(['TICK:APPLIED']);
      // Alice's registration ended; Bob was offered the seat in the same commit.
      const snapshot = await store.loadSnapshot(ws.wsId);
      expect(snapshot!.registrations.map((r) => [r.userId, r.status])).toEqual([[bob, 'OFFERED']]);
      await expectMarkersMatchLiveRegistrations(ws.wsId, 'PER_SESSION', snapshot!.registrations);
    });

    test('CANCEL_SESSION of the bound session (offered and queued registrations)', async () => {
      const store = new DynamoWorkshopStore(doc, TABLE);
      const ws = await createWorkshop([store], 'PER_SESSION');
      const target = side(store, ws.run);
      const [alice, bob, carol] = ws.users;
      const [sA, sB] = ws.sessionIds;
      await run(target, userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA] }));
      await run(target, userCommand(ws, bob!, { type: 'REGISTER', acceptable: [sA] }));
      await run(target, userCommand(ws, carol!, { type: 'REGISTER', acceptable: [sB] }));
      expect(
        await run(target, userCommand(ws, ws.organiser, { type: 'CANCEL_SESSION', sessionId: sA })),
      ).toEqual(['CANCEL_SESSION:APPLIED']);
      const snapshot = await store.loadSnapshot(ws.wsId);
      expect(snapshot!.registrations.map((r) => r.userId)).toEqual([carol]);
      await expectMarkersMatchLiveRegistrations(ws.wsId, 'PER_SESSION', snapshot!.registrations);
    });
  });

  test('UNIFIED: an expired offer and a re-registration in one decision commit with the IN condition', async () => {
    const store = new DynamoWorkshopStore(doc, TABLE);
    const ws = await createWorkshop([store], 'UNIFIED');
    const target = side(store, ws.run);
    const [alice] = ws.users;
    const [sA, sB] = ws.sessionIds;
    await run(target, userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA] }));
    target.ports.clock.set(addSeconds(T0, 90)); // the timer tick has not been processed yet
    const built: string[] = [];
    const original = store.buildTransaction.bind(store);
    store.buildTransaction = async (args) => {
      const result = await original(args);
      for (const index of result.markerIndexes) {
        built.push(String(result.items[index]?.Put?.ConditionExpression));
      }
      return result;
    };
    expect(
      await run(target, userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA, sB] })),
    ).toEqual(['REGISTER:APPLIED']);
    expect(built).toEqual(['attribute_not_exists(PK) OR #seq IN (:seq0, :seq1)']);
    const snapshot = await store.loadSnapshot(ws.wsId);
    expect(snapshot!.registrations.map((r) => [r.seq, r.status])).toEqual([[2, 'OFFERED']]);
    await expectMarkersMatchLiveRegistrations(ws.wsId, 'UNIFIED', snapshot!.registrations);
  });

  test('a marker held by another registration (e.g. a pre-fix orphan) fails the commit instead of breaking R1', async () => {
    const store = new DynamoWorkshopStore(doc, TABLE);
    const ws = await createWorkshop([store], 'PER_SESSION');
    const target = side(store, ws.run);
    const [alice] = ws.users;
    const [sA] = ws.sessionIds;
    // The orphan the pre-fix adapter left after a decline: still claims seq 1 as OFFERED.
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `WS#${ws.wsId}`,
          SK: `L#U#${alice}#${sA}`,
          entityType: 'UNIQUE_MARKER',
          workshopId: ws.wsId,
          userId: alice,
          scope: `${alice}#${sA}`,
          seq: 99,
          status: 'OFFERED',
        },
      }),
    );
    const register = userCommand(ws, alice!, { type: 'REGISTER', acceptable: [sA] });
    await expect(run(target, register)).rejects.toBeInstanceOf(UniqueMarkerConflictError);
    // Nothing of the decision was written; the command stays ACCEPTED for its redelivery.
    expect((await store.loadSnapshot(ws.wsId))!.registrations).toEqual([]);
    expect(
      await store.getCommandResult((register as { commandId: string }).commandId),
    ).toMatchObject({ status: 'ACCEPTED' });
  });

  describe.each(['UNIFIED', 'PER_SESSION'] as const)(
    'differential run against the in-memory store (%s)',
    (mode) => {
      test.each(Array.from({ length: SEEDS }, (_, index) => index + 1))(
        'seed %i',
        async (seed) => {
          const rng = prng(seed * 7919 + (mode === 'UNIFIED' ? 1 : 2));
          const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
          const memory = new InMemoryWorkshopStore();
          const dynamo = new DynamoWorkshopStore(doc, TABLE);
          const ws = await createWorkshop([memory, dynamo], mode, [2, 1, 3]);
          const sides = [side(memory, ws.run), side(dynamo, ws.run)] as const;
          const [mem, ddb] = sides;

          const both = async (command: Command): Promise<void> => {
            const [a, b] = [await run(mem, command), await run(ddb, command)];
            expect(b, `outcomes of ${command.type}`).toEqual(a);
            if ('commandId' in command) {
              const [ra, rb] = [
                await mem.store.getCommandResult(command.commandId),
                await ddb.store.getCommandResult(command.commandId),
              ];
              expect(rb).toEqual(ra);
            }
          };

          for (let step = 0; step < STEPS; step += 1) {
            const snapshot = await mem.store.loadSnapshot(ws.wsId);
            const roll = rng();
            if (roll < 0.3) {
              const acceptable =
                mode === 'PER_SESSION'
                  ? [pick(ws.sessionIds)]
                  : [...ws.sessionIds].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * 3));
              await both(userCommand(ws, pick(ws.users), { type: 'REGISTER', acceptable }));
            } else if (roll < 0.5) {
              const offers = snapshot!.offers;
              const offer = offers.length > 0 ? pick(offers) : undefined;
              const actor = offer !== undefined && rng() < 0.9 ? offer.userId : pick(ws.users);
              const type = rng() < 0.6 ? 'ACCEPT_OFFER' : 'DECLINE_OFFER';
              await both(userCommand(ws, actor, { type, offerId: offer?.id ?? 'no-such-offer' }));
            } else if (roll < 0.6) {
              const live = snapshot!.registrations;
              const target = live.length > 0 && rng() < 0.8 ? pick(live) : undefined;
              const actor = target?.userId ?? pick(ws.users);
              const sessionId =
                mode === 'PER_SESSION' && target !== undefined && rng() < 0.5
                  ? target.acceptable[0]
                  : undefined;
              await both(
                userCommand(ws, actor, {
                  type: 'CANCEL_REGISTRATION',
                  ...(sessionId === undefined ? {} : { sessionId }),
                }),
              );
            } else if (roll < 0.67) {
              const actor = rng() < 0.9 ? ws.organiser : pick(ws.users);
              await both(
                userCommand(ws, actor, {
                  type: 'SET_CAPACITY',
                  sessionId: pick(ws.sessionIds),
                  capacity: Math.floor(rng() * 5),
                }),
              );
            } else if (roll < 0.69) {
              await both(
                userCommand(ws, ws.organiser, {
                  type: 'CANCEL_SESSION',
                  sessionId: pick(ws.sessionIds),
                }),
              );
            } else if (roll < 0.72) {
              const closed = snapshot!.workshop.status === 'CLOSED';
              const type = closed && rng() < 0.8 ? 'OPEN_REGISTRATION' : 'CLOSE_REGISTRATION';
              await both(userCommand(ws, ws.organiser, { type }));
            } else if (roll < 0.73) {
              // Cancelling the workshop ends the run, so only near its end.
              if (step > STEPS * 0.8) {
                await both(userCommand(ws, ws.organiser, { type: 'CANCEL_WORKSHOP' }));
              }
            } else if (roll < 0.93) {
              const jump = rng();
              const ms =
                jump < 0.7
                  ? 1_000 + rng() * 29_000
                  : jump < 0.98
                    ? 30_000 + rng() * 90_000
                    : 1_800_000; // occasionally across a session cut-off
              const now = addSeconds(mem.ports.clock.now(), ms / 1000);
              mem.ports.clock.set(now);
              ddb.ports.clock.set(now);
              ddb.ports.timers.dueTicks(now);
              for (const tick of mem.ports.timers.dueTicks(now)) {
                await both(tick);
              }
            } else {
              // Sweep: the DUE index must agree on whether this workshop is due.
              const now = mem.ports.clock.now();
              const due = await Promise.all(
                sides.map(async (s) =>
                  (await s.store.listDueWorkshops(now)).some((w) => w.id === ws.wsId),
                ),
              );
              expect(due[1], 'DUE index').toBe(due[0]);
              if (due[0]) {
                await both({ type: 'TICK', workshopId: ws.wsId, source: 'SWEEP' });
              }
            }

            const [a, b] = [
              await mem.store.loadSnapshot(ws.wsId),
              await ddb.store.loadSnapshot(ws.wsId),
            ];
            expect(normalise(b), `snapshot after step ${step}`).toEqual(normalise(a));
            await expectMarkersMatchLiveRegistrations(ws.wsId, mode, a!.registrations);
          }

          // Read models and timers agree too.
          const sortBy = <T>(items: T[], key: (item: T) => string): T[] =>
            [...items].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
          const [ha, hb] = [
            await mem.store.listHistory(ws.wsId),
            await ddb.store.listHistory(ws.wsId),
          ];
          expect(sortBy(hb.registrations, (r) => String(r.seq).padStart(8, '0'))).toEqual(
            sortBy(ha.registrations, (r) => String(r.seq).padStart(8, '0')),
          );
          expect(sortBy(hb.offers, (o) => o.id)).toEqual(sortBy(ha.offers, (o) => o.id));
          expect(sortBy(await ddb.store.listBackfills(ws.wsId), (r) => r.id)).toEqual(
            sortBy(await mem.store.listBackfills(ws.wsId), (r) => r.id),
          );
          expect(ddb.ports.timers.scheduled).toEqual(mem.ports.timers.scheduled);
          for (const user of ws.users) {
            expect(
              sortBy(await ddb.store.listRegistrationsForUser(user), (r) => `${r.seq}`),
            ).toEqual(sortBy(await mem.store.listRegistrationsForUser(user), (r) => `${r.seq}`));
            expect(
              sortBy(await ddb.store.listArchivedOffersOfUser(ws.wsId, user), (o) => o.id),
            ).toEqual(sortBy(await mem.store.listArchivedOffersOfUser(ws.wsId, user), (o) => o.id));
            const notices = async (side: typeof mem) =>
              (await side.store.listNotificationsOfUserSince(user, ws.wsId, T0))
                .map((n) => `${n.createdAt} ${n.kind} ${n.title}`)
                .sort();
            expect(await notices(ddb)).toEqual(await notices(mem));
          }
        },
        120_000,
      );
    },
  );
});
