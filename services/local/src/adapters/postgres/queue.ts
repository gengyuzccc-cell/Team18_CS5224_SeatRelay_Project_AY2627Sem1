import { randomUUID } from 'node:crypto';
import type { Command } from '@seatrelay/contracts';
import type { OfferTimer } from '@seatrelay/core';
import { commandDedupId, type CommandQueue, type TimerScheduler } from '@seatrelay/service';
import type pg from 'pg';
import type { Executor } from './db';

/** The SQS FIFO deduplication window (CommandQueue port: a duplicate inside it is dropped). */
export const DEDUP_WINDOW_SECONDS = 300;

const INSERT_SQL = `
  INSERT INTO commands (workshop_id, payload, dedup_id)
  VALUES ($1, $2::jsonb, $3)
  ON CONFLICT (dedup_id) DO NOTHING
  RETURNING id`;

/**
 * Releases the dedup id of an earlier message that no longer deduplicates: one parked in the
 * DLQ (FAILED: re-sending it is the redrive), or one delivered (DONE) longer ago than the
 * window. A PENDING message keeps its id: it will still be delivered.
 */
const RELEASE_SQL = `
  UPDATE commands SET dedup_id = NULL
   WHERE dedup_id = $1
     AND (status = 'FAILED'
          OR (status = 'DONE' AND created_at < now() - make_interval(secs => $2)))`;

/**
 * The `commands` table as a FIFO queue per workshop (plan §2.7, the stand-in for
 * `commands.fifo`). Arrival order = `id`; `dedup_id` is the FIFO deduplication id (the client
 * commandId, or `tick#offerId#expiresAt`): a duplicate of a PENDING message, or of one
 * delivered within the 5-minute window, is dropped by `ON CONFLICT DO NOTHING`, which is what
 * makes an idempotent re-POST of a still-ACCEPTED command safe (C3).
 *
 * Like SQS, the deduplication does not last forever: when the earlier message was parked as
 * FAILED (the DLQ) or delivered more than 5 minutes ago, its dedup id is released and the
 * duplicate is enqueued as a new message at the tail of its workshop's queue. So a client that
 * re-POSTs a command still ACCEPTED after its message went to the DLQ gets it processed (the
 * worker acks it as already settled if it was settled meanwhile). The FAILED row is kept for
 * inspection with `dedup_id` NULL.
 *
 * Bound to the worker's transaction client, an enqueue (a REALLOCATE continuation) commits
 * atomically with the decision that produced it.
 */
export class PostgresCommandQueue implements CommandQueue {
  constructor(private readonly executor: Executor) {}

  bind(client: pg.PoolClient): PostgresCommandQueue {
    return new PostgresCommandQueue(client);
  }

  async enqueue(command: Command): Promise<void> {
    const dedupId = commandDedupId(command) ?? randomUUID();
    const values = [command.workshopId, JSON.stringify(command), dedupId];
    const inserted = await this.executor.query(INSERT_SQL, values);
    if ((inserted.rowCount ?? 0) > 0) {
      return;
    }
    // Duplicate (rare path): enqueue anyway once the earlier message no longer deduplicates.
    // Concurrent duplicates are safe: one release wins, and at most one INSERT gets the id.
    const released = await this.executor.query(RELEASE_SQL, [dedupId, DEDUP_WINDOW_SECONDS]);
    if ((released.rowCount ?? 0) > 0) {
      await this.executor.query(INSERT_SQL, values);
    }
  }
}

/**
 * One row of `timers` per new offer (plan §1.2, the stand-in for the `expiry-delay` queue).
 * The timer loop (`src/timers.ts`) turns due rows into TICK commands. Scheduled before the
 * commit; inside the worker's transaction the rows disappear with a rolled-back decision and a
 * duplicate from a retried decision is a harmless extra tick (deduplicated by the queue).
 */
export class PostgresTimerScheduler implements TimerScheduler {
  constructor(private readonly executor: Executor) {}

  bind(client: pg.PoolClient): PostgresTimerScheduler {
    return new PostgresTimerScheduler(client);
  }

  async schedule(wsId: string, timers: readonly OfferTimer[]): Promise<void> {
    if (timers.length === 0) {
      return;
    }
    const values: unknown[] = [];
    const rows = timers.map((timer, index) => {
      values.push(wsId, timer.offerId, timer.expiresAt);
      const base = index * 3;
      return `($${base + 1}, $${base + 2}, $${base + 3}::timestamptz)`;
    });
    await this.executor.query(
      `INSERT INTO timers (workshop_id, offer_id, fire_at) VALUES ${rows.join(', ')}`,
      values,
    );
  }
}
