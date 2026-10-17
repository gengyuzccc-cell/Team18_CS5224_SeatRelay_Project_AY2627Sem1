import { runSweep, tickForTimer, type Clock } from '@seatrelay/service';
import type pg from 'pg';
import { atomic, int, iso } from './adapters/postgres/db';
import { PostgresCommandQueue } from './adapters/postgres/queue';
import type { PostgresWorkshopStore } from './adapters/postgres/store';
import type { LocalLogger } from './logger';
import { createLoop, type Loop } from './loop';

interface TimerRow {
  id: string | number;
  workshop_id: string;
  offer_id: string;
  fire_at: Date;
}

const TIMER_BATCH = 200;

export interface TimerLoopDeps {
  pool: pg.Pool;
  logger: LocalLogger;
  pollMs: number;
}

/**
 * The expiry forwarder (plan §1.2): every `pollMs`, due `timers` rows become TICK commands
 * (`tick#offerId#expiresAt` dedup id, so a duplicate timer is dropped by the queue) and are
 * marked fired, in one transaction. The worker expires by server time, so a late tick is a
 * harmless no-op.
 */
export function createTimerLoop(deps: TimerLoopDeps): Loop {
  const { pool, logger, pollMs } = deps;
  return createLoop({
    name: 'timers',
    intervalMs: pollMs,
    logger,
    tick: () =>
      atomic(pool, async (client) => {
        const due = await client.query<TimerRow>(
          `SELECT id, workshop_id, offer_id, fire_at
             FROM timers
            WHERE NOT fired AND fire_at <= now()
            ORDER BY fire_at, id
              FOR UPDATE SKIP LOCKED
            LIMIT ${TIMER_BATCH}`,
        );
        if (due.rows.length === 0) {
          return false;
        }
        const queue = new PostgresCommandQueue(client);
        for (const row of due.rows) {
          await queue.enqueue(
            tickForTimer(row.workshop_id, { offerId: row.offer_id, expiresAt: iso(row.fire_at) }),
          );
        }
        await client.query(
          `UPDATE timers SET fired = true, fired_at = now() WHERE id = ANY($1::bigint[])`,
          [due.rows.map((row) => int(row.id))],
        );
        logger.debug('timers fired', { count: due.rows.length });
        return true;
      }),
  });
}

export interface SweepLoopDeps {
  store: PostgresWorkshopStore;
  queue: PostgresCommandQueue;
  clock: Clock;
  logger: LocalLogger;
  intervalMs: number;
}

/**
 * The safety net (plan §1.2): every `intervalMs` (5 min by default), a TICK for each workshop
 * whose `nextDueAt` has passed. In normal operation the per-offer timers have already done the
 * work and these ticks are no-ops (`SweepLateExpiries` stays 0).
 */
export function createSweepLoop(deps: SweepLoopDeps): Loop {
  const { store, queue, clock, logger, intervalMs } = deps;
  return createLoop({
    name: 'sweep',
    intervalMs,
    logger,
    tick: async () => {
      await runSweep({ store, queue, clock, logger });
      return false;
    },
  });
}
