import { randomUUID } from 'node:crypto';
import {
  buildCommand,
  type CommandAcceptedView,
  type CommandResultView,
  type DashboardView,
  type MyRegistrationListView,
  type VerifyView,
} from '@seatrelay/contracts';
import {
  MAX_ITEMS_PER_DECISION,
  addMinutes,
  addSeconds,
  estimateCommitItems,
} from '@seatrelay/core';
import { describe, expect, test } from 'vitest';
import {
  FaultInjectedError,
  VersionConflictError,
  commandDedupId,
  processCommand,
  tickForTimer,
} from '../src/index';
import {
  T0,
  accepted,
  alice,
  bob,
  bodyOf,
  call,
  carol,
  dave,
  scenario,
  workshopInput,
} from './helpers';

async function commandView(
  ports: Awaited<ReturnType<typeof scenario>>['ports'],
  commandId: string,
  user = bob,
): Promise<CommandResultView> {
  const response = await call(ports, 'GET', `/commands/${commandId}`, { user });
  expect(response.status).toBe(200);
  return bodyOf<CommandResultView>(response);
}

describe('processCommand: happy path', () => {
  test('register → offer → accept → confirmed, with timers, notifications and metrics', async () => {
    const { ports, orgId, wsId, s1, s2 } = await scenario();
    const { commandId } = await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1, s2],
    });
    ports.clock.advance(250);
    const drained = await ports.drain();
    expect(drained.map((entry) => entry.result.outcome)).toEqual(['APPLIED']);
    expect(drained[0]?.result.attempts).toBe(1);

    const settledAt = addSeconds(T0, 0.25);
    const registered = await commandView(ports, commandId);
    expect(registered).toEqual({
      commandId,
      type: 'REGISTER',
      workshopId: wsId,
      status: 'APPLIED',
      acceptedAt: T0,
      settledAt,
      result: {
        offersCreated: 1,
        registration: {
          status: 'OFFERED',
          seq: 1,
          acceptable: [s1, s2],
          currentOffer: {
            id: expect.any(String),
            sessionId: s1,
            expiresAt: addSeconds(settledAt, 60),
          },
        },
      },
    });
    const offerId = registered.result?.registration?.currentOffer?.id ?? '';
    expect(ports.timers.scheduled).toEqual([
      { wsId, timer: { offerId, expiresAt: addSeconds(settledAt, 60) } },
    ]);
    expect(ports.metrics.of('CommandSettledLatency')).toEqual([250]);
    expect(ports.metrics.of('OffersCreated')).toEqual([1]);
    expect(ports.metrics.of('OffersExpired')).toEqual([0]);
    expect(await ports.store.listNotificationsForUser(bob.userId)).toMatchObject([
      {
        kind: 'OFFER',
        offerId,
        status: 'PENDING',
        attempts: 0,
        userId: bob.userId,
        email: bob.email,
      },
    ]);
    const workshop = await ports.store.getWorkshop(wsId);
    expect(workshop).toMatchObject({ seq: 1, version: 1, nextDueAt: addSeconds(settledAt, 60) });

    const accept = await accepted(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId });
    await ports.drain();
    expect(await commandView(ports, accept.commandId)).toMatchObject({
      status: 'APPLIED',
      result: {
        offersCreated: 0,
        registration: { status: 'CONFIRMED', seq: 1, confirmedSessionId: s1 },
      },
    });
    const snapshot = await ports.store.loadSnapshot(wsId);
    expect(snapshot?.sessions.find((session) => session.id === s1)).toMatchObject({
      confirmed: 1,
      held: 0,
    });
    expect(snapshot?.offers).toEqual([]);
    expect(snapshot?.workshop.version).toBe(2);
    expect(snapshot?.workshop.nextDueAt).toBeUndefined();

    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.confirmed).toEqual([
      {
        seq: 1,
        userId: bob.userId,
        email: bob.email,
        displayName: 'Bob',
        status: 'CONFIRMED',
        sessionId: s1,
        confirmedAt: settledAt,
      },
    ]);
    expect(dashboard.counts).toEqual({
      queued: 0,
      offered: 0,
      confirmed: 1,
      backfills: 0,
      backfillsReallocated: 0,
      attended: 0,
    });
    expect(dashboard.distinctParticipantsServed).toBe(1);

    const verify = bodyOf<VerifyView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/verify`, { user: alice }),
    );
    expect(verify).toEqual({ ok: true, checkedAt: settledAt, violations: [] });

    const mine = bodyOf<MyRegistrationListView>(
      await call(ports, 'GET', '/me/registrations', { user: bob }),
    );
    expect(mine.registrations).toHaveLength(1);
    expect(mine.registrations[0]?.registration).toMatchObject({
      status: 'CONFIRMED',
      confirmedSessionId: s1,
      createdAt: settledAt,
    });
    expect(mine.registrations[0]?.workshop.id).toBe(wsId);
  });

  test('a second registrant backfills the seat released by a cancel in the same decision', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    ports.clock.advanceSeconds(10);
    const cancel = await accepted(ports, bob, wsId, { type: 'CANCEL_REGISTRATION' });
    const [entry] = await ports.drain();
    expect(entry?.result.outcome).toBe('APPLIED');
    expect(entry?.result.decision?.backfills).toMatchObject([
      { cause: 'CANCELLED_OFFER', sessionId: s1, newUserId: carol.userId, latencyMs: 0 },
    ]);
    expect(ports.metrics.of('BackfillLatency')).toEqual([0]);
    expect(await commandView(ports, cancel.commandId)).toMatchObject({
      status: 'APPLIED',
      result: { offersCreated: 1, registration: { status: 'CANCELLED' } },
    });
    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.offered.map((entry) => entry.userId)).toEqual([carol.userId]);
    expect(dashboard.counts.backfillsReallocated).toBe(1);
  });
});

describe('processCommand: deterministic rejections never throw', () => {
  test('unknown offer, duplicate registration and CLOSED workshop settle as REJECTED', async () => {
    const { ports, wsId, s1 } = await scenario();
    const ghost = await accepted(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId: 'nope' });
    const first = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    const duplicate = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    const close = await accepted(ports, alice, wsId, { type: 'CLOSE_REGISTRATION' });
    const late = await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    const bogus = await accepted(ports, alice, wsId, {
      type: 'SET_CAPACITY',
      sessionId: s1,
      capacity: 0,
    });

    const outcomes = (await ports.drain()).map((entry) => entry.result.outcome);
    expect(outcomes).toEqual([
      'REJECTED',
      'APPLIED',
      'REJECTED',
      'APPLIED',
      'REJECTED',
      'REJECTED',
    ]);

    expect(await commandView(ports, ghost.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_FOUND',
    });
    expect(await commandView(ports, first.commandId)).toMatchObject({ status: 'APPLIED' });
    expect(await commandView(ports, duplicate.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'ALREADY_REGISTERED',
    });
    expect(await commandView(ports, close.commandId, alice)).toMatchObject({ status: 'APPLIED' });
    expect(await commandView(ports, late.commandId, carol)).toMatchObject({
      status: 'REJECTED',
      reason: 'WORKSHOP_NOT_OPEN',
    });
    expect(await commandView(ports, bogus.commandId, alice)).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_CAPACITY',
    });
    // Rejections with no tick-first effect do not bump the version.
    expect((await ports.store.getWorkshop(wsId))?.version).toBe(2);
    expect(ports.metrics.of('CommandSettledLatency')).toHaveLength(6);
  });

  test('an organiser command injected behind the API by a non-member is REJECTED(FORBIDDEN)', async () => {
    const { ports, wsId, s1 } = await scenario();
    const command = buildCommand(
      { type: 'SET_CAPACITY', commandId: randomUUID(), sessionId: s1, capacity: 9 },
      wsId,
      bob,
    );
    const result = await processCommand(ports, command);
    expect(result.outcome).toBe('REJECTED');
    expect(result.decision?.reason).toBe('FORBIDDEN');
    expect(await ports.store.getCommandResult(command.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'FORBIDDEN',
      acceptedAt: T0,
      settledAt: T0,
    });
    expect((await ports.store.loadSnapshot(wsId))?.sessions[0]?.capacity).toBe(1);
  });

  test('a command for an unknown workshop is dropped as NOOP', async () => {
    const { ports, s1 } = await scenario();
    const command = buildCommand(
      { type: 'REGISTER', commandId: randomUUID(), acceptable: [s1] },
      'missing',
      bob,
    );
    await expect(processCommand(ports, command)).resolves.toMatchObject({ outcome: 'NOOP' });
  });
});

describe('processCommand: optimistic lock', () => {
  test('VERSION conflict reloads the snapshot and retries', async () => {
    const { ports, wsId, s1 } = await scenario();
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    let conflicts = 0;
    ports.store.beforeCommit = () => {
      if (conflicts < 2) {
        conflicts += 1;
        ports.store.bumpVersion(wsId); // another writer got in between load and commit
      }
    };
    const [entry] = await ports.drain();
    expect(entry?.result).toMatchObject({ outcome: 'APPLIED', attempts: 3 });
    expect(ports.metrics.of('MetaConflictRetries')).toEqual([1, 1]);
    const workshop = await ports.store.getWorkshop(wsId);
    expect(workshop?.version).toBe(3); // 2 bumps + the committed decision
    expect((await ports.store.loadSnapshot(wsId))?.registrations).toHaveLength(1);
    expect(ports.timers.scheduled).toHaveLength(3); // scheduled before every commit attempt: harmless
  });

  test('gives up after maxVersionRetries and throws VersionConflictError', async () => {
    const { ports, wsId, s1 } = await scenario();
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    ports.store.beforeCommit = () => ports.store.bumpVersion(wsId);
    await expect(ports.drain()).rejects.toBeInstanceOf(VersionConflictError);
    expect(ports.metrics.of('MetaConflictRetries')).toEqual([1, 1, 1, 1]);
    expect((await ports.store.loadSnapshot(wsId))?.registrations).toEqual([]);

    const command = buildCommand(
      { type: 'REGISTER', commandId: randomUUID(), acceptable: [s1] },
      wsId,
      carol,
    );
    ports.metrics.clear();
    await expect(processCommand(ports, command, { maxVersionRetries: 1 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect(ports.metrics.of('MetaConflictRetries')).toEqual([1, 1]);
  });
});

describe('processCommand: fault injection and redelivery', () => {
  test('AFTER_COMMIT: effects are committed once; the redelivery is acknowledged', async () => {
    const { ports, wsId, s1 } = await scenario();
    const { commandId } = await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'AFTER_COMMIT',
    });
    await expect(ports.drain({ faultInjection: true })).rejects.toBeInstanceOf(FaultInjectedError);
    expect(await commandView(ports, commandId)).toMatchObject({ status: 'APPLIED' });
    expect((await ports.store.loadSnapshot(wsId))?.registrations).toHaveLength(1);

    const message = buildCommand(
      { type: 'REGISTER', commandId, acceptable: [s1], _fault: 'AFTER_COMMIT' },
      wsId,
      bob,
    );
    const redelivery = await processCommand(ports, message, {
      faultInjection: true,
      deliveryAttempt: 2,
    });
    expect(redelivery).toEqual({ outcome: 'ALREADY_SETTLED', attempts: 0 });
    const snapshot = await ports.store.loadSnapshot(wsId);
    expect(snapshot?.registrations).toHaveLength(1);
    expect(snapshot?.workshop).toMatchObject({ seq: 1, version: 1 });
    expect(ports.store.commits).toBe(1);
    expect(ports.timers.scheduled).toHaveLength(1);
    expect(await ports.store.listNotificationsForUser(bob.userId)).toHaveLength(1);
  });

  test('redelivery emulation: the harness retries a failed message and then succeeds', async () => {
    const { ports, wsId, s1 } = await scenario();
    const { commandId } = await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'AFTER_COMMIT',
    });
    const processed = await ports.drain({ faultInjection: true, onError: 'redeliver' });
    expect(processed.map((entry) => [entry.deliveryAttempt, entry.result.outcome])).toEqual([
      [2, 'ALREADY_SETTLED'],
    ]);
    expect(ports.deadLetters).toEqual([]);
    expect(await commandView(ports, commandId)).toMatchObject({ status: 'APPLIED' });
  });

  test('COMMAND_ALREADY_SETTLED from the commit itself (settled between load and commit)', async () => {
    const { ports, wsId, s1 } = await scenario();
    const { commandId } = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    const message = ports.queue.dequeue();
    if (message === undefined) {
      throw new Error('expected a message');
    }
    ports.store.beforeCommit = async () => {
      ports.store.beforeCommit = undefined;
      await processCommand(ports, message); // the "other" worker settles it first
    };
    const result = await processCommand(ports, message);
    expect(result.outcome).toBe('ALREADY_SETTLED');
    expect(result.attempts).toBe(1);
    expect(ports.store.commits).toBe(1);
    expect((await ports.store.loadSnapshot(wsId))?.registrations).toHaveLength(1);
    expect(await commandView(ports, commandId)).toMatchObject({ status: 'APPLIED' });
  });

  test('BEFORE_COMMIT: nothing is committed; the redelivery applies the command', async () => {
    const { ports, wsId, s1 } = await scenario();
    const { commandId } = await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'BEFORE_COMMIT',
    });
    await expect(ports.drain({ faultInjection: true })).rejects.toMatchObject({
      fault: 'BEFORE_COMMIT',
    });
    expect(await commandView(ports, commandId)).toMatchObject({ status: 'ACCEPTED' });
    expect((await ports.store.loadSnapshot(wsId))?.registrations).toEqual([]);
    expect(ports.timers.scheduled).toHaveLength(1); // sent before the commit; a harmless extra tick

    const message = buildCommand(
      { type: 'REGISTER', commandId, acceptable: [s1], _fault: 'BEFORE_COMMIT' },
      wsId,
      bob,
    );
    const redelivery = await processCommand(ports, message, {
      faultInjection: true,
      deliveryAttempt: 2,
    });
    expect(redelivery.outcome).toBe('APPLIED');
    expect(await commandView(ports, commandId)).toMatchObject({ status: 'APPLIED' });
  });

  test('TIMER_SEND fires at the timer-scheduling point even when the decision creates no timer', async () => {
    const { ports, wsId, s1 } = await scenario();
    const register = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const offerId =
      (await commandView(ports, register.commandId)).result?.registration?.currentOffer?.id ?? '';
    const accept = await accepted(ports, bob, wsId, {
      type: 'ACCEPT_OFFER',
      offerId,
      _fault: 'TIMER_SEND',
    });
    await expect(ports.drain({ faultInjection: true })).rejects.toMatchObject({
      fault: 'TIMER_SEND',
    });
    expect(await commandView(ports, accept.commandId)).toMatchObject({ status: 'ACCEPTED' });
    const message = buildCommand(
      { type: 'ACCEPT_OFFER', commandId: accept.commandId, offerId, _fault: 'TIMER_SEND' },
      wsId,
      bob,
    );
    await expect(
      processCommand(ports, message, { faultInjection: true, deliveryAttempt: 2 }),
    ).resolves.toMatchObject({ outcome: 'APPLIED' });
  });

  test('a REALLOCATE continuation lost after the commit is recovered by the redelivery itself', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    for (let i = 1; i <= 16; i += 1) {
      await accepted(ports, { userId: `u${i}`, email: `u${i}@example.com` }, wsId, {
        type: 'REGISTER',
        acceptable: [s1],
      });
    }
    await ports.drain(); // 1 OFFERED, 15 QUEUED
    ports.metrics.clear();
    const { commandId } = await accepted(ports, alice, wsId, {
      type: 'SET_CAPACITY',
      sessionId: s1,
      capacity: 20,
      _fault: 'AFTER_COMMIT',
    });
    // The first delivery commits 12 offers and crashes before enqueueing the continuation;
    // the redelivery is acknowledged as already settled AND converges the workshop.
    const processed = await ports.drain({ faultInjection: true, onError: 'redeliver' });
    expect(
      processed.map((entry) => [entry.command.type, entry.deliveryAttempt, entry.result.outcome]),
    ).toEqual([['SET_CAPACITY', 2, 'ALREADY_SETTLED']]);
    expect(ports.deadLetters).toEqual([]);
    expect(await commandView(ports, commandId, alice)).toMatchObject({ status: 'APPLIED' });
    const snapshot = await ports.store.loadSnapshot(wsId);
    expect(snapshot?.registrations.filter((r) => r.status === 'QUEUED')).toEqual([]);
    expect(snapshot?.sessions[0]).toMatchObject({ capacity: 20, held: 16 });
    const verify = bodyOf<VerifyView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/verify`, { user: alice }),
    );
    expect(verify.ok).toBe(true);
    expect(ports.logger.entries.some((entry) => entry.message.includes('convergence pass'))).toBe(
      true,
    );
    // the 3 seats the lost continuation would have relayed are still attributed to the raise
    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.counts).toMatchObject({ queued: 0, offered: 16 });
    expect(dashboard.backfills.filter((b) => b.cause === 'CAPACITY_UP')).toHaveLength(12);
    // a redelivery of a settled command on an idle workshop is a plain ack (no commit)
    const commits = ports.store.commits;
    const again = buildCommand(
      { type: 'SET_CAPACITY', commandId, sessionId: s1, capacity: 20 },
      wsId,
      alice,
    );
    expect(await processCommand(ports, again, { deliveryAttempt: 3 })).toEqual({
      outcome: 'ALREADY_SETTLED',
      attempts: 0,
    });
    expect(ports.store.commits).toBe(commits);
  });

  test('a lost continuation is also covered by the sweep: nextDueAt is `now` while a chain is pending', async () => {
    const { ports, wsId, s1 } = await scenario();
    for (let i = 1; i <= 16; i += 1) {
      await accepted(ports, { userId: `u${i}`, email: `u${i}@example.com` }, wsId, {
        type: 'REGISTER',
        acceptable: [s1],
      });
    }
    await ports.drain();
    await accepted(ports, alice, wsId, { type: 'SET_CAPACITY', sessionId: s1, capacity: 20 });
    const message = ports.queue.dequeue()!;
    ports.queue.failNextEnqueue = true; // the continuation enqueue fails after the commit
    await expect(processCommand(ports, message)).rejects.toThrow('injected queue failure');
    expect((await ports.store.getWorkshop(wsId))?.nextDueAt).toBe(ports.clock.now());
    expect(ports.queue.size).toBe(0);
    expect((await ports.sweep()).workshopIds).toEqual([wsId]);
    await ports.drain();
    const snapshot = await ports.store.loadSnapshot(wsId);
    expect(snapshot?.registrations.filter((r) => r.status === 'QUEUED')).toEqual([]);
    expect(snapshot?.workshop.nextDueAt).toBe(addSeconds(T0, 60));
  });

  test('TIMER_SEND: thrown instead of scheduling; nothing committed; redelivery applies', async () => {
    const { ports, wsId, s1 } = await scenario();
    const { commandId } = await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'TIMER_SEND',
    });
    await expect(ports.drain({ faultInjection: true })).rejects.toMatchObject({
      fault: 'TIMER_SEND',
    });
    expect(ports.timers.scheduled).toEqual([]);
    expect(ports.store.commits).toBe(0);
    const message = buildCommand(
      { type: 'REGISTER', commandId, acceptable: [s1], _fault: 'TIMER_SEND' },
      wsId,
      bob,
    );
    await expect(
      processCommand(ports, message, { faultInjection: true, deliveryAttempt: 2 }),
    ).resolves.toMatchObject({ outcome: 'APPLIED' });
    expect(ports.timers.scheduled).toHaveLength(1);
  });

  test('fault flags are ignored unless faultInjection is enabled', async () => {
    const { ports, wsId, s1 } = await scenario();
    await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'BEFORE_COMMIT',
    });
    const [entry] = await ports.drain();
    expect(entry?.result.outcome).toBe('APPLIED');
  });
});

describe('processCommand: ticks, expiry, sweep and continuations', () => {
  test('a timer TICK expires the offer, backfills the queue and reports latency', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    ports.metrics.clear();

    ports.clock.advanceSeconds(30);
    expect(await ports.fireDueTimers()).toEqual([]); // not due yet

    ports.clock.advanceSeconds(31); // 61 s after the offer: 1 s past expiresAt
    const [tick] = await ports.fireDueTimers();
    expect(tick?.command).toMatchObject({ type: 'TICK', source: 'TIMER', workshopId: wsId });
    expect(tick?.result.outcome).toBe('APPLIED');
    expect(ports.metrics.of('OffersExpired')).toEqual([1]);
    expect(ports.metrics.of('OffersCreated')).toEqual([1]);
    expect(ports.metrics.of('BackfillLatency')).toEqual([1000]);
    expect(ports.metrics.of('SweepLateExpiries')).toEqual([]);
    expect(ports.metrics.of('CommandSettledLatency')).toEqual([]); // internal command

    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.offered.map((entry) => entry.userId)).toEqual([carol.userId]);
    expect(dashboard.backfills).toMatchObject([
      {
        cause: 'EXPIRED',
        sessionId: s1,
        releasedAt: addSeconds(T0, 60),
        reallocatedAt: addSeconds(T0, 61),
        newUserId: carol.userId,
        latencyMs: 1000,
      },
    ]);
    expect(dashboard.queue).toEqual([]);
    expect(await ports.store.listNotificationsForUser(bob.userId)).toMatchObject([
      { kind: 'OFFER' },
      { kind: 'EXPIRED' },
    ]);
    const history = await ports.store.listHistory(wsId);
    expect(history.offers).toMatchObject([{ userId: bob.userId, status: 'EXPIRED' }]);
    expect(history.registrations).toMatchObject([
      { userId: bob.userId, status: 'ENDED', endReason: 'NO_ACCEPTABLE_SESSION' },
    ]);
    // A late duplicate of the same timer is a harmless no-op.
    const stale = tickForTimer(wsId, { offerId: 'id-x', expiresAt: addSeconds(T0, 60) });
    expect(await processCommand(ports, stale)).toMatchObject({ outcome: 'NOOP' });
    expect(commandDedupId(stale)).toBe(`tick#id-x#${addSeconds(T0, 60)}`);
  });

  test('a TICK on an idle workshop is a NOOP without a commit', async () => {
    const { ports, wsId } = await scenario();
    const result = await processCommand(ports, { type: 'TICK', workshopId: wsId });
    expect(result.outcome).toBe('NOOP');
    expect(ports.store.commits).toBe(0);
    expect((await ports.store.getWorkshop(wsId))?.version).toBe(0);
  });

  test('sweep ticks only due workshops and counts late expiries', async () => {
    const { ports, wsId, s1 } = await scenario();
    const other = await scenario({}, undefined);
    void other;
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    ports.metrics.clear();

    ports.clock.advanceSeconds(30);
    expect((await ports.sweep()).workshopIds).toEqual([]);

    ports.clock.advanceSeconds(200); // 230 s after the offer: timer path "failed", 170 s late
    expect((await ports.sweep()).workshopIds).toEqual([wsId]);
    expect(ports.queue.messages).toEqual([{ type: 'TICK', workshopId: wsId, source: 'SWEEP' }]);
    const [entry] = await ports.drain();
    expect(entry?.result.outcome).toBe('APPLIED');
    expect(ports.metrics.of('OffersExpired')).toEqual([1]);
    expect(ports.metrics.of('SweepLateExpiries')).toEqual([1]);

    // Nothing pending any more: the sweep finds nothing, and a manual sweep tick reports 0.
    expect((await ports.sweep()).workshopIds).toEqual([]);
    await processCommand(ports, { type: 'TICK', workshopId: wsId, source: 'SWEEP' });
    expect(ports.metrics.of('SweepLateExpiries')).toEqual([1, 0]);
  });

  test('a sweep expiry within the 60 s grace is not counted as late', async () => {
    const { ports, wsId, s1 } = await scenario();
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    ports.clock.advanceSeconds(90); // 30 s after expiresAt
    await ports.sweep();
    await ports.drain();
    expect(ports.metrics.of('OffersExpired')).toEqual([0, 1]);
    expect(ports.metrics.of('SweepLateExpiries')).toEqual([0]);
  });

  test('more than 12 allocations in one decision continue in an enqueued REALLOCATE', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    const users = Array.from({ length: 16 }, (_, i) => ({
      userId: `u${i + 1}`,
      email: `u${i + 1}@example.com`,
    }));
    for (const user of users) {
      await accepted(ports, user, wsId, { type: 'REGISTER', acceptable: [s1] });
    }
    await ports.drain();
    expect(
      (await ports.store.loadSnapshot(wsId))?.registrations.filter((r) => r.status === 'QUEUED'),
    ).toHaveLength(15);

    const { commandId } = await accepted(ports, alice, wsId, {
      type: 'SET_CAPACITY',
      sessionId: s1,
      capacity: 20,
    });
    const message = ports.queue.dequeue();
    if (message === undefined) {
      throw new Error('expected the SET_CAPACITY message');
    }
    const result = await processCommand(ports, message);
    expect(result.outcome).toBe('APPLIED');
    expect(result.decision?.metrics.offersCreated).toBe(12);
    expect(result.decision?.continuation).toEqual({
      type: 'REALLOCATE',
      workshopId: wsId,
      pendingCapacityUp: [{ sessionId: s1, seats: 7 }],
    });
    expect(ports.queue.messages).toEqual([result.decision?.continuation]);
    expect(await commandView(ports, commandId, alice)).toMatchObject({
      status: 'APPLIED',
      result: { offersCreated: 12 },
    });

    const rest = await ports.drain();
    expect(rest.map((entry) => [entry.command.type, entry.result.outcome])).toEqual([
      ['REALLOCATE', 'APPLIED'],
    ]);
    expect(rest[0]?.result.decision?.metrics.offersCreated).toBe(3);
    expect(rest[0]?.result.decision?.continuation).toBeUndefined();

    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.counts).toMatchObject({
      queued: 0,
      offered: 16,
      backfills: 15,
      backfillsReallocated: 15,
    });
    expect(
      dashboard.backfills.every(
        (record) => record.cause === 'CAPACITY_UP' && record.latencyMs === 0,
      ),
    ).toBe(true);
    expect(ports.timers.scheduled).toHaveLength(16);
    const verify = bodyOf<VerifyView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/verify`, { user: alice }),
    );
    expect(verify.ok).toBe(true);
    expect(await ports.store.listDueWorkshops(addSeconds(T0, 60))).toMatchObject([{ id: wsId }]);
  });

  test('the ACCEPT after expiresAt is REJECTED(OFFER_EXPIRED) once the timer tick already expired it', async () => {
    const { ports, wsId, s1, s2 } = await scenario();
    const register = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const offerId =
      (await commandView(ports, register.commandId)).result?.registration?.currentOffer?.id ?? '';
    ports.clock.advanceSeconds(60); // exactly expiresAt
    const [tick] = await ports.fireDueTimers();
    expect(tick?.result.outcome).toBe('APPLIED');
    expect(tick?.result.decision?.metrics.offersExpired).toBe(1);
    expect((await ports.store.loadSnapshot(wsId))?.offers.map((o) => o.userId)).toEqual([
      carol.userId,
    ]);
    ports.clock.advance(200);
    const late = await accepted(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId });
    const decline = await accepted(ports, bob, wsId, { type: 'DECLINE_OFFER', offerId });
    const stranger = await accepted(ports, dave, wsId, { type: 'ACCEPT_OFFER', offerId });
    await ports.drain();
    expect(await commandView(ports, late.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_EXPIRED',
    });
    expect(await commandView(ports, decline.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_EXPIRED',
    });
    expect(await commandView(ports, stranger.commandId, dave)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_YOURS',
    });
    // a second answer to an offer that was accepted is "not active", not "not found"
    const carolReg = (await ports.store.loadSnapshot(wsId))?.registrations.find(
      (r) => r.userId === carol.userId,
    );
    const carolOffer = carolReg?.currentOfferId ?? '';
    await accepted(ports, carol, wsId, { type: 'ACCEPT_OFFER', offerId: carolOffer });
    await ports.drain();
    const again = await accepted(ports, carol, wsId, { type: 'ACCEPT_OFFER', offerId: carolOffer });
    const declineAfter = await accepted(ports, carol, wsId, {
      type: 'DECLINE_OFFER',
      offerId: carolOffer,
    });
    await ports.drain();
    expect(await commandView(ports, again.commandId, carol)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_ACTIVE',
    });
    expect(await commandView(ports, declineAfter.commandId, carol)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_ACTIVE',
    });
    expect((await ports.store.loadSnapshot(wsId))?.settledOffers).toBeUndefined();
    void s2;
  });

  test('every commit of a mass-expiry wave, of user commands in it and of organiser cancels fits the transaction', async () => {
    const sizes: number[] = [];
    const { ports, wsId, s1 } = await scenario(
      {},
      workshopInput({
        sessions: [
          { title: 'Big', startsAt: addMinutes(T0, 24 * 60), capacity: 100 },
          { title: 'Other', startsAt: addMinutes(T0, 26 * 60), capacity: 1 },
        ],
      }),
    );
    ports.store.beforeCommit = (args) => {
      sizes.push(
        estimateCommitItems({ writes: args.writes, notifications: args.notifications }) +
          (args.commandResult === undefined ? -1 : 0),
      );
    };
    for (let i = 1; i <= 200; i += 1) {
      await accepted(ports, { userId: `u${i}`, email: `u${i}@example.com` }, wsId, {
        type: 'REGISTER',
        acceptable: [s1],
      });
    }
    await ports.drain(); // 100 OFFERED, 100 QUEUED
    ports.clock.advanceSeconds(61);
    const wave = await ports.fireDueTimers();
    expect(wave.length).toBeGreaterThan(9);
    expect(
      wave
        .map((entry) => entry.result.decision?.metrics.offersExpired ?? 0)
        .reduce((a, b) => a + b),
    ).toBe(100);
    expect(ports.metrics.of('BackfillLatency')).toHaveLength(100);
    // a REGISTER and an ACCEPT landing in the next wave, then the organiser cancels
    ports.clock.advanceSeconds(61);
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    await accepted(ports, alice, wsId, { type: 'CANCEL_SESSION', sessionId: s1 });
    await ports.drain();
    await accepted(ports, alice, wsId, { type: 'CANCEL_WORKSHOP' });
    await ports.drain();
    expect((await ports.store.getWorkshop(wsId))?.status).toBe('CANCELLED');
    expect(sizes.length).toBeGreaterThan(30);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_ITEMS_PER_DECISION);
    expect(Math.max(...sizes)).toBeLessThan(100);
  });

  test('a release left for the continuation is attributed even when a queued command runs first', async () => {
    // 13 seats: 12 holders expiring at +60 s, one more (dave) still holding; 13 waiting.
    // dave's DECLINE is already in the FIFO when the 12 timer ticks are forwarded, so the
    // DECLINE expires the 12 offers (hitting the offer cap), relays 12 seats and leaves one
    // release pending; the first TICK (ahead of the REALLOCATE) relays that seat.
    const { ports, orgId, wsId, s1 } = await scenario(
      {},
      workshopInput({
        sessions: [
          { title: 'Big', startsAt: addMinutes(T0, 24 * 60), capacity: 13 },
          { title: 'Other', startsAt: addMinutes(T0, 26 * 60), capacity: 1 },
        ],
      }),
    );
    for (let i = 1; i <= 12; i += 1) {
      await accepted(ports, { userId: `u${i}`, email: `u${i}@example.com` }, wsId, {
        type: 'REGISTER',
        acceptable: [s1],
      });
    }
    await ports.drain();
    ports.clock.advanceSeconds(30);
    const daveReg = await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [s1] });
    for (let i = 13; i <= 25; i += 1) {
      await accepted(ports, { userId: `u${i}`, email: `u${i}@example.com` }, wsId, {
        type: 'REGISTER',
        acceptable: [s1],
      });
    }
    await ports.drain();
    const daveOffer =
      (await commandView(ports, daveReg.commandId, dave)).result?.registration?.currentOffer?.id ??
      '';
    ports.clock.advanceSeconds(30); // the 12 first offers expire now
    await accepted(ports, dave, wsId, { type: 'DECLINE_OFFER', offerId: daveOffer });
    for (const tick of ports.timers.dueTicks(ports.clock.now())) {
      await ports.queue.enqueue(tick);
    }
    expect(ports.queue.messages.map((m) => m.type)).toEqual([
      'DECLINE_OFFER',
      ...Array(12).fill('TICK'),
    ]);
    const processed = await ports.drain();
    // The DECLINE fills its item budget with expiries (11 of the 12, 87 items) and relays no
    // seat; the first TICK expires the last one and relays 12 (the offer cap); the second
    // TICK relays the 13th; every later tick and both continuations find nothing to do.
    expect(processed.map((entry) => [entry.command.type, entry.result.outcome])).toEqual([
      ['DECLINE_OFFER', 'APPLIED'],
      ['TICK', 'APPLIED'],
      ['TICK', 'APPLIED'],
      ...Array(10).fill(['TICK', 'NOOP']),
      ['REALLOCATE', 'NOOP'],
      ['REALLOCATE', 'NOOP'],
    ]);
    expect(processed.map((entry) => entry.result.decision?.metrics.offersCreated ?? 0)).toEqual([
      0,
      12,
      1,
      ...Array(12).fill(0),
    ]);
    for (const entry of processed) {
      if (entry.result.decision !== undefined) {
        expect(estimateCommitItems(entry.result.decision)).toBeLessThanOrEqual(
          MAX_ITEMS_PER_DECISION,
        );
      }
    }
    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.counts).toMatchObject({
      queued: 0,
      offered: 13,
      backfills: 13,
      backfillsReallocated: 13,
    });
    expect(ports.metrics.of('BackfillLatency')).toHaveLength(13);
    expect((await ports.store.loadSnapshot(wsId))?.pendingBackfills).toEqual([]);
  });

  test('the ACCEPT after expiresAt loses even when no timer has fired yet', async () => {
    const { ports, wsId, s1 } = await scenario();
    const register = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const offerId =
      (await commandView(ports, register.commandId)).result?.registration?.currentOffer?.id ?? '';
    ports.clock.advanceSeconds(60); // exactly expiresAt
    const late = await accepted(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId });
    await ports.drain();
    expect(await commandView(ports, late.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_EXPIRED',
    });
    expect(ports.timers.pending).toHaveLength(1); // the timer is still to fire: harmless when it does
    expect(await ports.fireDueTimers()).toMatchObject([{ result: { outcome: 'NOOP' } }]);
  });
});

describe('idempotent 202 after settlement', () => {
  test('re-POST of a settled command returns its outcome without re-enqueueing', async () => {
    const { ports, wsId, s1 } = await scenario();
    const first = await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const again = await call(ports, 'POST', `/workshops/${wsId}/commands`, {
      user: dave,
      body: { type: 'REGISTER', commandId: first.commandId, acceptable: [s1] },
    });
    expect(again.status).toBe(202);
    expect(bodyOf<CommandAcceptedView>(again)).toMatchObject({
      status: 'APPLIED',
      pollAfterMs: 300,
    });
    expect(ports.queue.size).toBe(0);
  });
});
