/**
 * Runtime configuration (plan §2.6 / §2.7). `index.html` loads `/env.js`, which assigns
 * `window.__SEATRELAY_ENV__` before the bundle runs, so ONE build serves CloudFront and nginx.
 * `public/env.js` holds the `pnpm dev` defaults (local Keycloak + Fastify API).
 */

export const AUTH_PROVIDERS = ['cognito', 'keycloak'] as const;
export type AuthProviderKind = (typeof AUTH_PROVIDERS)[number];

export interface SeatRelayEnv {
  provider: AuthProviderKind;
  /** OIDC issuer, e.g. `http://localhost:8080/realms/seatrelay` or the Cognito issuer. */
  authority: string;
  /** Public PKCE client id (also the `aud` the API expects on the ID token). */
  clientId: string;
  /** Cognito hosted UI base URL (`https://….amazoncognito.com`); empty for Keycloak. */
  hostedUiDomain: string;
  /** API origin, no trailing slash. */
  apiBaseUrl: string;
  /** `local` | `dev` | `pilot` … shown in the header badge. */
  stage: string;
}

export const DEFAULT_ENV: SeatRelayEnv = {
  provider: 'keycloak',
  authority: 'http://localhost:8080/realms/seatrelay',
  clientId: 'seatrelay-web',
  hostedUiDomain: '',
  apiBaseUrl: 'http://localhost:3000',
  stage: 'local',
};

declare global {
  interface Window {
    __SEATRELAY_ENV__?: unknown;
  }
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

function stringField(raw: Record<string, unknown>, key: keyof SeatRelayEnv): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new EnvError(`env.js: ${key} must be a string`);
  }
  return value.trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Validates `window.__SEATRELAY_ENV__` (or any raw object) and fills defaults. Missing fields
 * fall back to the local defaults; a wrong type or unknown provider is a configuration error
 * that the app renders instead of silently talking to the wrong backend. (`readEnv` additionally
 * refuses a missing object on a deployed origin, see `resolveEnv`.)
 */
export function parseEnv(raw: unknown): SeatRelayEnv {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_ENV };
  }
  if (typeof raw !== 'object') {
    throw new EnvError('env.js: window.__SEATRELAY_ENV__ must be an object');
  }
  const record = raw as Record<string, unknown>;
  const provider = stringField(record, 'provider') ?? DEFAULT_ENV.provider;
  if (!(AUTH_PROVIDERS as readonly string[]).includes(provider)) {
    throw new EnvError(`env.js: provider must be one of ${AUTH_PROVIDERS.join(', ')}`);
  }
  const authority = stripTrailingSlash(stringField(record, 'authority') || DEFAULT_ENV.authority);
  const clientId = stringField(record, 'clientId') || DEFAULT_ENV.clientId;
  const hostedUiDomain = stripTrailingSlash(stringField(record, 'hostedUiDomain') ?? '');
  const apiBaseUrl = stripTrailingSlash(
    stringField(record, 'apiBaseUrl') || DEFAULT_ENV.apiBaseUrl,
  );
  const stage = stringField(record, 'stage') || DEFAULT_ENV.stage;
  if (provider === 'cognito' && hostedUiDomain.length === 0) {
    throw new EnvError('env.js: hostedUiDomain is required when provider is cognito');
  }
  return {
    provider: provider as AuthProviderKind,
    authority,
    clientId,
    hostedUiDomain,
    apiBaseUrl,
    stage,
  };
}

/** `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`: where the local defaults are right. */
export function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * `parseEnv` plus one rule: an absent `window.__SEATRELAY_ENV__` only falls back to the local
 * defaults in `vite dev` or on a local origin. On a deployed origin it means `/env.js` did not
 * load (e.g. CloudFront answered a missing object with index.html, which `nosniff` refuses to
 * run), and silently talking to localhost would send sign-in to http://localhost:8080.
 */
export function resolveEnv(raw: unknown, options: { allowLocalDefaults: boolean }): SeatRelayEnv {
  if ((raw === undefined || raw === null) && !options.allowLocalDefaults) {
    throw new EnvError(
      'env.js did not load: window.__SEATRELAY_ENV__ is undefined on this origin. Publish /env.js for this deployment.',
    );
  }
  return parseEnv(raw);
}

export function readEnv(): SeatRelayEnv {
  return resolveEnv(window.__SEATRELAY_ENV__, {
    allowLocalDefaults: import.meta.env.DEV || isLocalHostname(window.location.hostname),
  });
}
