import type { Context } from 'aws-lambda';
import { runSweep, systemClock, type SweepPorts, type SweepResult } from '@seatrelay/service';
import { commandQueue, runtime, store } from '../lib/ports';
import { lazy, noopLifecycle, type InvocationLifecycle } from '../lib/runtime';

export interface SweepHandlerDeps {
  ports: SweepPorts;
  lifecycle?: InvocationLifecycle;
}

export interface SweepSummary {
  now: string;
  ticked: number;
  workshopIds: string[];
}

export type SweepHandler = (event?: unknown, context?: Context) => Promise<SweepSummary>;

/**
 * EventBridge `rate(5 minutes)` safety net (plan §1.2): `listDueWorkshops(now)` on the sparse
 * DUE index and one `TICK{source: 'SWEEP'}` per due workshop (dedup `sweep#wsId#minute`).
 * In normal operation every tick is a no-op; the worker reports `SweepLateExpiries` otherwise.
 */
export function createSweepHandler(deps: SweepHandlerDeps): SweepHandler {
  const lifecycle = deps.lifecycle ?? noopLifecycle;
  return async (_event, context) => {
    lifecycle.begin(context);
    try {
      const result: SweepResult = await runSweep(deps.ports);
      return { now: result.now, ticked: result.workshopIds.length, workshopIds: result.workshopIds };
    } finally {
      lifecycle.end();
    }
  };
}

const defaultHandler = lazy(() =>
  createSweepHandler({
    ports: { store: store(), queue: commandQueue(), clock: systemClock, logger: runtime().logger },
    lifecycle: runtime(),
  }),
);

export const handler: SweepHandler = (event, context) => defaultHandler()(event, context);
