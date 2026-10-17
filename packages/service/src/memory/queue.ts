import type { Command, TickCommand } from '@seatrelay/contracts';
import { parseIso, type OfferTimer } from '@seatrelay/core';
import { commandDedupId, tickForTimer } from '../commands';
import type { CommandQueue, TimerScheduler } from '../ports';

/**
 * In-memory FIFO. Messages are stored in arrival order; a single consumer (the test harness)
 * processes them one at a time, which is exactly the per-workshop ordering the real queue
 * guarantees. Like SQS FIFO, a message whose dedup id was already accepted is dropped
 * (`deduplicated` counts them); the deduplication window is unbounded here.
 * `failNextEnqueue` makes the next `enqueue` throw (503 path tests).
 */
export class InMemoryCommandQueue implements CommandQueue {
  readonly messages: Command[] = [];
  private readonly dedupIds = new Set<string>();
  failNextEnqueue = false;
  enqueued = 0;
  deduplicated = 0;

  async enqueue(command: Command): Promise<void> {
    if (this.failNextEnqueue) {
      this.failNextEnqueue = false;
      throw new Error('injected queue failure');
    }
    const dedupId = commandDedupId(command);
    if (dedupId !== undefined) {
      if (this.dedupIds.has(dedupId)) {
        this.deduplicated += 1;
        return;
      }
      this.dedupIds.add(dedupId);
    }
    this.enqueued += 1;
    this.messages.push(structuredClone(command));
  }

  dequeue(): Command | undefined {
    return this.messages.shift();
  }

  get size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export interface ScheduledTimer {
  wsId: string;
  timer: OfferTimer;
}

/**
 * Records every scheduled expiry timer. `dueTicks(now)` removes the timers that have fired
 * and returns the TICKs the expiry forwarder would enqueue for them.
 */
export class InMemoryTimerScheduler implements TimerScheduler {
  readonly pending: ScheduledTimer[] = [];
  readonly scheduled: ScheduledTimer[] = [];
  failNextSchedule = false;

  async schedule(wsId: string, timers: readonly OfferTimer[]): Promise<void> {
    if (this.failNextSchedule) {
      this.failNextSchedule = false;
      throw new Error('injected timer failure');
    }
    for (const timer of timers) {
      const entry = { wsId, timer: { ...timer } };
      this.pending.push(entry);
      this.scheduled.push(entry);
    }
  }

  dueTicks(now: string): TickCommand[] {
    const nowMs = parseIso(now);
    const due: TickCommand[] = [];
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const entry = this.pending[i];
      if (entry !== undefined && parseIso(entry.timer.expiresAt) <= nowMs) {
        due.unshift(tickForTimer(entry.wsId, entry.timer));
        this.pending.splice(i, 1);
      }
    }
    return due;
  }
}
