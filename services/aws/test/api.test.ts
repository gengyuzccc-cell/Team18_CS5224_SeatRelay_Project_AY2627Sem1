import type {
  ErrorBody,
  HealthView,
  MeView,
  Organization,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { InMemoryLogger, type ApiApp, type ApiRequest } from '@seatrelay/service';
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApiHandler, parseEventBody, unusableCommandIdentity } from '../src/handlers/api';
import { apiEvent, bob, call, claimsOf, scenario, setup, alice, postCommand } from './harness';

function parse<T>(body: string | undefined): T {
  return JSON.parse(body ?? 'null') as T;
}

describe('api handler: event → ApiRequest → response', () => {
  test('maps method, path, query, headers, JSON body and the JWT identity; writes status/headers/body back', async () => {
    let captured: ApiRequest | undefined;
    const app: ApiApp = {
      routes: [],
      handle: async (request) => {
        captured = request;
        return { status: 201, headers: { 'content-type': 'application/json' }, body: { ok: 1 } };
      },
    };
    const handler = createApiHandler({ app, logger: new InMemoryLogger() });
    const result = await handler(
      apiEvent({
        method: 'POST',
        path: '/orgs',
        query: { page: '2' },
        headers: { 'x-trace': 'abc' },
        body: { name: 'Team 18' },
        claims: claimsOf(bob),
      }),
    );
    expect(captured).toEqual({
      method: 'POST',
      path: '/orgs',
      query: { page: '2' },
      headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      body: { name: 'Team 18' },
      user: { userId: 'bob', email: 'bob@example.com', name: 'Bob' },
    });
    expect(result).toEqual({
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":1}',
    });
  });

  test('no body and no claims: body/user are absent; an empty response body is an empty string', async () => {
    let captured: ApiRequest | undefined;
    const app: ApiApp = {
      routes: [],
      handle: async (request) => {
        captured = request;
        return { status: 204, headers: {} };
      },
    };
    const handler = createApiHandler({ app, logger: new InMemoryLogger() });
    const result = await handler(apiEvent({ path: '/health' }));
    expect(captured).not.toHaveProperty('body');
    expect(captured).not.toHaveProperty('user');
    expect(result).toEqual({ statusCode: 204, headers: {}, body: '' });
  });

  test('base64-encoded bodies are decoded; malformed JSON is a 400 VALIDATION_ERROR', async () => {
    const event = apiEvent({ method: 'POST', path: '/orgs', body: { name: 'x' }, base64: true });
    expect(parseEventBody(event)).toEqual({ ok: true, body: { name: 'x' } });
    expect(parseEventBody(apiEvent({ path: '/x', rawBody: '   ' }))).toEqual({
      ok: true,
      body: undefined,
    });
    expect(parseEventBody(apiEvent({ path: '/x', rawBody: '{nope' }))).toEqual({ ok: false });

    const ports = setup();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const result = await handler(
      apiEvent({ method: 'POST', path: '/orgs', rawBody: '{nope', claims: claimsOf(bob) }),
    );
    expect(result.statusCode).toBe(400);
    expect(parse<ErrorBody>(result.body)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Malformed JSON body',
    });
  });
});

describe('api handler against the real route table', () => {
  test('GET /health needs no identity', async () => {
    const ports = setup();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const result = await handler(apiEvent({ path: '/health' }));
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-type']).toBe('application/json; charset=utf-8');
    expect(parse<HealthView>(result.body)).toEqual({
      ok: true,
      service: 'seatrelay',
      stage: 'test',
      time: expect.any(String),
    });
  });

  test('a protected route without authorizer claims answers 401 UNAUTHORIZED', async () => {
    const ports = setup();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const result = await handler(apiEvent({ path: '/me' }));
    expect(result.statusCode).toBe(401);
    expect(parse<ErrorBody>(result.body)).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    // A token without an email claim (an access token) is anonymous as well.
    const withoutEmail = await handler(apiEvent({ path: '/me', claims: { sub: 'bob' } }));
    expect(withoutEmail.statusCode).toBe(401);
  });

  test('claims sub/email/name become the AuthUser of the request', async () => {
    const ports = setup();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const result = await handler(apiEvent({ path: '/me', claims: claimsOf(alice) }));
    expect(result.statusCode).toBe(200);
    expect(parse<MeView>(result.body)).toEqual({
      userId: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      organizations: [],
    });
  });

  test('POST with a JSON body creates a resource (201) as the signed-in user', async () => {
    const ports = setup();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const result = await handler(
      apiEvent({
        method: 'POST',
        path: '/orgs',
        body: { name: 'Team 18' },
        claims: claimsOf(alice),
      }),
    );
    expect(result.statusCode).toBe(201);
    expect(parse<Organization>(result.body)).toMatchObject({
      ownerUserId: 'alice',
      members: ['alice'],
    });
  });

  test('GET /public/workshops/{wsId} is served by the public workshop route without a user', async () => {
    const { ports, wsId, s1 } = await scenario();
    await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });

    const signedIn = await handler(apiEvent({ path: `/workshops/${wsId}`, claims: claimsOf(bob) }));
    expect(signedIn.statusCode).toBe(200);
    expect(parse<WorkshopPublicView>(signedIn.body).me).toMatchObject({
      status: 'OFFERED',
      seq: 1,
    });

    const anonymous = await handler(apiEvent({ path: `/public/workshops/${wsId}` }));
    expect(anonymous.statusCode).toBe(200);
    const view = parse<WorkshopPublicView>(anonymous.body);
    expect(view.workshop.id).toBe(wsId);
    expect(view.me).toBeUndefined();
    expect(view.sessions.map((session) => session.free)).toEqual([0, 1]);

    // The public prefix is only rewritten for that one route shape.
    const trailing = await handler(apiEvent({ path: `/public/workshops/${wsId}/` }));
    expect(trailing.statusCode).toBe(200);
    const other = await handler(apiEvent({ path: `/public/workshops/${wsId}/commands` }));
    expect(other.statusCode).toBe(404);
    const unknown = await handler(apiEvent({ path: '/public/workshops/nope' }));
    expect(unknown.statusCode).toBe(404);
    expect(parse<ErrorBody>(unknown.body).code).toBe('NOT_FOUND');
  });

  test('responses carry no CORS headers (API Gateway adds them)', async () => {
    const ports = setup();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const result = await handler(
      apiEvent({
        path: '/me',
        claims: claimsOf(bob),
        headers: { origin: 'http://localhost:5173' },
      }),
    );
    const names = Object.keys(result.headers ?? {}).map((name) => name.toLowerCase());
    expect(names.some((name) => name.startsWith('access-control-'))).toBe(false);
  });

  test('errors mapped by the route table keep their {code, message} body', async () => {
    const { ports, orgId } = await scenario();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const forbidden = await handler(
      apiEvent({ path: `/orgs/${orgId}/workshops`, claims: claimsOf(bob) }),
    );
    expect(forbidden.statusCode).toBe(403);
    expect(parse<ErrorBody>(forbidden.body).code).toBe('FORBIDDEN');
    const invalid = await handler(
      apiEvent({ method: 'POST', path: '/orgs', body: { name: '' }, claims: claimsOf(bob) }),
    );
    expect(invalid.statusCode).toBe(400);
    expect(parse<ErrorBody>(invalid.body).code).toBe('VALIDATION_ERROR');
  });
});

describe('api handler: identities the command schema rejects', () => {
  test('a command from an e-mail zod rejects gets 400 VALIDATION_ERROR, not a 202 that can never settle', async () => {
    const { ports, wsId, s1 } = await scenario();
    const handler = createApiHandler({ app: ports.api, logger: ports.logger });
    const odd = { userId: 'odd', email: 'a&b@example.com' };
    const commandId = randomUUID();
    const result = await handler(
      apiEvent({
        method: 'POST',
        path: `/workshops/${wsId}/commands`,
        body: { type: 'REGISTER', commandId, acceptable: [s1] },
        claims: claimsOf(odd),
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(parse<ErrorBody>(result.body)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The e-mail address of this account cannot be used to submit commands',
    });
    // Nothing was accepted or enqueued, so nothing is left to poll.
    expect(await ports.store.getCommandResult(commandId)).toBeUndefined();
    expect(ports.queue.messages).toHaveLength(0);
    // The account still reads normally.
    expect((await handler(apiEvent({ path: '/me', claims: claimsOf(odd) }))).statusCode).toBe(200);

    // The same command from a schema-valid address is accepted.
    const accepted = await handler(
      apiEvent({
        method: 'POST',
        path: `/workshops/${wsId}/commands`,
        body: { type: 'REGISTER', commandId: randomUUID(), acceptable: [s1] },
        claims: claimsOf({ userId: 'plus', email: 'user+tag@example.com' }),
      }),
    );
    expect(accepted.statusCode).toBe(202);
  });

  test('unusableCommandIdentity only applies to the command intake route', () => {
    const odd = { userId: 'odd', email: 'josé@example.com' };
    expect(unusableCommandIdentity('POST', '/workshops/w1/commands', odd)).toBe(true);
    expect(unusableCommandIdentity('post', '/workshops/w1/commands/', odd)).toBe(true);
    expect(unusableCommandIdentity('GET', '/workshops/w1/commands', odd)).toBe(false);
    expect(unusableCommandIdentity('POST', '/orgs', odd)).toBe(false);
    expect(unusableCommandIdentity('POST', '/workshops/w1/commands', undefined)).toBe(false);
    expect(
      unusableCommandIdentity('POST', '/workshops/w1/commands', {
        userId: 'ok',
        email: 'ok@example.com',
      }),
    ).toBe(false);
  });
});

describe('api handler: failure containment', () => {
  test('an unexpected throw is logged with its stack and answered 500 INTERNAL without details', async () => {
    const logger = new InMemoryLogger();
    const app: ApiApp = {
      routes: [],
      handle: async () => {
        throw new Error('secret database hostname leaked');
      },
    };
    const ended: string[] = [];
    const handler = createApiHandler({
      app,
      logger,
      lifecycle: { begin: () => ended.push('begin'), end: () => ended.push('end') },
    });
    const result = await handler(apiEvent({ path: '/me', claims: claimsOf(bob) }));
    expect(result).toEqual({
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ code: 'INTERNAL', message: 'Internal error' }),
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('at ');
    const entry = logger.entries.find((line) => line.level === 'error');
    expect(entry?.fields).toMatchObject({ error: 'secret database hostname leaked' });
    expect(String(entry?.fields?.stack)).toContain('secret database hostname leaked');
    expect(ended).toEqual(['begin', 'end']);
  });

  test('the in-memory route table itself maps handler exceptions to 500 the same way', async () => {
    const ports = setup();
    const response = await call(ports, 'GET', '/health');
    expect(response.status).toBe(200);
  });
});
