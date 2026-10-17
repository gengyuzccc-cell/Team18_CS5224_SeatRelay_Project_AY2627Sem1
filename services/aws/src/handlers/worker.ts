import type {
  Context,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import { CommandSchema, type Command } from '@seatrelay/contracts';
import {
  FaultInjectedError,
  processCommand,
  type ProcessCommandResult,
  type WorkerPorts,
} from '@seatrelay/service';
import { envFlag } from '../lib/env';
import { errorFields } from '../lib/logger';
import { runtime, workerPorts } from '../lib/ports';
import { lazy, noopLifecycle, type InvocationLifecycle } from '../lib/runtime';

export interface WorkerHandlerDeps {
  ports: WorkerPorts;
  /** Honour `_fault` flags (deployment setting ALLOW_FAULT_FLAGS=true, dev only). */
  faultInjection: boolean;
  lifecycle?: InvocationLifecycle;
  maxVersionRetries?: number;
}

export type WorkerHandler = (event: SQSEvent, context?: Context) => Promise<SQSBatchResponse>;

export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string };

export function parseCommandBody(body: string): ParsedCommand {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: 'body is not JSON' };
  }
  const result = CommandSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, command: result.data };
}

export function deliveryAttemptOf(record: SQSRecord): number {
  const count = Number(record.attributes?.ApproximateReceiveCount ?? '1');
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
}

/**
 * FIFO consumer (plan §2.4). Written for N records although the event source uses BatchSize 1:
 * records are processed in order; a deterministic rejection settles the command as REJECTED
 * and never fails the record; a malformed message is logged and dropped (it can never
 * succeed, and failing it would stall its workshop's message group); an infrastructure error
 * (DynamoDB/SQS failure, exhausted version retries, an injected fault) reports that record and
 * every following record in `batchItemFailures`, as the FIFO batch rule requires.
 */
export function createWorkerHandler(deps: WorkerHandlerDeps): WorkerHandler {
  const lifecycle = deps.lifecycle ?? noopLifecycle;
  const { ports } = deps;
  return async (event, context) => {
    const failures: SQSBatchItemFailure[] = [];
    const records = event.Records ?? [];
    lifecycle.begin(context);
    try {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        const parsed = parseCommandBody(record.body);
        if (!parsed.ok) {
          ports.logger.error('malformed command message dropped', {
            messageId: record.messageId,
            error: parsed.error,
          });
          continue;
        }
        const { command } = parsed;
        const deliveryAttempt = deliveryAttemptOf(record);
        try {
          const result: ProcessCommandResult = await processCommand(ports, command, {
            faultInjection: deps.faultInjection,
            deliveryAttempt,
            ...(deps.maxVersionRetries === undefined
              ? {}
              : { maxVersionRetries: deps.maxVersionRetries }),
          });
          ports.logger.info('message processed', {
            messageId: record.messageId,
            type: command.type,
            workshopId: command.workshopId,
            outcome: result.outcome,
            attempts: result.attempts,
            deliveryAttempt,
          });
        } catch (error) {
          const fields = {
            messageId: record.messageId,
            type: command.type,
            workshopId: command.workshopId,
            deliveryAttempt,
            failedFromIndex: index,
            ...errorFields(error),
          };
          if (error instanceof FaultInjectedError) {
            ports.logger.warn('injected fault; message will be redelivered', fields);
          } else {
            ports.logger.error(
              'infrastructure error; reporting this and following records',
              fields,
            );
          }
          for (const rest of records.slice(index)) {
            failures.push({ itemIdentifier: rest.messageId });
          }
          break;
        }
      }
      return { batchItemFailures: failures };
    } finally {
      lifecycle.end();
    }
  };
}

const defaultHandler = lazy(() =>
  createWorkerHandler({
    ports: workerPorts(),
    faultInjection: envFlag('ALLOW_FAULT_FLAGS'),
    lifecycle: runtime(),
  }),
);

export const handler: WorkerHandler = (event, context) => defaultHandler()(event, context);
