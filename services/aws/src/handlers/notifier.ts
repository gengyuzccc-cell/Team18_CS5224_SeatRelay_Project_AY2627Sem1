import type {
  Context,
  DynamoDBBatchItemFailure,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Notification } from '@seatrelay/contracts';
import type { Logger, MetricsSink } from '@seatrelay/service';
import {
  DynamoNotificationStatusStore,
  type NotificationStatusStore,
} from '../adapters/dynamo/notifications';
import { entityTypeOf, toNotification } from '../adapters/dynamo/mapping';
import { SesEmailSender, type EmailSender } from '../adapters/ses';
import { documentClient, sesClient } from '../lib/clients';
import { renderEmail } from '../lib/email';
import { envFlag, envNumber, requireEnv } from '../lib/env';
import { errorFields } from '../lib/logger';
import { runtime } from '../lib/ports';
import { lazy, noopLifecycle, type InvocationLifecycle } from '../lib/runtime';
import { TokenBucket } from '../lib/tokenBucket';

export interface NotifierDeps {
  store: NotificationStatusStore;
  /** Required when `emailEnabled`. */
  sender?: EmailSender;
  emailEnabled: boolean;
  /** Paces SES calls (EMAIL_RATE_PER_SEC). */
  rate: { take(): Promise<void> };
  logger: Logger;
  metrics: MetricsSink;
  lifecycle?: InvocationLifecycle;
}

export type NotifierHandler = (
  event: DynamoDBStreamEvent,
  context?: Context,
) => Promise<DynamoDBBatchResponse>;

export interface NotifierSummary {
  sent: number;
  skipped: number;
  failed: number;
}

/** The inserted NOTIFICATION entity of a stream record, or undefined for anything else. */
export function notificationOfRecord(record: DynamoDBRecord): Notification | undefined {
  const image = record.dynamodb?.NewImage;
  if (record.eventName !== 'INSERT' || image === undefined) {
    return undefined;
  }
  const item = unmarshall(image as unknown as Record<string, AttributeValue>);
  if (entityTypeOf(item) !== 'NOTIFICATION') {
    return undefined;
  }
  return toNotification(item);
}

/**
 * DynamoDB Streams → SES (plan §2.4). INSERT NOTIFICATION items only (the event source filter):
 * - `EMAIL_ENABLED !== 'true'`: the notification is marked SKIPPED (in-app only);
 * - otherwise one e-mail (text + minimal HTML) per notification, paced by the token bucket,
 *   then SENT; a permanent SES error (`MessageRejected`, sandbox) marks it FAILED and never
 *   throws; a transient error (throttling) stops the batch at that record, which is reported
 *   in `batchItemFailures` so the stream retries from it (`NotificationFailures` counts both).
 * - The status update is a MODIFY the stream filter ignores; a notification already past
 *   PENDING (a retried batch) is not sent twice.
 */
export function createNotifierHandler(deps: NotifierDeps): NotifierHandler {
  const lifecycle = deps.lifecycle ?? noopLifecycle;
  if (deps.emailEnabled && deps.sender === undefined) {
    throw new Error('notifier: emailEnabled requires a sender');
  }
  return async (event, context) => {
    const failures: DynamoDBBatchItemFailure[] = [];
    const summary: NotifierSummary = { sent: 0, skipped: 0, failed: 0 };
    lifecycle.begin(context);
    try {
      for (const record of event.Records ?? []) {
        let notification: Notification | undefined;
        try {
          notification = notificationOfRecord(record);
        } catch (error) {
          deps.logger.error('unreadable notification record dropped', {
            sequenceNumber: record.dynamodb?.SequenceNumber,
            ...errorFields(error),
          });
          continue;
        }
        if (notification === undefined) {
          continue;
        }
        const fields = {
          notificationId: notification.id,
          userId: notification.userId,
          workshopId: notification.workshopId,
          kind: notification.kind,
        };
        try {
          if (!deps.emailEnabled) {
            await deps.store.markStatus(notification, 'SKIPPED', notification.attempts);
            summary.skipped += 1;
            deps.logger.info('notification skipped (e-mail disabled)', fields);
            continue;
          }
          const status = await deps.store.getStatus(notification);
          if (status !== 'PENDING') {
            deps.logger.info('notification already handled', { ...fields, status });
            continue;
          }
          await deps.rate.take();
          const attempts = notification.attempts + 1;
          const result = await deps.sender!.send({
            to: notification.email,
            ...renderEmail(notification),
          });
          if (result.ok) {
            await deps.store.markStatus(notification, 'SENT', attempts);
            summary.sent += 1;
            deps.logger.info('notification sent', { ...fields, messageId: result.messageId });
          } else {
            await deps.store.markStatus(notification, 'FAILED', attempts, result.error);
            summary.failed += 1;
            deps.metrics.emit('NotificationFailures', 1, 'Count');
            deps.logger.warn('notification rejected permanently', {
              ...fields,
              error: result.error,
            });
          }
        } catch (error) {
          summary.failed += 1;
          deps.metrics.emit('NotificationFailures', 1, 'Count');
          const sequenceNumber = record.dynamodb?.SequenceNumber;
          deps.logger.warn('transient notification failure; retrying from this record', {
            ...fields,
            sequenceNumber,
            ...errorFields(error),
          });
          if (sequenceNumber === undefined) {
            throw error;
          }
          failures.push({ itemIdentifier: sequenceNumber });
          break;
        }
      }
      deps.logger.info('notifier batch done', { ...summary, retried: failures.length });
      return { batchItemFailures: failures };
    } finally {
      lifecycle.end();
    }
  };
}

const defaultHandler = lazy(() => {
  const emailEnabled = envFlag('EMAIL_ENABLED');
  return createNotifierHandler({
    store: new DynamoNotificationStatusStore(documentClient(), requireEnv('TABLE_NAME')),
    ...(emailEnabled
      ? { sender: new SesEmailSender(sesClient(), requireEnv('SENDER_EMAIL')) }
      : {}),
    emailEnabled,
    rate: new TokenBucket(Math.max(0.1, envNumber('EMAIL_RATE_PER_SEC', 1))),
    logger: runtime().logger,
    metrics: runtime().metrics,
    lifecycle: runtime(),
  });
});

export const handler: NotifierHandler = (event, context) => defaultHandler()(event, context);
