import type { AuthUser } from '@seatrelay/contracts';
import { createInMemoryPorts, toWireResponse, type InMemoryPorts } from '@seatrelay/service';
import { decodeJwtPayload, unsignedJwt } from '../../src/lib/jwt';
import type { FetchLike } from '../../src/lib/api';
import type { EnsureUserResult, MintedToken, UserProvider, UserSpec } from '../../src/lib/users';

/**
 * Routes `fetch` calls into the in-memory `createApiApp` of `@seatrelay/service`, verifying
 * nothing: the bearer token is an unsigned JWT whose claims become the `AuthUser`. After a
 * command POST the queue is drained (the worker runs), so the first poll sees the settled
 * record, like a fast deployment.
 */
export interface InMemoryApi {
  ports: InMemoryPorts;
  fetch: FetchLike;
  baseUrl: string;
  tokenFor(user: AuthUser): string;
  /** Number of requests served so far. */
  requests: number;
}

export function createInMemoryApi(
  options: { now?: string; drainOnPost?: boolean } = {},
): InMemoryApi {
  const ports = createInMemoryPorts({ now: options.now ?? '2026-10-20T02:00:00.000Z' });
  const drainOnPost = options.drainOnPost ?? true;
  const api: InMemoryApi = {
    ports,
    baseUrl: 'http://api.test',
    requests: 0,
    tokenFor: (user) =>
      unsignedJwt({
        sub: user.userId,
        email: user.email,
        ...(user.name === undefined ? {} : { name: user.name }),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    fetch: async (input, init) => {
      api.requests += 1;
      const url = new URL(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = headerRecord(init?.headers);
      let user: AuthUser | undefined;
      const auth = headers.authorization;
      if (auth !== undefined && auth.startsWith('Bearer ')) {
        const payload = decodeJwtPayload(auth.slice('Bearer '.length));
        user = { userId: String(payload.sub), email: String(payload.email) };
        if (typeof payload.name === 'string') {
          user.name = payload.name;
        }
      }
      const body =
        typeof init?.body === 'string' && init.body.length > 0
          ? (JSON.parse(init.body) as unknown)
          : undefined;
      const response = await ports.api.handle({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        body,
        ...(user === undefined ? {} : { user }),
      });
      if (drainOnPost && method === 'POST' && /^\/workshops\/[^/]+\/commands$/.test(url.pathname)) {
        ports.clock.advance(7);
        await ports.drain();
      }
      const wire = toWireResponse(response);
      return new Response(wire.body, { status: wire.status, headers: wire.headers });
    },
  };
  return api;
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined || headers === null) {
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  const entries: [string, string | readonly string[]][] = Array.isArray(headers)
    ? (headers as [string, string][])
    : Object.entries(headers);
  for (const [key, value] of entries) {
    out[key.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
  }
  return out;
}

/** A `UserProvider` that invents stable ids and mints unsigned JWTs. */
export function fakeUserProvider(api: InMemoryApi): UserProvider & {
  users: Map<string, { userId: string; name: string; password: string }>;
  ensured: UserSpec[];
} {
  const users = new Map<string, { userId: string; name: string; password: string }>();
  const ensured: UserSpec[] = [];
  let counter = 0;
  return {
    kind: 'fake',
    issuer: 'fake',
    users,
    ensured,
    async ensureUser(spec: UserSpec): Promise<EnsureUserResult> {
      ensured.push(spec);
      const key = spec.email.toLowerCase();
      const existing = users.get(key);
      if (existing !== undefined) {
        existing.password = spec.password;
        return { userId: existing.userId, created: false };
      }
      counter += 1;
      const userId = `u-${counter}`;
      users.set(key, { userId, name: spec.name ?? spec.email, password: spec.password });
      return { userId, created: true };
    },
    async mintIdToken(email: string, password: string): Promise<MintedToken> {
      const user = users.get(email.toLowerCase());
      if (user === undefined || user.password !== password) {
        throw new Error(`invalid credentials for ${email}`);
      }
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return {
        idToken: api.tokenFor({ userId: user.userId, email, name: user.name }),
        expiresAt,
        userId: user.userId,
        name: user.name,
      };
    },
  };
}
