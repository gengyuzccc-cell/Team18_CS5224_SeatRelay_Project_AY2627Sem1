import { randomUUID } from 'node:crypto';
import type { Organization, UserCommand } from '@seatrelay/contracts';
import { addMinutes, newSession, newWorkshop, type WorkshopSnapshot } from '@seatrelay/core';
import {
  acceptedCommandResult,
  noopMetrics,
  silentLogger,
  systemClock,
  uuidIdGen,
  type WorkerPorts,
} from '@seatrelay/service';
import pg from 'pg';
import { createPool, migrate } from '../src/adapters/postgres/db';
import { PostgresCommandQueue, PostgresTimerScheduler } from '../src/adapters/postgres/queue';
import { PostgresWorkshopStore } from '../src/adapters/postgres/store';
import { createLogger } from '../src/logger';

export const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://seatrelay:seatrelay@localhost:5432/seatrelay';

/** Every test table lives in this schema (dropped and recreated per run), never in `public`. */
export const TEST_SCHEMA = 'seatrelay_test';

/** `undefined` when PostgreSQL answers, otherwise the reason it does not. */
export async function probePostgres(): Promise<string | undefined> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3_000, max: 1 });
  try {
    await pool.query('SELECT 1');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function freshSchemaPool(): Promise<pg.Pool> {
  const admin = createPool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  } finally {
    await admin.end();
  }
  const pool = createPool({ connectionString: DATABASE_URL, schema: TEST_SCHEMA, max: 5 });
  await migrate(pool);
  return pool;
}

export const organiser = { userId: 'organiser', email: 'organiser@example.com', name: 'Olivia' };
export const alice = { userId: 'alice', email: 'alice@example.com', name: 'Alice' };
export const bob = { userId: 'bob', email: 'bob@example.com', name: 'Bob' };
export const carol = { userId: 'carol', email: 'carol@example.com' };

export interface Fixture {
  pool: pg.Pool;
  store: PostgresWorkshopStore;
  queue: PostgresCommandQueue;
  timers: PostgresTimerScheduler;
  ports: WorkerPorts;
  org: Organization;
  wsId: string;
  s1: string;
  s2: string;
}

export function workerPorts(
  pool: pg.Pool,
): Pick<Fixture, 'store' | 'queue' | 'timers' | 'ports'> {
  const store = new PostgresWorkshopStore(pool);
  const queue = new PostgresCommandQueue(pool);
  const timers = new PostgresTimerScheduler(pool);
  const ports: WorkerPorts = {
    store,
    queue,
    timers,
    clock: systemClock,
    ids: uuidIdGen,
    logger: silentLogger,
    metrics: noopMetrics,
  };
  return { store, queue, timers, ports };
}

/** An organisation with one UNIFIED workshop: two sessions of capacity 1 tomorrow, hold 60 s. */
export async function createFixture(
  pool: pg.Pool,
  options: { holdSeconds?: number; mode?: 'UNIFIED' | 'PER_SESSION'; capacity?: number } = {},
): Promise<Fixture> {
  const base = workerPorts(pool);
  const now = systemClock.now();
  const org: Organization = {
    id: randomUUID(),
    name: 'Team 18',
    ownerUserId: organiser.userId,
    members: [organiser.userId],
    createdAt: now,
  };
  await base.store.createOrganization(org);
  const workshop = newWorkshop({
    id: randomUUID(),
    orgId: org.id,
    title: 'Intro to Git',
    holdSeconds: options.holdSeconds ?? 60,
    mode: options.mode ?? 'UNIFIED',
    createdAt: now,
  });
  const sessions = [
    newSession({
      id: randomUUID(),
      workshopId: workshop.id,
      title: 'Morning',
      startsAt: addMinutes(now, 24 * 60),
      capacity: options.capacity ?? 1,
    }),
    newSession({
      id: randomUUID(),
      workshopId: workshop.id,
      title: 'Afternoon',
      startsAt: addMinutes(now, 26 * 60),
      capacity: options.capacity ?? 1,
    }),
  ];
  await base.store.createWorkshop(workshop, sessions);
  return {
    pool,
    ...base,
    org,
    wsId: workshop.id,
    s1: sessions[0]!.id,
    s2: sessions[1]!.id,
  };
}

type Payload<T extends UserCommand['type']> = Omit<
  Extract<UserCommand, { type: T }>,
  'type' | 'commandId' | 'workshopId' | 'actorUserId' | 'actorEmail' | 'actorDisplayName'
>;

/** A full user command as the API would build it (fresh commandId). */
export function command<T extends UserCommand['type']>(
  type: T,
  wsId: string,
  actor: { userId: string; email: string; name?: string },
  payload: Payload<T>,
): Extract<UserCommand, { type: T }> {
  return {
    type,
    commandId: randomUUID(),
    workshopId: wsId,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    ...(actor.name === undefined ? {} : { actorDisplayName: actor.name }),
    ...payload,
  } as Extract<UserCommand, { type: T }>;
}

/** Writes the ACCEPTED record the API would write before enqueueing (plan §1.3). */
export async function accept(store: PostgresWorkshopStore, cmd: UserCommand): Promise<void> {
  const put = await store.putCommandAccepted(acceptedCommandResult(cmd, systemClock.now()));
  if (!put.created) {
    throw new Error(`command ${cmd.commandId} already accepted`);
  }
}

export async function snapshotOf(store: PostgresWorkshopStore, wsId: string): Promise<WorkshopSnapshot> {
  const snapshot = await store.loadSnapshot(wsId);
  if (snapshot === undefined) {
    throw new Error(`workshop ${wsId} not found`);
  }
  return snapshot;
}

export async function count(pool: pg.Pool, table: string, where = 'TRUE', values: unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, values);
  return Number(result.rows[0]?.n ?? 0);
}

export const testLogger = createLogger('error');
