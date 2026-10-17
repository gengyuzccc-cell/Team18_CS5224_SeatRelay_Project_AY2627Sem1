import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiClient, type TargetConfig } from '@seatrelay/scripts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountPool } from '../src/lib/accounts';
import { statusOf, tamperToken } from '../src/lib/httpProbe';
import { createWorkshop, ensureOrganisation, invariantSnapshot, myRegistration } from '../src/lib/scenario';
import { startMemoryServer, writeFixtureTokenCache, type MemoryServer } from './helpers/memoryServer';

/**
 * The experiment client stack over real HTTP: the in-memory fixture (the service route table and
 * `processCommand` on memory adapters, wall clock, background worker with redelivery), accounts
 * from a token cache (never minted), commands POSTed and polled with the §1.3 backoff.
 */

let server: MemoryServer;
let pool: AccountPool;
let dir: string;

beforeAll(async () => {
  server = await startMemoryServer({ redeliveryDelayMs: 200, workerPollMs: 10 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seatrelay-fixture-'));
  const cacheFile = path.join(dir, 'tokens.json');
  writeFixtureTokenCache(cacheFile, server, { count: 3 });
  const target: TargetConfig = { name: 'local', stage: 'local', apiBase: server.url, apiSource: 'flag' };
  pool = new AccountPool({
    target,
    naming: { prefix: 'loaduser', domain: 'example.com', organiserEmail: 'organiser@example.com', outsiderEmail: 'loaduser-outsider@example.com' },
    password: 'unused',
    cacheFile,
    create: false,
    provider: () => Promise.reject(new Error('the fixture never mints tokens')),
  });
});

afterAll(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('experiment client against the HTTP fixture', () => {
  it('runs register → offer → accept through POST 202 + polling, verify ok', async () => {
    const organiser = await pool.organiser();
    const [alice, bob] = await pool.participants(2);
    const org = await ensureOrganisation(organiser, 'Fixture org');
    const again = await ensureOrganisation(organiser, 'Fixture org');
    expect(again.id).toBe(org.id);
    const ws = await createWorkshop(organiser, org.id, { title: 'Fixture', holdSeconds: 60, sessions: [{ capacity: 1 }, { capacity: 1 }] });
    const [s1, s2] = ws.sessionIds as [string, string];

    const registered = await alice!.client.sendCommand(ws.wsId, { type: 'REGISTER', acceptable: [s2, s1] });
    expect(registered.record.status).toBe('APPLIED');
    expect(registered.record.result?.registration?.currentOffer?.sessionId).toBe(s2);
    expect(registered.polls).toBeGreaterThanOrEqual(1);
    expect(registered.serverSettleMs).toBeGreaterThanOrEqual(0);

    const offerId = registered.record.result?.registration?.currentOffer?.id ?? '';
    const stolen = await bob!.client.sendCommand(ws.wsId, { type: 'ACCEPT_OFFER', offerId });
    expect(stolen.record).toMatchObject({ status: 'REJECTED', reason: 'OFFER_NOT_YOURS' });
    const accepted = await alice!.client.sendCommand(ws.wsId, { type: 'ACCEPT_OFFER', offerId });
    expect(accepted.record.result?.registration?.status).toBe('CONFIRMED');

    const inv = await invariantSnapshot(organiser, org.id, ws.wsId);
    expect(inv).toMatchObject({ ok: true, overCapacity: 0, doubleHolds: 0 });
    expect(pool.stats).toMatchObject({ minted: 0, created: 0 });
  });

  it('a BEFORE_COMMIT fault is redelivered and settles exactly once', async () => {
    const organiser = await pool.organiser();
    const [, , carol] = await pool.participants(3);
    const org = await ensureOrganisation(organiser, 'Fixture org');
    const ws = await createWorkshop(organiser, org.id, { title: 'Fault', holdSeconds: 60, sessions: [{ capacity: 2 }, { capacity: 1 }] });
    const settled = await carol!.client.sendCommand(ws.wsId, { type: 'REGISTER', acceptable: [ws.sessionIds[0] as string], _fault: 'BEFORE_COMMIT' });
    expect(settled.record.status).toBe('APPLIED');
    expect(server.deliveries.get(settled.commandId)).toBe(2);
    expect(settled.serverSettleMs).toBeGreaterThanOrEqual(200);
    const dash = await organiser.client.dashboard(org.id, ws.wsId);
    expect(dash.workshop.seq).toBe(1);
    expect((await myRegistration(carol!, ws.wsId))?.status).toBe('OFFERED');
  });

  it('answers 401 to a tampered token and to no token', async () => {
    const [alice] = await pool.participants(1);
    const tampered = new ApiClient({ baseUrl: server.url, token: tamperToken(await alice!.token()) });
    expect(await statusOf(tampered, 'GET', '/me')).toBe('401 UNAUTHORIZED');
    expect(await statusOf(new ApiClient({ baseUrl: server.url }), 'GET', '/me')).toBe('401 UNAUTHORIZED');
    expect(await statusOf(alice!.client, 'GET', '/me')).toBe('200');
  });
});
