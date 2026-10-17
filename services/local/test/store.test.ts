import { randomUUID } from 'node:crypto';
import type { Registration } from '@seatrelay/contracts';
import { addSeconds, decide, type Change } from '@seatrelay/core';
import { processCommand, systemClock, uuidIdGen } from '@seatrelay/service';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pgErrorCode } from '../src/adapters/postgres/db';
import { PostgresUserDirectory } from '../src/adapters/postgres/users';
import { createNotifier } from '../src/notifier';
import { createTimerLoop } from '../src/timers';
import { createWorker } from '../src/worker';
import {
  DATABASE_URL,
  TEST_SCHEMA,
  accept,
  alice,
  bob,
  carol,
  command,
  count,
  createFixture,
  freshSchemaPool,
  probePostgres,
  snapshotOf,
  testLogger,
  workerPorts,
} from './helpers';

const unavailable = await probePostgres();
if (unavailable !== undefined) {
  console.warn(
    `\n[@seatrelay/local] PostgreSQL is not reachable at ${DATABASE_URL} (${unavailable}).\n` +
      `The postgres store tests are SKIPPED. Start it with:\n` +
      `  docker compose -f services/local/docker-compose.yml up -d postgres\n`,
  );
}

describe.skipIf(unavailable !== undefined)('postgres adapter (real PostgreSQL)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await freshSchemaPool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('schema applies cleanly and idempotently', async () => {
    const { migrate } = await import('../src/adapters/postgres/db');
    await migrate(pool); // second application: every statement is IF NOT EXISTS
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
      [TEST_SCHEMA],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'attendance',
      'backfill_records',
      'command_results',
      'commands',
      'notifications',
      'offers',
      'offers_history',
      'org_members',
      'organizations',
      'registrations',
      'registrations_history',
      'sessions',
      'timers',
      'users',
      'workshops',
    ]);
  });

  test('organisation and workshop CRUD round-trips', async () => {
    const f = await createFixture(pool);
    const org = await f.store.getOrganization(f.org.id);
    expect(org).toEqual(f.org);
    expect(await f.store.listOrganizationsForUser('organiser')).toContainEqual(f.org);
    const withBob = await f.store.addMember(f.org.id, 'bob');
    expect(withBob?.members).toEqual(['organiser', 'bob']);
    expect((await f.store.addMember(f.org.id, 'bob'))?.members).toEqual(['organiser', 'bob']);
    expect(await f.store.addMember('nope', 'bob')).toBeUndefined();

    const workshop = await f.store.getWorkshop(f.wsId);
    expect(workshop).toMatchObject({ id: f.wsId, status: 'OPEN', seq: 0, version: 0, holdSeconds: 60 });
    expect(workshop?.nextDueAt).toBeUndefined();
    expect((await f.store.listSessions(f.wsId)).map((s) => s.id)).toEqual([f.s1, f.s2]);
    expect((await f.store.listWorkshopsForOrg(f.org.id)).map((w) => w.id)).toEqual([f.wsId]);

    const patched = await f.store.updateWorkshopInfo(f.wsId, {
      title: 'Git 101',
      updatedAt: '2030-01-01T00:00:00.000Z',
    });
    expect(patched).toMatchObject({ title: 'Git 101', description: '', updatedAt: '2030-01-01T00:00:00.000Z', version: 0 });
    expect(await f.store.updateWorkshopInfo('nope', { updatedAt: systemClock.now() })).toBeUndefined();
  });

  test('processCommand against the store: register → offer, timer row, notification, settled result', async () => {
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, alice, { acceptable: [f.s1, f.s2] });
    await accept(f.store, register);
    const result = await processCommand(f.ports, register);
    expect(result.outcome).toBe('APPLIED');

    const snapshot = await snapshotOf(f.store, f.wsId);
    expect(snapshot.workshop).toMatchObject({ seq: 1, version: 1 });
    expect(snapshot.registrations).toHaveLength(1);
    expect(snapshot.registrations[0]).toMatchObject({
      userId: 'alice',
      seq: 1,
      status: 'OFFERED',
      acceptable: [f.s1, f.s2],
      displayName: 'Alice',
    });
    expect(snapshot.offers).toHaveLength(1);
    const offer = snapshot.offers[0]!;
    expect(offer).toMatchObject({ sessionId: f.s1, userId: 'alice', status: 'OFFERED', registrationSeq: 1 });
    expect(offer.expiresAt).toBe(addSeconds(offer.createdAt, 60));
    expect(snapshot.workshop.nextDueAt).toBe(offer.expiresAt);
    expect(snapshot.sessions.find((s) => s.id === f.s1)).toMatchObject({ held: 1, confirmed: 0 });

    const record = await f.store.getCommandResult(register.commandId);
    expect(record).toMatchObject({
      status: 'APPLIED',
      type: 'REGISTER',
      actorUserId: 'alice',
      result: { offersCreated: 1, registration: { status: 'OFFERED', seq: 1 } },
    });
    expect(record?.settledAt).toBeDefined();
    expect(await count(pool, 'timers', 'workshop_id = $1 AND offer_id = $2 AND NOT fired', [f.wsId, offer.id])).toBe(1);
    expect(await count(pool, 'notifications', `workshop_id = $1 AND status = 'PENDING' AND kind = 'OFFER'`, [f.wsId])).toBe(1);
    expect((await f.store.listNotificationsForUser('alice')).map((n) => n.kind)).toContain('OFFER');
    expect(await f.store.listDueWorkshops(addSeconds(offer.expiresAt, 1))).toContainEqual(
      expect.objectContaining({ id: f.wsId }),
    );
    expect(await f.store.listDueWorkshops(addSeconds(offer.expiresAt, -1))).not.toContainEqual(
      expect.objectContaining({ id: f.wsId }),
    );
  });

  test('commit: stale version → VERSION and nothing is written', async () => {
    const f = await createFixture(pool);
    const snapshot = await snapshotOf(f.store, f.wsId);
    const register = command('REGISTER', f.wsId, bob, { acceptable: [f.s1] });
    await accept(f.store, register);
    const decision = decide(snapshot, register, { now: systemClock.now(), newId: () => randomUUID() });
    expect(decision.status).toBe('APPLIED');

    // A concurrent writer moved the workshop on.
    await pool.query(`UPDATE workshops SET version = version + 1 WHERE id = $1`, [f.wsId]);

    const committed = await f.store.commit({
      wsId: f.wsId,
      expectedVersion: snapshot.workshop.version,
      writes: decision.writes,
      notifications: [],
      commandResult: {
        commandId: register.commandId,
        type: 'REGISTER',
        actorUserId: 'bob',
        workshopId: f.wsId,
        status: 'APPLIED',
        acceptedAt: systemClock.now(),
        settledAt: systemClock.now(),
        ttl: 0,
      },
    });
    expect(committed).toEqual({ ok: false, conflict: 'VERSION' });
    expect((await snapshotOf(f.store, f.wsId)).registrations).toHaveLength(0);
    expect((await f.store.getCommandResult(register.commandId))?.status).toBe('ACCEPTED');
    expect(await count(pool, 'timers', 'workshop_id = $1', [f.wsId])).toBe(0);
  });

  test('commit: already settled command → COMMAND_ALREADY_SETTLED (redelivery acked)', async () => {
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, alice, { acceptable: [f.s1] });
    await accept(f.store, register);
    expect((await processCommand(f.ports, register)).outcome).toBe('APPLIED');
    const settled = (await f.store.getCommandResult(register.commandId))!;

    const direct = await f.store.commit({
      wsId: f.wsId,
      expectedVersion: 1,
      writes: [],
      notifications: [],
      commandResult: settled,
    });
    expect(direct).toEqual({ ok: false, conflict: 'COMMAND_ALREADY_SETTLED' });

    // The orchestration path: a redelivered message is acknowledged without a second decision.
    const redelivered = await processCommand(f.ports, register, { deliveryAttempt: 2 });
    expect(redelivered.outcome).toBe('ALREADY_SETTLED');
    expect((await snapshotOf(f.store, f.wsId)).workshop.version).toBe(1);
    expect(await count(pool, 'registrations', 'workshop_id = $1', [f.wsId])).toBe(1);
  });

  test('archive moves rows to history (accept, cancel) and backfills are recorded', async () => {
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, alice, { acceptable: [f.s1, f.s2] });
    await accept(f.store, register);
    await processCommand(f.ports, register);
    const offerId = (await snapshotOf(f.store, f.wsId)).offers[0]!.id;

    const acceptOffer = command('ACCEPT_OFFER', f.wsId, alice, { offerId });
    await accept(f.store, acceptOffer);
    expect((await processCommand(f.ports, acceptOffer)).outcome).toBe('APPLIED');
    let snapshot = await snapshotOf(f.store, f.wsId);
    expect(snapshot.offers).toHaveLength(0);
    expect(snapshot.registrations[0]).toMatchObject({ status: 'CONFIRMED', confirmedSessionId: f.s1 });
    expect(snapshot.sessions.find((s) => s.id === f.s1)).toMatchObject({ held: 0, confirmed: 1 });
    expect(await f.store.getArchivedOffer(f.wsId, offerId)).toMatchObject({ id: offerId, status: 'ACCEPTED' });
    expect(await f.store.getArchivedOffer(f.wsId, 'nope')).toBeUndefined();
    expect(await count(pool, 'offers', 'id = $1', [offerId])).toBe(0);
    expect(await count(pool, 'offers_history', 'id = $1', [offerId])).toBe(1);

    // Bob queues behind the confirmed seat, then Alice cancels: the seat relays in the same commit.
    const bobRegisters = command('REGISTER', f.wsId, bob, { acceptable: [f.s1] });
    await accept(f.store, bobRegisters);
    await processCommand(f.ports, bobRegisters);
    const cancel = command('CANCEL_REGISTRATION', f.wsId, alice, {});
    await accept(f.store, cancel);
    expect((await processCommand(f.ports, cancel)).outcome).toBe('APPLIED');

    snapshot = await snapshotOf(f.store, f.wsId);
    expect(snapshot.registrations.map((r) => [r.userId, r.status])).toEqual([['bob', 'OFFERED']]);
    expect(await count(pool, 'registrations', 'workshop_id = $1 AND user_id = $2', [f.wsId, 'alice'])).toBe(0);
    const history = await f.store.listHistory(f.wsId);
    expect(history.registrations).toHaveLength(1);
    expect(history.registrations[0]).toMatchObject({ userId: 'alice', seq: 1, status: 'CANCELLED' });
    expect(history.offers.map((o) => o.status)).toEqual(['ACCEPTED']);
    const backfills = await f.store.listBackfills(f.wsId);
    expect(backfills).toHaveLength(1);
    expect(backfills[0]).toMatchObject({ sessionId: f.s1, cause: 'CANCELLED_CONFIRMED', newUserId: 'bob', latencyMs: 0 });
    expect(snapshot.pendingBackfills).toHaveLength(0);

    const mine = await f.store.listRegistrationsForUser('alice');
    expect(mine.some((r) => r.workshopId === f.wsId && r.status === 'CANCELLED')).toBe(true);

    // A late accept of the archived offer is answered with the archived state, not NOT_FOUND.
    const late = command('ACCEPT_OFFER', f.wsId, alice, { offerId });
    await accept(f.store, late);
    const lateResult = await processCommand(f.ports, late);
    expect(lateResult.outcome).toBe('REJECTED');
    expect(lateResult.decision?.reason).toBe('OFFER_NOT_ACTIVE');
    expect((await f.store.getCommandResult(late.commandId))?.reason).toBe('OFFER_NOT_ACTIVE');
  });

  test('R1 unique index: a second live registration in the same scope is refused by the database', async () => {
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, carol, { acceptable: [f.s1] });
    await accept(f.store, register);
    await processCommand(f.ports, register);
    const snapshot = await snapshotOf(f.store, f.wsId);
    const duplicate: Registration = { ...snapshot.registrations[0]!, seq: 99 };
    const writes: Change[] = [
      {
        kind: 'PUT_WORKSHOP_STATE',
        workshopId: f.wsId,
        status: 'OPEN',
        seq: 99,
        version: snapshot.workshop.version + 1,
        updatedAt: systemClock.now(),
      },
      { kind: 'PUT_REGISTRATION', registration: duplicate },
    ];
    await expect(
      f.store.commit({ wsId: f.wsId, expectedVersion: snapshot.workshop.version, writes, notifications: [] }),
    ).rejects.toSatisfy((error: unknown) => pgErrorCode(error) === '23505');
    // the failed transaction left the workshop untouched
    expect((await snapshotOf(f.store, f.wsId)).workshop.version).toBe(snapshot.workshop.version);
  });

  test('PER_SESSION: one registration per (user, session) is allowed, scope key differs', async () => {
    const f = await createFixture(pool, { mode: 'PER_SESSION' });
    for (const sessionId of [f.s1, f.s2]) {
      const register = command('REGISTER', f.wsId, carol, { acceptable: [sessionId] });
      await accept(f.store, register);
      expect((await processCommand(f.ports, register)).outcome).toBe('APPLIED');
    }
    const scopes = await pool.query<{ scope_key: string }>(
      `SELECT scope_key FROM registrations WHERE workshop_id = $1 ORDER BY seq`,
      [f.wsId],
    );
    expect(scopes.rows.map((row) => row.scope_key)).toEqual([`carol#${f.s1}`, `carol#${f.s2}`]);
  });

  test('queue: dedup on commandId and tick#offerId#expiresAt; sweep ticks always enqueue', async () => {
    await pool.query('TRUNCATE commands');
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, alice, { acceptable: [f.s1] });
    await f.queue.enqueue(register);
    await f.queue.enqueue(register);
    expect(await count(pool, 'commands', 'dedup_id = $1', [register.commandId])).toBe(1);

    const expiresAt = systemClock.now();
    const tick = { type: 'TICK' as const, workshopId: f.wsId, source: 'TIMER' as const, offerId: 'o1', expiresAt };
    await f.queue.enqueue(tick);
    await f.queue.enqueue(tick);
    expect(await count(pool, 'commands', 'dedup_id = $1', [`tick#o1#${expiresAt}`])).toBe(1);

    await f.queue.enqueue({ type: 'TICK', workshopId: f.wsId, source: 'SWEEP' });
    await f.queue.enqueue({ type: 'TICK', workshopId: f.wsId, source: 'SWEEP' });
    expect(await count(pool, 'commands', `workshop_id = $1 AND payload->>'source' = 'SWEEP'`, [f.wsId])).toBe(2);
    expect(await count(pool, 'commands', `status = 'PENDING'`)).toBe(4);
  });

  test('timers: only due rows become TICK commands and are marked fired', async () => {
    await pool.query('TRUNCATE commands, timers');
    const f = await createFixture(pool);
    const past = addSeconds(systemClock.now(), -5);
    const future = addSeconds(systemClock.now(), 3600);
    await f.timers.schedule(f.wsId, [
      { offerId: 'due', expiresAt: past },
      { offerId: 'later', expiresAt: future },
    ]);
    const loop = createTimerLoop({ pool, logger: testLogger, pollMs: 1000 });
    expect(await loop.runOnce()).toBe(true);
    expect(await loop.runOnce()).toBe(false);

    const commands = await pool.query<{ dedup_id: string; payload: { offerId: string; source: string } }>(
      `SELECT dedup_id, payload FROM commands WHERE workshop_id = $1`,
      [f.wsId],
    );
    expect(commands.rows).toHaveLength(1);
    expect(commands.rows[0]?.dedup_id).toBe(`tick#due#${past}`);
    expect(commands.rows[0]?.payload).toMatchObject({ type: 'TICK', source: 'TIMER', offerId: 'due', expiresAt: past });
    expect(await count(pool, 'timers', `offer_id = 'due' AND fired`)).toBe(1);
    expect(await count(pool, 'timers', `offer_id = 'later' AND NOT fired`)).toBe(1);
  });

  test('worker: processes the queue in order; a tick after expiry relays the seat', async () => {
    await pool.query('TRUNCATE commands, timers');
    const f = await createFixture(pool, { holdSeconds: 30 });
    const worker = createWorker({
      ...f,
      clock: systemClock,
      ids: uuidIdGen,
      logger: testLogger,
      metrics: f.ports.metrics,
      config: { pollMs: 10, maxAttempts: 3, retryBackoffMs: 0, faultInjection: true },
    });
    expect(await worker.processNext()).toBeUndefined();

    const aliceRegisters = command('REGISTER', f.wsId, alice, { acceptable: [f.s1] });
    const bobRegisters = command('REGISTER', f.wsId, bob, { acceptable: [f.s1] });
    for (const cmd of [aliceRegisters, bobRegisters]) {
      await accept(f.store, cmd);
      await f.queue.enqueue(cmd);
    }
    expect(await worker.processNext()).toMatchObject({ type: 'REGISTER', outcome: 'APPLIED', deliveryAttempt: 1 });
    expect(await worker.processNext()).toMatchObject({ type: 'REGISTER', outcome: 'APPLIED' });
    expect(await worker.processNext()).toBeUndefined();
    let snapshot = await snapshotOf(f.store, f.wsId);
    expect(snapshot.registrations.map((r) => [r.userId, r.status])).toEqual([
      ['alice', 'OFFERED'],
      ['bob', 'QUEUED'],
    ]);
    expect(await count(pool, 'commands', `status = 'DONE'`)).toBe(2);

    // Simulate the hold elapsing: fire the timer now and process the TICK.
    const offer = snapshot.offers[0]!;
    await pool.query(`UPDATE timers SET fire_at = now() - interval '1 second' WHERE offer_id = $1`, [offer.id]);
    await pool.query(`UPDATE offers SET expires_at = now() - interval '1 second' WHERE id = $1`, [offer.id]);
    const timerLoop = createTimerLoop({ pool, logger: testLogger, pollMs: 1000 });
    expect(await timerLoop.runOnce()).toBe(true);
    expect(await worker.processNext()).toMatchObject({ type: 'TICK', outcome: 'APPLIED' });
    snapshot = await snapshotOf(f.store, f.wsId);
    expect(snapshot.registrations.map((r) => [r.userId, r.status])).toEqual([['bob', 'OFFERED']]);
    expect(await f.store.getArchivedOffer(f.wsId, offer.id)).toMatchObject({ status: 'EXPIRED' });
    const backfills = await f.store.listBackfills(f.wsId);
    expect(backfills.map((b) => [b.cause, b.newUserId])).toEqual([['EXPIRED', 'bob']]);
    const history = await f.store.listHistory(f.wsId);
    expect(history.registrations.map((r) => [r.userId, r.status, r.endReason])).toEqual([
      ['alice', 'ENDED', 'NO_ACCEPTABLE_SESSION'],
    ]);
  });

  test('worker: fault flags — BEFORE_COMMIT rolls back and retries, AFTER_COMMIT keeps the commit and acks the redelivery', async () => {
    await pool.query('TRUNCATE commands, timers');
    const f = await createFixture(pool);
    const worker = createWorker({
      ...f,
      clock: systemClock,
      ids: uuidIdGen,
      logger: testLogger,
      metrics: f.ports.metrics,
      config: { pollMs: 10, maxAttempts: 3, retryBackoffMs: 0, faultInjection: true },
    });

    const before = command('REGISTER', f.wsId, alice, { acceptable: [f.s1], _fault: 'BEFORE_COMMIT' });
    await accept(f.store, before);
    await f.queue.enqueue(before);
    expect(await worker.processNext()).toMatchObject({ outcome: 'RETRY', deliveryAttempt: 1 });
    expect((await snapshotOf(f.store, f.wsId)).registrations).toHaveLength(0);
    expect(await count(pool, 'timers', 'workshop_id = $1', [f.wsId])).toBe(0);
    expect(await count(pool, 'commands', `status = 'PENDING' AND attempts = 1`)).toBe(1);
    expect(await worker.processNext()).toMatchObject({ outcome: 'APPLIED', deliveryAttempt: 2 });
    expect((await snapshotOf(f.store, f.wsId)).registrations).toHaveLength(1);

    const after = command('REGISTER', f.wsId, bob, { acceptable: [f.s2], _fault: 'AFTER_COMMIT' });
    await accept(f.store, after);
    await f.queue.enqueue(after);
    expect(await worker.processNext()).toMatchObject({ outcome: 'RETRY', deliveryAttempt: 1 });
    expect((await f.store.getCommandResult(after.commandId))?.status).toBe('APPLIED');
    expect((await snapshotOf(f.store, f.wsId)).registrations).toHaveLength(2);
    expect(await worker.processNext()).toMatchObject({ outcome: 'ALREADY_SETTLED', deliveryAttempt: 2 });
    expect((await snapshotOf(f.store, f.wsId)).registrations).toHaveLength(2);
    expect(await count(pool, 'commands', `status = 'DONE'`)).toBe(2);
    expect(await count(pool, 'commands', `status <> 'DONE'`)).toBe(0);
  });

  test('worker: an invalid payload is parked as FAILED without blocking the workshop', async () => {
    await pool.query('TRUNCATE commands, timers');
    const f = await createFixture(pool);
    await pool.query(`INSERT INTO commands (workshop_id, payload) VALUES ($1, '{"type":"NOPE"}')`, [f.wsId]);
    const register = command('REGISTER', f.wsId, carol, { acceptable: [f.s1] });
    await accept(f.store, register);
    await f.queue.enqueue(register);
    const worker = createWorker({
      ...f,
      clock: systemClock,
      ids: uuidIdGen,
      logger: testLogger,
      metrics: f.ports.metrics,
      config: { pollMs: 10, maxAttempts: 3, retryBackoffMs: 0, faultInjection: false },
    });
    expect(await worker.processNext()).toMatchObject({ outcome: 'INVALID' });
    expect(await worker.processNext()).toMatchObject({ outcome: 'APPLIED' });
    expect(await count(pool, 'commands', `status = 'FAILED'`)).toBe(1);
  });

  test('notifier: SKIPPED without a mailer, SENT with one, FAILED after the attempts are exhausted', async () => {
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, alice, { acceptable: [f.s1] });
    await accept(f.store, register);
    await processCommand(f.ports, register);
    expect(await count(pool, 'notifications', `workshop_id = $1 AND status = 'PENDING'`, [f.wsId])).toBe(1);

    const skipping = createNotifier({ pool, logger: testLogger, metrics: f.ports.metrics, pollMs: 1000, maxAttempts: 3 });
    const skipped = await skipping.processBatch();
    expect(skipped.skipped).toBeGreaterThanOrEqual(1);
    expect(await count(pool, 'notifications', `workshop_id = $1 AND status = 'SKIPPED'`, [f.wsId])).toBe(1);

    const sent: string[] = [];
    await pool.query(`UPDATE notifications SET status = 'PENDING', attempts = 0 WHERE workshop_id = $1`, [f.wsId]);
    const sending = createNotifier({
      pool,
      logger: testLogger,
      metrics: f.ports.metrics,
      pollMs: 1000,
      maxAttempts: 3,
      mailer: {
        send: async (message) => {
          sent.push(message.to);
        },
      },
    });
    expect((await sending.processBatch()).sent).toBe(1);
    expect(sent).toEqual(['alice@example.com']);
    expect(await count(pool, 'notifications', `workshop_id = $1 AND status = 'SENT' AND sent_at IS NOT NULL`, [f.wsId])).toBe(1);

    await pool.query(`UPDATE notifications SET status = 'PENDING', attempts = 0 WHERE workshop_id = $1`, [f.wsId]);
    const failing = createNotifier({
      pool,
      logger: testLogger,
      metrics: f.ports.metrics,
      pollMs: 1000,
      maxAttempts: 2,
      mailer: {
        send: async () => {
          throw new Error('smtp down');
        },
      },
    });
    expect(await failing.processBatch()).toMatchObject({ retried: 1, failed: 0 });
    expect(await failing.processBatch()).toMatchObject({ retried: 0, failed: 1 });
    expect(await count(pool, 'notifications', `workshop_id = $1 AND status = 'FAILED' AND attempts = 2`, [f.wsId])).toBe(1);
  });

  test('command results: conditional insert, rollback delete, notifications read marker, attendance', async () => {
    const f = await createFixture(pool);
    const register = command('REGISTER', f.wsId, alice, { acceptable: [f.s1] });
    const { acceptedCommandResult } = await import('@seatrelay/service');
    const record = acceptedCommandResult(register, systemClock.now());
    expect(await f.store.putCommandAccepted(record)).toEqual({ created: true });
    expect(await f.store.putCommandAccepted(record)).toEqual({ created: false, existing: record });
    await f.store.deleteCommandIfAccepted(record.commandId);
    expect(await f.store.getCommandResult(record.commandId)).toBeUndefined();

    await accept(f.store, register);
    await processCommand(f.ports, register);
    await f.store.deleteCommandIfAccepted(register.commandId); // settled: must stay
    expect((await f.store.getCommandResult(register.commandId))?.status).toBe('APPLIED');

    const [notification] = await f.store.listNotificationsForUser('alice');
    const readAt = systemClock.now();
    expect(await f.store.markNotificationRead('bob', notification!.id, readAt)).toBeUndefined();
    expect((await f.store.markNotificationRead('alice', notification!.id, readAt))?.readAt).toBe(readAt);

    const attendance = { workshopId: f.wsId, userId: 'alice', attended: true, markedAt: readAt, markedBy: 'organiser' };
    await f.store.putAttendance(attendance);
    await f.store.putAttendance({ ...attendance, attended: false });
    expect(await f.store.listAttendance(f.wsId)).toEqual([{ ...attendance, attended: false }]);
  });

  test('user directory: identities seen in tokens resolve by e-mail', async () => {
    const users = new PostgresUserDirectory(pool, 0);
    await users.touch({ userId: 'u-1', email: 'Dave@Example.com', name: 'Dave' });
    expect(await users.findUserIdByEmail('dave@example.com')).toBe('u-1');
    expect(await users.findUserIdByEmail('nobody@example.com')).toBeUndefined();
  });
});
