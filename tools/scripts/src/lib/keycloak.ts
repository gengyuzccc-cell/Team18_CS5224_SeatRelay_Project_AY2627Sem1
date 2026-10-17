import { networkCause, type FetchLike } from './api';
import { CliError } from './cli';
import { decodeJwtPayload, jwtExpiresAt } from './jwt';
import {
  splitName,
  type EnsureUserResult,
  type MintedToken,
  type UserProvider,
  type UserSpec,
} from './users';

/**
 * Keycloak (local stack, plan §2.7): ID tokens through the password grant of the public
 * `tooling` client, and account provisioning through the admin REST API with the bootstrap
 * admin of `docker-compose.yml` (admin / admin).
 */

export interface KeycloakOptions {
  /** e.g. http://localhost:8080 */
  baseUrl: string;
  realm: string;
  /** Public client with direct access grants (`tooling`). */
  clientId: string;
  adminUsername: string;
  adminPassword: string;
  adminRealm: string;
  fetch?: FetchLike;
}

export const DEFAULT_KEYCLOAK: KeycloakOptions = {
  baseUrl: 'http://localhost:8080',
  realm: 'seatrelay',
  clientId: 'tooling',
  adminUsername: 'admin',
  adminPassword: 'admin',
  adminRealm: 'master',
};

/** The four accounts of `services/local/keycloak/realm-export.json`. */
export const REALM_USERS: readonly { email: string; name: string }[] = [
  { email: 'organiser@example.com', name: 'Olivia Organiser' },
  { email: 'alice@example.com', name: 'Alice Participant' },
  { email: 'bob@example.com', name: 'Bob Participant' },
  { email: 'carol@example.com', name: 'Carol Participant' },
];

export function keycloakIssuer(options: Pick<KeycloakOptions, 'baseUrl' | 'realm'>): string {
  return `${options.baseUrl.replace(/\/+$/, '')}/realms/${options.realm}`;
}

export const KEYCLOAK_UNREACHABLE_HINT =
  'Is the local stack up? docker compose -f services/local/docker-compose.yml ps ' +
  '(Keycloak takes about a minute to become healthy after `up`).';

/** `fetch` that turns "no HTTP answer" into a CliError naming the Keycloak URL. */
function fetchOf(options: KeycloakOptions): FetchLike {
  const inner: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    try {
      return await inner(input, init);
    } catch (error) {
      throw new CliError(
        `Keycloak is not reachable at ${options.baseUrl} (${networkCause(error)})`,
        { hint: KEYCLOAK_UNREACHABLE_HINT },
      );
    }
  };
}

async function tokenEndpoint(
  options: KeycloakOptions,
  realm: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/token`;
  const response = await fetchOf(options)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    const description = body.error_description ?? body.error ?? text;
    throw new Error(
      `Keycloak token request (${form.grant_type} for ${form.username ?? form.client_id}) failed: ${response.status} ${String(description)}`,
    );
  }
  return body;
}

/** Password grant on the `tooling` client → ID token (`scope=openid`). */
export async function keycloakPasswordGrant(
  options: KeycloakOptions,
  username: string,
  password: string,
): Promise<MintedToken> {
  const body = await tokenEndpoint(options, options.realm, {
    grant_type: 'password',
    client_id: options.clientId,
    username,
    password,
    scope: 'openid',
  });
  const idToken = body.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new Error(
      `Keycloak returned no id_token for ${username} (is scope=openid allowed on ${options.clientId}?)`,
    );
  }
  const payload = decodeJwtPayload(idToken);
  const minted: MintedToken = {
    idToken,
    expiresAt: jwtExpiresAt(idToken),
    userId: typeof payload.sub === 'string' ? payload.sub : '',
  };
  if (typeof payload.name === 'string' && payload.name.length > 0) {
    minted.name = payload.name;
  }
  return minted;
}

interface KeycloakUserRepresentation {
  id?: string;
  username?: string;
  email?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
  credentials?: { type: string; value: string; temporary: boolean }[];
}

/** Admin REST API client (`/admin/realms/{realm}/users`). */
export class KeycloakAdmin {
  private readonly options: KeycloakOptions;
  private readonly fetchImpl: FetchLike;
  private adminToken: { token: string; expiresAt: number } | undefined;

  constructor(options: KeycloakOptions) {
    this.options = options;
    this.fetchImpl = fetchOf(options);
  }

  private get base(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  async token(): Promise<string> {
    const now = Date.now();
    if (this.adminToken !== undefined && this.adminToken.expiresAt - 15_000 > now) {
      return this.adminToken.token;
    }
    const body = await tokenEndpoint(this.options, this.options.adminRealm, {
      grant_type: 'password',
      client_id: 'admin-cli',
      username: this.options.adminUsername,
      password: this.options.adminPassword,
    });
    const token = body.access_token;
    if (typeof token !== 'string') {
      throw new Error('Keycloak admin token response has no access_token');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 60;
    this.adminToken = { token, expiresAt: now + expiresIn * 1000 };
    return token;
  }

  private async admin(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token()}`,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(
      `${this.base}/admin/realms/${this.options.realm}${path}`,
      init,
    );
    if (!response.ok && response.status !== 409) {
      const text = await response.text();
      throw new Error(`Keycloak admin ${method} ${path} failed: ${response.status} ${text}`);
    }
    return response;
  }

  async findUserByEmail(email: string): Promise<KeycloakUserRepresentation | undefined> {
    const response = await this.admin(
      'GET',
      `/users?email=${encodeURIComponent(email)}&exact=true&max=2`,
    );
    const users = (await response.json()) as KeycloakUserRepresentation[];
    const wanted = email.toLowerCase();
    return users.find((user) => user.email?.toLowerCase() === wanted) ?? users[0];
  }

  /** Creates the account (enabled, e-mail verified, permanent password); 409 = exists. */
  async createUser(spec: UserSpec): Promise<{ id?: string; created: boolean }> {
    const { firstName, lastName } = splitName(spec.name ?? spec.email);
    const representation: KeycloakUserRepresentation = {
      username: spec.email,
      email: spec.email,
      enabled: true,
      emailVerified: true,
      firstName,
      lastName,
      credentials: [{ type: 'password', value: spec.password, temporary: false }],
    };
    const response = await this.admin('POST', '/users', representation);
    if (response.status === 409) {
      return { created: false };
    }
    const location = response.headers.get('location') ?? '';
    const id = location
      .split('/')
      .filter((part) => part.length > 0)
      .pop();
    return { ...(id === undefined ? {} : { id }), created: true };
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.admin('PUT', `/users/${encodeURIComponent(userId)}/reset-password`, {
      type: 'password',
      value: password,
      temporary: false,
    });
  }

  /** Idempotent: existing accounts keep their id and get the password (re)set. */
  async ensureUser(spec: UserSpec): Promise<EnsureUserResult> {
    const existing = await this.findUserByEmail(spec.email);
    if (existing?.id !== undefined) {
      await this.setPassword(existing.id, spec.password);
      return { userId: existing.id, created: false };
    }
    const created = await this.createUser(spec);
    if (created.created) {
      return created.id === undefined ? { created: true } : { userId: created.id, created: true };
    }
    // Lost a race with a concurrent creation: look it up again.
    const again = await this.findUserByEmail(spec.email);
    if (again?.id !== undefined) {
      await this.setPassword(again.id, spec.password);
      return { userId: again.id, created: false };
    }
    throw new Error(`Keycloak reported ${spec.email} as existing but it cannot be found`);
  }
}

export function keycloakUserProvider(options: KeycloakOptions): UserProvider {
  const admin = new KeycloakAdmin(options);
  return {
    kind: 'keycloak',
    issuer: keycloakIssuer(options),
    ensureUser: (spec) => admin.ensureUser(spec),
    mintIdToken: (email, password) => keycloakPasswordGrant(options, email, password),
  };
}
