import { sweepTick } from '../commands';
import type { Clock, CommandQueue, Logger, WorkshopStore } from '../ports';

export interface SweepPorts {
  store: WorkshopStore;
  queue: CommandQueue;
  clock: Clock;
  logger: Logger;
}

export interface SweepResult {
  now: string;
  /** Workshops that received a sweep TICK. */
  workshopIds: string[];
}

/**
 * Safety net (plan §1.2): every 5 minutes, TICK each workshop whose `nextDueAt` has passed.
 * In normal operation the per-offer timers already did the work and these ticks are no-ops;
 * the worker reports `SweepLateExpiries` when one of them actually expires an offer.
 */
export async function runSweep(ports: SweepPorts): Promise<SweepResult> {
  const now = ports.clock.now();
  const due = await ports.store.listDueWorkshops(now);
  const workshopIds: string[] = [];
  for (const workshop of due) {
    await ports.queue.enqueue(sweepTick(workshop.id));
    workshopIds.push(workshop.id);
  }
  ports.logger.info('sweep completed', { now, ticked: workshopIds.length });
  return { now, workshopIds };
}
