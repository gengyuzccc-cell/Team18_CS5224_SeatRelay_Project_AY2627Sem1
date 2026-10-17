import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { TickCommand } from '@seatrelay/contracts';
import { addSeconds, parseIso } from '@seatrelay/core';
import { InMemoryCommandQueue, InMemoryLogger, ManualClock } from '@seatrelay/service';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  RE_DELAY_THRESHOLD_MS,
  createExpiryForwarderHandler,
  parseTickBody,
  remainingMs,
} from '../src/handlers/expiryForwarder';
import { T0, WS } from './fixtures';
import { sqsRecord } from './harness';

const sqs = mockClient(SQSClient);
const DELAY_URL =
  'https://sqs.ap-southeast-1.amazonaws.com/123456789012/seatrelay-test-expiry-delay';

function tick(expiresAt: string, offerId = 'offer-1'): TickCommand {
  return { type: 'TICK', workshopId: WS, source: 'TIMER', offerId, expiresAt };
}

function build(now = T0) {
  const commands = new InMemoryCommandQueue();
  const logger = new InMemoryLogger();
  const clock = new ManualClock(now);
  const handler = createExpiryForwarderHandler({
    sqs: new SQSClient({}),
    delayQueueUrl: DELAY_URL,
    commands,
    clock,
    logger,
  });
  return { handler, commands, logger, clock };
}

beforeEach(() => {
  sqs.reset();
  sqs.on(SendMessageCommand).resolves({});
});

describe('helpers', () => {
  test('parseTickBody accepts TICKs only', () => {
    expect(parseTickBody(JSON.stringify(tick(T0)))).toEqual(tick(T0));
    expect(parseTickBody(JSON.stringify({ type: 'REGISTER', workshopId: WS }))).toBeUndefined();
    expect(parseTickBody('{')).toBeUndefined();
  });

  test('remainingMs is how early the tick is, never negative, 0 without expiresAt', () => {
    const nowMs = parseIso(T0);
    expect(remainingMs(tick(addSeconds(T0, 90)), nowMs)).toBe(90_000);
    expect(remainingMs(tick(addSeconds(T0, -90)), nowMs)).toBe(0);
    expect(remainingMs({ type: 'TICK', workshopId: WS }, nowMs)).toBe(0);
  });
});

describe('expiry forwarder', () => {
  test('a due tick goes to the FIFO under the workshop group with the natural dedup id', async () => {
    const { handler, commands } = build(addSeconds(T0, 61));
    const due = tick(addSeconds(T0, 60));
    await expect(handler({ Records: [sqsRecord(due)] })).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(commands.messages).toEqual([due]);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  test('a tick that is early by at most one second is forwarded rather than re-delayed', async () => {
    const { handler, commands } = build(T0);
    const slightlyEarly = tick(addSeconds(T0, RE_DELAY_THRESHOLD_MS / 1000));
    await handler({ Records: [sqsRecord(slightlyEarly)] });
    expect(commands.messages).toEqual([slightlyEarly]);
  });

  test('a tick that is early by more than one second goes back to the delay queue (holds > 15 min)', async () => {
    const { handler, commands, logger } = build(T0);
    const longHold = tick(addSeconds(T0, 20 * 60));
    const mediumHold = tick(addSeconds(T0, 90), 'offer-2');
    await expect(
      handler({ Records: [sqsRecord(longHold), sqsRecord(mediumHold)] }),
    ).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(commands.messages).toEqual([]);
    const sent = sqs.commandCalls(SendMessageCommand).map((call) => call.args[0].input);
    expect(sent).toEqual([
      { QueueUrl: DELAY_URL, MessageBody: JSON.stringify(longHold), DelaySeconds: 900 },
      { QueueUrl: DELAY_URL, MessageBody: JSON.stringify(mediumHold), DelaySeconds: 90 },
    ]);
    expect(logger.entries.filter((entry) => entry.message === 'tick re-delayed')).toHaveLength(2);
  });

  test('a tick without source is forwarded as a TIMER tick; sweep ticks keep their source', async () => {
    const { handler, commands } = build(addSeconds(T0, 10));
    const bare = { type: 'TICK', workshopId: WS, offerId: 'o', expiresAt: T0 };
    const sweep = { type: 'TICK', workshopId: WS, source: 'SWEEP' };
    await handler({ Records: [sqsRecord(bare), sqsRecord(sweep)] });
    expect(commands.messages).toEqual([{ ...bare, source: 'TIMER' }, sweep]);
  });

  test('malformed records are dropped; failures are reported per record only', async () => {
    const { handler, commands, logger } = build(addSeconds(T0, 120));
    commands.failNextEnqueue = true;
    const records = [
      sqsRecord('garbage', { messageId: 'bad' }),
      sqsRecord(tick(T0, 'a'), { messageId: 'fails' }),
      sqsRecord(tick(T0, 'b'), { messageId: 'ok' }),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'fails' }],
    });
    expect(commands.messages.map((message) => (message as TickCommand).offerId)).toEqual(['b']);
    expect(
      logger.entries.find((entry) => entry.message === 'malformed tick dropped')?.fields,
    ).toEqual({
      messageId: 'bad',
    });
  });

  test('a failed re-delay is reported for that record', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('SQS down'));
    const { handler } = build(T0);
    await expect(
      handler({ Records: [sqsRecord(tick(addSeconds(T0, 600)), { messageId: 'x' })] }),
    ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'x' }] });
  });

  test('the same tick arriving twice is dropped by FIFO deduplication (tick#offerId#expiresAt)', async () => {
    const { handler, commands } = build(addSeconds(T0, 61));
    const due = tick(addSeconds(T0, 60));
    await handler({ Records: [sqsRecord(due), sqsRecord(due)] });
    expect(commands.messages).toHaveLength(1);
    expect(commands.deduplicated).toBe(1);
  });
});
