#!/usr/bin/env tsx
import fs from 'node:fs';
import { CliError, intOption, log, parseCli, runMain, stringOption } from './lib/cli';
import { REALM_USERS, keycloakUserProvider } from './lib/keycloak';
import { keycloakOptionsFromEnv } from './lib/targets';
import {
  mergeTokenCache,
  readTokenCache,
  tokenCachePath,
  writeTokenCache,
  type TokenCache,
} from './lib/tokenCache';
import {
  DEFAULT_PASSWORD,
  generatedUserSpecs,
  provisionUsers,
  toCacheUser,
  type UserSpec,
} from './lib/users';

const USAGE = `
get-tokens-keycloak — ID tokens of the local stack's Keycloak users, in the k6 token-cache format

  pnpm --filter @seatrelay/scripts get-tokens-keycloak -- [options]

Who gets a token (first match wins)
  --users FILE         JSON array of { email, password?, name? } (or { users: [...] }), or one
                       e-mail per line
  --count N            generated accounts <prefix>-1@<domain> … <prefix>-N@<domain>
                       (--prefix loaduser, --domain example.com), created when missing
  (default)            the four realm users: organiser@, alice@, bob@, carol@example.com

Options
  --password PASS      password for accounts without one (default Passw0rd!)
  --keycloak URL       Keycloak base URL (default http://localhost:8080 / KEYCLOAK_BASE)
  --realm NAME         realm (default seatrelay)            --client ID   public client (default tooling)
  --admin-user U       bootstrap admin (default admin)      --admin-password P (default admin)
  --no-create          do not create missing accounts / reset passwords (no admin API call)
  --target NAME        cache file name suffix (default local)
  --cache FILE         cache file (default tools/loadtest/.token-cache.<target>.json)
  --concurrency N      parallel token requests (default 4)

Tokens come from the password grant of the public client (scope=openid); the cache is
tools/loadtest/.token-cache.local.json = { users: [{ email, idToken, expiresAt, userId }] }.
`;

function parseUsersFile(file: string, password: string): UserSpec[] {
  const raw = fs.readFileSync(file, 'utf8');
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : (parsed as { users?: unknown[] }).users;
    if (!Array.isArray(list)) {
      throw new CliError(`${file}: expected a JSON array or { users: [...] }`);
    }
    return list.map((entry, index) => {
      if (typeof entry === 'string') {
        return { email: entry, password };
      }
      const spec = entry as Partial<UserSpec>;
      if (typeof spec.email !== 'string') {
        throw new CliError(`${file}: entry ${index} has no email`);
      }
      return {
        email: spec.email,
        password: spec.password ?? password,
        ...(spec.name === undefined ? {} : { name: spec.name }),
      };
    });
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((email) => ({ email, password }));
}

runMain(async () => {
  const { values } = parseCli(
    {
      users: { type: 'string' },
      count: { type: 'string' },
      prefix: { type: 'string' },
      domain: { type: 'string' },
      password: { type: 'string' },
      keycloak: { type: 'string' },
      realm: { type: 'string' },
      client: { type: 'string' },
      'admin-user': { type: 'string' },
      'admin-password': { type: 'string' },
      'no-create': { type: 'boolean' },
      target: { type: 'string' },
      cache: { type: 'string' },
      concurrency: { type: 'string' },
    },
    USAGE,
  );
  const password = stringOption(values, 'password', DEFAULT_PASSWORD) as string;
  const target = stringOption(values, 'target', 'local') as string;
  const cacheFile = tokenCachePath(target, stringOption(values, 'cache'));

  let specs: UserSpec[];
  const usersFile = stringOption(values, 'users');
  const count = intOption(values, 'count', 0);
  if (usersFile !== undefined) {
    specs = parseUsersFile(usersFile, password);
  } else if (count > 0) {
    specs = generatedUserSpecs({
      count,
      prefix: stringOption(values, 'prefix', 'loaduser') as string,
      domain: stringOption(values, 'domain', 'example.com') as string,
      password,
    });
  } else {
    specs = REALM_USERS.map((user) => ({ ...user, password }));
  }
  if (specs.length === 0) {
    throw new CliError('no users to mint tokens for');
  }

  const keycloak = keycloakOptionsFromEnv({
    ...(stringOption(values, 'keycloak') === undefined
      ? {}
      : { baseUrl: stringOption(values, 'keycloak') }),
    ...(stringOption(values, 'realm') === undefined
      ? {}
      : { realm: stringOption(values, 'realm') }),
    ...(stringOption(values, 'client') === undefined
      ? {}
      : { clientId: stringOption(values, 'client') }),
    ...(stringOption(values, 'admin-user') === undefined
      ? {}
      : { adminUsername: stringOption(values, 'admin-user') }),
    ...(stringOption(values, 'admin-password') === undefined
      ? {}
      : { adminPassword: stringOption(values, 'admin-password') }),
  });
  const provider = keycloakUserProvider(keycloak);
  const create = values['no-create'] !== true;
  log('minting tokens', {
    issuer: provider.issuer,
    client: keycloak.clientId,
    users: specs.length,
    create,
  });

  let created = 0;
  let users;
  try {
    users = await provisionUsers(provider, specs, {
      create,
      concurrency: intOption(values, 'concurrency', 4),
      onUser: (user) => {
        created += user.created ? 1 : 0;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(message, {
      hint: `Is the local stack up? docker compose -f services/local/docker-compose.yml ps (Keycloak at ${keycloak.baseUrl})`,
    });
  }

  let existing: TokenCache | undefined;
  try {
    existing = readTokenCache(cacheFile);
  } catch {
    existing = undefined;
  }
  const cache = mergeTokenCache(existing, users.map(toCacheUser), {
    target,
    issuer: provider.issuer,
  });
  writeTokenCache(cacheFile, cache);
  const soonest = users.map((user) => user.expiresAt).sort()[0];
  log('token cache written', {
    file: cacheFile,
    users: cache.users.length,
    created,
    firstExpiry: soonest,
  });
  process.stdout.write(
    `${JSON.stringify({ target, cacheFile, users: users.length, created, firstExpiry: soonest })}\n`,
  );
});
