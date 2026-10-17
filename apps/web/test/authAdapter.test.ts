import { describe, expect, it, vi } from 'vitest';
import {
  buildOidcSettings,
  cognitoLogoutUrl,
  returnToFromState,
  sanitizeReturnTo,
  signOut,
} from '../src/auth/authAdapter';
import type { SeatRelayEnv } from '../src/env';

const cognito: SeatRelayEnv = {
  provider: 'cognito',
  authority: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc',
  clientId: '6f926dm22ulrv8gfjro2db1ac',
  hostedUiDomain: 'https://seatrelay-123.auth.ap-southeast-1.amazoncognito.com',
  apiBaseUrl: 'https://api.example.com',
  stage: 'dev',
};
const keycloak: SeatRelayEnv = {
  provider: 'keycloak',
  authority: 'http://localhost:8080/realms/seatrelay',
  clientId: 'seatrelay-web',
  hostedUiDomain: '',
  apiBaseUrl: 'http://localhost:3000',
  stage: 'local',
};

describe('authAdapter', () => {
  it('uses code + PKCE, /callback as redirect and the ID-token-friendly scopes', () => {
    const settings = buildOidcSettings(keycloak, 'http://localhost:5173');
    expect(settings.response_type).toBe('code');
    expect(settings.redirect_uri).toBe('http://localhost:5173/callback');
    expect(settings.post_logout_redirect_uri).toBe('http://localhost:5173/');
    expect(settings.scope).toBe('openid email profile');
    expect(settings.automaticSilentRenew).toBe(true);
    expect(settings.loadUserInfo).toBe(false);
  });

  it('builds the Cognito hosted-UI logout URL with the registered logout_uri (trailing slash)', () => {
    const url = new URL(cognitoLogoutUrl(cognito, 'https://d2ni5e1z674t04.cloudfront.net'));
    expect(url.origin + url.pathname).toBe(
      'https://seatrelay-123.auth.ap-southeast-1.amazoncognito.com/logout',
    );
    expect(url.searchParams.get('client_id')).toBe(cognito.clientId);
    expect(url.searchParams.get('logout_uri')).toBe('https://d2ni5e1z674t04.cloudfront.net/');
    expect(
      cognitoLogoutUrl(
        { ...cognito, hostedUiDomain: 'x.auth.region.amazoncognito.com/' },
        'http://localhost:5173',
      ),
    ).toMatch(/^https:\/\/x\.auth\.region\.amazoncognito\.com\/logout\?/);
  });

  it('Cognito sign-out removes the user then navigates to the hosted UI; Keycloak uses signoutRedirect', async () => {
    const navigate = vi.fn();
    const client = { removeUser: vi.fn(async () => {}), signoutRedirect: vi.fn(async () => {}) };
    await signOut(client, cognito, 'http://localhost:5173', navigate);
    expect(client.removeUser).toHaveBeenCalledTimes(1);
    expect(client.signoutRedirect).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(cognitoLogoutUrl(cognito, 'http://localhost:5173'));

    navigate.mockClear();
    client.removeUser.mockClear();
    await signOut(client, keycloak, 'http://localhost:5173', navigate);
    expect(client.signoutRedirect).toHaveBeenCalledWith({
      post_logout_redirect_uri: 'http://localhost:5173/',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('only returns to same-origin paths after sign-in', () => {
    expect(sanitizeReturnTo('/workshops/abc?x=1')).toBe('/workshops/abc?x=1');
    expect(sanitizeReturnTo('https://evil.example')).toBe('/');
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
    expect(sanitizeReturnTo('/callback?code=1')).toBe('/');
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(returnToFromState({ returnTo: '/me/registrations' })).toBe('/me/registrations');
    expect(returnToFromState('garbage')).toBe('/');
  });
});
