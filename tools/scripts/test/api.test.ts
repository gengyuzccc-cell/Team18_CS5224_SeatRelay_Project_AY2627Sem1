import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApiClient,
  ApiHttpError,
  BACKGROUND_POLL_MS,
  CommandRejectedError,
  CommandTimeoutError,
  expectApplied,
  pollDelayMs,
} from '../src/lib/api';
import { createInMemoryApi } from './helpers/inMemoryApi';

const ORGANISER = { userId: 'org-1', email: 'organiser@example.com', name: 'Olivia Organiser' };
const ALICE = { userId: 'alice-1', email: 'alice@example.com', name: 'Alice' };

async function workshopFixture() {
  const api = createInMemoryApi();
  const anonymous = new ApiClient({
    baseUrl: api.baseUrl,
    fetch: api.fetch,
    commandOptions: { sleep: async () => undefined },
  });
  const organiser = anonymous.withToken(api.tokenFor(ORGANISER));
  const org = await organiser.createOrg('Test org');
  const created = await organiser.createWorkshop(org.id, {
    title: 'WS',
    holdSeconds: 60,
    sessions: [
      { title: 'S1', startsAt: '2026-11-16T02:00:00.000Z', capacity: 1 },
      { title: 'S2', startsAt: '2026-11-17T02:00:00.000Z', capacity: 1 },
    ],
  });
  return { api, anonymous, organiser, org, created, wsId: created.workshop.id };
}

describe('pollDelayMs (plan §1.3)', () => {
  it('backs off 300 → 500 → 1000 → 2000 and caps at 2000', () => {
    expect([0, 1, 2, 3, 4, 9].map((i) => pollDelayMs(i, 0))).toEqual([
      300, 500, 1000, 2000, 2000, 2000,
    ]);
  });

  it('drops to background polling every 5 s after the 30 s budget', () => {
    expect(pollDelayMs(2, 30_000)).toBe(BACKGROUND_POLL_MS);
    expect(pollDelayMs(0, 29_999)).toBe(300);
  });
});

describe('ApiClient', () => {
  it('calls the route table: health, org, workshop, public view', async () => {
    const { anonymous, organiser, org, created, wsId } = await workshopFixture();
    expect((await anonymous.health()).ok).toBe(true);
    expect(org.members).toEqual([ORGANISER.userId]);
    expect(created.sessions).toHaveLength(2);
    const view = await anonymous.getWorkshop(wsId);
    expect(view.workshop.holdSeconds).toBe(60);
    expect(view.me).toBeUndefined();
    const me = await organiser.me();
    expect(me.organizations.map((o) => o.id)).toEqual([org.id]);
  });

  it('maps non-2xx responses to ApiHttpError with the error code', async () => {
    const { anonymous, organiser, api, org, wsId } = await workshopFixture();
    await expect(anonymous.me()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    await expect(anonymous.getWorkshop('nope')).rejects.toBeInstanceOf(ApiHttpError);
    const stranger = anonymous.withToken(api.tokenFor(ALICE));
    await expect(stranger.dashboard(org.id, wsId)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await expect(organiser.createOrg('')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('sends a command and polls until it settles, reporting latencies', async () => {
    const { anonymous, api, created, wsId } = await workshopFixture();
    const alice = anonymous.withToken(api.tokenFor(ALICE));
    const sleeps: number[] = [];
    const settled = await alice.sendCommand(
      wsId,
      { type: 'REGISTER', acceptable: created.sessions.map((s) => s.id) },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(settled.accepted.status).toBe('ACCEPTED');
    expect(settled.record.status).toBe('APPLIED');
    expect(settled.record.result?.registration?.status).toBe('OFFERED');
    expect(settled.polls).toBe(1);
    expect(sleeps).toEqual([300]);
    expect(settled.settleMs).toBeGreaterThanOrEqual(0);
    expect(settled.serverSettleMs).toBe(7);
    expect(settled.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the §1.3 backoff while the command stays ACCEPTED, then the 5 s background poll', async () => {
    const { created } = await workshopFixture();
    // Hold the worker back: the queue is only drained manually here.
    const slowApi = createInMemoryApi({ drainOnPost: false });
    const organiser = new ApiClient({
      baseUrl: slowApi.baseUrl,
      fetch: slowApi.fetch,
      token: slowApi.tokenFor(ORGANISER),
    });
    const org = await organiser.createOrg('Slow org');
    const slowCreated = await organiser.createWorkshop(org.id, {
      title: 'Slow',
      sessions: created.sessions.map((s) => ({
        title: s.title,
        startsAt: s.startsAt,
        capacity: 1,
      })),
    });
    const alice = organiser.withToken(slowApi.tokenFor(ALICE));
    const sleeps: number[] = [];
    let clock = 0;
    const settled = await alice.sendCommand(
      slowCreated.workshop.id,
      { type: 'REGISTER', acceptable: [slowCreated.sessions[0]?.id ?? ''] },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
          // 300 + 500 + 1000 + 15 × 2000 = 31.8 s after 18 polls: the 19th waits 5 s.
          if (sleeps.length === 19) {
            await slowApi.ports.drain();
          }
        },
      },
    );
    // 300 (pollAfterMs), 500, 1000, 2000 (capped) … then 5000 once the 30 s budget is spent.
    expect(sleeps.slice(0, 4)).toEqual([300, 500, 1000, 2000]);
    expect(sleeps.slice(3, 18).every((ms) => ms === 2000)).toBe(true);
    expect(sleeps[18]).toBe(5000);
    expect(settled.polls).toBe(19);
    expect(settled.settleMs).toBe(36_800);
    expect(settled.record.status).toBe('APPLIED');

    // Timeout: nobody drains the queue.
    const bob = organiser.withToken(
      slowApi.tokenFor({ userId: 'bob-1', email: 'bob@example.com' }),
    );
    let t = 0;
    await expect(
      bob.sendCommand(
        slowCreated.workshop.id,
        { type: 'REGISTER', acceptable: [slowCreated.sessions[1]?.id ?? ''] },
        { timeoutMs: 40_000, now: () => t, sleep: async (ms) => void (t += ms) },
      ),
    ).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it('re-POSTing a settled commandId returns the terminal record without polling (C3)', async () => {
    const { anonymous, api, created, wsId } = await workshopFixture();
    const alice = anonymous.withToken(api.tokenFor(ALICE));
    const commandId = randomUUID();
    const first = await alice.sendCommand(wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [created.sessions[0]?.id ?? ''],
    });
    const again = await alice.sendCommand(wsId, {
      type: 'REGISTER',
      commandId,
      acceptable: [created.sessions[0]?.id ?? ''],
    });
    expect(first.record.status).toBe('APPLIED');
    expect(again.polls).toBe(0);
    expect(again.record.status).toBe('APPLIED');
    expect(again.record.settledAt).toBe(first.record.settledAt);
  });

  it('expectApplied throws CommandRejectedError with the reason', async () => {
    const { anonymous, api, created, wsId } = await workshopFixture();
    const alice = anonymous.withToken(api.tokenFor(ALICE));
    const acceptable = [created.sessions[0]?.id ?? ''];
    expectApplied(await alice.sendCommand(wsId, { type: 'REGISTER', acceptable }), 'first');
    const second = await alice.sendCommand(wsId, { type: 'REGISTER', acceptable });
    expect(second.record.status).toBe('REJECTED');
    expect(second.record.reason).toBe('ALREADY_REGISTERED');
    expect(() => expectApplied(second, 'second')).toThrow(CommandRejectedError);
  });
});
