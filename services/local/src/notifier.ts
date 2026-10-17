import type { MetricsSink } from '@seatrelay/service';
import nodemailer, { type Transporter } from 'nodemailer';
import type pg from 'pg';
import { atomic } from './adapters/postgres/db';
import { toNotification, type NotificationRow } from './adapters/postgres/store';
import { errorFields, type LocalLogger } from './logger';
import { createLoop, type Loop } from './loop';

const NOTIFIER_BATCH = 20;

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export function smtpMailer(smtpUrl: string, from: string): Mailer {
  const transport: Transporter = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

export interface NotifierDeps {
  pool: pg.Pool;
  logger: LocalLogger;
  metrics: MetricsSink;
  pollMs: number;
  maxAttempts: number;
  /** `undefined` = EMAIL_ENABLED=false: notifications are recorded as SKIPPED, nothing is sent. */
  mailer?: Mailer;
}

export interface NotifierBatch {
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
}

export interface Notifier extends Loop {
  processBatch(): Promise<NotifierBatch>;
}

/**
 * The notifier loop (plan §2.7): every `pollMs`, PENDING notifications (oldest first, locked
 * with SKIP LOCKED) are sent through SMTP (Mailpit in compose) and marked SENT; a failed send
 * bumps `attempts` and parks the row as FAILED after `maxAttempts` (`NotificationFailures`).
 * With e-mail disabled the rows are marked SKIPPED, so the in-app notification centre still
 * shows them.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { pool, logger, metrics, pollMs, maxAttempts, mailer } = deps;

  async function processBatch(): Promise<NotifierBatch> {
    return atomic(pool, async (client) => {
      const batch: NotifierBatch = { sent: 0, skipped: 0, failed: 0, retried: 0 };
      const pending = await client.query<NotificationRow>(
        `SELECT * FROM notifications
          WHERE status = 'PENDING'
          ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
          LIMIT ${NOTIFIER_BATCH}`,
      );
      for (const row of pending.rows) {
        const notification = toNotification(row);
        const fields = {
          notificationId: notification.id,
          workshopId: notification.workshopId,
          kind: notification.kind,
        };
        if (mailer === undefined) {
          await client.query(
            `UPDATE notifications SET status = 'SKIPPED', attempts = attempts + 1 WHERE id = $1`,
            [notification.id],
          );
          batch.skipped += 1;
          continue;
        }
        try {
          await mailer.send({
            to: notification.email,
            subject: notification.title,
            text: notification.body,
          });
          await client.query(
            `UPDATE notifications SET status = 'SENT', attempts = attempts + 1, sent_at = now(), last_error = NULL WHERE id = $1`,
            [notification.id],
          );
          batch.sent += 1;
          logger.debug('notification sent', fields);
        } catch (error) {
          const attempts = notification.attempts + 1;
          const exhausted = attempts >= maxAttempts;
          await client.query(
            `UPDATE notifications SET status = $2, attempts = $3, last_error = $4 WHERE id = $1`,
            [
              notification.id,
              exhausted ? 'FAILED' : 'PENDING',
              attempts,
              error instanceof Error ? error.message : String(error),
            ],
          );
          metrics.emit('NotificationFailures', 1, 'Count');
          if (exhausted) {
            batch.failed += 1;
            logger.error('notification failed; attempts exhausted', {
              ...fields,
              attempts,
              ...errorFields(error),
            });
          } else {
            batch.retried += 1;
            logger.warn('notification send failed; will retry', {
              ...fields,
              attempts,
              ...errorFields(error),
            });
          }
        }
      }
      return batch;
    });
  }

  const loop = createLoop({
    name: 'notifier',
    intervalMs: pollMs,
    logger,
    tick: async () => {
      const batch = await processBatch();
      return batch.sent + batch.skipped + batch.failed + batch.retried > 0;
    },
  });
  return { ...loop, processBatch };
}
