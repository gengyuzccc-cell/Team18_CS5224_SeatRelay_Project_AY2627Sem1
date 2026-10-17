import type { CommandTrace } from './ops';
import type { ExperimentContext } from './run';
import { sleep } from './scenario';

/**
 * Waiting for the redelivery of a message whose first delivery was crashed on purpose
 * (`_fault`, plan §2.4). Local: the `commands` row is polled until it shows ≥ 2 deliveries and
 * status DONE. AWS: the message is invisible for the queue's visibility timeout (120 s), so the
 * script waits `--redelivery-wait` and then reads the worker log lines of the command (Logs
 * Insights) to see the deliveries. Without either side channel the script waits and says so.
 */

export interface RedeliveryOutcome {
  /** How the redelivery was established. */
  how: 'trace' | 'waited';
  /** Deliveries seen (undefined when not observable). */
  deliveries?: number;
  status?: string;
  detail: string;
  events: string[];
}

export async function awaitRedelivery(
  ctx: ExperimentContext,
  commandId: string,
  options: {
    /** Lower bound of the log search window (epoch ms). */
    sinceMs: number;
    /** When the crashing delivery settled (epoch ms, default now); the wait counts from here. */
    crashedAtMs?: number;
    minDeliveries?: number;
    pollMs?: number;
  } = { sinceMs: Date.now() },
): Promise<RedeliveryOutcome> {
  const minDeliveries = options.minDeliveries ?? 2;
  const deadline = (options.crashedAtMs ?? Date.now()) + ctx.options.redeliveryWaitMs;
  if (ctx.ops.kind === 'local') {
    let last: CommandTrace | undefined;
    for (;;) {
      last = await ctx.ops.commandTrace(commandId, options.sinceMs);
      if (!last.available) {
        break;
      }
      if ((last.deliveries ?? 0) >= minDeliveries && last.status === 'DONE') {
        return {
          how: 'trace',
          deliveries: last.deliveries,
          status: last.status,
          detail: last.detail,
          events: last.events,
        };
      }
      if (Date.now() >= deadline) {
        return {
          how: 'trace',
          ...(last.deliveries === undefined ? {} : { deliveries: last.deliveries }),
          ...(last.status === undefined ? {} : { status: last.status }),
          detail: `${last.detail} (still short of ${minDeliveries} deliveries after ${Math.round(ctx.options.redeliveryWaitMs / 1000)} s)`,
          events: last.events,
        };
      }
      await sleep(options.pollMs ?? 500);
    }
    await sleep(Math.max(0, deadline - Date.now()));
    return {
      how: 'waited',
      detail: `commands row not readable (${last?.detail ?? 'no trace'}); waited ${Math.round(ctx.options.redeliveryWaitMs / 1000)} s`,
      events: [],
    };
  }
  ctx.log(`waiting up to ${Math.round(Math.max(0, deadline - Date.now()) / 1000)} s for the redelivery of ${commandId} (visibility timeout)`);
  await sleep(Math.max(0, deadline - Date.now()));
  const trace = await ctx.ops.commandTrace(commandId, options.sinceMs);
  if (!trace.available) {
    return { how: 'waited', detail: `worker logs not readable (${trace.detail}); waited ${Math.round(ctx.options.redeliveryWaitMs / 1000)} s`, events: [] };
  }
  return {
    how: 'trace',
    ...(trace.deliveries === undefined ? {} : { deliveries: trace.deliveries }),
    detail: trace.detail,
    events: trace.events,
  };
}

/** One-line description for summaries. */
export function describeRedelivery(outcome: RedeliveryOutcome): string {
  return outcome.deliveries === undefined
    ? `${outcome.how}: ${outcome.detail}`
    : `${outcome.deliveries} deliveries${outcome.status === undefined ? '' : `, ${outcome.status}`} (${outcome.detail})`;
}
