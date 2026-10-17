import { randomUUID } from 'node:crypto';
import type { SQSRecord } from 'aws-lambda';
import type { Command } from '@seatrelay/contracts';
import { describe, expect, test } from 'vitest';
import { createWorkerHandler, deliveryAttemptOf, parseCommandBody } from '../src/handlers/worker';
import { bob, carol, postCommand, scenario, sqsRecord } from './harness';

/** Takes every message the in-memory API enqueued and turns it into SQS records. */
function drainToRecords(messages: Command[], receiveCount = 1): SQSRecord[] {
  const records = messages.map((message, index) =>
    sqsRecord(message, {
      messageId: `msg-${index + 1}`,
      receiveCount,
      groupId: message.workshopId,
    }),
  );
  messages.length = 0;
  return records;
}

describe('message parsing', () => {
  test('parseCommandBody validates against the contracts schema', () => {
    const tick = { type: 'TICK', workshopId: 'ws-1', source: 'SWEEP' };
    expect(parseCommandBody(JSON.stringify(tick))).toEqual({ ok: true, command: tick });
    expect(parseCommandBody('not json')).toEqual({ ok: false, error: 'body is not JSON' });
    expect(parseCommandBody(JSON.stringify({ type: 'BOGUS', workshopId: 'ws-1' })).ok).toBe(false);
    expect(parseCommandBody(JSON.stringify({ type: 'REGISTER', workshopId: 'ws-1' })).ok).toBe(
      false,
    );
  });

  test('deliveryAttemptOf reads ApproximateReceiveCount (1 when missing or invalid)', () => {
    expect(deliveryAttemptOf(sqsRecord({}, { receiveCount: 3 }))).toBe(3);
    expect(deliveryAttemptOf(sqsRecord({}))).toBe(1);
    const broken = sqsRecord({});
    broken.attributes.ApproximateReceiveCount = 'many';
    expect(deliveryAttemptOf(broken)).toBe(1);
  });
});

describe('worker handler', () => {
  test('applies commands in order, settles them and emits metrics; no batch failures', async () => {
    const { ports, wsId, s1, s2 } = await scenario();
    const first = await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1, s2] });
    const second = await postCommand(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    const records = drainToRecords(ports.queue.messages);
    const handler = createWorkerHandler({ ports, faultInjection: true });

    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(await ports.store.getCommandResult(first.commandId)).toMatchObject({
      status: 'APPLIED',
      result: { offersCreated: 1, registration: { status: 'OFFERED', seq: 1 } },
    });
    expect(await ports.store.getCommandResult(second.commandId)).toMatchObject({
      status: 'APPLIED',
      result: { offersCreated: 0, registration: { status: 'QUEUED', seq: 2, queuePosition: 1 } },
    });
    expect(ports.metrics.of('OffersCreated')).toEqual([1, 0]);
    expect(ports.metrics.of('CommandSettledLatency')).toHaveLength(2);
    expect(ports.timers.scheduled).toHaveLength(1);
    expect(
      ports.logger.entries.filter((entry) => entry.message === 'message processed'),
    ).toHaveLength(2);
  });

  test('a deterministic rejection settles the command as REJECTED and never fails the record', async () => {
    const { ports, wsId } = await scenario();
    const accept = await postCommand(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId: 'nope' });
    const handler = createWorkerHandler({ ports, faultInjection: true });
    await expect(handler({ Records: drainToRecords(ports.queue.messages) })).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(await ports.store.getCommandResult(accept.commandId)).toMatchObject({
      status: 'REJECTED',
      reason: 'OFFER_NOT_FOUND',
    });
  });

  test('malformed messages are dropped (logged), not retried', async () => {
    const { ports } = await scenario();
    const handler = createWorkerHandler({ ports, faultInjection: false });
    const records = [
      sqsRecord('not json', { messageId: 'bad-1' }),
      sqsRecord({ type: 'BOGUS', workshopId: 'x' }, { messageId: 'bad-2' }),
    ];
    await expect(handler({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(
      ports.logger.entries.filter((entry) => entry.message === 'malformed command message dropped'),
    ).toHaveLength(2);
  });

  test('internal ticks for an unknown workshop are a NOOP', async () => {
    const { ports } = await scenario();
    const handler = createWorkerHandler({ ports, faultInjection: false });
    const tick: Command = { type: 'TICK', workshopId: 'missing', source: 'SWEEP' };
    await expect(handler({ Records: [sqsRecord(tick)] })).resolves.toEqual({
      batchItemFailures: [],
    });
  });

  test('an infrastructure error fails that record and every following one (FIFO rule), earlier ones stay settled', async () => {
    const { ports, wsId, s1, s2 } = await scenario();
    const ok = await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1, s2] });
    const broken = await postCommand(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.queue.enqueue({ type: 'TICK', workshopId: wsId, source: 'SWEEP' });
    const records = drainToRecords(ports.queue.messages);
    ports.store.beforeCommit = (args) => {
      if (args.commandResult?.commandId === broken.commandId) {
        throw Object.assign(new Error('DynamoDB unavailable'), { name: 'InternalServerError' });
      }
    };
    const handler = createWorkerHandler({ ports, faultInjection: false });

    await expect(handler({ Records: records })).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-2' }, { itemIdentifier: 'msg-3' }],
    });
    expect(await ports.store.getCommandResult(ok.commandId)).toMatchObject({ status: 'APPLIED' });
    expect(await ports.store.getCommandResult(broken.commandId)).toMatchObject({
      status: 'ACCEPTED',
    });
    const failure = ports.logger.entries.find(
      (entry) => entry.message === 'infrastructure error; reporting this and following records',
    );
    expect(failure?.fields).toMatchObject({
      messageId: 'msg-2',
      failedFromIndex: 1,
      error: 'DynamoDB unavailable',
    });
  });

  test('exhausted version-conflict retries are an infrastructure error (MetaConflictRetries emitted)', async () => {
    const { ports, wsId, s1 } = await scenario();
    const command = await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    ports.store.beforeCommit = (args) => ports.store.bumpVersion(args.wsId);
    const handler = createWorkerHandler({ ports, faultInjection: false, maxVersionRetries: 2 });
    const [record] = drainToRecords(ports.queue.messages);
    await expect(handler({ Records: [record!] })).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
    expect(ports.metrics.of('MetaConflictRetries')).toEqual([1, 1, 1]);
    expect(await ports.store.getCommandResult(command.commandId)).toMatchObject({
      status: 'ACCEPTED',
    });
  });

  test('_fault flags fire only with faultInjection on and only on the first delivery', async () => {
    const { ports, wsId, s1 } = await scenario({ allowFaultFlags: true });
    const command = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'BEFORE_COMMIT',
    });
    const [message] = ports.queue.messages;
    expect(message).toMatchObject({ _fault: 'BEFORE_COMMIT' });
    const injecting = createWorkerHandler({ ports, faultInjection: true });

    const firstDelivery = sqsRecord(message, { messageId: 'm1', receiveCount: 1 });
    await expect(injecting({ Records: [firstDelivery] })).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'm1' }],
    });
    expect(await ports.store.getCommandResult(command.commandId)).toMatchObject({
      status: 'ACCEPTED',
    });
    expect(
      ports.logger.entries.some(
        (entry) => entry.message === 'injected fault; message will be redelivered',
      ),
    ).toBe(true);

    const redelivery = sqsRecord(message, { messageId: 'm1', receiveCount: 2 });
    await expect(injecting({ Records: [redelivery] })).resolves.toEqual({ batchItemFailures: [] });
    expect(await ports.store.getCommandResult(command.commandId)).toMatchObject({
      status: 'APPLIED',
    });
  });

  test('with faultInjection off (pilot) the flag is ignored', async () => {
    const { ports, wsId, s1 } = await scenario({ allowFaultFlags: true });
    const command = await postCommand(ports, bob, wsId, {
      type: 'REGISTER',
      acceptable: [s1],
      _fault: 'AFTER_COMMIT',
    });
    const handler = createWorkerHandler({ ports, faultInjection: false });
    await expect(handler({ Records: drainToRecords(ports.queue.messages) })).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(await ports.store.getCommandResult(command.commandId)).toMatchObject({
      status: 'APPLIED',
    });
  });

  test('a redelivered, already settled command is acknowledged (C3)', async () => {
    const { ports, wsId, s1 } = await scenario();
    const command = await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    const [message] = ports.queue.messages;
    const handler = createWorkerHandler({ ports, faultInjection: false });
    await handler({ Records: [sqsRecord(message, { messageId: randomUUID() })] });
    await expect(handler({ Records: [sqsRecord(message, { receiveCount: 2 })] })).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(await ports.store.getCommandResult(command.commandId)).toMatchObject({
      status: 'APPLIED',
    });
    const processed = ports.logger.entries.filter((entry) => entry.message === 'message processed');
    expect(processed.map((entry) => entry.fields?.outcome)).toEqual(['APPLIED', 'ALREADY_SETTLED']);
  });

  test('the invocation lifecycle wraps the batch even when a record fails', async () => {
    const { ports } = await scenario();
    const events: string[] = [];
    const handler = createWorkerHandler({
      ports,
      faultInjection: false,
      lifecycle: { begin: () => events.push('begin'), end: () => events.push('end') },
    });
    await handler({ Records: [sqsRecord('garbage')] });
    expect(events).toEqual(['begin', 'end']);
  });
});
