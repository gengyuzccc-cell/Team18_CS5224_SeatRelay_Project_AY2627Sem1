import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isUserCommand, type AuthUser, type Command, type Notification } from '@seatrelay/contracts';
import {
  createInMemoryPorts,
  processCommand,
  toWireResponse,
  type InMemoryPorts,
} from '@seatrelay/service';
import { writeTokenCache, type TokenCache } from '@seatrelay/scripts';

/**
 * A self-test target for the experiment scripts: the real route table (`createApiApp`) and
 * worker orchestration (`processCommand`) of `@seatrelay/service` on its in-memory adapters,
 * served over HTTP with the wall clock, a background worker (SQS-like redelivery after a
 * crash, so `_fault` flags behave as on a deployment), the per-offer timer loop, the sweep and
 * a notifier that marks notifications SKIPPED. Tokens are HS256 JWTs signed with a fixture
 * secret, so tampered or missing tokens get 401 like Keycloak/Cognito-verified ones.
 *
 * It is NOT a measurement target: numbers obtained against it say nothing about either
 * deployment. It exists so that every script can be executed end to end without Docker/AWS.
 */

export interface MemoryServerOptions {
  port?: number;
  /** Idle wait of the worker loop (default 20 ms). */
  workerPollMs?: number;
  /** Timer loop period (default 250 ms). */
  timerPollMs?: number;
  /** Sweep period (default 60 s). */
  sweepMs?: number;
  /** Redelivery delay after a failed delivery (default 1000 ms, like the local server). */
  redeliveryDelayMs?: number;
  /** Deliveries before a message is dead-lettered (default 3). */
  maxReceiveCount?: number;
  allowFaultFlags?: boolean;
  /** Notifier delay before a PENDING notification becomes SKIPPED (default 200 ms). */
  notifierDelayMs?: number;
  secret?: string;
}

export interface MemoryServer {
  url: string;
  ports: InMemoryPorts;
  /** Deliveries per user commandId (the "commands row" of this target). */
  deliveries: Map<string, number>;
  deadLetters: Command[];
  signToken(user: AuthUser, ttlSeconds?: number): string;
  close(): Promise<void>;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

export function verifyJwt(token: string, secret: string, nowMs = Date.now()): AuthUser | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === undefined)) {
    return undefined;
  }
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return undefined;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
    return undefined;
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= nowMs) {
    return undefined;
  }
  return {
    userId: claims.sub,
    email: claims.email,
    ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
  };
}

export async function startMemoryServer(options: MemoryServerOptions = {}): Promise<MemoryServer> {
  const secret = options.secret ?? 'seatrelay-fixture-secret';
  const allowFaultFlags = options.allowFaultFlags ?? true;
  const ports = createInMemoryPorts({ allowFaultFlags, stage: 'fixture' });
  // Wall clock for the API and the worker (both hold this instance).
  ports.clock.now = () => new Date().toISOString();

  const deliveries = new Map<string, number>();
  const attempts = new WeakMap<Command, number>();
  const deadLetters: Command[] = [];
  const timeouts = new Set<NodeJS.Timeout>();
  let workerBusy = false;
  let closed = false;

  async function workOnce(): Promise<void> {
    if (workerBusy || closed) {
      return;
    }
    workerBusy = true;
    try {
      for (;;) {
        const command = ports.queue.dequeue();
        if (command === undefined) {
          return;
        }
        const deliveryAttempt = attempts.get(command) ?? 1;
        if (isUserCommand(command)) {
          deliveries.set(command.commandId, deliveryAttempt);
        }
        try {
          await processCommand(ports, command, { faultInjection: allowFaultFlags, deliveryAttempt });
        } catch {
          if (deliveryAttempt >= (options.maxReceiveCount ?? 3)) {
            deadLetters.push(command);
            continue;
          }
          attempts.set(command, deliveryAttempt + 1);
          const timeout = setTimeout(() => {
            timeouts.delete(timeout);
            ports.queue.messages.push(command);
          }, options.redeliveryDelayMs ?? 1000);
          timeouts.add(timeout);
        }
      }
    } finally {
      workerBusy = false;
    }
  }

  const store = ports.store as unknown as { notifications: Map<string, Notification[]> };
  const notifierDelayMs = options.notifierDelayMs ?? 200;
  function notifyOnce(): void {
    const cutoff = Date.now() - notifierDelayMs;
    for (const list of store.notifications.values()) {
      for (const notification of list) {
        if (notification.status === 'PENDING' && Date.parse(notification.createdAt) <= cutoff) {
          notification.status = 'SKIPPED';
          notification.attempts += 1;
        }
      }
    }
  }

  const intervals = [
    setInterval(() => void workOnce(), options.workerPollMs ?? 20),
    setInterval(() => {
      for (const tick of ports.timers.dueTicks(ports.clock.now())) {
        void ports.queue.enqueue(tick);
      }
    }, options.timerPollMs ?? 250),
    setInterval(() => void ports.sweep(), options.sweepMs ?? 60_000),
    setInterval(notifyOnce, 100),
  ];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://fixture');
        const send = (status: number, headers: Record<string, string>, body: string) => {
          res.writeHead(status, headers);
          res.end(body);
        };
        if (url.pathname === '/metrics') {
          const metrics: Record<string, { count: number; sum: number }> = {};
          for (const sample of ports.metrics.samples) {
            const entry = (metrics[sample.name] ??= { count: 0, sum: 0 });
            entry.count += 1;
            entry.sum += sample.value;
          }
          send(200, { 'content-type': 'application/json' }, JSON.stringify({ since: 'fixture start', metrics }));
          return;
        }
        let user: AuthUser | undefined;
        const auth = req.headers.authorization;
        if (auth !== undefined) {
          user = auth.startsWith('Bearer ') ? verifyJwt(auth.slice(7), secret) : undefined;
          if (user === undefined) {
            send(401, { 'content-type': 'application/json' }, JSON.stringify({ code: 'UNAUTHORIZED', message: 'Invalid token' }));
            return;
          }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
        } catch {
          send(400, { 'content-type': 'application/json' }, JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Invalid JSON' }));
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') {
            headers[key] = value;
          }
        }
        const response = await ports.api.handle({
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers,
          body,
          ...(user === undefined ? {} : { user }),
        });
        const wire = toWireResponse(response);
        send(wire.status, wire.headers, wire.body);
      })().catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    ports,
    deliveries,
    deadLetters,
    signToken(user, ttlSeconds = 3600) {
      return signJwt(
        {
          sub: user.userId,
          email: user.email,
          ...(user.name === undefined ? {} : { name: user.name }),
          exp: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        secret,
      );
    },
    async close() {
      closed = true;
      for (const interval of intervals) {
        clearInterval(interval);
      }
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Stable fixture user id of an e-mail address. */
export function fixtureUserId(email: string): string {
  return `user-${email.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Writes a token cache (the format the experiments read) with signed tokens for the
 * organiser, the outsider and `prefix-1 … prefix-<count>`, so scripts run with `--no-create`.
 */
export function writeFixtureTokenCache(
  file: string,
  server: Pick<MemoryServer, 'signToken'>,
  options: { count: number; prefix?: string; domain?: string; organiser?: string; extra?: string[] },
): TokenCache {
  const prefix = options.prefix ?? 'loaduser';
  const domain = options.domain ?? 'example.com';
  const emails = [
    options.organiser ?? 'organiser@example.com',
    `${prefix}-outsider@${domain}`,
    ...Array.from({ length: options.count }, (_, i) => `${prefix}-${i + 1}@${domain}`),
    ...(options.extra ?? []),
  ];
  const ttlSeconds = 12 * 3600;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const cache: TokenCache = {
    target: 'local',
    issuer: 'memory-fixture',
    issuedAt: new Date().toISOString(),
    users: emails.map((email) => {
      const userId = fixtureUserId(email);
      const name = email.split('@')[0] ?? email;
      return { email, userId, name, expiresAt, idToken: server.signToken({ userId, email, name }, ttlSeconds) };
    }),
  };
  writeTokenCache(file, cache);
  return cache;
}
