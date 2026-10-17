import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Minimal surface the adapters need: both `pg.Pool` and `pg.PoolClient` satisfy it, so the
 * same adapter code runs on the pool (API requests) or inside the worker's transaction
 * (snapshot load + commit on one connection, under the per-workshop advisory lock).
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export type Executor = pg.Pool | pg.PoolClient;

export function isPool(executor: Executor): executor is pg.Pool {
  return executor instanceof pg.Pool;
}

export interface PoolOptions {
  connectionString: string;
  max?: number;
  /** PostgreSQL `search_path` (tests isolate themselves in their own schema). */
  schema?: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  const config: pg.PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (options.schema !== undefined) {
    config.options = `-c search_path=${options.schema}`;
  }
  return new pg.Pool(config);
}

/**
 * Runs `fn` atomically on the executor. On a pool: one connection, BEGIN … COMMIT (ROLLBACK on
 * error). On a client that is already inside a transaction (the worker): a SAVEPOINT, released
 * on success and rolled back to on error, so a failed conditional commit leaves the enclosing
 * transaction clean for the retry.
 */
export async function atomic<T>(
  executor: Executor,
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED',
  readOnly = false,
): Promise<T> {
  if (isPool(executor)) {
    const client = await executor.connect();
    try {
      await client.query(
        `BEGIN ISOLATION LEVEL ${isolation}${readOnly ? ' READ ONLY' : ''}`,
      );
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }
  await executor.query('SAVEPOINT seatrelay_atomic');
  try {
    const result = await fn(executor);
    await executor.query('RELEASE SAVEPOINT seatrelay_atomic');
    return result;
  } catch (error) {
    await executor.query('ROLLBACK TO SAVEPOINT seatrelay_atomic').catch(() => undefined);
    throw error;
  }
}

/** The path of `sql/schema.sql` relative to this source file (works from source and in Docker). */
export const SCHEMA_SQL_PATH = fileURLToPath(new URL('../../../sql/schema.sql', import.meta.url));

/**
 * Applies `sql/schema.sql` (every statement is IF NOT EXISTS) under an advisory lock so that
 * several starting instances never race on DDL. Idempotent.
 */
export async function migrate(pool: pg.Pool, schemaSqlPath = SCHEMA_SQL_PATH): Promise<void> {
  const sql = await readFile(schemaSqlPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['seatrelay:migrate']);
    try {
      await client.query(sql);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['seatrelay:migrate']);
    }
  } finally {
    client.release();
  }
}

/* ---------- value mapping ---------- */

/** `timestamptz` → ISO-8601 UTC with milliseconds (CONVENTIONS §3). */
export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function isoOrUndefined(value: Date | string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/** `bigint` columns arrive as strings. */
export function int(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Error code of a PostgreSQL error (`23505` = unique_violation, …). */
export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Unix epoch seconds → `timestamptz` parameter. */
export function epochSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
