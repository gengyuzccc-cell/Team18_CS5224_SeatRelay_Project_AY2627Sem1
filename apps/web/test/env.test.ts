import { describe, expect, it } from 'vitest';
import { DEFAULT_ENV, EnvError, isLocalHostname, parseEnv, resolveEnv } from '../src/env';

describe('env.js contract', () => {
  it('falls back to the local Keycloak defaults when env.js is missing', () => {
    expect(parseEnv(undefined)).toEqual(DEFAULT_ENV);
    expect(parseEnv({})).toEqual(DEFAULT_ENV);
  });

  it('accepts the deploy-web.sh shape and trims trailing slashes', () => {
    const env = parseEnv({
      provider: 'cognito',
      authority: 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool/',
      clientId: 'abc',
      hostedUiDomain: 'https://seatrelay-1.auth.ap-southeast-1.amazoncognito.com/',
      apiBaseUrl: 'https://xyz.execute-api.ap-southeast-1.amazonaws.com/',
      stage: 'dev',
    });
    expect(env.authority).toBe('https://cognito-idp.ap-southeast-1.amazonaws.com/pool');
    expect(env.hostedUiDomain).toBe('https://seatrelay-1.auth.ap-southeast-1.amazoncognito.com');
    expect(env.apiBaseUrl).toBe('https://xyz.execute-api.ap-southeast-1.amazonaws.com');
    expect(env.stage).toBe('dev');
  });

  it('rejects an unknown provider, a non-string field and cognito without a hosted UI domain', () => {
    expect(() => parseEnv({ provider: 'okta' })).toThrow(EnvError);
    expect(() => parseEnv({ apiBaseUrl: 42 })).toThrow(EnvError);
    expect(() => parseEnv({ provider: 'cognito', hostedUiDomain: '' })).toThrow(EnvError);
  });

  it('refuses a missing env.js on a deployed origin instead of defaulting to localhost', () => {
    expect(() => resolveEnv(undefined, { allowLocalDefaults: false })).toThrow(
      /env.js did not load/,
    );
    expect(resolveEnv(undefined, { allowLocalDefaults: true })).toEqual(DEFAULT_ENV);
    expect(resolveEnv({ stage: 'dev' }, { allowLocalDefaults: false }).stage).toBe('dev');
  });

  it('treats only loopback hosts as local', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '[::1]']) {
      expect(isLocalHostname(host)).toBe(true);
    }
    for (const host of ['d1234.cloudfront.net', 'seatrelay.example.com', '10.0.0.5']) {
      expect(isLocalHostname(host)).toBe(false);
    }
  });
});
