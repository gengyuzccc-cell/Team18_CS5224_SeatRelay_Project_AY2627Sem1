import { SQSClient, SendMessageBatchCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Command, TickCommand } from '@seatrelay/contracts';
import { addSeconds, parseIso, type OfferTimer } from '@seatrelay/core';
import { ManualClock } from '@seatrelay/service';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  MAX_SQS_DELAY_SECONDS,
  SqsCommandQueue,
  SqsTimerScheduler,
  dedupIdFor,
  delaySecondsFor,
  minuteBucket,
  sendDelayedTick,
} from '../src/adapters/sqs';
import { CMD_ID, T0, WS } from './fixtures';

const sqs = mockClient(SQSClient);
const FIFO_URL =
  'https://sqs.ap-southeast-1.amazonaws.com/123456789012/seatrelay-test-commands.fifo';
const DELAY_URL =
  'https://sqs.ap-southeast-1.amazonaws.com/123456789012/seatrelay-test-expiry-delay';

const register: Command = {
  type: 'REGISTER',
  commandId: CMD_ID,
  workshopId: WS,
  actorUserId: 'bob',
  actorEmail: 'bob@example.com',
  acceptable: ['s1'],
};
const timerTick: TickCommand = {
  type: 'TICK',
  workshopId: WS,
  source: 'TIMER',
  offerId: 'offer-1',
  expiresAt: addSeconds(T0, 60),
};

beforeEach(() => {
  sqs.reset();
});

describe('dedup ids', () => {
  test('user commands use the client commandId; timer ticks tick#offerId#expiresAt', () => {
    expect(dedupIdFor(register, T0)).toBe(CMD_ID);
    expect(dedupIdFor(timerTick, T0)).toBe(`tick#offer-1#${addSeconds(T0, 60)}`);
  });

  test('sweep ticks are deduplicated per workshop and minute', () => {
    const sweep: TickCommand = { type: 'TICK', workshopId: WS, source: 'SWEEP' };
    expect(dedupIdFor(sweep, '2026-11-03T06:00:12.345Z')).toBe('sweep#ws-1#2026-11-03T06:00');
    expect(dedupIdFor(sweep, '2026-11-03T06:00:59.999Z')).toBe('sweep#ws-1#2026-11-03T06:00');
    expect(dedupIdFor(sweep, '2026-11-03T06:01:00.000Z')).toBe('sweep#ws-1#2026-11-03T06:01');
    expect(minuteBucket(T0)).toBe('2026-11-03T06:00');
  });

  test('continuations and keyless ticks get a fresh id per delivery', () => {
    const reallocate: Command = { type: 'REALLOCATE', workshopId: WS };
    const a = dedupIdFor(reallocate, T0);
    const b = dedupIdFor(reallocate, T0);
    expect(a.startsWith('reallocate#ws-1#')).toBe(true);
    expect(a).not.toBe(b);
    const adHoc: TickCommand = { type: 'TICK', workshopId: WS };
    expect(dedupIdFor(adHoc, T0).startsWith('tick#ws-1#')).toBe(true);
  });
});

describe('SqsCommandQueue (commands.fifo)', () => {
  test('SendMessage with MessageGroupId = workshopId and an explicit dedup id', async () => {
    sqs.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    const queue = new SqsCommandQueue(new SQSClient({}), FIFO_URL, new ManualClock(T0));
    await queue.enqueue(register);
    await queue.enqueue(timerTick);
    const calls = sqs.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input).toEqual({
      QueueUrl: FIFO_URL,
      MessageBody: JSON.stringify(register),
      MessageGroupId: WS,
      MessageDeduplicationId: CMD_ID,
    });
    expect(calls[1]!.args[0].input).toMatchObject({
      MessageGroupId: WS,
      MessageDeduplicationId: `tick#offer-1#${addSeconds(T0, 60)}`,
    });
    expect(calls[1]!.args[0].input).not.toHaveProperty('DelaySeconds');
  });

  test('SQS failures propagate (the API answers 503 and rolls the ACCEPTED record back)', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('ServiceUnavailable'));
    const queue = new SqsCommandQueue(new SQSClient({}), FIFO_URL, new ManualClock(T0));
    await expect(queue.enqueue(register)).rejects.toThrow('ServiceUnavailable');
  });
});

describe('delay computation', () => {
  const nowMs = parseIso(T0);

  test('clamp(ceil((expiresAt − now) / 1000), 0, 900)', () => {
    expect(delaySecondsFor(addSeconds(T0, 60), nowMs)).toBe(60);
    expect(delaySecondsFor(addSeconds(T0, 0.2), nowMs)).toBe(1);
    expect(delaySecondsFor(addSeconds(T0, 59.001), nowMs)).toBe(60);
    expect(delaySecondsFor(T0, nowMs)).toBe(0);
    expect(delaySecondsFor(addSeconds(T0, -30), nowMs)).toBe(0);
    expect(delaySecondsFor(addSeconds(T0, 900), nowMs)).toBe(900);
    expect(delaySecondsFor(addSeconds(T0, 20 * 60), nowMs)).toBe(MAX_SQS_DELAY_SECONDS);
  });

  test('sendDelayedTick clamps the delay too', async () => {
    sqs.on(SendMessageCommand).resolves({});
    await sendDelayedTick(new SQSClient({}), DELAY_URL, timerTick, 5000);
    await sendDelayedTick(new SQSClient({}), DELAY_URL, timerTick, -3);
    const delays = sqs
      .commandCalls(SendMessageCommand)
      .map((call) => call.args[0].input.DelaySeconds);
    expect(delays).toEqual([900, 0]);
    expect(sqs.commandCalls(SendMessageCommand)[0]!.args[0].input).toMatchObject({
      QueueUrl: DELAY_URL,
      MessageBody: JSON.stringify(timerTick),
    });
  });
});

describe('SqsTimerScheduler (expiry-delay)', () => {
  function timers(count: number): OfferTimer[] {
    return Array.from({ length: count }, (_, index) => ({
      offerId: `offer-${index}`,
      expiresAt: addSeconds(T0, 30 + index),
    }));
  }

  test('SendMessageBatch in chunks of 10 with per-entry DelaySeconds and TICK bodies', async () => {
    sqs.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    const scheduler = new SqsTimerScheduler(new SQSClient({}), DELAY_URL, new ManualClock(T0));
    await scheduler.schedule(WS, timers(25));
    const calls = sqs.commandCalls(SendMessageBatchCommand);
    expect(calls.map((call) => call.args[0].input.Entries?.length)).toEqual([10, 10, 5]);
    const first = calls[0]!.args[0].input;
    expect(first.QueueUrl).toBe(DELAY_URL);
    expect(first.Entries?.[0]).toEqual({
      Id: '0',
      MessageBody: JSON.stringify({
        type: 'TICK',
        workshopId: WS,
        source: 'TIMER',
        offerId: 'offer-0',
        expiresAt: addSeconds(T0, 30),
      }),
      DelaySeconds: 30,
    });
    expect(first.Entries?.map((entry) => entry.Id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index)),
    );
    expect(calls[2]!.args[0].input.Entries?.[4]?.DelaySeconds).toBe(54);
  });

  test('delays are clamped to the 900 s SQS cap and never negative', async () => {
    sqs.on(SendMessageBatchCommand).resolves({});
    const scheduler = new SqsTimerScheduler(new SQSClient({}), DELAY_URL, new ManualClock(T0));
    await scheduler.schedule(WS, [
      { offerId: 'late', expiresAt: addSeconds(T0, -5) },
      { offerId: 'long', expiresAt: addSeconds(T0, 3600) },
    ]);
    const entries = sqs.commandCalls(SendMessageBatchCommand)[0]!.args[0].input.Entries ?? [];
    expect(entries.map((entry) => entry.DelaySeconds)).toEqual([0, 900]);
  });

  test('a partially failed batch throws so the command is redelivered (ticks are harmless)', async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false, Message: 'x' }],
    });
    const scheduler = new SqsTimerScheduler(new SQSClient({}), DELAY_URL, new ManualClock(T0));
    await expect(scheduler.schedule(WS, timers(3))).rejects.toThrow(
      /1 of 3 entries \(1:InternalError\)/,
    );
  });

  test('no timers: no request', async () => {
    const scheduler = new SqsTimerScheduler(new SQSClient({}), DELAY_URL, new ManualClock(T0));
    await scheduler.schedule(WS, []);
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });
});
