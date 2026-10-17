import {
  ApiClient,
  decodeJwtPayload,
  findCachedUser,
  isTokenFresh,
  mapWithConcurrency,
  mergeTokenCache,
  readTokenCache,
  writeTokenCache,
  type FetchLike,
  type TargetConfig,
  type TokenCache,
  type TokenCacheUser,
  type UserProvider,
} from '@seatrelay/scripts';

/**
 * Accounts with ID tokens for an experiment. Tokens come from the shared k6 token cache
 * (`tools/loadtest/.token-cache.<target>.json`, written by `create-test-users` on dev and
 * `get-tokens-keycloak` on local); a missing or stale entry is minted through the target's
 * identity provider (Keycloak password grant / Cognito InitiateAuth), creating the account
 * first when allowed. Every `Account.client` refreshes its token transparently, so long runs
 * (the 60 s holds of the backfill experiment × many workshops) never fail on an expired token.
 */

/** Refresh when fewer than this many ms remain before `exp`. */
export const TOKEN_REFRESH_MARGIN_MS = 120_000;

export interface Account {
  readonly email: string;
  readonly userId: string;
  readonly name: string | undefined;
  /** Authenticated client; the bearer token is renewed before it expires. */
  readonly client: ApiClient;
  token(): Promise<string>;
}

export interface AccountNaming {
  /** `loaduser` → loaduser-1@…, loaduser-2@… */
  prefix: string;
  domain: string;
  organiserEmail: string;
  outsiderEmail: string;
}

export function participantEmail(naming: Pick<AccountNaming, 'prefix' | 'domain'>, index: number): string {
  return `${naming.prefix}-${index}@${naming.domain}`;
}

/** `loaduser-7@example.com` → `Loaduser 7` (the display name of generated accounts). */
export function displayNameOf(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._+-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface AccountPoolOptions {
  target: TargetConfig;
  naming: AccountNaming;
  password: string;
  cacheFile: string;
  /** Create missing accounts (and reset their password) through the provider. */
  create: boolean;
  /** Built on first use only: dev needs AWS credentials for the Cognito pool lookup. */
  provider: () => Promise<UserProvider>;
  fetch?: FetchLike;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export class AccountPool {
  readonly naming: AccountNaming;
  private readonly options: AccountPoolOptions;
  private readonly accounts = new Map<string, Account>();
  private cache: TokenCache;
  private providerPromise: Promise<UserProvider> | undefined;
  private minted = 0;
  private created = 0;

  constructor(options: AccountPoolOptions) {
    this.options = options;
    this.naming = options.naming;
    this.cache = loadCache(options.cacheFile);
  }

  get stats(): { cached: number; minted: number; created: number } {
    return { cached: this.accounts.size - this.minted, minted: this.minted, created: this.created };
  }

  organiser(): Promise<Account> {
    return this.get(this.naming.organiserEmail);
  }

  /** An organiser of another organisation (cross-org negative cases). */
  outsider(): Promise<Account> {
    return this.get(this.naming.outsiderEmail);
  }

  /** `prefix-<from>@domain` … `prefix-<from + count − 1>@domain`. */
  participants(count: number, from = 1): Promise<Account[]> {
    const emails = Array.from({ length: count }, (_, i) => participantEmail(this.naming, from + i));
    return this.many(emails);
  }

  async many(emails: readonly string[], concurrency = 4): Promise<Account[]> {
    return mapWithConcurrency(emails, concurrency, (email) => this.get(email));
  }

  async get(email: string, name?: string): Promise<Account> {
    const key = email.toLowerCase();
    const existing = this.accounts.get(key);
    if (existing !== undefined) {
      return existing;
    }
    let entry = findCachedUser(this.cache, email);
    if (entry === undefined || !isTokenFresh(entry, this.now(), TOKEN_REFRESH_MARGIN_MS)) {
      entry = await this.mint(email, name);
    }
    const account = this.buildAccount(entry, name);
    this.accounts.set(key, account);
    return account;
  }

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private provider(): Promise<UserProvider> {
    this.providerPromise ??= this.options.provider();
    return this.providerPromise;
  }

  private async mint(email: string, name?: string): Promise<TokenCacheUser> {
    const provider = await this.provider();
    const displayName = name ?? displayNameOf(email);
    let userId: string | undefined;
    if (this.options.create) {
      const ensured = await provider.ensureUser({ email, password: this.options.password, name: displayName });
      userId = ensured.userId;
      if (ensured.created) {
        this.created += 1;
      }
    }
    const minted = await provider.mintIdToken(email, this.options.password);
    this.minted += 1;
    const entry: TokenCacheUser = {
      email,
      idToken: minted.idToken,
      expiresAt: minted.expiresAt,
      userId: userId ?? minted.userId,
      name: minted.name ?? displayName,
    };
    this.cache = mergeTokenCache(this.cache, [entry], { target: this.options.target.name, issuer: provider.issuer }, this.now());
    this.persist();
    this.options.log?.('token minted', { email, created: this.options.create, expiresAt: entry.expiresAt });
    return entry;
  }

  private persist(): void {
    try {
      writeTokenCache(this.options.cacheFile, this.cache);
    } catch (error) {
      this.options.log?.('token cache not written', {
        file: this.options.cacheFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildAccount(initial: TokenCacheUser, name?: string): Account {
    const fetchImpl: FetchLike = this.options.fetch ?? ((input, init) => fetch(input, init));
    let entry = initial;
    const token = async (): Promise<string> => {
      if (!isTokenFresh(entry, this.now(), TOKEN_REFRESH_MARGIN_MS)) {
        entry = await this.mint(entry.email, name);
      }
      return entry.idToken;
    };
    const authFetch: FetchLike = async (input, init) => {
      const headers: Record<string, string> = {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        authorization: `Bearer ${await token()}`,
      };
      return fetchImpl(input, { ...init, headers });
    };
    const client = new ApiClient({ baseUrl: this.options.target.apiBase, fetch: authFetch });
    return {
      email: initial.email,
      userId: initial.userId ?? subOf(initial.idToken),
      name: initial.name ?? name,
      client,
      token,
    };
  }
}

function subOf(idToken: string): string {
  try {
    const { sub } = decodeJwtPayload(idToken);
    return typeof sub === 'string' ? sub : '';
  } catch {
    return '';
  }
}

function loadCache(file: string): TokenCache {
  try {
    return readTokenCache(file);
  } catch {
    return { users: [] };
  }
}
