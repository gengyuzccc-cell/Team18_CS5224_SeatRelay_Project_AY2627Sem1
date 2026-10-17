import { randomUUID } from 'node:crypto';
import type {
  CommandAcceptedView,
  CommandResultView,
  ErrorBody,
  HealthView,
  MeView,
  Organization,
  UserCommand,
  VerifyView,
  Workshop,
  WorkshopListView,
  WorkshopPublic,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { addMinutes } from '@seatrelay/core';
import { describe, expect, test } from 'vitest';
import {
  API_ROUTE_TABLE,
  matchRoute,
  normalisePath,
  toWireResponse,
  type Route,
} from '../src/index';
import {
  T0,
  accepted,
  alice,
  bob,
  bodyOf,
  call,
  carol,
  createOrg,
  createWorkshop,
  dave,
  expectError,
  postCommand,
  scenario,
  setup,
  workshopInput,
} from './helpers';

describe('router primitives', () => {
  test('normalisePath strips query strings and trailing slashes', () => {
    expect(normalisePath('/workshops/abc/?x=1')).toBe('/workshops/abc');
    expect(normalisePath('health')).toBe('/health');
    expect(normalisePath('/')).toBe('/');
  });

  test('matchRoute decodes params and ignores method mismatches', () => {
    const routes: Route<unknown>[] = [
      {
        name: 'a',
        method: 'GET',
        pattern: '/a/:id',
        auth: 'none',
        handler: async () => ({ status: 200, headers: {} }),
      },
    ];
    expect(matchRoute(routes, 'get', '/a/x%20y')?.params).toEqual({ id: 'x y' });
    expect(matchRoute(routes, 'POST', '/a/x')).toBeUndefined();
    expect(matchRoute(routes, 'GET', '/a')).toBeUndefined();
    expect(matchRoute(routes, 'GET', '/a/x/y')).toBeUndefined();
  });

  test('the route table covers every plan §2.5 route', () => {
    const keys = API_ROUTE_TABLE.map((route) => `${route.method} ${route.pattern}`);
    expect(keys).toEqual([
      'GET /health',
      'GET /me',
      'GET /me/registrations',
      'GET /me/notifications',
      'POST /me/notifications/:notificationId/read',
      'POST /orgs',
      'POST /orgs/:orgId/members',
      'GET /orgs/:orgId/workshops',
      'POST /orgs/:orgId/workshops',
      'GET /workshops/:wsId',
      'PATCH /workshops/:wsId',
      'POST /workshops/:wsId/commands',
      'GET /commands/:commandId',
      'GET /orgs/:orgId/workshops/:wsId/dashboard',
      'PUT /orgs/:orgId/workshops/:wsId/attendance/:userId',
      'GET /orgs/:orgId/workshops/:wsId/export.csv',
      'GET /orgs/:orgId/workshops/:wsId/verify',
    ]);
  });

  test('toWireResponse serialises JSON bodies and passes strings through', () => {
    expect(toWireResponse({ status: 200, headers: {}, body: { a: 1 } }).body).toBe('{"a":1}');
    expect(toWireResponse({ status: 200, headers: {}, body: 'x,y' }).body).toBe('x,y');
    expect(toWireResponse({ status: 204, headers: {} }).body).toBe('');
  });
});

describe('auth and routing', () => {
  test('GET /health needs no user', async () => {
    const ports = setup({ stage: 'dev' });
    const response = await call(ports, 'GET', '/health');
    expect(response.status).toBe(200);
    expect(bodyOf<HealthView>(response)).toEqual({
      ok: true,
      service: 'seatrelay',
      stage: 'dev',
      time: T0,
    });
  });

  test('401 without a user on every protected route', async () => {
    const ports = setup();
    const protectedCalls: [string, string][] = [
      ['GET', '/me'],
      ['GET', '/me/registrations'],
      ['GET', '/me/notifications'],
      ['POST', '/me/notifications/n1/read'],
      ['POST', '/orgs'],
      ['POST', '/orgs/o/members'],
      ['GET', '/orgs/o/workshops'],
      ['POST', '/orgs/o/workshops'],
      ['PATCH', '/workshops/w'],
      ['POST', '/workshops/w/commands'],
      ['GET', '/commands/c'],
      ['GET', '/orgs/o/workshops/w/dashboard'],
      ['PUT', '/orgs/o/workshops/w/attendance/u'],
      ['GET', '/orgs/o/workshops/w/export.csv'],
      ['GET', '/orgs/o/workshops/w/verify'],
    ];
    for (const [method, path] of protectedCalls) {
      expectError(await call(ports, method, path, { body: {} }), 401, 'UNAUTHORIZED');
    }
  });

  test('404 for unknown routes, wrong methods and unknown resources', async () => {
    const ports = setup();
    expectError(await call(ports, 'GET', '/nope', { user: alice }), 404, 'NOT_FOUND');
    expectError(await call(ports, 'DELETE', '/health'), 404, 'NOT_FOUND');
    expectError(await call(ports, 'GET', '/workshops/missing'), 404, 'NOT_FOUND');
    expectError(await call(ports, 'GET', '/commands/missing', { user: alice }), 404, 'NOT_FOUND');
    expectError(
      await call(ports, 'POST', '/orgs/missing/workshops', { user: alice, body: workshopInput() }),
      404,
      'NOT_FOUND',
    );
  });

  test('errors have the {code, message} body and JSON content type', async () => {
    const ports = setup();
    const response = await call(ports, 'GET', '/me');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) });
  });
});

describe('organisations', () => {
  test('POST /orgs makes the caller owner and member; GET /me lists it', async () => {
    const ports = setup();
    const org = await createOrg(ports, alice, '  NUS Hackers ');
    expect(org).toEqual({
      id: 'id-1',
      name: 'NUS Hackers',
      ownerUserId: alice.userId,
      members: [alice.userId],
      createdAt: T0,
    });
    const me = bodyOf<MeView>(await call(ports, 'GET', '/me', { user: alice }));
    expect(me).toEqual({
      userId: alice.userId,
      email: alice.email,
      name: 'Alice',
      organizations: [org],
    });
    const other = bodyOf<MeView>(await call(ports, 'GET', '/me', { user: carol }));
    expect(other.organizations).toEqual([]);
    expect(other).not.toHaveProperty('name');
  });

  test('members can add members by userId or by email; outsiders get 403', async () => {
    const ports = setup();
    const org = await createOrg(ports, alice);
    ports.userDirectory.register('Carol@example.com', carol.userId);

    expectError(
      await call(ports, 'POST', `/orgs/${org.id}/members`, {
        user: bob,
        body: { userId: bob.userId },
      }),
      403,
      'FORBIDDEN',
    );
    const withBob = await call(ports, 'POST', `/orgs/${org.id}/members`, {
      user: alice,
      body: { userId: bob.userId },
    });
    expect(withBob.status).toBe(200);
    expect(bodyOf<Organization>(withBob).members).toEqual([alice.userId, bob.userId]);

    const withCarol = await call(ports, 'POST', `/orgs/${org.id}/members`, {
      user: bob,
      body: { email: 'carol@example.com' },
    });
    expect(bodyOf<Organization>(withCarol).members).toEqual([
      alice.userId,
      bob.userId,
      carol.userId,
    ]);

    expectError(
      await call(ports, 'POST', `/orgs/${org.id}/members`, {
        user: alice,
        body: { email: 'nobody@example.com' },
      }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await call(ports, 'POST', `/orgs/${org.id}/members`, { user: alice, body: {} }),
      400,
      'VALIDATION_ERROR',
    );
  });
});

describe('workshop creation', () => {
  test('creates workshop and sessions synchronously with engine defaults', async () => {
    const ports = setup();
    const org = await createOrg(ports, alice);
    const startsAt = '2026-11-04T14:00:00+08:00';
    const view = await createWorkshop(ports, alice, org.id, {
      title: 'Rust 101',
      sessions: [
        { title: 'A', startsAt, capacity: 3 },
        { title: 'B', startsAt: addMinutes(T0, 48 * 60), capacity: 2 },
      ],
    });
    expect(view.workshop).toEqual({
      id: 'id-2',
      orgId: org.id,
      title: 'Rust 101',
      description: '',
      status: 'OPEN',
      mode: 'UNIFIED',
      holdSeconds: 900,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(view.queueLength).toBe(0);
    expect(view.sessions).toHaveLength(2);
    expect(view.sessions[0]).toEqual({
      id: 'id-3',
      workshopId: 'id-2',
      title: 'A',
      startsAt: '2026-11-04T06:00:00.000Z',
      cutoffAt: '2026-11-04T05:30:00.000Z',
      capacity: 3,
      confirmed: 0,
      held: 0,
      status: 'OPEN',
      free: 3,
      queueLength: 0,
    });
    const stored = await ports.store.getWorkshop('id-2');
    expect(stored?.seq).toBe(0);
    expect(stored?.version).toBe(0);

    const list = bodyOf<WorkshopListView>(
      await call(ports, 'GET', `/orgs/${org.id}/workshops`, { user: alice }),
    );
    expect(list.workshops.map((workshop: Workshop) => workshop.id)).toEqual(['id-2']);
  });

  test('validates 2–5 sessions and holdSeconds bounds', async () => {
    const ports = setup();
    const org = await createOrg(ports, alice);
    const session = (n: number) => ({
      title: `S${n}`,
      startsAt: addMinutes(T0, 60 * n),
      capacity: 1,
    });
    const post = (body: unknown) =>
      call(ports, 'POST', `/orgs/${org.id}/workshops`, { user: alice, body });

    expectError(await post({ title: 'x', sessions: [session(1)] }), 400, 'VALIDATION_ERROR');
    expectError(
      await post({ title: 'x', sessions: [1, 2, 3, 4, 5, 6].map(session) }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await post({ title: 'x', holdSeconds: 29, sessions: [1, 2].map(session) }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await post({ title: 'x', holdSeconds: 86_401, sessions: [1, 2].map(session) }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await post({ title: 'x', holdSeconds: 60.5, sessions: [1, 2].map(session) }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await post({ title: '', sessions: [1, 2].map(session) }), 400, 'VALIDATION_ERROR');
    expectError(
      await post({ title: 'x', sessions: [{ ...session(1), startsAt: 'tomorrow' }, session(2)] }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await post(undefined), 400, 'VALIDATION_ERROR');
    expect(
      (await post({ title: 'x', holdSeconds: 30, sessions: [1, 2, 3, 4, 5].map(session) })).status,
    ).toBe(201);
    expect(
      (await post({ title: 'x', holdSeconds: 86_400, sessions: [1, 2].map(session) })).status,
    ).toBe(201);
  });

  test('rejects a session whose registration cut-off has already passed', async () => {
    const ports = setup();
    const org = await createOrg(ports, alice);
    const post = (startsAt: string) =>
      call(ports, 'POST', `/orgs/${org.id}/workshops`, {
        user: alice,
        body: {
          title: 'x',
          sessions: [
            { title: 'Soon', startsAt, capacity: 1 },
            { title: 'Later', startsAt: addMinutes(T0, 24 * 60), capacity: 1 },
          ],
        },
      });
    const tooSoon = await post(addMinutes(T0, 20)); // cut-off would be 10 min ago
    expectError(tooSoon, 400, 'VALIDATION_ERROR');
    expect(bodyOf<ErrorBody>(tooSoon).message).toContain('Soon');
    expectError(await post(addMinutes(T0, -60)), 400, 'VALIDATION_ERROR');
    expectError(await post(addMinutes(T0, 30)), 400, 'VALIDATION_ERROR'); // cut-off = now
    expect((await post(addMinutes(T0, 31))).status).toBe(201);
  });
});

describe('organiser routes (C7)', () => {
  test('403 for cross-org dashboard, export, verify, attendance, PATCH and organiser commands', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    await createOrg(ports, bob, 'Other org');
    const base = `/orgs/${orgId}/workshops/${wsId}`;

    expectError(await call(ports, 'GET', `${base}/dashboard`, { user: bob }), 403, 'FORBIDDEN');
    expectError(await call(ports, 'GET', `${base}/export.csv`, { user: bob }), 403, 'FORBIDDEN');
    expectError(await call(ports, 'GET', `${base}/verify`, { user: bob }), 403, 'FORBIDDEN');
    expectError(
      await call(ports, 'PUT', `${base}/attendance/carol`, { user: bob, body: { attended: true } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call(ports, 'PATCH', `/workshops/${wsId}`, { user: bob, body: { title: 'Hijacked' } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call(ports, 'GET', `/orgs/${orgId}/workshops`, { user: bob }),
      403,
      'FORBIDDEN',
    );
    for (const body of [
      { type: 'SET_CAPACITY', sessionId: s1, capacity: 5 },
      { type: 'CANCEL_SESSION', sessionId: s1 },
      { type: 'CANCEL_WORKSHOP' },
      { type: 'CLOSE_REGISTRATION' },
      { type: 'OPEN_REGISTRATION' },
    ] as const) {
      expectError(await postCommand(ports, bob, wsId, body), 403, 'FORBIDDEN');
    }
    expect(ports.queue.size).toBe(0);
    expect(await ports.store.getWorkshop(wsId)).toMatchObject({ title: 'Intro to Git' });
  });

  test('404 when the workshop is not in the organisation of the path', async () => {
    const { ports, wsId } = await scenario();
    const other = await createOrg(ports, alice, 'Second org of alice');
    expectError(
      await call(ports, 'GET', `/orgs/${other.id}/workshops/${wsId}/dashboard`, { user: alice }),
      404,
      'NOT_FOUND',
    );
  });

  test('PATCH edits title/description (and updatedAt) only and leaves engine fields alone', async () => {
    const { ports, wsId } = await scenario();
    ports.clock.advanceSeconds(100);
    const response = await call(ports, 'PATCH', `/workshops/${wsId}`, {
      user: alice,
      body: { description: 'Bring a laptop' },
    });
    expect(response.status).toBe(200);
    expect(bodyOf<WorkshopPublic>(response)).toMatchObject({
      title: 'Intro to Git',
      description: 'Bring a laptop',
      updatedAt: ports.clock.now(),
    });
    expect(response.body).not.toHaveProperty('version'); // the public shape, like GET/POST
    expect(response.body).not.toHaveProperty('seq');
    expect(await ports.store.getWorkshop(wsId)).toMatchObject({
      description: 'Bring a laptop',
      updatedAt: ports.clock.now(),
      createdAt: T0,
      version: 0,
      seq: 0,
    });
    expectError(
      await call(ports, 'PATCH', `/workshops/${wsId}`, { user: alice, body: {} }),
      400,
      'VALIDATION_ERROR',
    );
  });
});

describe('POST /workshops/{wsId}/commands', () => {
  test('202 for a participant command, with the built command on the queue', async () => {
    const { ports, wsId, s1, s2 } = await scenario();
    const commandId = randomUUID();
    const response = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [s1, s2],
      issuedAt: T0,
    });
    expect(response.status).toBe(202);
    expect(bodyOf<CommandAcceptedView>(response)).toEqual({
      commandId,
      type: 'REGISTER',
      workshopId: wsId,
      status: 'ACCEPTED',
      acceptedAt: T0,
      href: `/commands/${commandId}`,
      pollAfterMs: 300,
    });
    expect(ports.queue.messages).toEqual([
      {
        type: 'REGISTER',
        commandId,
        issuedAt: T0,
        acceptable: [s1, s2],
        workshopId: wsId,
        actorUserId: bob.userId,
        actorEmail: bob.email,
        actorDisplayName: 'Bob',
      } satisfies UserCommand,
    ]);
    const record = await ports.store.getCommandResult(commandId);
    expect(record).toMatchObject({ status: 'ACCEPTED', actorUserId: bob.userId, acceptedAt: T0 });
    expect(record?.ttl).toBe(Math.floor(Date.parse(T0) / 1000) + 30 * 86_400);
  });

  test('re-POST with the same commandId is idempotent: same record, enqueued once', async () => {
    const { ports, wsId, s1 } = await scenario();
    const commandId = randomUUID();
    const first = await accepted(ports, bob, wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [s1],
    });
    ports.clock.advanceSeconds(5);
    const second = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [s1],
    });
    expect(second.status).toBe(202);
    expect(bodyOf<CommandAcceptedView>(second)).toEqual(first);
    expect(ports.queue.size).toBe(1);

    await ports.drain();
    const third = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [s1],
    });
    expect(third.status).toBe(202);
    expect(bodyOf<CommandAcceptedView>(third)).toMatchObject({
      commandId,
      status: 'APPLIED',
      settledAt: expect.any(String),
      result: { offersCreated: 1 },
      href: `/commands/${commandId}`,
    });
    expect(ports.queue.size).toBe(0);
  });

  test('409 when another actor reuses a commandId', async () => {
    const { ports, wsId, s1 } = await scenario();
    const commandId = randomUUID();
    await accepted(ports, bob, wsId, { type: 'REGISTER', commandId, acceptable: [s1] });
    expectError(
      await postCommand(ports, carol, wsId, { type: 'REGISTER', commandId, acceptable: [s1] }),
      409,
      'CONFLICT',
    );
  });

  test('503 when the queue is unavailable, and the ACCEPTED record is rolled back', async () => {
    const { ports, wsId, s1 } = await scenario();
    const commandId = randomUUID();
    ports.queue.failNextEnqueue = true;
    expectError(
      await postCommand(ports, bob, wsId, { type: 'REGISTER', commandId, acceptable: [s1] }),
      503,
      'QUEUE_UNAVAILABLE',
    );
    expect(await ports.store.getCommandResult(commandId)).toBeUndefined();
    expect(ports.queue.size).toBe(0);
    // The browser retries with the same commandId and succeeds.
    const retry = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [s1],
    });
    expect(retry.status).toBe(202);
    expect(ports.queue.size).toBe(1);
  });

  test('an orphaned ACCEPTED record is re-enqueued on retry, and a failing rollback still answers 503', async () => {
    const { ports, wsId, s1 } = await scenario();
    const commandId = randomUUID();
    ports.queue.failNextEnqueue = true;
    const original = ports.store.deleteCommandIfAccepted.bind(ports.store);
    ports.store.deleteCommandIfAccepted = async () => {
      throw new Error('store down');
    };
    expectError(
      await postCommand(ports, bob, wsId, { type: 'REGISTER', commandId, acceptable: [s1] }),
      503,
      'QUEUE_UNAVAILABLE',
    );
    ports.store.deleteCommandIfAccepted = original;
    // the record survived the failed rollback: nothing on the queue would ever settle it
    expect(await ports.store.getCommandResult(commandId)).toMatchObject({ status: 'ACCEPTED' });
    expect(ports.queue.size).toBe(0);
    const retry = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [s1],
    });
    expect(retry.status).toBe(202);
    expect(bodyOf<CommandAcceptedView>(retry)).toMatchObject({ commandId, status: 'ACCEPTED' });
    expect(ports.queue.size).toBe(1);
    // a third POST while still ACCEPTED is deduplicated by the FIFO (same commandId)
    expect(
      (await postCommand(ports, bob, wsId, { type: 'REGISTER', commandId, acceptable: [s1] }))
        .status,
    ).toBe(202);
    expect(ports.queue.size).toBe(1);
    expect(ports.queue.deduplicated).toBe(1);
    await ports.drain();
    expect(await ports.store.getCommandResult(commandId)).toMatchObject({ status: 'APPLIED' });
    // once settled, a re-POST neither enqueues nor fails when the queue is down
    ports.queue.failNextEnqueue = true;
    expect(
      (await postCommand(ports, bob, wsId, { type: 'REGISTER', commandId, acceptable: [s1] }))
        .status,
    ).toBe(202);
    ports.queue.failNextEnqueue = false;
    // a re-enqueue failure for a still-ACCEPTED record answers 503 without touching the record
    const other = randomUUID();
    await accepted(ports, carol, wsId, { type: 'REGISTER', commandId: other, acceptable: [s1] });
    ports.queue.messages.length = 0; // simulate the message being lost
    ports.queue.failNextEnqueue = true;
    expectError(
      await postCommand(ports, carol, wsId, {
        type: 'REGISTER',
        commandId: other,
        acceptable: [s1],
      }),
      503,
      'QUEUE_UNAVAILABLE',
    );
    expect(await ports.store.getCommandResult(other)).toMatchObject({ status: 'ACCEPTED' });
  });

  test('validates the body with CommandBodySchema', async () => {
    const { ports, wsId, s1 } = await scenario();
    expectError(
      await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [] }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await call(ports, 'POST', `/workshops/${wsId}/commands`, {
        user: bob,
        body: { type: 'REGISTER', commandId: 'not-a-uuid', acceptable: [s1] },
      }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await call(ports, 'POST', `/workshops/${wsId}/commands`, {
        user: bob,
        body: { type: 'NOPE' },
      }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await postCommand(ports, bob, 'missing-ws', { type: 'REGISTER', acceptable: [s1] }),
      404,
      'NOT_FOUND',
    );
    expect(ports.queue.size).toBe(0);
  });

  test('_fault is stripped unless fault flags are allowed', async () => {
    const strict = await scenario({ allowFaultFlags: false });
    await accepted(strict.ports, bob, strict.wsId, {
      type: 'REGISTER',
      acceptable: [strict.s1],
      _fault: 'AFTER_COMMIT',
    });
    expect(strict.ports.queue.messages[0]).not.toHaveProperty('_fault');

    const lenient = await scenario({ allowFaultFlags: true });
    await accepted(lenient.ports, bob, lenient.wsId, {
      type: 'REGISTER',
      acceptable: [lenient.s1],
      _fault: 'AFTER_COMMIT',
    });
    expect(lenient.ports.queue.messages[0]).toMatchObject({ _fault: 'AFTER_COMMIT' });
  });
});

describe('GET /commands/{id}', () => {
  test('visible to the issuer and the organisers, 404 for everyone else', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    await call(ports, 'POST', `/orgs/${orgId}/members`, {
      user: alice,
      body: { userId: dave.userId },
    });
    const { commandId } = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });

    const issuer = await call(ports, 'GET', `/commands/${commandId}`, { user: bob });
    expect(issuer.status).toBe(200);
    expect(bodyOf<CommandResultView>(issuer)).toEqual({
      commandId,
      type: 'REGISTER',
      workshopId: wsId,
      status: 'ACCEPTED',
      acceptedAt: T0,
    });
    expect(issuer.body).not.toHaveProperty('actorUserId');
    expect(issuer.body).not.toHaveProperty('ttl');
    expect((await call(ports, 'GET', `/commands/${commandId}`, { user: alice })).status).toBe(200);
    expect((await call(ports, 'GET', `/commands/${commandId}`, { user: dave })).status).toBe(200);
    expectError(
      await call(ports, 'GET', `/commands/${commandId}`, { user: carol }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('GET /workshops/{wsId}', () => {
  test('public view without a user; `me` when the caller has a registration', async () => {
    const { ports, wsId, s1, s2 } = await scenario();
    const anonymous = bodyOf<WorkshopPublicView>(await call(ports, 'GET', `/workshops/${wsId}`));
    expect(anonymous.workshop).not.toHaveProperty('version');
    expect(anonymous.workshop).not.toHaveProperty('seq');
    expect(anonymous).not.toHaveProperty('me');
    expect(anonymous.sessions.map((session) => session.free)).toEqual([1, 1]);

    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1, s2] });
    await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();

    const mine = bodyOf<WorkshopPublicView>(
      await call(ports, 'GET', `/workshops/${wsId}`, { user: carol }),
    );
    expect(mine.queueLength).toBe(1);
    expect(
      mine.sessions.map((session) => [session.held, session.free, session.queueLength]),
    ).toEqual([
      [1, 0, 1],
      [0, 1, 0],
    ]);
    expect(mine.me).toEqual({ status: 'QUEUED', seq: 2, queuePosition: 1, acceptable: [s1] });
    const his = bodyOf<WorkshopPublicView>(
      await call(ports, 'GET', `/workshops/${wsId}`, { user: bob }),
    );
    expect(his.me).toMatchObject({ status: 'OFFERED', seq: 1, currentOffer: { sessionId: s1 } });
    const stranger = bodyOf<WorkshopPublicView>(
      await call(ports, 'GET', `/workshops/${wsId}`, { user: dave }),
    );
    expect(stranger).not.toHaveProperty('me');
  });

  test('CLOSED and CANCELLED workshops stay readable', async () => {
    const { ports, wsId } = await scenario();
    await accepted(ports, alice, wsId, { type: 'CLOSE_REGISTRATION' });
    await ports.drain();
    expect(
      bodyOf<WorkshopPublicView>(await call(ports, 'GET', `/workshops/${wsId}`)).workshop.status,
    ).toBe('CLOSED');
    await accepted(ports, alice, wsId, { type: 'CANCEL_WORKSHOP' });
    await ports.drain();
    const view = bodyOf<WorkshopPublicView>(await call(ports, 'GET', `/workshops/${wsId}`));
    expect(view.workshop.status).toBe('CANCELLED');
    expect(view.sessions.every((session) => session.status === 'CANCELLED')).toBe(true);
  });

  test('a cancelled workshop with many registrations is drained in several commits', async () => {
    const { ports, orgId, wsId, s1, s2 } = await scenario(
      {},
      workshopInput({
        sessions: [
          { title: 'Morning', startsAt: addMinutes(T0, 24 * 60), capacity: 5 },
          { title: 'Afternoon', startsAt: addMinutes(T0, 26 * 60), capacity: 5 },
        ],
      }),
    );
    for (let i = 1; i <= 40; i += 1) {
      await accepted(ports, { userId: `u${i}`, email: `u${i}@example.com` }, wsId, {
        type: 'REGISTER',
        acceptable: [s1, s2],
      });
    }
    await ports.drain();
    const commitsBefore = ports.store.commits;
    const { commandId } = await accepted(ports, alice, wsId, { type: 'CANCEL_WORKSHOP' });
    const [first] = await ports.drain();
    expect(first?.result.outcome).toBe('APPLIED');
    expect(
      bodyOf<CommandResultView>(await call(ports, 'GET', `/commands/${commandId}`, { user: alice }))
        .status,
    ).toBe('APPLIED');
    expect(ports.store.commits - commitsBefore).toBeGreaterThan(1);
    const view = bodyOf<WorkshopPublicView>(await call(ports, 'GET', `/workshops/${wsId}`));
    expect(view.workshop.status).toBe('CANCELLED');
    expect(view.queueLength).toBe(0);
    const verify = bodyOf<VerifyView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/verify`, { user: alice }),
    );
    expect(verify.ok).toBe(true);
    const history = await ports.store.listHistory(wsId);
    expect(history.registrations).toHaveLength(40);
    expect(history.registrations.every((r) => r.endReason === 'WORKSHOP_CANCELLED')).toBe(true);
    expect(
      ports.store.allNotifications().filter((n) => n.kind === 'WORKSHOP_CANCELLED'),
    ).toHaveLength(40);
  });
});
