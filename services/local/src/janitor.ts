import type pg from 'pg';
import type { LocalLogger } from './logger';
import { createLoop, type Loop } from './loop';

export interface JanitorDeps {
  pool: pg.Pool;
  logger: LocalLogger;
  intervalMs: number;
}

export interface JanitorReport {
  commandResults: number;
  notifications: number;
  timers: number;
  commands: number;
}

/**
 * The TTL stand-in (plan §1.4: CommandResult 30 days, Notification 90 days, enforced by
 * DynamoDB TTL in the cloud): deletes expired rows, fired timers older than an hour and DONE
 * queue rows older than a day. FAILED queue rows (the DLQ) are kept for inspection.
 */
export function createJanitor(deps: JanitorDeps): Loop & { sweepOnce(): Promise<JanitorReport> } {
  const { pool, logger, intervalMs } = deps;

  async function sweepOnce(): Promise<JanitorReport> {
    const [commandResults, notifications, timers, commands] = await Promise.all([
      pool.query(`DELETE FROM command_results WHERE expires_at < now()`),
      pool.query(`DELETE FROM notifications WHERE expires_at < now()`),
      pool.query(`DELETE FROM timers WHERE fired AND fired_at < now() - interval '1 hour'`),
      pool.query(`DELETE FROM commands WHERE status = 'DONE' AND done_at < now() - interval '24 hours'`),
    ]);
    const report: JanitorReport = {
      commandResults: commandResults.rowCount ?? 0,
      notifications: notifications.rowCount ?? 0,
      timers: timers.rowCount ?? 0,
      commands: commands.rowCount ?? 0,
    };
    if (Object.values(report).some((count) => count > 0)) {
      logger.info('janitor removed expired rows', { ...report });
    }
    return report;
  }

  const loop = createLoop({
    name: 'janitor',
    intervalMs,
    logger,
    tick: async () => {
      await sweepOnce();
      return false;
    },
  });
  return { ...loop, sweepOnce };
}
