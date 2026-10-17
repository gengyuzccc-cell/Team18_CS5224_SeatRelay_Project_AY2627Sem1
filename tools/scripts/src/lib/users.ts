import { CliError, mapWithConcurrency } from './cli';
import type { TokenCacheUser } from './tokenCache';

/**
 * Identity provisioning shared by every script that needs accounts with ID tokens: the
 * Cognito pool of a stage (`cognito.ts`) or the Keycloak realm of the local stack
 * (`keycloak.ts`). The engine identifies people by the token's `sub`, so every seeded
 * participant must be a real account.
 */

/** Password of the local stack's realm users (services/local/keycloak/realm-export.json). */
export const DEFAULT_PASSWORD = 'Passw0rd!';

/** Environment variable holding the test accounts' password on the AWS stages. */
export const TEST_PASSWORD_ENV = 'SEATRELAY_TEST_PASSWORD';

/**
 * Password of the test accounts of `target`: `--password` when given; otherwise DEFAULT_PASSWORD
 * on the local stack (its realm users, and services/local/scripts/smoke.sh, use it) and
 * $SEATRELAY_TEST_PASSWORD on an AWS stage. The repository is public, so an AWS stage refuses
 * the documented default: a script would otherwise sign in with, or reset accounts to, a password
 * anyone can read.
 */
export function testPassword(
  target: string,
  explicit?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const password = explicit ?? (target === 'local' ? DEFAULT_PASSWORD : env[TEST_PASSWORD_ENV]);
  if (password === undefined || password === '') {
    throw new CliError(`no test-account password for target ${target}`, {
      hint: `export ${TEST_PASSWORD_ENV}=<private password> (or pass --password); the default is for the local stack only`,
    });
  }
  if (target !== 'local' && password === DEFAULT_PASSWORD) {
    throw new CliError(`the documented default password is public; it is refused for target ${target}`, {
      hint: `choose a private password in ${TEST_PASSWORD_ENV} and reset the accounts with tools/scripts/bin/reset-test-passwords.sh`,
    });
  }
  return password;
}

export interface UserSpec {
  email: string;
  password: string;
  /** Display name (`name` claim). Derived from the e-mail when omitted. */
  name?: string;
}

export interface MintedToken {
  idToken: string;
  /** ISO-8601 UTC, the token's `exp`. */
  expiresAt: string;
  /** The token's `sub`. */
  userId: string;
  name?: string;
}

export interface EnsureUserResult {
  /** Known only when the provider returns it (Cognito on creation, Keycloak always). */
  userId?: string;
  created: boolean;
}

export interface UserProvider {
  readonly kind: 'keycloak' | 'cognito' | 'fake';
  readonly issuer: string;
  /** Creates the account when missing and (re)sets its permanent password; idempotent. */
  ensureUser(spec: UserSpec): Promise<EnsureUserResult>;
  /** Mints an ID token through the password grant / USER_PASSWORD_AUTH. */
  mintIdToken(email: string, password: string): Promise<MintedToken>;
}

export interface ProvisionedUser extends TokenCacheUser {
  userId: string;
  created: boolean;
}

export interface ProvisionOptions {
  /** Create missing accounts (default true); false = only mint tokens for existing ones. */
  create?: boolean;
  concurrency?: number;
  onUser?: (user: ProvisionedUser, index: number) => void;
}

/** Ensures every account exists (when `create`) and mints one ID token per account. */
export async function provisionUsers(
  provider: UserProvider,
  specs: readonly UserSpec[],
  options: ProvisionOptions = {},
): Promise<ProvisionedUser[]> {
  const { create = true, concurrency = 4 } = options;
  return mapWithConcurrency(specs, concurrency, async (spec, index) => {
    const name = spec.name ?? nameFromEmail(spec.email);
    const ensured = create ? await provider.ensureUser({ ...spec, name }) : { created: false };
    const minted = await provider.mintIdToken(spec.email, spec.password);
    const user: ProvisionedUser = {
      email: spec.email,
      idToken: minted.idToken,
      expiresAt: minted.expiresAt,
      userId: ensured.userId ?? minted.userId,
      name: minted.name ?? name,
      created: ensured.created,
    };
    options.onUser?.(user, index);
    return user;
  });
}

export function toCacheUser(user: ProvisionedUser): TokenCacheUser {
  const cached: TokenCacheUser = {
    email: user.email,
    idToken: user.idToken,
    expiresAt: user.expiresAt,
    userId: user.userId,
  };
  if (user.name !== undefined) {
    cached.name = user.name;
  }
  return cached;
}

export interface GeneratedUsersOptions {
  count: number;
  prefix: string;
  domain: string;
  password: string;
  /** First index (default 1): `prefix-1@domain`, `prefix-2@domain`, … */
  startAt?: number;
}

/** `loaduser-1@example.com` … `loaduser-N@example.com` with names `Loaduser 1` … */
export function generatedUserSpecs(options: GeneratedUsersOptions): UserSpec[] {
  const start = options.startAt ?? 1;
  return Array.from({ length: options.count }, (_, i) => {
    const email = `${options.prefix}-${start + i}@${options.domain}`;
    return { email, password: options.password, name: nameFromEmail(email) };
  });
}

/** `study.jordan@example.com` → `Study Jordan`, `loaduser-12@…` → `Loaduser 12`. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._+-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** `Mei Lin Chua` → `{ firstName: 'Mei Lin', lastName: 'Chua' }` (single word: lastName empty). */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) {
    return { firstName: parts[0] ?? '', lastName: '' };
  }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] as string };
}
