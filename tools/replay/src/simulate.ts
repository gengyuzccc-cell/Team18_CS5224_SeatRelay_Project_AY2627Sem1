import type {
  Command,
  Registration,
  TickSource,
  UserCommand,
  WorkshopMode,
} from '@seatrelay/contracts';
import {
  checkInvariants,
  cloneSnapshot,
  decide,
  newSession,
  newWorkshop,
  parseIso,
  toIso,
  type Decision,
  type DecisionLimits,
  type WorkshopSnapshot,
} from '@seatrelay/core';
import type { OfferReaction, Participant, Scenario, ScenarioSession } from './generator';
import { MetricsCollector, type RunMetrics, type RunSamples } from './metrics';
import { applyChangesInPlace } from './store';

/**
 * Discrete-event replay of one scenario under one mode (plan §2.2 "baseline = same engine +
 * per-session allocator, replayed under a simulated clock"). Every state change goes through
 * `decide()` and the engine's `Change[]` is applied to the live snapshot by `store.ts` (the
 * in-place equivalent of `applyChanges()`); the loop only turns the pre-drawn behaviour stream
 * into commands at the right simulated instants and feeds the engine's own timers back as TICKs:
 *
 *  - ARRIVE: REGISTER (UNIFIED: one registration with the full preference list; PER_SESSION:
 *    one registration per acceptable session, the way people use per-session forms);
 *  - OFFER notification → ACCEPT/DECLINE after the participant's delay, or nothing (expiry);
 *  - every `decision.timers[]` entry and every `workshop.nextDueAt` → a TICK at that instant;
 *  - each session's cut-off → a TICK (the sweep) and the "seats wasted" reading;
 *  - CONFIRMED → optional later cancellation; in PER_SESSION also the optional clean-up of the
 *    participant's other registrations, and a second offer meets the "secondary" reaction.
 *
 * The run ends at the latest cut-off. It is deterministic: no randomness, no wall clock.
 */

export const WORKSHOP_ID = 'ws-replay';
export const ORG_ID = 'org-replay';

export interface StepContext {
  command: Command;
  decision: Decision;
  /** Deep copy of the snapshot the decision was made against (only taken for observers). */
  before: WorkshopSnapshot;
  after: WorkshopSnapshot;
  now: string;
}

export interface SimulateOptions {
  /** Observed after every decision, continuations included. */
  onStep?: (step: StepContext) => void;
  /** Run `checkInvariants` after every decision and count violations (slow; tests/`--check`). */
  checkInvariants?: boolean;
  limits?: Partial<DecisionLimits>;
}

export interface SimulationResult {
  seed: number;
  mode: WorkshopMode;
  metrics: RunMetrics;
  samples: RunSamples;
  /** Live state at the end of the run (after the last cut-off). */
  snapshot: WorkshopSnapshot;
  /** Commands issued, by type. */
  commands: Record<string, number>;
  /** Rejected commands, by reason. */
  rejections: Record<string, number>;
  events: number;
}

type CancelCause = 'LIFE' | 'ABANDON' | 'CLEANUP';

type SimEvent =
  | { kind: 'ARRIVE'; user: number }
  | { kind: 'RESPOND'; user: number; offerId: string; action: Exclude<OfferReaction, 'IGNORE'> }
  | { kind: 'TICK'; source: TickSource; offerId?: string; expiresAt?: string }
  | { kind: 'CANCEL'; user: number; cause: CancelCause }
  | { kind: 'CUTOFF'; sessionId: string };

interface Scheduled {
  at: number;
  seq: number;
  event: SimEvent;
}

/** Binary min-heap on (at, seq): same-instant events run in scheduling order. */
class EventQueue {
  private readonly heap: Scheduled[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(at: number, event: SimEvent): void {
    const item: Scheduled = { at, seq: this.seq++, event };
    const heap = this.heap;
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (EventQueue.before(heap[parent]!, item)) {
        break;
      }
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = item;
  }

  pop(): Scheduled | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) {
      return undefined;
    }
    const last = heap.pop()!;
    if (heap.length > 0) {
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        let candidate = last;
        if (left < heap.length && EventQueue.before(heap[left]!, candidate)) {
          smallest = left;
          candidate = heap[left]!;
        }
        if (right < heap.length && EventQueue.before(heap[right]!, candidate)) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        heap[index] = heap[smallest]!;
        index = smallest;
      }
      heap[index] = last;
    }
    return top;
  }

  private static before(a: Scheduled, b: Scheduled): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
}

interface UserState {
  firstConfirmedSession?: string;
}

export function buildSnapshot(scenario: Scenario, mode: WorkshopMode): WorkshopSnapshot {
  const workshop = newWorkshop({
    id: WORKSHOP_ID,
    orgId: ORG_ID,
    title: `Replay seed ${scenario.seed}`,
    description: `mode ${mode}`,
    mode,
    holdSeconds: scenario.params.holdSeconds,
    createdAt: scenario.openedAt,
  });
  const sessions = scenario.sessions.map((session) =>
    newSession({
      id: session.id,
      workshopId: WORKSHOP_ID,
      title: session.title,
      startsAt: session.startsAt,
      capacity: session.capacity,
    }),
  );
  return { workshop, sessions, registrations: [], offers: [] };
}

class Simulation {
  private snapshot: WorkshopSnapshot;
  private nowMs: number;
  private now: string;
  private readonly endMs: number;
  private readonly queue = new EventQueue();
  private readonly scheduledTicks = new Set<number>();
  private readonly participants: readonly Participant[];
  private readonly userIndex = new Map<string, number>();
  private readonly users: UserState[];
  private readonly sessionById = new Map<string, ScenarioSession>();
  private readonly metrics: MetricsCollector;
  private idCounter = 0;
  private commandCounter = 0;
  private readonly commands: Record<string, number> = {};
  private readonly rejections: Record<string, number> = {};
  private events = 0;

  constructor(
    private readonly scenario: Scenario,
    private readonly mode: WorkshopMode,
    private readonly options: SimulateOptions,
  ) {
    this.snapshot = buildSnapshot(scenario, mode);
    this.nowMs = parseIso(scenario.openedAt);
    this.now = scenario.openedAt;
    this.endMs = parseIso(scenario.endsAt);
    this.participants = scenario.participants;
    this.users = scenario.participants.map(() => ({}));
    this.metrics = new MetricsCollector(scenario, this.nowMs);
    scenario.participants.forEach((participant, index) => {
      this.userIndex.set(participant.userId, index);
      this.queue.push(parseIso(participant.arrivalAt), { kind: 'ARRIVE', user: index });
    });
    for (const session of scenario.sessions) {
      this.sessionById.set(session.id, session);
      this.queue.push(parseIso(session.cutoffAt), { kind: 'CUTOFF', sessionId: session.id });
    }
  }

  run(): SimulationResult {
    for (;;) {
      const next = this.queue.pop();
      if (next === undefined || next.at > this.endMs) {
        break;
      }
      if (next.at < this.nowMs) {
        throw new Error(`event scheduled in the past: ${toIso(next.at)} < ${this.now}`);
      }
      this.nowMs = next.at;
      this.now = toIso(next.at);
      this.events += 1;
      this.handle(next.event);
    }
    const final = checkInvariants(this.snapshot, toIso(this.endMs));
    this.metrics.addInvariantViolations(final.violations.length);
    const { metrics, samples } = this.metrics.finish(this.snapshot, this.endMs);
    return {
      seed: this.scenario.seed,
      mode: this.mode,
      metrics,
      samples,
      snapshot: this.snapshot,
      commands: this.commands,
      rejections: this.rejections,
      events: this.events,
    };
  }

  /* ---------- events ---------- */

  private handle(event: SimEvent): void {
    switch (event.kind) {
      case 'ARRIVE':
        this.arrive(event.user);
        break;
      case 'RESPOND':
        this.respond(event.user, event.offerId, event.action);
        break;
      case 'TICK':
        this.issue({
          type: 'TICK',
          workshopId: WORKSHOP_ID,
          source: event.source,
          ...(event.offerId === undefined ? {} : { offerId: event.offerId }),
          ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
        });
        break;
      case 'CANCEL':
        this.cancel(event.user, event.cause);
        break;
      case 'CUTOFF': {
        this.issue({ type: 'TICK', workshopId: WORKSHOP_ID, source: 'SWEEP' });
        const session = this.snapshot.sessions.find(
          (candidate) => candidate.id === event.sessionId,
        );
        if (session !== undefined) {
          this.metrics.recordCutoff(session);
        }
        break;
      }
    }
  }

  private arrive(user: number): void {
    const participant = this.participants[user]!;
    if (this.mode === 'UNIFIED') {
      this.issue(
        this.userCommand(participant, { type: 'REGISTER', acceptable: participant.preferences }),
      );
    } else {
      for (const sessionId of participant.preferences) {
        this.issue(this.userCommand(participant, { type: 'REGISTER', acceptable: [sessionId] }));
      }
    }
    if (participant.abandons) {
      this.queue.push(this.nowMs + participant.abandonAfterMs, {
        kind: 'CANCEL',
        user,
        cause: 'ABANDON',
      });
    }
  }

  private respond(user: number, offerId: string, action: 'ACCEPT' | 'DECLINE'): void {
    if (!this.snapshot.offers.some((offer) => offer.id === offerId)) {
      return; // already expired, revoked or settled: nothing to answer
    }
    const participant = this.participants[user]!;
    this.issue(
      this.userCommand(participant, {
        type: action === 'ACCEPT' ? 'ACCEPT_OFFER' : 'DECLINE_OFFER',
        offerId,
      }),
    );
  }

  private cancel(user: number, cause: CancelCause): void {
    const participant = this.participants[user]!;
    const mine = this.liveRegistrationsOf(participant.userId);
    if (mine.length === 0) {
      return;
    }
    const holdsSeat = mine.some(
      (registration) => registration.status === 'OFFERED' || registration.status === 'CONFIRMED',
    );
    switch (cause) {
      case 'LIFE':
        // Can no longer attend: leave the workshop entirely (every registration, R6).
        this.issue(this.userCommand(participant, { type: 'CANCEL_REGISTRATION' }));
        return;
      case 'ABANDON':
        if (!holdsSeat) {
          this.issue(this.userCommand(participant, { type: 'CANCEL_REGISTRATION' }));
        }
        return;
      case 'CLEANUP': {
        const keep = this.users[user]!.firstConfirmedSession;
        const stillConfirmed = mine.some(
          (registration) =>
            registration.status === 'CONFIRMED' && registration.confirmedSessionId === keep,
        );
        if (keep === undefined || !stillConfirmed) {
          return;
        }
        for (const registration of mine) {
          const sessionId = registration.acceptable[0];
          if (sessionId !== undefined && sessionId !== keep) {
            this.issue(this.userCommand(participant, { type: 'CANCEL_REGISTRATION', sessionId }));
          }
        }
        return;
      }
    }
  }

  /* ---------- engine ---------- */

  private issue(command: Command): void {
    this.commands[command.type] = (this.commands[command.type] ?? 0) + 1;
    let current = command;
    let guard = 0;
    for (;;) {
      const before = this.options.onStep === undefined ? undefined : cloneSnapshot(this.snapshot);
      const decision = decide(this.snapshot, current, {
        now: this.now,
        newId: () => `id${++this.idCounter}`,
        ...(this.options.limits === undefined ? {} : { limits: this.options.limits }),
      });
      const after = applyChangesInPlace(this.snapshot, decision.writes);
      this.snapshot = after;
      if (decision.status === 'REJECTED') {
        const reason = decision.reason ?? 'UNKNOWN';
        this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
      }
      this.metrics.observe(current, decision, after, this.nowMs);
      if (this.options.checkInvariants) {
        this.metrics.addInvariantViolations(checkInvariants(after, this.now).violations.length);
      }
      this.react(decision, after);
      if (before !== undefined) {
        this.options.onStep?.({ command: current, decision, before, after, now: this.now });
      }
      if (decision.continuation === undefined) {
        break;
      }
      current = decision.continuation;
      this.commands[current.type] = (this.commands[current.type] ?? 0) + 1;
      if (++guard > 10_000) {
        throw new Error('continuation chain did not converge');
      }
    }
  }

  /** Turns a decision's timers and notifications into future events. */
  private react(decision: Decision, after: WorkshopSnapshot): void {
    for (const timer of decision.timers) {
      this.scheduleTick(parseIso(timer.expiresAt), 'TIMER', timer.offerId, timer.expiresAt);
    }
    const offers = decision.notifications.filter((note) => note.kind === 'OFFER');
    offers.forEach((note, position) => {
      const offer = after.offers.find((candidate) => candidate.id === note.offerId);
      const user = this.userIndex.get(note.userId);
      if (offer === undefined || user === undefined) {
        return;
      }
      const participant = this.participants[user]!;
      const response = participant.responses[offer.sessionId];
      if (response === undefined) {
        return; // never offered a session outside the preference list (R3)
      }
      // Offers made to the same user later in this decision are not yet "held" from the
      // participant's point of view: the first offer they get is the one they react to first.
      const laterSessions = new Set<string>();
      for (const later of offers.slice(position + 1)) {
        if (later.userId === note.userId) {
          const sessionId = after.offers.find(
            (candidate) => candidate.id === later.offerId,
          )?.sessionId;
          if (sessionId !== undefined) {
            laterSessions.add(sessionId);
          }
        }
      }
      const holdsElsewhere = this.heldSessions(after, note.userId).some(
        (sessionId) => sessionId !== offer.sessionId && !laterSessions.has(sessionId),
      );
      const reaction = holdsElsewhere ? participant.secondaryReaction : response.reaction;
      if (reaction === 'IGNORE') {
        return;
      }
      const respondAt = this.nowMs + response.delayMs;
      if (respondAt >= parseIso(offer.expiresAt)) {
        return; // too late: the hold lapses before the answer (ACCEPT would be OFFER_EXPIRED)
      }
      this.queue.push(respondAt, { kind: 'RESPOND', user, offerId: offer.id, action: reaction });
    });

    for (const note of decision.notifications) {
      if (note.kind !== 'CONFIRMED') {
        continue;
      }
      const user = this.userIndex.get(note.userId);
      const archived = decision.writes.find(
        (write) => write.kind === 'ARCHIVE_OFFER' && write.offer.id === note.offerId,
      );
      if (user === undefined || archived === undefined || archived.kind !== 'ARCHIVE_OFFER') {
        continue;
      }
      const state = this.users[user]!;
      if (state.firstConfirmedSession !== undefined) {
        continue; // a second (duplicate) confirmation changes nothing in the behaviour stream
      }
      const sessionId = archived.offer.sessionId;
      state.firstConfirmedSession = sessionId;
      const participant = this.participants[user]!;
      if (participant.cancels) {
        const cutoffMs = parseIso(this.sessionById.get(sessionId)!.cutoffAt);
        const at = this.nowMs + Math.round(participant.cancelFraction * (cutoffMs - this.nowMs));
        if (at > this.nowMs) {
          this.queue.push(at, { kind: 'CANCEL', user, cause: 'LIFE' });
        }
      }
      if (this.mode === 'PER_SESSION' && participant.cleansUp) {
        this.queue.push(this.nowMs + participant.cleanupDelayMs, {
          kind: 'CANCEL',
          user,
          cause: 'CLEANUP',
        });
      }
    }

    if (after.workshop.nextDueAt !== undefined) {
      this.scheduleTick(parseIso(after.workshop.nextDueAt), 'SWEEP');
    }
  }

  /** One TICK per instant is enough: tick-first expires everything due at once. */
  private scheduleTick(at: number, source: TickSource, offerId?: string, expiresAt?: string): void {
    if (at > this.endMs || this.scheduledTicks.has(at)) {
      return;
    }
    this.scheduledTicks.add(at);
    this.queue.push(at, {
      kind: 'TICK',
      source,
      ...(offerId === undefined ? {} : { offerId }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }

  /* ---------- helpers ---------- */

  private liveRegistrationsOf(userId: string): Registration[] {
    return this.snapshot.registrations.filter((registration) => registration.userId === userId);
  }

  /** Sessions in which the user currently holds a seat (OFFERED or CONFIRMED). */
  private heldSessions(snapshot: WorkshopSnapshot, userId: string): string[] {
    const held: string[] = [];
    for (const registration of snapshot.registrations) {
      if (registration.userId !== userId) {
        continue;
      }
      if (registration.status === 'CONFIRMED' && registration.confirmedSessionId !== undefined) {
        held.push(registration.confirmedSessionId);
      } else if (registration.status === 'OFFERED') {
        const offer = snapshot.offers.find(
          (candidate) => candidate.id === registration.currentOfferId,
        );
        if (offer !== undefined) {
          held.push(offer.sessionId);
        }
      }
    }
    return held;
  }

  private userCommand(
    participant: Participant,
    payload:
      | { type: 'REGISTER'; acceptable: string[] }
      | { type: 'ACCEPT_OFFER'; offerId: string }
      | { type: 'DECLINE_OFFER'; offerId: string }
      | { type: 'CANCEL_REGISTRATION'; sessionId?: string },
  ): UserCommand {
    this.commandCounter += 1;
    const commandId = `00000000-0000-4000-8000-${String(this.commandCounter).padStart(12, '0')}`;
    const actor = {
      commandId,
      workshopId: WORKSHOP_ID,
      actorUserId: participant.userId,
      actorEmail: participant.email,
    };
    switch (payload.type) {
      case 'REGISTER':
        return { ...actor, type: 'REGISTER', acceptable: [...payload.acceptable] };
      case 'ACCEPT_OFFER':
        return { ...actor, type: 'ACCEPT_OFFER', offerId: payload.offerId };
      case 'DECLINE_OFFER':
        return { ...actor, type: 'DECLINE_OFFER', offerId: payload.offerId };
      case 'CANCEL_REGISTRATION':
        return payload.sessionId === undefined
          ? { ...actor, type: 'CANCEL_REGISTRATION' }
          : { ...actor, type: 'CANCEL_REGISTRATION', sessionId: payload.sessionId };
    }
  }
}

export function simulate(
  scenario: Scenario,
  mode: WorkshopMode,
  options: SimulateOptions = {},
): SimulationResult {
  return new Simulation(scenario, mode, options).run();
}

/** Both modes of one seed, in a fixed order. */
export function simulateBoth(
  scenario: Scenario,
  options: SimulateOptions = {},
): { unified: SimulationResult; perSession: SimulationResult } {
  return {
    unified: simulate(scenario, 'UNIFIED', options),
    perSession: simulate(scenario, 'PER_SESSION', options),
  };
}
