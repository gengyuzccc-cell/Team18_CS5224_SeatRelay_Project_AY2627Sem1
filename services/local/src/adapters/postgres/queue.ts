import { randomUUID } from 'node:crypto';
import type { Command } from '@seatrelay/contracts';
import type { OfferTimer } from '@seatrelay/core';
import { commandDedupId, type CommandQueue, type TimerScheduler } from '@seatrelay/service';
import type pg from 'pg';
import type { Executor } from './db';

/**
 * The `commands` table as a FIFO queue per workshop (plan §2.7, the stand-in for
 * `commands.fifo`). Arrival order = `id`; `dedup_id` is the FIFO deduplication id (the client
 * commandId, or `tick#offerId#expiresAt`): a duplicate is dropped by `ON CONFLICT DO NOTHING`,
 * which is what makes an idempotent re-POST of a still-ACCEPTED command safe (C3).
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
    await this.executor.query(
      `INSERT INTO commands (workshop_id, payload, dedup_id)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (dedup_id) DO NOTHING`,
      [command.workshopId, JSON.stringify(command), commandDedupId(command) ?? randomUUID()],
    );
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
