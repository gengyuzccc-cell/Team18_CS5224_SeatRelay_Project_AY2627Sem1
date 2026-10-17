import { CommandSchema, type Command } from '@seatrelay/contracts';
import {
  FaultInjectedError,
  processCommand,
  type Clock,
  type IdGen,
  type MetricsSink,
  type ProcessOutcome,
} from '@seatrelay/service';
import type pg from 'pg';
import { int } from './adapters/postgres/db';
import type { PostgresCommandQueue, PostgresTimerScheduler } from './adapters/postgres/queue';
import type { PostgresWorkshopStore } from './adapters/postgres/store';
import { errorFields, type LocalLogger } from './logger';
import { createLoop, type Loop } from './loop';

export interface WorkerConfig {
  pollMs: number;
  /** Deliveries before a command is parked as FAILED (the DLQ equivalent, plan §2.4). */
  maxAttempts: number;
  /** Retry backoff = `retryBackoffMs × attempt`. */
  retryBackoffMs: number;
  /** Honour `_fault` flags (ALLOW_FAULT_FLAGS=true). */
  faultInjection: boolean;
}

export interface WorkerDeps {
  pool: pg.Pool;
  store: PostgresWorkshopStore;
  queue: PostgresCommandQueue;
  timers: PostgresTimerScheduler;
  clock: Clock;
  ids: IdGen;
  logger: LocalLogger;
  metrics: MetricsSink;
  config: WorkerConfig;
}

export interface WorkerStep {
  id: number;
  workshopId: string;
  type: string;
  deliveryAttempt: number;
  /** `FAILED` once the attempts are exhausted; `RETRY` when parked for a later delivery. */
  outcome: ProcessOutcome | 'RETRY' | 'FAILED' | 'INVALID';
}

export interface Worker extends Loop {
  /** Claims and processes one command; `undefined` when the queue is empty. */
  processNext(): Promise<WorkerStep | undefined>;
}

interface CommandRow {
  id: string | number;
  workshop_id: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

/**
 * Head-of-line claim: the oldest available PENDING command whose workshop has no earlier
 * PENDING command (strict FIFO per workshop even with several worker processes; a command
 * parked for retry blocks its workshop like an SQS FIFO message group does). `SKIP LOCKED`
 * lets concurrent workers pick different workshops.
 */
const CLAIM_SQL = `
  SELECT c.id, c.workshop_id, c.payload, c.attempts, c.created_at
    FROM commands c
   WHERE c.status = 'PENDING'
     AND c.available_at <= now()
     AND NOT EXISTS (
       SELECT 1 FROM commands p
        WHERE p.workshop_id = c.workshop_id AND p.status = 'PENDING' AND p.id < c.id)
   ORDER BY c.id
     FOR UPDATE OF c SKIP LOCKED
   LIMIT 1`;

/**
 * The worker loop (plan §2.7): every `pollMs`, one transaction claims the next command, takes
 * the workshop's advisory lock (`pg_advisory_xact_lock(hashtext(workshop_id))`, serialising
 * every writer of that workshop), runs `processCommand` with the store, queue and timer
 * scheduler bound to the same connection (snapshot load, timer rows, commit and continuation
 * enqueue are one transaction) and marks the command DONE in that transaction.
 *
 * Infrastructure errors roll everything back and park the command for `retryBackoffMs ×
 * attempt`; after `maxAttempts` deliveries it is marked FAILED (the DLQ). Deterministic
 * rejections never throw (they settle the command as REJECTED inside the transaction).
 *
 * Fault flags: BEFORE_COMMIT and TIMER_SEND throw before the commit, so the rollback leaves
 * nothing behind and the redelivery settles the command. AFTER_COMMIT throws after the store
 * commit: the transaction is committed anyway and only the message is left for redelivery, so
 * the redelivery hits COMMAND_ALREADY_SETTLED and acks it, exactly like the cloud path.
 */
export function createWorker(deps: WorkerDeps): Worker {
  const { pool, store, queue, timers, clock, ids, logger, metrics, config } = deps;

  async function processNext(): Promise<WorkerStep | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<CommandRow>(CLAIM_SQL);
      const row = claimed.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const id = int(row.id);
      const deliveryAttempt = row.attempts + 1;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [row.workshop_id]);

      const parsed = CommandSchema.safeParse(row.payload);
      if (!parsed.success) {
        logger.error('invalid command payload; parked as FAILED', {
          queueId: id,
          workshopId: row.workshop_id,
          issues: parsed.error.issues.map((issue) => issue.message),
        });
        await client.query(
          `UPDATE commands SET status = 'FAILED', attempts = $2, last_error = $3, done_at = now() WHERE id = $1`,
          [id, deliveryAttempt, 'invalid payload'],
        );
        await client.query('COMMIT');
        return {
          id,
          workshopId: row.workshop_id,
          type: 'INVALID',
          deliveryAttempt,
          outcome: 'INVALID',
        };
      }
      const command: Command = parsed.data;
      const fields = {
        queueId: id,
        workshopId: command.workshopId,
        type: command.type,
        deliveryAttempt,
        ...('commandId' in command ? { commandId: command.commandId } : {}),
      };
      const queueLatencyMs = Date.now() - row.created_at.getTime();

      try {
        const result = await processCommand(
          {
            store: store.bind(client),
            queue: queue.bind(client),
            timers: timers.bind(client),
            clock,
            ids,
            logger,
            metrics,
          },
          command,
          { faultInjection: config.faultInjection, deliveryAttempt },
        );
        await client.query(
          `UPDATE commands SET status = 'DONE', attempts = $2, done_at = now(), last_error = NULL WHERE id = $1`,
          [id, deliveryAttempt],
        );
        await client.query('COMMIT');
        logger.debug('command processed', {
          ...fields,
          outcome: result.outcome,
          engineAttempts: result.attempts,
          queueLatencyMs,
        });
        return {
          id,
          workshopId: command.workshopId,
          type: command.type,
          deliveryAttempt,
          outcome: result.outcome,
        };
      } catch (error) {
        const backoffMs = config.retryBackoffMs * deliveryAttempt;
        if (error instanceof FaultInjectedError && error.fault === 'AFTER_COMMIT') {
          // Committed decision, "crashed" before the ack: keep the writes, redeliver the message.
          await client.query(
            `UPDATE commands SET attempts = $2, available_at = now() + ($3::int * interval '1 millisecond'), last_error = $4 WHERE id = $1`,
            [id, deliveryAttempt, backoffMs, error.message],
          );
          await client.query('COMMIT');
          logger.warn('injected fault after commit; message left for redelivery', {
            ...fields,
            backoffMs,
          });
          return {
            id,
            workshopId: command.workshopId,
            type: command.type,
            deliveryAttempt,
            outcome: 'RETRY',
          };
        }
        await client.query('ROLLBACK').catch(() => undefined);
        const exhausted = deliveryAttempt >= config.maxAttempts;
        const message = error instanceof Error ? error.message : String(error);
        await client.query(
          `UPDATE commands
              SET attempts = $2,
                  status = $3,
                  available_at = now() + ($4::int * interval '1 millisecond'),
                  last_error = $5,
                  done_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE done_at END
            WHERE id = $1`,
          [id, deliveryAttempt, exhausted ? 'FAILED' : 'PENDING', backoffMs, message],
        );
        if (exhausted) {
          logger.error('command failed; attempts exhausted (parked as FAILED)', {
            ...fields,
            ...errorFields(error),
          });
        } else {
          logger.warn('command failed; scheduled for redelivery', {
            ...fields,
            backoffMs,
            ...errorFields(error),
          });
        }
        return {
          id,
          workshopId: command.workshopId,
          type: command.type,
          deliveryAttempt,
          outcome: exhausted ? 'FAILED' : 'RETRY',
        };
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const loop = createLoop({
    name: 'worker',
    intervalMs: config.pollMs,
    logger,
    tick: async () => (await processNext()) !== undefined,
  });
  return { ...loop, processNext };
}
