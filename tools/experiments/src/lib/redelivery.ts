import type { CommandTrace } from './ops';
import type { ExperimentContext } from './run';
import { sleep } from './scenario';

/**
 * Waiting for the redelivery of a message whose first delivery was crashed on purpose
 * (`_fault`, plan §2.4). Local: the `commands` row is polled until it shows ≥ 2 deliveries and
 * status DONE. AWS: the message is invisible for the queue's visibility timeout (120 s), so the
 * script waits `--redelivery-wait` and then reads the worker log lines of the command (Logs
 * Insights) to see the deliveries, polling for up to `logsGraceMs` more while the log lines
 * are still being ingested. Without either side channel the script waits and says so.
 *
 * On AWS a fault case is only proven by the worker logs: an unobservable redelivery is a
 * failed check there (`recordRedeliveryCheck`), not a skip — otherwise a deployment that
 * silently strips `_fault` would pass every fault case.
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
    /** AWS: keep re-reading the worker logs this long after the wait (ingestion lag; default 90 s). */
    logsGraceMs?: number;
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
  let trace = await ctx.ops.commandTrace(commandId, options.sinceMs);
  const graceEnd = Date.now() + (options.logsGraceMs ?? 90_000);
  while (trace.available && (trace.deliveries ?? 0) < minDeliveries && Date.now() < graceEnd) {
    await sleep(options.pollMs ?? 10_000);
    trace = await ctx.ops.commandTrace(commandId, options.sinceMs);
  }
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

/** The trace lines of an outcome, for raw.csv / summary.md (traceability evidence). */
export function traceText(outcome: RedeliveryOutcome, max = 12): string {
  const lines = outcome.events.slice(0, max);
  return `${lines.join(' | ')}${outcome.events.length > max ? ` | … ${outcome.events.length - max} more` : ''}`;
}

/** Whether a redelivery must be observed to pass: always on AWS, where only the logs prove it. */
export function redeliveryMustBeObserved(kind: 'local' | 'aws'): boolean {
  return kind === 'aws';
}

/**
 * Verdict of a fault case's redelivery: ≥ 2 deliveries (and, locally, the row DONE) passes; an
 * unobservable count passes only where it need not be observed (local without psql access).
 */
export function redeliveryOk(kind: 'local' | 'aws', outcome: RedeliveryOutcome, minDeliveries = 2): boolean {
  if (outcome.deliveries === undefined) {
    return !redeliveryMustBeObserved(kind);
  }
  return outcome.deliveries >= minDeliveries && (outcome.status === undefined || outcome.status === 'DONE');
}

/**
 * Records the redelivery as a check. Unobservable: a skip on local (no psql access to the
 * `commands` table), a FAILED check on AWS (the fault must be shown to have fired).
 */
export function recordRedeliveryCheck(
  ctx: ExperimentContext,
  input: { run: number; scenario: string; step: string; outcome: RedeliveryOutcome },
): boolean {
  const { run, scenario, step, outcome } = input;
  if (outcome.deliveries === undefined && !redeliveryMustBeObserved(ctx.ops.kind)) {
    ctx.skip(scenario, `${step} (delivery count)`, describeRedelivery(outcome), run);
    return true;
  }
  const ok = redeliveryOk(ctx.ops.kind, outcome);
  ctx.check({
    run,
    scenario,
    step,
    ok,
    expected: '≥ 2 deliveries, last one acknowledged',
    actual:
      outcome.deliveries === undefined
        ? `not observable: ${describeRedelivery(outcome)} (on AWS the worker logs must show the redelivery)`
        : describeRedelivery(outcome),
  });
  return ok;
}
