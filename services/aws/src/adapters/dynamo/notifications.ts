import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Notification, NotificationStatus } from '@seatrelay/contracts';
import { isConditionalCheckFailed } from './errors';
import { notificationKey } from './keys';

export interface NotificationStatusStore {
  /** Current status of the stored notification; undefined when it no longer exists (TTL). */
  getStatus(notification: Notification): Promise<NotificationStatus | undefined>;
  /**
   * Records the delivery outcome (status, attempts, optional last error). This is a MODIFY on
   * the item, which the notifier's stream filter (INSERT only) ignores. False when the item
   * does not exist any more.
   */
  markStatus(
    notification: Notification,
    status: NotificationStatus,
    attempts: number,
    lastError?: string,
  ): Promise<boolean>;
}

const MAX_ERROR_LENGTH = 500;

/** The notifier's view of the `U#{userId}` / `N#{createdAt}#{id}` items. */
export class DynamoNotificationStatusStore implements NotificationStatusStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async getStatus(notification: Notification): Promise<NotificationStatus | undefined> {
    const output = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: notificationKey(notification.userId, notification.createdAt, notification.id),
        ConsistentRead: true,
        ProjectionExpression: '#status',
        ExpressionAttributeNames: { '#status': 'status' },
      }),
    );
    const status = output.Item?.status;
    return typeof status === 'string' ? (status as NotificationStatus) : undefined;
  }

  async markStatus(
    notification: Notification,
    status: NotificationStatus,
    attempts: number,
    lastError?: string,
  ): Promise<boolean> {
    const names: Record<string, string> = { '#status': 'status', '#attempts': 'attempts' };
    const values: Record<string, unknown> = { ':status': status, ':attempts': attempts };
    let expression = 'SET #status = :status, #attempts = :attempts';
    if (lastError !== undefined) {
      names['#lastError'] = 'lastError';
      values[':lastError'] = lastError.slice(0, MAX_ERROR_LENGTH);
      expression += ', #lastError = :lastError';
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: notificationKey(notification.userId, notification.createdAt, notification.id),
          UpdateExpression: expression,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return false;
      }
      throw error;
    }
  }
}
