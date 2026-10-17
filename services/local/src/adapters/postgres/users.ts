import type { AuthUser } from '@seatrelay/contracts';
import type { UserDirectory } from '@seatrelay/service';
import type { Executor } from './db';

/**
 * Email → userId lookup for `POST /orgs/{orgId}/members` by email. Keycloak is the identity
 * authority; this is a cache of the identities seen in verified ID tokens (`users` table),
 * refreshed at most once per `refreshMs` per user so that polling clients cost no writes.
 */
export class PostgresUserDirectory implements UserDirectory {
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly executor: Executor,
    private readonly refreshMs = 10 * 60_000,
  ) {}

  async findUserIdByEmail(email: string): Promise<string | undefined> {
    const result = await this.executor.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1) ORDER BY last_seen_at DESC LIMIT 1`,
      [email],
    );
    return result.rows[0]?.id;
  }

  /** Records the identity of an authenticated request (throttled per user). */
  async touch(user: AuthUser, now = Date.now()): Promise<void> {
    const last = this.lastTouched.get(user.userId);
    if (last !== undefined && now - last < this.refreshMs) {
      return;
    }
    this.lastTouched.set(user.userId, now);
    if (this.lastTouched.size > 10_000) {
      this.lastTouched.clear();
    }
    await this.executor.query(
      `INSERT INTO users (id, email, name, last_seen_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, last_seen_at = EXCLUDED.last_seen_at`,
      [user.userId, user.email, user.name ?? null, new Date(now).toISOString()],
    );
  }
}
