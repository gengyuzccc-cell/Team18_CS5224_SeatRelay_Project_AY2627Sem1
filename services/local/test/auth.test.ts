import { CommandSchema, MAX_DISPLAY_NAME_LENGTH, buildCommand } from '@seatrelay/contracts';
import { describe, expect, test } from 'vitest';
import { AuthError, bearerToken, toAuthUser } from '../src/auth';
import { loadConfig } from '../src/config';

describe('auth claims mapping', () => {
  test('maps sub/email/name of a Keycloak ID token', () => {
    expect(
      toAuthUser({
        sub: '4c9461ff-59d8-4f3b-826e-fd81eba4d6e6',
        email: 'alice@example.com',
        name: 'Alice Participant',
        preferred_username: 'alice@example.com',
      }),
    ).toEqual({
      userId: '4c9461ff-59d8-4f3b-826e-fd81eba4d6e6',
      email: 'alice@example.com',
      name: 'Alice Participant',
    });
  });

  test('falls back to given/family name and preferred_username', () => {
    expect(
      toAuthUser({ sub: 'u1', preferred_username: 'bob@example.com', given_name: 'Bob', family_name: 'P' }),
    ).toEqual({ userId: 'u1', email: 'bob@example.com', name: 'Bob P' });
    expect(toAuthUser({ sub: 'u2', email: 'c@example.com' })).toEqual({ userId: 'u2', email: 'c@example.com' });
  });

  test('rejects tokens without subject or email', () => {
    expect(() => toAuthUser({ email: 'x@example.com' })).toThrow(AuthError);
    expect(() => toAuthUser({ sub: 'u3' })).toThrow(AuthError);
    expect(() => toAuthUser({ sub: 'x'.repeat(129), email: 'x@example.com' })).toThrow(AuthError);
  });

  test('a username that is not an e-mail address is refused (401), not turned into an unprocessable command', () => {
    // A Keycloak user created without an e-mail: preferred_username is a plain username.
    expect(() => toAuthUser({ sub: 'u4', preferred_username: 'loaduser-7' })).toThrow(/no valid email/);
    expect(() => toAuthUser({ sub: 'u4', email: 'not-an-address', preferred_username: 'loaduser-7' })).toThrow(
      AuthError,
    );
    // An invalid email claim falls back to a preferred_username that is an address.
    expect(toAuthUser({ sub: 'u5', email: 'nope', preferred_username: 'dave@example.com' }).email).toBe(
      'dave@example.com',
    );
    expect(toAuthUser({ sub: 'u6', email: '  erin@example.com ' }).email).toBe('erin@example.com');
  });

  test('display names are trimmed and truncated to the command schema limit', () => {
    const long = toAuthUser({ sub: 'u7', email: 'f@example.com', name: `  ${'N'.repeat(300)}` });
    expect(long.name).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
    expect(toAuthUser({ sub: 'u8', email: 'g@example.com', name: '   ' })).toEqual({
      userId: 'u8',
      email: 'g@example.com',
    });
  });

  test('every identity toAuthUser accepts yields a command the worker can parse', () => {
    const users = [
      toAuthUser({ sub: '4c9461ff-59d8-4f3b-826e-fd81eba4d6e6', email: 'alice@example.com', name: 'Alice' }),
      toAuthUser({ sub: 'u9', preferred_username: 'bob@example.com', given_name: 'B'.repeat(200) }),
      toAuthUser({ sub: 'u10', email: 'carol@example.com', name: ' ' }),
    ];
    for (const user of users) {
      const command = buildCommand(
        { type: 'REGISTER', commandId: '0b6f3f9e-8f5d-4a55-9a8e-6c1f3f7f2b10', acceptable: ['s1'] },
        'ws-1',
        user,
      );
      expect(CommandSchema.safeParse(command).success).toBe(true);
    }
  });

  test('extracts bearer tokens', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Bearer ')).toBeUndefined();
  });
});

describe('configuration', () => {
  test('parses the compose environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://seatrelay:seatrelay@postgres:5432/seatrelay',
      OIDC_ISSUER: 'http://localhost:8080/realms/seatrelay',
      OIDC_JWKS_URL: 'http://keycloak:8080/realms/seatrelay/protocol/openid-connect/certs',
      OIDC_AUDIENCE: 'seatrelay-web, tooling',
      SMTP_URL: 'smtp://mailpit:1025',
      EMAIL_ENABLED: 'true',
      ALLOW_FAULT_FLAGS: 'false',
      WEB_ORIGIN: 'http://localhost:8081,http://localhost:5173',
      WORKER_POLL_MS: '200',
    });
    expect(config).toMatchObject({
      port: 3000,
      oidc: { audience: ['seatrelay-web', 'tooling'] },
      emailEnabled: true,
      allowFaultFlags: false,
      webOrigins: ['http://localhost:8081', 'http://localhost:5173'],
      workerPollMs: 200,
      timerPollMs: 1000,
      smtpUrl: 'smtp://mailpit:1025',
    });
  });

  test('notifier defaults retry with backoff for about 13.5 minutes', () => {
    const base = {
      DATABASE_URL: 'postgres://localhost/seatrelay',
      OIDC_ISSUER: 'http://localhost:8080/realms/seatrelay',
      OIDC_JWKS_URL: 'http://localhost:8080/realms/seatrelay/protocol/openid-connect/certs',
    };
    expect(loadConfig(base)).toMatchObject({ notifierMaxAttempts: 10, notifierRetryBackoffMs: 2000 });
    expect(
      loadConfig({ ...base, NOTIFIER_MAX_ATTEMPTS: '3', NOTIFIER_RETRY_BACKOFF_MS: '0' }),
    ).toMatchObject({ notifierMaxAttempts: 3, notifierRetryBackoffMs: 0 });
    expect(() => loadConfig({ ...base, NOTIFIER_RETRY_BACKOFF_MS: '-1' })).toThrow(/NOTIFIER_RETRY_BACKOFF_MS/);
  });

  test('reports missing variables', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
