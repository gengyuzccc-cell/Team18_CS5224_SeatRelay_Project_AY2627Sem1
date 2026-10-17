import { randomUUID } from 'node:crypto';
import {
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import type { Command, TickCommand } from '@seatrelay/contracts';
import { parseIso, type OfferTimer } from '@seatrelay/core';
import {
  commandDedupId,
  commandGroupId,
  tickForTimer,
  type Clock,
  type CommandQueue,
  type TimerScheduler,
} from '@seatrelay/service';

/** SQS message timers are capped at 15 minutes. */
export const MAX_SQS_DELAY_SECONDS = 900;
const SEND_BATCH_LIMIT = 10;

/**
 * FIFO deduplication id (plan §1.2/§1.3, CONVENTIONS §5):
 * - user commands: the client `commandId` (idempotent re-POST, C3);
 * - timer ticks: `tick#{offerId}#{expiresAt}`;
 * - sweep ticks: `sweep#{wsId}#{minute}` (one per workshop per minute; the sweep runs every 5);
 * - everything else (REALLOCATE continuations, ad-hoc ticks): a fresh UUID, every delivery counts.
 */
export function dedupIdFor(command: Command, now: string): string {
  const natural = commandDedupId(command);
  if (natural !== undefined) {
    return natural;
  }
  if (command.type === 'TICK' && command.source === 'SWEEP') {
    return `sweep#${command.workshopId}#${minuteBucket(now)}`;
  }
  return `${command.type.toLowerCase()}#${command.workshopId}#${randomUUID()}`;
}

/** `2026-11-03T06:00:00.000Z` → `2026-11-03T06:00`. */
export function minuteBucket(now: string): string {
  return new Date(parseIso(now)).toISOString().slice(0, 16);
}

/** `clamp(ceil((expiresAt − now) / 1000), 0, 900)`. */
export function delaySecondsFor(expiresAt: string, nowMs: number): number {
  const seconds = Math.ceil((parseIso(expiresAt) - nowMs) / 1000);
  return Math.min(MAX_SQS_DELAY_SECONDS, Math.max(0, seconds));
}

/** `CommandQueue` on the `commands.fifo` queue: group = workshopId, explicit dedup id. */
export class SqsCommandQueue implements CommandQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly clock: Clock,
  ) {}

  async enqueue(command: Command): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(command),
        MessageGroupId: commandGroupId(command),
        MessageDeduplicationId: dedupIdFor(command, this.clock.now()),
      }),
    );
  }
}

/** Sends one TICK to the standard delay queue with the given timer (used by the forwarder too). */
export async function sendDelayedTick(
  sqs: SQSClient,
  delayQueueUrl: string,
  tick: TickCommand,
  delaySeconds: number,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: delayQueueUrl,
      MessageBody: JSON.stringify(tick),
      DelaySeconds: Math.min(MAX_SQS_DELAY_SECONDS, Math.max(0, Math.round(delaySeconds))),
    }),
  );
}

/**
 * `TimerScheduler` on the standard `expiry-delay` queue: `SendMessageBatch` (10 per call) with
 * `DelaySeconds = clamp(ceil((expiresAt − now) / 1000), 0, 900)` and body
 * `TICK{workshopId, source: 'TIMER', offerId, expiresAt}`. Holds longer than 15 minutes are
 * re-delayed by the forwarder when the message arrives early. Called before the commit, so a
 * failed batch simply fails the command (redelivered; extra ticks are harmless).
 */
export class SqsTimerScheduler implements TimerScheduler {
  constructor(
    private readonly sqs: SQSClient,
    private readonly delayQueueUrl: string,
    private readonly clock: Clock,
  ) {}

  async schedule(wsId: string, timers: readonly OfferTimer[]): Promise<void> {
    const nowMs = parseIso(this.clock.now());
    for (let start = 0; start < timers.length; start += SEND_BATCH_LIMIT) {
      const chunk = timers.slice(start, start + SEND_BATCH_LIMIT);
      const entries: SendMessageBatchRequestEntry[] = chunk.map((timer, index) => ({
        Id: String(index),
        MessageBody: JSON.stringify(tickForTimer(wsId, timer)),
        DelaySeconds: delaySecondsFor(timer.expiresAt, nowMs),
      }));
      const output = await this.sqs.send(
        new SendMessageBatchCommand({ QueueUrl: this.delayQueueUrl, Entries: entries }),
      );
      const failed = output.Failed ?? [];
      if (failed.length > 0) {
        const codes = failed.map((entry) => `${entry.Id}:${entry.Code ?? '?'}`).join(', ');
        throw new Error(`timer scheduling failed for ${failed.length} of ${chunk.length} entries (${codes})`);
      }
    }
  }
}
