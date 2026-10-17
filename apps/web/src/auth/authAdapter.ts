import type { StateStore, User, UserManagerSettings } from 'oidc-client-ts';
import type { SeatRelayEnv } from '../env';

/**
 * Authentication adapter (plan §2.4 / §2.6): authorization code + PKCE through
 * react-oidc-context; the **ID token** is the API bearer (it carries `email`, and the API
 * authorizer checks `aud` = web client id). Silent renew uses the refresh token.
 *
 * Logout differs per provider: Cognito's discovery document has no `end_session_endpoint`, so
 * after `removeUser()` the browser is sent to the hosted UI `/logout` endpoint; Keycloak uses
 * standard RP-initiated logout (`signoutRedirect`).
 */

export const CALLBACK_PATH = '/callback';
export const RETURN_TO_KEY = 'seatrelay:returnTo';

export function redirectUri(origin: string): string {
  return `${origin}${CALLBACK_PATH}`;
}

/** Registered logout URLs end with a slash (`http://localhost:5173/`), so match them exactly. */
export function postLogoutRedirectUri(origin: string): string {
  return `${origin}/`;
}

export function buildOidcSettings(
  env: SeatRelayEnv,
  origin: string,
  userStore?: StateStore,
): UserManagerSettings {
  return {
    authority: env.authority,
    client_id: env.clientId,
    redirect_uri: redirectUri(origin),
    post_logout_redirect_uri: postLogoutRedirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 60,
    loadUserInfo: false,
    monitorSession: false,
    revokeTokensOnSignout: false,
    ...(userStore !== undefined ? { userStore } : {}),
  };
}

/** `https://<domain>/logout?client_id=…&logout_uri=<origin>/` (classic hosted UI). */
export function cognitoLogoutUrl(env: SeatRelayEnv, origin: string): string {
  const base = env.hostedUiDomain.startsWith('http')
    ? env.hostedUiDomain
    : `https://${env.hostedUiDomain}`;
  const query = new URLSearchParams({
    client_id: env.clientId,
    logout_uri: postLogoutRedirectUri(origin),
  });
  return `${base.replace(/\/+$/, '')}/logout?${query.toString()}`;
}

/** The API bearer: the ID token (plan §2.4). */
export function bearerToken(user: User | null | undefined): string | undefined {
  const token = user?.id_token;
  return token !== undefined && token.length > 0 ? token : undefined;
}

export interface SessionProfile {
  userId: string;
  email: string;
  name?: string;
}

export function profileOf(user: User | null | undefined): SessionProfile | undefined {
  if (user === null || user === undefined) {
    return undefined;
  }
  const { profile } = user;
  const sub = profile.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    return undefined;
  }
  const emailClaim = profile.email ?? profile.preferred_username;
  const email = typeof emailClaim === 'string' ? emailClaim : '';
  const nameClaim =
    profile.name ??
    [profile.given_name, profile.family_name].filter((part) => typeof part === 'string').join(' ');
  const name = typeof nameClaim === 'string' && nameClaim.trim().length > 0 ? nameClaim : undefined;
  return { userId: sub, email, ...(name !== undefined ? { name } : {}) };
}

/** Where to go after the sign-in round trip; only same-origin paths are accepted. */
export function sanitizeReturnTo(candidate: unknown): string {
  if (typeof candidate !== 'string') {
    return '/';
  }
  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.startsWith(CALLBACK_PATH)
  ) {
    return '/';
  }
  return candidate;
}

/** `signinRedirect` state → the stored return path (state is `{ returnTo }`). */
export function returnToFromState(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'returnTo' in state) {
    return sanitizeReturnTo((state as { returnTo?: unknown }).returnTo);
  }
  return '/';
}

/** Subset of the react-oidc-context API the sign-out flow needs (keeps this file testable). */
export interface SignOutClient {
  removeUser(): Promise<void>;
  signoutRedirect(args?: { post_logout_redirect_uri?: string }): Promise<void>;
}

export async function signOut(
  client: SignOutClient,
  env: SeatRelayEnv,
  origin: string,
  navigate: (url: string) => void,
): Promise<void> {
  if (env.provider === 'cognito') {
    await client.removeUser();
    navigate(cognitoLogoutUrl(env, origin));
    return;
  }
  await client.signoutRedirect({ post_logout_redirect_uri: postLogoutRedirectUri(origin) });
}
