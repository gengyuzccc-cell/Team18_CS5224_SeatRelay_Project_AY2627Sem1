import { describe, expect, it } from 'vitest';
import {
  needsStartupRenew,
  RENEW_RETRY_WINDOW_MS,
  unauthorizedAction,
} from '../src/auth/sessionRenewal';

const NOW = 1_800_000_000_000;

describe('start-up renewal of a stored, expired session', () => {
  it('renews only an expired user that holds a refresh token', () => {
    expect(needsStartupRenew({ expired: true, refresh_token: 'rt' })).toBe(true);
    expect(needsStartupRenew({ expired: false, refresh_token: 'rt' })).toBe(false);
    expect(needsStartupRenew({ expired: true, refresh_token: undefined })).toBe(false);
    expect(needsStartupRenew({ expired: true, refresh_token: '' })).toBe(false);
    expect(needsStartupRenew(null)).toBe(false);
    expect(needsStartupRenew(undefined)).toBe(false);
  });
});

describe('a 401 from the API', () => {
  const user = { expired: false, refresh_token: 'rt', id_token: 'token-1' };

  it('renews once when the rejected token is still the current one', () => {
    expect(unauthorizedAction(user, 'token-1', undefined, NOW)).toBe('renew');
  });

  it('signs out locally when renewing is impossible or just did not help', () => {
    expect(
      unauthorizedAction({ ...user, refresh_token: undefined }, 'token-1', undefined, NOW),
    ).toBe('sign-out');
    expect(unauthorizedAction(user, 'token-1', NOW - RENEW_RETRY_WINDOW_MS + 1, NOW)).toBe(
      'sign-out',
    );
    expect(unauthorizedAction(user, 'token-1', NOW - RENEW_RETRY_WINDOW_MS - 1, NOW)).toBe('renew');
  });

  it('ignores a 401 for a token that was already replaced, or when nothing was sent', () => {
    expect(unauthorizedAction(user, 'token-0', undefined, NOW)).toBe('ignore');
    expect(unauthorizedAction(user, undefined, undefined, NOW)).toBe('ignore');
    expect(unauthorizedAction(null, 'token-1', undefined, NOW)).toBe('ignore');
  });
});
