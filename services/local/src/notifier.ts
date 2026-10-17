import type { MetricsSink } from '@seatrelay/service';
import nodemailer, { type Transporter } from 'nodemailer';
import type pg from 'pg';
import { atomic } from './adapters/postgres/db';
import { toNotification, type NotificationRow } from './adapters/postgres/store';
import { errorFields, type LocalLogger } from './logger';
import { createLoop, type Loop } from './loop';

const NOTIFIER_BATCH = 20;

/** Upper bound of the retry delay between two send attempts of one notification. */
export const NOTIFIER_MAX_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Delay before the next send attempt after `failedAttempts` failures: exponential backoff
 * `baseMs × 2^(failedAttempts − 1)`, capped at 5 minutes. With the defaults (2 s, 10 attempts)
 * the attempts span about 13.5 minutes, so an SMTP outage of that length recovers by itself.
 */
export function notificationRetryDelayMs(failedAttempts: number, baseMs: number): number {
  const exponent = Math.max(failedAttempts - 1, 0);
  return Math.min(baseMs * 2 ** exponent, NOTIFIER_MAX_RETRY_DELAY_MS);
}

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/**
 * Socket timeouts for the SMTP connection (nodemailer defaults: 2 min connect, 10 min idle).
 * The notifier holds its batch transaction while sending, so a hanging relay must fail fast and
 * go through the retry backoff. A value given in the SMTP_URL query string wins.
 */
const SMTP_TIMEOUTS: Record<string, string> = {
  connectionTimeout: '10000',
  greetingTimeout: '10000',
  socketTimeout: '30000',
};

/** `smtpUrl` with the SMTP_TIMEOUTS added as nodemailer URL options (unless already set). */
export function withSmtpTimeouts(smtpUrl: string): string {
  const url = new URL(smtpUrl);
  for (const [option, value] of Object.entries(SMTP_TIMEOUTS)) {
    if (!url.searchParams.has(option)) {
      url.searchParams.set(option, value);
    }
  }
  return url.toString();
}

export function smtpMailer(smtpUrl: string, from: string): Mailer {
  const transport: Transporter = nodemailer.createTransport(withSmtpTimeouts(smtpUrl));
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
  /** Send attempts before a notification is parked as FAILED. */
  maxAttempts: number;
  /** Base of the exponential retry backoff (`notificationRetryDelayMs`); 0 = retry on the next poll. */
  retryBackoffMs: number;
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
 * The notifier loop (plan §2.7): every `pollMs`, due PENDING notifications (`next_attempt_at
 * <= now()`, oldest first, locked with SKIP LOCKED) are sent through SMTP (Mailpit in compose)
 * and marked SENT. A failed send bumps `attempts`, emits `NotificationFailures` and pushes
 * `next_attempt_at` back by an exponential backoff (the counterpart of the cloud notifier's
 * stream retries, plan §2.4 / §4), so a transient SMTP outage delays the e-mails instead of
 * dropping them; after `maxAttempts` the row is parked as FAILED. With e-mail disabled the
 * rows are marked SKIPPED. Either way the in-app notification centre still shows them.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { pool, logger, metrics, pollMs, maxAttempts, retryBackoffMs, mailer } = deps;

  async function processBatch(): Promise<NotifierBatch> {
    return atomic(pool, async (client) => {
      const batch: NotifierBatch = { sent: 0, skipped: 0, failed: 0, retried: 0 };
      const pending = await client.query<NotificationRow>(
        `SELECT * FROM notifications
          WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at, created_at, id
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
          const retryInMs = exhausted ? 0 : notificationRetryDelayMs(attempts, retryBackoffMs);
          // clock_timestamp(): the backoff counts from this failure, not from the batch start.
          await client.query(
            `UPDATE notifications
                SET status = $2, attempts = $3, last_error = $4,
                    next_attempt_at = clock_timestamp() + ($5::int * interval '1 millisecond')
              WHERE id = $1`,
            [
              notification.id,
              exhausted ? 'FAILED' : 'PENDING',
              attempts,
              error instanceof Error ? error.message : String(error),
              retryInMs,
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
              retryInMs,
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
      // Rows that only failed and were rescheduled are not progress: let the loop sleep
      // `pollMs` instead of hammering an SMTP server that is down.
      return batch.sent + batch.skipped + batch.failed > 0;
    },
  });
  return { ...loop, processBatch };
}
