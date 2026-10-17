import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from '../src/lib/cli';
import {
  findCachedUser,
  isTokenFresh,
  mergeTokenCache,
  readTokenCache,
  tokenCachePath,
  writeTokenCache,
  type TokenCacheUser,
} from '../src/lib/tokenCache';

const dirs: string[] = [];
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seatrelay-cache-'));
  dirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const user = (email: string, expiresAt: string): TokenCacheUser => ({
  email,
  idToken: `tok-${email}`,
  expiresAt,
});

describe('token cache', () => {
  it('defaults to tools/loadtest/.token-cache.<target>.json', () => {
    expect(tokenCachePath('local')).toMatch(/tools[/\\]loadtest[/\\]\.token-cache\.local\.json$/);
    expect(tokenCachePath('dev', 'custom.json')).toBe(path.resolve('custom.json'));
  });

  it('writes and reads the { users: [{ email, idToken, expiresAt }] } format', () => {
    const file = tmpFile('.token-cache.test.json');
    writeTokenCache(file, {
      target: 'test',
      users: [user('a@example.com', '2030-01-01T00:00:00.000Z')],
    });
    const cache = readTokenCache(file);
    expect(cache.users).toHaveLength(1);
    expect(findCachedUser(cache, 'A@EXAMPLE.COM')?.idToken).toBe('tok-a@example.com');
    expect(findCachedUser(cache, 'nobody@example.com')).toBeUndefined();
  });

  it('fails clearly on a missing or invalid file', () => {
    expect(() => readTokenCache(tmpFile('missing.json'))).toThrow(CliError);
    const bad = tmpFile('bad.json');
    fs.writeFileSync(bad, JSON.stringify({ users: [{ email: 'x' }] }));
    expect(() => readTokenCache(bad)).toThrow(/not valid/);
  });

  it('merges by e-mail and drops expired entries', () => {
    const now = Date.parse('2026-10-17T06:00:00.000Z');
    const fresh = user('a@example.com', '2026-10-17T07:00:00.000Z');
    const stale = user('b@example.com', '2026-10-17T05:00:00.000Z');
    expect(isTokenFresh(fresh, now)).toBe(true);
    expect(isTokenFresh(stale, now)).toBe(false);
    const merged = mergeTokenCache(
      { users: [fresh, stale] },
      [user('A@example.com', '2026-10-17T08:00:00.000Z')],
      { target: 'local' },
      now,
    );
    expect(merged.users.map((u) => [u.email, u.expiresAt])).toEqual([
      ['A@example.com', '2026-10-17T08:00:00.000Z'],
    ]);
    expect(merged.issuedAt).toBe('2026-10-17T06:00:00.000Z');
  });
});
