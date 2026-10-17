import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CliError, LOADTEST_DIR, resolveUserPath } from './cli';

/**
 * `tools/loadtest/.token-cache.<target>.json` — the ID tokens k6 and the seed scripts use.
 * Written by `create-test-users` (Cognito) and `get-tokens-keycloak` (local stack); git-ignored.
 */
export const TokenCacheUserSchema = z.object({
  email: z.string().email(),
  idToken: z.string().min(1),
  /** ISO-8601 UTC; the token's `exp`. */
  expiresAt: z.string().datetime(),
  /** The token's `sub` (handy for `POST /orgs/{id}/members`). */
  userId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export type TokenCacheUser = z.infer<typeof TokenCacheUserSchema>;

export const TokenCacheSchema = z.object({
  target: z.string().optional(),
  issuer: z.string().optional(),
  issuedAt: z.string().datetime().optional(),
  users: z.array(TokenCacheUserSchema),
});
export type TokenCache = z.infer<typeof TokenCacheSchema>;

export function tokenCachePath(target: string, override?: string): string {
  if (override !== undefined && override.length > 0) {
    return resolveUserPath(override);
  }
  return path.join(LOADTEST_DIR, `.token-cache.${target}.json`);
}

export function readTokenCache(file: string): TokenCache {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new CliError(`token cache not found: ${file}`, {
      hint: 'Create it first: pnpm --filter @seatrelay/scripts get-tokens-keycloak (local) or create-test-users (dev).',
    });
  }
  const parsed = TokenCacheSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new CliError(
      `token cache ${file} is not valid: ${parsed.error.issues[0]?.message ?? 'schema'}`,
    );
  }
  return parsed.data;
}

export function writeTokenCache(file: string, cache: TokenCache): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
}

export function findCachedUser(cache: TokenCache, email: string): TokenCacheUser | undefined {
  const wanted = email.toLowerCase();
  return cache.users.find((user) => user.email.toLowerCase() === wanted);
}

/** True while the token is at least `marginMs` away from its `exp`. */
export function isTokenFresh(user: TokenCacheUser, now = Date.now(), marginMs = 60_000): boolean {
  return Date.parse(user.expiresAt) - marginMs > now;
}

/** Merges fresh entries into an existing cache (by e-mail), dropping expired ones. */
export function mergeTokenCache(
  existing: TokenCache | undefined,
  users: readonly TokenCacheUser[],
  meta: Pick<TokenCache, 'target' | 'issuer'>,
  now = Date.now(),
): TokenCache {
  const byEmail = new Map<string, TokenCacheUser>();
  for (const user of existing?.users ?? []) {
    if (isTokenFresh(user, now)) {
      byEmail.set(user.email.toLowerCase(), user);
    }
  }
  for (const user of users) {
    byEmail.set(user.email.toLowerCase(), user);
  }
  return {
    ...meta,
    issuedAt: new Date(now).toISOString(),
    users: [...byEmail.values()],
  };
}
