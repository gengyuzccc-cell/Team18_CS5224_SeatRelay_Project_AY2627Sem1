import type {
  Command,
  Offer,
  Registration,
  Session,
  Workshop,
  WorkshopMode,
} from '@seatrelay/contracts';
import { expect } from 'vitest';
import {
  addMinutes,
  applyChanges,
  checkInvariants,
  decide,
  newSession,
  newWorkshop,
  type DecideContext,
  type Decision,
  type DecisionLimits,
  type WorkshopSnapshot,
} from '../src/index';

export const T0 = '2026-11-03T06:00:00.000Z';
export const WS = 'ws1';
export const UUID = '8f0d2a7e-6f4b-4a7c-9c1e-2a3b4c5d6e7f';

export function at(minutesAfterT0: number): string {
  return addMinutes(T0, minutesAfterT0);
}

export interface SessionSpec {
  id: string;
  capacity?: number;
  /** minutes after T0; cutoff is 30 min earlier */
  startsInMinutes?: number;
  title?: string;
}

export function makeSession(spec: SessionSpec): Session {
  return newSession({
    id: spec.id,
    workshopId: WS,
    title: spec.title ?? `Session ${spec.id}`,
    startsAt: at(spec.startsInMinutes ?? 24 * 60),
    capacity: spec.capacity ?? 1,
  });
}

export interface SnapshotSpec {
  mode?: WorkshopMode;
  holdSeconds?: number;
  sessions?: SessionSpec[];
  workshop?: Partial<Workshop>;
}

export function makeSnapshot(spec: SnapshotSpec = {}): WorkshopSnapshot {
  const workshop = {
    ...newWorkshop({
      id: WS,
      orgId: 'org1',
      title: 'Intro to Git',
      mode: spec.mode ?? 'UNIFIED',
      holdSeconds: spec.holdSeconds ?? 600,
      createdAt: T0,
    }),
    ...spec.workshop,
  };
  const sessions = (spec.sessions ?? [{ id: 'A' }, { id: 'B' }]).map(makeSession);
  return { workshop, sessions, registrations: [], offers: [], pendingBackfills: [] };
}

let globalIdCounter = 0;

/**
 * Deterministic ids. By default every ctx continues a module-wide counter so ids are unique
 * across decisions (as UUIDs are in production); pass `start` for a reproducible sequence.
 */
export function makeCtx(
  now: string,
  limits?: Partial<DecisionLimits>,
  start?: number,
): DecideContext {
  let counter = start;
  const ctx: DecideContext = {
    now,
    newId: () => (counter === undefined ? `id-${++globalIdCounter}` : `id-${start}-${++counter}`),
  };
  if (limits !== undefined) {
    ctx.limits = limits;
  }
  return ctx;
}

export const user = (n: number | string) => `u${n}`;
export const email = (n: number | string) => `u${n}@example.com`;

const actor = (n: number | string) => ({
  commandId: UUID,
  workshopId: WS,
  actorUserId: user(n),
  actorEmail: email(n),
});

export const cmd = {
  register: (n: number | string, acceptable: string[]): Command => ({
    type: 'REGISTER',
    ...actor(n),
    acceptable,
  }),
  accept: (n: number | string, offerId: string): Command => ({
    type: 'ACCEPT_OFFER',
    ...actor(n),
    offerId,
  }),
  decline: (n: number | string, offerId: string): Command => ({
    type: 'DECLINE_OFFER',
    ...actor(n),
    offerId,
  }),
  cancel: (n: number | string, sessionId?: string): Command => ({
    type: 'CANCEL_REGISTRATION',
    ...actor(n),
    ...(sessionId === undefined ? {} : { sessionId }),
  }),
  setCapacity: (sessionId: string, capacity: number): Command => ({
    type: 'SET_CAPACITY',
    ...actor('org'),
    sessionId,
    capacity,
  }),
  cancelSession: (sessionId: string): Command => ({
    type: 'CANCEL_SESSION',
    ...actor('org'),
    sessionId,
  }),
  cancelWorkshop: (): Command => ({ type: 'CANCEL_WORKSHOP', ...actor('org') }),
  close: (): Command => ({ type: 'CLOSE_REGISTRATION', ...actor('org') }),
  open: (): Command => ({ type: 'OPEN_REGISTRATION', ...actor('org') }),
  tick: (source?: 'TIMER' | 'SWEEP'): Command => ({
    type: 'TICK',
    workshopId: WS,
    ...(source === undefined ? {} : { source }),
  }),
  reallocate: (): Command => ({ type: 'REALLOCATE', workshopId: WS }),
};

export interface StepResult {
  decision: Decision;
  snapshot: WorkshopSnapshot;
}

/**
 * Runs one command (asserting purity) and applies its writes. Does NOT run continuations.
 * Like the service does for ACCEPT/DECLINE (one point read of `H#O#{offerId}`), the next
 * snapshot carries the archived offers as `settledOffers`, here simply all of them.
 */
export function step(
  snapshot: WorkshopSnapshot,
  command: Command,
  now: string,
  limits?: Partial<DecisionLimits>,
): StepResult {
  const frozen = structuredClone(snapshot);
  const decision = decide(snapshot, command, makeCtx(now, limits));
  expect(snapshot).toStrictEqual(frozen);
  const next = applyChanges(snapshot, decision.writes);
  const settled = [
    ...(snapshot.settledOffers ?? []),
    ...decision.writes.flatMap((write) => (write.kind === 'ARCHIVE_OFFER' ? [write.offer] : [])),
  ];
  if (settled.length > 0) {
    next.settledOffers = settled;
  }
  return { decision, snapshot: next };
}

/** Runs a command and every continuation it spawns; asserts invariants afterwards. */
export function run(
  snapshot: WorkshopSnapshot,
  command: Command,
  now: string,
  limits?: Partial<DecisionLimits>,
): StepResult & { decisions: Decision[] } {
  const decisions: Decision[] = [];
  let current = step(snapshot, command, now, limits);
  decisions.push(current.decision);
  let guard = 0;
  while (current.decision.continuation !== undefined) {
    if (++guard > 200) {
      throw new Error('continuation did not converge');
    }
    current = step(current.snapshot, current.decision.continuation, now, limits);
    decisions.push(current.decision);
  }
  const report = checkInvariants(current.snapshot, now);
  expect(report.violations).toEqual([]);
  return { ...current, decisions };
}

/** Convenience: registers users 1..n with the same preference list at `now`. */
export function registerMany(
  snapshot: WorkshopSnapshot,
  users: (number | string)[],
  acceptable: string[],
  now: string,
): WorkshopSnapshot {
  let current = snapshot;
  for (const n of users) {
    current = run(current, cmd.register(n, acceptable), now).snapshot;
  }
  return current;
}

export function regOf(snapshot: WorkshopSnapshot, n: number | string): Registration | undefined {
  return snapshot.registrations.find((registration) => registration.userId === user(n));
}

export function offerOf(snapshot: WorkshopSnapshot, n: number | string): Offer | undefined {
  return snapshot.offers.find((offer) => offer.userId === user(n));
}

export function sessionOf(snapshot: WorkshopSnapshot, id: string): Session {
  const session = snapshot.sessions.find((candidate) => candidate.id === id);
  if (session === undefined) {
    throw new Error(`no session ${id}`);
  }
  return session;
}

export function writesOfKind(decision: Decision, kind: string): number {
  return decision.writes.filter((write) => write.kind === kind).length;
}

/**
 * Invariants that must hold between the decisions of a continuation chain: everything but
 * no-starvation, which is only guaranteed once the chain is done.
 */
export function expectHardInvariants(snapshot: WorkshopSnapshot, now: string): void {
  const report = checkInvariants(snapshot, now);
  expect(report.violations.filter((v) => v.code !== 'NO_STARVATION')).toEqual([]);
}

/** Number of writes per kind, for compact assertions on big decisions. */
export function writeHistogram(decision: Decision): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const write of decision.writes) {
    histogram[write.kind] = (histogram[write.kind] ?? 0) + 1;
  }
  return histogram;
}
