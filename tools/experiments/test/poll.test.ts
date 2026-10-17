import { randomUUID } from 'node:crypto';
import type { CommandResultView } from '@seatrelay/contracts';
import { ApiClient, ApiHttpError, CommandTimeoutError, type FetchLike } from '@seatrelay/scripts';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  commandBody,
  isSettled,
  pollCommand,
  postConcurrently,
  serverSettleMs,
  settledFingerprint,
} from '../src/lib/poll';

/**
 * The polling client against a mocked `fetch`: a scripted `GET /commands/{id}` sequence and a
 * virtual clock that only advances when the client sleeps, so the plan §1.3 backoff schedule
 * (300 → 500 → 1000 → 2000 ms, every 5 s after 30 s) and the latencies are exact.
 */

const BASE = 'https://api.example.test';
const WS = 'ws-1';

interface Call {
  method: string;
  url: string;
  at: number;
  authorization: string | undefined;
  body: unknown;
}

function record(commandId: string, status: CommandResultView['status'], extra: Partial<CommandResultView> = {}): CommandResultView {
  return {
    commandId,
    type: 'REGISTER',
    workshopId: WS,
    status,
    acceptedAt: '2026-11-03T06:00:00.000Z',
    ...extra,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A virtual clock plus a fetch that answers GET /commands/{id} from `statuses` in order. */
function harness(statuses: CommandResultView['status'][], settledAt = '2026-11-03T06:00:01.250Z') {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let gets = 0;
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: input, at: clock, authorization: headers.authorization, body });
    const url = new URL(input);
    if (method === 'POST' && url.pathname === `/workshops/${WS}/commands`) {
      const { commandId } = body as { commandId: string };
      return json(202, { ...record(commandId, 'ACCEPTED'), href: `/commands/${commandId}`, pollAfterMs: 300 });
    }
    const match = /^\/commands\/(.+)$/.exec(url.pathname);
    if (method === 'GET' && match !== null) {
      const commandId = decodeURIComponent(match[1] as string);
      const status = statuses[Math.min(gets, statuses.length - 1)] as CommandResultView['status'];
      gets += 1;
      return json(200, record(commandId, status, isSettled(status) ? { settledAt, result: { offersCreated: 1 } } : {}));
    }
    return json(404, { code: 'NOT_FOUND', message: 'no route' });
  };
  return {
    calls,
    sleeps,
    fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    client: (token = 'tok') => new ApiClient({ baseUrl: BASE, token, fetch }),
  };
}

describe('pollCommand', () => {
  it('polls with the §1.3 backoff until APPLIED and reports both latencies', async () => {
    const h = harness(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'APPLIED']);
    const startedAt = h.now();
    const polled = await pollCommand(h.client(), 'cmd-1', { now: h.now, sleep: h.sleep, startedAt });
    expect(h.sleeps).toEqual([300, 500, 1000, 2000]);
    expect(polled.polls).toBe(4);
    expect(polled.elapsedMs).toBe(3800);
    expect(polled.record.status).toBe('APPLIED');
    expect(polled.serverSettleMs).toBe(1250);
    expect(h.calls.every((call) => call.method === 'GET' && call.url === `${BASE}/commands/cmd-1`)).toBe(true);
    expect(h.calls[0]?.authorization).toBe('Bearer tok');
  });

  it('caps the delay at 2000 ms and drops to 5 s background polling after 30 s', async () => {
    const h = harness([...Array<CommandResultView['status']>(20).fill('ACCEPTED'), 'REJECTED']);
    const polled = await pollCommand(h.client(), 'cmd-2', { now: h.now, sleep: h.sleep, timeoutMs: 120_000 });
    expect(h.sleeps.slice(0, 6)).toEqual([300, 500, 1000, 2000, 2000, 2000]);
    // 300 + 500 + 1000 + 2000 × 14 = 29 800 ms < 30 s; the next delays are 2000 then 5000.
    const crossing = h.sleeps.findIndex((ms) => ms === 5000);
    const elapsedBefore = h.sleeps.slice(0, crossing).reduce((acc, ms) => acc + ms, 0);
    expect(elapsedBefore).toBeGreaterThanOrEqual(30_000);
    expect(h.sleeps.slice(crossing).every((ms) => ms === 5000)).toBe(true);
    expect(polled.record.status).toBe('REJECTED');
  });

  it('honours a custom first delay (the 202 pollAfterMs)', async () => {
    const h = harness(['APPLIED']);
    await pollCommand(h.client(), 'cmd-3', { now: h.now, sleep: h.sleep, firstDelayMs: 50 });
    expect(h.sleeps).toEqual([50]);
  });

  it('throws CommandTimeoutError when the budget runs out, never sleeping past it', async () => {
    const h = harness(['ACCEPTED']);
    await expect(pollCommand(h.client(), 'cmd-4', { now: h.now, sleep: h.sleep, timeoutMs: 2_000 })).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(h.sleeps).toEqual([300, 500, 1000, 200]);
    expect(h.sleeps.reduce((acc, ms) => acc + ms, 0)).toBe(2_000);
  });

  it('propagates HTTP errors as ApiHttpError with the { code, message } body', async () => {
    const fetch: FetchLike = async () => json(404, { code: 'NOT_FOUND', message: 'Command not found' });
    const client = new ApiClient({ baseUrl: BASE, token: 't', fetch });
    const error = await pollCommand(client, 'missing', { sleep: async () => undefined }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).status).toBe(404);
    expect((error as ApiHttpError).code).toBe('NOT_FOUND');
  });
});

describe('ApiClient.sendCommand (POST 202 + polling)', () => {
  it('POSTs a client-generated UUID commandId and polls it to the terminal state', async () => {
    const h = harness(['ACCEPTED', 'APPLIED']);
    const settled = await h.client().sendCommand(WS, { type: 'REGISTER', acceptable: ['s1'] }, { now: h.now, sleep: h.sleep });
    const post = h.calls[0];
    expect(post?.method).toBe('POST');
    expect((post?.body as { commandId: string }).commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(settled.commandId).toBe((post?.body as { commandId: string }).commandId);
    expect(h.sleeps).toEqual([300, 500]);
    expect(settled.settleMs).toBe(800);
    expect(settled.acceptMs).toBe(0);
    expect(settled.polls).toBe(2);
    expect(settled.serverSettleMs).toBe(1250);
  });

  it('reuses a given commandId (idempotency key)', async () => {
    const h = harness(['APPLIED']);
    const commandId = randomUUID();
    const settled = await h.client().sendCommand(WS, { type: 'CANCEL_REGISTRATION', commandId }, { now: h.now, sleep: h.sleep });
    expect(settled.commandId).toBe(commandId);
    expect((h.calls[0]?.body as { commandId: string }).commandId).toBe(commandId);
  });
});

describe('postConcurrently', () => {
  it('fires every copy at once and returns failures instead of throwing', async () => {
    let posts = 0;
    const fetch: FetchLike = async (_input, init) => {
      posts += 1;
      const body = JSON.parse(String(init?.body)) as { commandId: string };
      return posts === 3
        ? json(503, { code: 'QUEUE_UNAVAILABLE', message: 'queue down' })
        : json(202, { ...record(body.commandId, 'ACCEPTED'), href: `/commands/${body.commandId}`, pollAfterMs: 300 });
    };
    const client = new ApiClient({ baseUrl: BASE, token: 't', fetch });
    const body = commandBody({ type: 'REGISTER', acceptable: ['s1'] }, randomUUID());
    const outcomes = await postConcurrently(client, WS, body, 5);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(4);
    const failed = outcomes.find((outcome) => !outcome.ok);
    expect(failed !== undefined && !failed.ok && failed.error instanceof ApiHttpError && failed.error.status === 503).toBe(true);
    expect(outcomes.every((outcome) => !outcome.ok || outcome.view.commandId === body.commandId)).toBe(true);
  });
});

describe('settled-record helpers', () => {
  it('serverSettleMs = settledAt − acceptedAt, undefined while ACCEPTED', () => {
    expect(serverSettleMs({ acceptedAt: '2026-11-03T06:00:00.000Z', settledAt: '2026-11-03T06:00:02.500Z' })).toBe(2500);
    expect(serverSettleMs({ acceptedAt: '2026-11-03T06:00:00.000Z' })).toBeUndefined();
    expect(isSettled('ACCEPTED')).toBe(false);
    expect(isSettled('APPLIED') && isSettled('REJECTED')).toBe(true);
  });

  it('canonicalJson is independent of key order; the fingerprint ignores transport fields', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(canonicalJson({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }));
    const settled = record('c', 'APPLIED', { settledAt: '2026-11-03T06:00:01.000Z', result: { offersCreated: 0 } });
    const asPosted = { ...settled, href: '/commands/c', pollAfterMs: 300 };
    expect(settledFingerprint(asPosted)).toBe(settledFingerprint(settled));
    expect(settledFingerprint({ ...settled, settledAt: '2026-11-03T06:00:02.000Z' })).not.toBe(settledFingerprint(settled));
  });
});
