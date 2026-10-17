import type { Context, SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { TickCommandSchema, type TickCommand } from '@seatrelay/contracts';
import { parseIso } from '@seatrelay/core';
import { systemClock, type Clock, type CommandQueue, type Logger } from '@seatrelay/service';
import { delaySecondsFor, sendDelayedTick } from '../adapters/sqs';
import { sqsClient } from '../lib/clients';
import { requireEnv } from '../lib/env';
import { errorFields } from '../lib/logger';
import { commandQueue, runtime } from '../lib/ports';
import { lazy, noopLifecycle, type InvocationLifecycle } from '../lib/runtime';

/** A tick that arrives more than this early (hold > 15 min) goes back to the delay queue. */
export const RE_DELAY_THRESHOLD_MS = 1000;

export interface ExpiryForwarderDeps {
  sqs: SQSClient;
  delayQueueUrl: string;
  /** The FIFO command queue (group = workshopId, dedup = `tick#offerId#expiresAt`). */
  commands: CommandQueue;
  clock: Clock;
  logger: Logger;
  lifecycle?: InvocationLifecycle;
}

export type ExpiryForwarderHandler = (event: SQSEvent, context?: Context) => Promise<SQSBatchResponse>;

export function parseTickBody(body: string): TickCommand | undefined {
  try {
    const result = TickCommandSchema.safeParse(JSON.parse(body));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Milliseconds the tick is early; 0 when due (or when the tick carries no `expiresAt`). */
export function remainingMs(tick: TickCommand, nowMs: number): number {
  return tick.expiresAt === undefined ? 0 : Math.max(0, parseIso(tick.expiresAt) - nowMs);
}

/**
 * Delay queue → FIFO (plan §1.2). For each TICK: if it is still more than one second early
 * (the hold was longer than the 900 s SQS timer cap) it is re-sent to the delay queue with the
 * remaining delay, clamped to 900 s again; otherwise it is enqueued on the FIFO under the
 * workshop's message group. Failures are reported per record (standard queue, partial batch).
 */
export function createExpiryForwarderHandler(deps: ExpiryForwarderDeps): ExpiryForwarderHandler {
  const lifecycle = deps.lifecycle ?? noopLifecycle;
  return async (event, context) => {
    const failures: SQSBatchItemFailure[] = [];
    lifecycle.begin(context);
    try {
      for (const record of event.Records ?? []) {
        const tick = parseTickBody(record.body);
        if (tick === undefined) {
          deps.logger.error('malformed tick dropped', { messageId: record.messageId });
          continue;
        }
        const nowMs = parseIso(deps.clock.now());
        const remaining = remainingMs(tick, nowMs);
        try {
          if (remaining > RE_DELAY_THRESHOLD_MS) {
            const delaySeconds = delaySecondsFor(tick.expiresAt!, nowMs);
            await sendDelayedTick(deps.sqs, deps.delayQueueUrl, tick, delaySeconds);
            deps.logger.info('tick re-delayed', {
              workshopId: tick.workshopId,
              offerId: tick.offerId,
              expiresAt: tick.expiresAt,
              delaySeconds,
            });
          } else {
            await deps.commands.enqueue({ ...tick, source: tick.source ?? 'TIMER' });
            deps.logger.info('tick forwarded', {
              workshopId: tick.workshopId,
              offerId: tick.offerId,
              expiresAt: tick.expiresAt,
              lateMs: tick.expiresAt === undefined ? 0 : nowMs - parseIso(tick.expiresAt),
            });
          }
        } catch (error) {
          deps.logger.error('tick forwarding failed', {
            messageId: record.messageId,
            workshopId: tick.workshopId,
            ...errorFields(error),
          });
          failures.push({ itemIdentifier: record.messageId });
        }
      }
      return { batchItemFailures: failures };
    } finally {
      lifecycle.end();
    }
  };
}

const defaultHandler = lazy(() =>
  createExpiryForwarderHandler({
    sqs: sqsClient(),
    delayQueueUrl: requireEnv('EXPIRY_DELAY_QUEUE_URL'),
    commands: commandQueue(),
    clock: systemClock,
    logger: runtime().logger,
    lifecycle: runtime(),
  }),
);

export const handler: ExpiryForwarderHandler = (event, context) =>
  defaultHandler()(event, context);
