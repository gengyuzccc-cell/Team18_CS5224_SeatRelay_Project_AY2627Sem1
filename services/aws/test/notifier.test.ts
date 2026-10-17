import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Notification, NotificationStatus } from '@seatrelay/contracts';
import { InMemoryLogger, InMemoryMetrics } from '@seatrelay/service';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DynamoNotificationStatusStore,
  type NotificationStatusStore,
} from '../src/adapters/dynamo/notifications';
import { liveOfferItem, notificationItem } from '../src/adapters/dynamo/mapping';
import type { EmailMessage, EmailSendResult, EmailSender } from '../src/adapters/ses';
import { createNotifierHandler, notificationOfRecord } from '../src/handlers/notifier';
import { T0, notification, offer } from './fixtures';
import { streamRecord } from './harness';

interface Mark {
  id: string;
  status: NotificationStatus;
  attempts: number;
  lastError?: string;
}

class FakeStatusStore implements NotificationStatusStore {
  readonly statuses = new Map<string, NotificationStatus>();
  readonly marks: Mark[] = [];
  missing = new Set<string>();
  /** Errors thrown by the next markStatus calls (one per call). */
  readonly markFailures: Error[] = [];

  async getStatus(target: Notification): Promise<NotificationStatus | undefined> {
    if (this.missing.has(target.id)) return undefined;
    return this.statuses.get(target.id) ?? 'PENDING';
  }

  async markStatus(
    target: Notification,
    status: NotificationStatus,
    attempts: number,
    lastError?: string,
  ): Promise<boolean> {
    const failure = this.markFailures.shift();
    if (failure !== undefined) throw failure;
    if (this.missing.has(target.id)) return false;
    this.statuses.set(target.id, status);
    this.marks.push({
      id: target.id,
      status,
      attempts,
      ...(lastError === undefined ? {} : { lastError }),
    });
    return true;
  }
}

class FakeSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  readonly script: (() => Promise<EmailSendResult>)[] = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    const next = this.script.shift();
    return next === undefined ? { ok: true, messageId: `ses-${this.sent.length}` } : next();
  }
}

function build(emailEnabled: boolean) {
  const store = new FakeStatusStore();
  const sender = new FakeSender();
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const take = vi.fn(async () => undefined);
  const sleeps: number[] = [];
  const handler = createNotifierHandler({
    store,
    sender,
    emailEnabled,
    rate: { take },
    logger,
    metrics,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { handler, store, sender, logger, metrics, take, sleeps };
}

function insert(target: Notification, sequenceNumber: string) {
  return streamRecord('INSERT', notificationItem(target), sequenceNumber);
}

describe('notificationOfRecord', () => {
  test('unmarshalls INSERTed NOTIFICATION items and ignores everything else', () => {
    expect(notificationOfRecord(insert(notification(), '1'))).toEqual(notification());
    expect(
      notificationOfRecord(streamRecord('MODIFY', notificationItem(notification()), '2')),
    ).toBeUndefined();
    expect(
      notificationOfRecord(streamRecord('REMOVE', notificationItem(notification()), '3')),
    ).toBeUndefined();
    expect(
      notificationOfRecord(streamRecord('INSERT', liveOfferItem(offer()), '4')),
    ).toBeUndefined();
  });

  test('a corrupt NOTIFICATION image throws (the handler drops it)', () => {
    const corrupt = { ...notificationItem(notification()), status: 'BOGUS' };
    expect(() => notificationOfRecord(streamRecord('INSERT', corrupt, '5'))).toThrow();
  });
});

describe('notifier handler', () => {
  test('EMAIL_ENABLED=false: every notification is marked SKIPPED without touching SES', async () => {
    const { handler, store, sender, take } = build(false);
    const records = [
      insert(notification({ id: 'n-1' }), '1'),
      insert(notification({ id: 'n-2' }), '2'),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(store.marks).toEqual([
      { id: 'n-1', status: 'SKIPPED', attempts: 0 },
      { id: 'n-2', status: 'SKIPPED', attempts: 0 },
    ]);
    expect(sender.sent).toEqual([]);
    expect(take).not.toHaveBeenCalled();
  });

  test('sends text + HTML through the rate limiter and marks SENT with attempts + 1', async () => {
    const { handler, store, sender, take, metrics } = build(true);
    await expect(handler({ Records: [insert(notification(), '1')] })).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(take).toHaveBeenCalledTimes(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      to: 'bob@example.com',
      subject: '[SeatRelay] Seat offered: Seat offered',
    });
    expect(sender.sent[0]?.text).toContain('A seat in Morning is held for you.');
    expect(sender.sent[0]?.html).toContain('<h2>Seat offered</h2>');
    expect(store.marks).toEqual([{ id: 'n-1', status: 'SENT', attempts: 1 }]);
    expect(metrics.of('NotificationFailures')).toEqual([]);
  });

  test('a permanent SES rejection marks FAILED with the error and continues with the next record', async () => {
    const { handler, store, sender, metrics, logger } = build(true);
    sender.script.push(async () => ({
      ok: false,
      error: 'MessageRejected: Email address is not verified',
    }));
    const records = [
      insert(notification({ id: 'n-1' }), '1'),
      insert(notification({ id: 'n-2' }), '2'),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(store.marks).toEqual([
      {
        id: 'n-1',
        status: 'FAILED',
        attempts: 1,
        lastError: 'MessageRejected: Email address is not verified',
      },
      { id: 'n-2', status: 'SENT', attempts: 1 },
    ]);
    expect(metrics.of('NotificationFailures')).toEqual([1]);
    expect(
      logger.entries.some((entry) => entry.message === 'notification rejected permanently'),
    ).toBe(true);
  });

  test('a transient failure stops the batch at that record and reports it for retry', async () => {
    const { handler, store, sender, metrics } = build(true);
    sender.script.push(async () => {
      throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
    });
    const records = [
      insert(notification({ id: 'n-1' }), '101'),
      insert(notification({ id: 'n-2' }), '102'),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: '101' }],
    });
    expect(sender.sent).toHaveLength(1); // the second record waits for the retry
    expect(store.marks).toEqual([]); // nothing recorded: the item stays PENDING for the retry
    expect(metrics.of('NotificationFailures')).toEqual([1]);
  });

  test('a failed SENT status write after a successful send is retried in-process, never redelivered (no second e-mail)', async () => {
    const { handler, store, sender, metrics, sleeps } = build(true);
    const throughput = () =>
      Object.assign(new Error('Throughput exceeds the current capacity'), {
        name: 'ProvisionedThroughputExceededException',
      });
    store.markFailures.push(throughput());
    const records = [
      insert(notification({ id: 'n-1' }), '1'),
      insert(notification({ id: 'n-2' }), '2'),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(sender.sent).toHaveLength(2);
    expect(store.marks).toEqual([
      { id: 'n-1', status: 'SENT', attempts: 1 },
      { id: 'n-2', status: 'SENT', attempts: 1 },
    ]);
    expect(sleeps).toEqual([100]);
    expect(metrics.of('NotificationFailures')).toEqual([]);

    // A status write that keeps failing is logged; the record is still not retried.
    const second = build(true);
    second.store.markFailures.push(throughput(), throughput(), throughput());
    await expect(second.handler({ Records: [insert(notification(), '7')] })).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(second.sender.sent).toHaveLength(1);
    expect(second.store.marks).toEqual([]);
    expect(second.metrics.of('NotificationFailures')).toEqual([]);
    expect(
      second.logger.entries.find(
        (entry) => entry.message === 'notification sent but its SENT status could not be recorded',
      )?.fields,
    ).toMatchObject({ notificationId: 'n-1', attempts: 3 });
    expect(second.sleeps).toEqual([100, 200]);
  });

  test('retried batches do not send a notification that is already past PENDING', async () => {
    const { handler, store, sender } = build(true);
    store.statuses.set('n-1', 'SENT');
    store.missing.add('n-2');
    const records = [
      insert(notification({ id: 'n-1' }), '1'),
      insert(notification({ id: 'n-2' }), '2'),
      insert(notification({ id: 'n-3' }), '3'),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(sender.sent.map((message) => message.to)).toEqual(['bob@example.com']);
    expect(store.marks).toEqual([{ id: 'n-3', status: 'SENT', attempts: 1 }]);
  });

  test('non-INSERT records, other entities and corrupt images are skipped', async () => {
    const { handler, store, sender, logger } = build(true);
    const records = [
      streamRecord('MODIFY', notificationItem(notification({ id: 'n-1', status: 'SENT' })), '1'),
      streamRecord('INSERT', liveOfferItem(offer()), '2'),
      streamRecord(
        'INSERT',
        { ...notificationItem(notification({ id: 'n-x' })), kind: 'NOPE' },
        '3',
      ),
      insert(notification({ id: 'n-2' }), '4'),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(sender.sent).toHaveLength(1);
    expect(store.marks).toEqual([{ id: 'n-2', status: 'SENT', attempts: 1 }]);
    expect(
      logger.entries.find((entry) => entry.message === 'unreadable notification record dropped')
        ?.fields,
    ).toMatchObject({ sequenceNumber: '3' });
  });

  test('a sender is required when e-mail is enabled', () => {
    expect(() =>
      createNotifierHandler({
        store: new FakeStatusStore(),
        emailEnabled: true,
        rate: { take: async () => undefined },
        logger: new InMemoryLogger(),
        metrics: new InMemoryMetrics(),
      }),
    ).toThrow(/requires a sender/);
  });
});

describe('DynamoNotificationStatusStore', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const TABLE = 'seatrelay-test';
  const newStore = () =>
    new DynamoNotificationStatusStore(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-southeast-1' })),
      TABLE,
    );

  beforeEach(() => {
    ddb.reset();
  });

  test('getStatus is a consistent projected GetItem on U#{userId} / N#{createdAt}#{id}', async () => {
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: { status: 'PENDING' } })
      .resolvesOnce({});
    const store = newStore();
    await expect(store.getStatus(notification())).resolves.toBe('PENDING');
    await expect(store.getStatus(notification())).resolves.toBeUndefined();
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toEqual({
      TableName: TABLE,
      Key: { PK: 'U#bob', SK: `N#${T0}#n-1` },
      ConsistentRead: true,
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    });
  });

  test('markStatus updates status/attempts (+ truncated lastError) only while the item exists', async () => {
    ddb
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(new ConditionalCheckFailedException({ $metadata: {}, message: 'gone' }));
    const store = newStore();
    await expect(store.markStatus(notification(), 'FAILED', 2, 'x'.repeat(600))).resolves.toBe(
      true,
    );
    await expect(store.markStatus(notification(), 'SENT', 1)).resolves.toBe(false);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      TableName: TABLE,
      Key: { PK: 'U#bob', SK: `N#${T0}#n-1` },
      UpdateExpression: 'SET #status = :status, #attempts = :attempts, #lastError = :lastError',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: {
        ':status': 'FAILED',
        ':attempts': 2,
        ':lastError': 'x'.repeat(500),
      },
    });
    ddb
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    await expect(store.markStatus(notification(), 'SENT', 1)).rejects.toThrow('down');
  });
});
