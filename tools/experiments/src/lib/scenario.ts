import { setTimeout as sleepMs } from 'node:timers/promises';
import type {
  CreateWorkshopInput,
  DashboardView,
  Organization,
  RegistrationSummary,
  SessionView,
  VerifyView,
  WorkshopMode,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import {
  CommandRejectedError,
  HOUR_MS,
  findOrCreateOrg,
  type ApiClient,
  type SettledCommand,
} from '@seatrelay/scripts';
import type { Account } from './accounts';

/**
 * Scenario building blocks shared by the experiment scripts: workshops are created through the
 * public API exactly like the browser does, state is only ever read back through the routes,
 * and the invariant counters (over-capacity, double holds) are computed from the organiser
 * dashboard, independently of the server's own `verify`.
 */

export interface SessionSpec {
  title?: string;
  capacity: number;
  /** Start offset from now (default: 24 h + 2 h × index). */
  startsInMs?: number;
}

export interface WorkshopSpec {
  title: string;
  holdSeconds: number;
  mode?: WorkshopMode;
  sessions: readonly SessionSpec[];
}

export interface CreatedWorkshop {
  orgId: string;
  wsId: string;
  sessions: SessionView[];
  /** In creation order (the dashboard sorts by start time, which is the same order here). */
  sessionIds: string[];
  holdSeconds: number;
  view: WorkshopPublicView;
}

export function workshopInput(spec: WorkshopSpec, now: number = Date.now()): CreateWorkshopInput {
  return {
    title: spec.title,
    mode: spec.mode ?? 'UNIFIED',
    holdSeconds: spec.holdSeconds,
    sessions: spec.sessions.map((session, index) => ({
      title: session.title ?? `S${index + 1}`,
      startsAt: new Date(now + (session.startsInMs ?? 24 * HOUR_MS + index * 2 * HOUR_MS)).toISOString(),
      capacity: session.capacity,
    })),
  };
}

export async function createWorkshop(
  organiser: Account,
  orgId: string,
  spec: WorkshopSpec,
): Promise<CreatedWorkshop> {
  const view = await organiser.client.createWorkshop(orgId, workshopInput(spec));
  const sessions = [...view.sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || (a.id < b.id ? -1 : 1));
  return {
    orgId,
    wsId: view.workshop.id,
    sessions,
    sessionIds: sessions.map((session) => session.id),
    holdSeconds: view.workshop.holdSeconds,
    view,
  };
}

/** The organiser's organisation with that name, created when missing. */
export async function ensureOrganisation(organiser: Account, name: string): Promise<Organization> {
  const { organization } = await findOrCreateOrg(organiser.client, name);
  return organization;
}

export function registrationOf(settled: SettledCommand): RegistrationSummary | undefined {
  return settled.record.result?.registration;
}

/** The registration summary a settled command must carry (throws otherwise). */
export function requireRegistration(settled: SettledCommand, context: string): RegistrationSummary {
  if (settled.record.status !== 'APPLIED') {
    throw new CommandRejectedError(settled.record, context);
  }
  const registration = registrationOf(settled);
  if (registration === undefined) {
    throw new Error(`${context}: command ${settled.commandId} settled without a registration`);
  }
  return registration;
}

/** The caller's live registration in the workshop (public view `me`). */
export async function myRegistration(
  account: Account,
  wsId: string,
): Promise<RegistrationSummary | undefined> {
  const view = await account.client.getWorkshop(wsId);
  return view.me;
}

export function sleep(ms: number): Promise<void> {
  return sleepMs(Math.max(0, ms));
}

/** Resolves at the given epoch-ms instant (immediately when it has passed). */
export function sleepUntil(epochMs: number, now: () => number = () => Date.now()): Promise<void> {
  return sleep(epochMs - now());
}

export class WaitTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms waiting for ${what}`);
    this.name = 'WaitTimeoutError';
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls `probe` until it returns a value; `undefined` means "not yet". */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  options: WaitOptions,
): Promise<T> {
  const now = options.now ?? (() => Date.now());
  const pause = options.sleep ?? sleep;
  const interval = options.intervalMs ?? 500;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (now() >= deadline) {
      throw new WaitTimeoutError(what, options.timeoutMs);
    }
    await pause(Math.min(interval, Math.max(0, deadline - now())));
  }
}

export interface ClockOffset {
  /** `serverNow − clientNow` in ms (positive: the server clock is ahead). */
  offsetMs: number;
  rttMs: number;
  samples: number;
}

/**
 * Estimates the server clock relative to this process from `GET /health` (`time` is the
 * server's own clock), NTP-style: the sample with the smallest round trip wins.
 */
export async function serverClockOffset(client: ApiClient, samples = 5): Promise<ClockOffset> {
  let best: ClockOffset | undefined;
  for (let i = 0; i < samples; i += 1) {
    const sent = Date.now();
    const health = await client.health();
    const received = Date.now();
    const rttMs = received - sent;
    const offsetMs = Date.parse(health.time) - (sent + rttMs / 2);
    if (best === undefined || rttMs < best.rttMs) {
      best = { offsetMs, rttMs, samples };
    }
  }
  return best as ClockOffset;
}

/** Sessions whose `confirmed + held` exceeds `capacity` (C1). */
export function overCapacity(sessions: readonly SessionView[]): number {
  return sessions.filter((session) => session.confirmed + session.held > session.capacity).length;
}

/** Users holding more than one OFFERED/CONFIRMED seat in the workshop (C2, UNIFIED mode). */
export function doubleHolds(dashboard: DashboardView): number {
  const holds = new Map<string, number>();
  for (const entry of [...dashboard.offered, ...dashboard.confirmed]) {
    holds.set(entry.userId, (holds.get(entry.userId) ?? 0) + 1);
  }
  let users = 0;
  for (const count of holds.values()) {
    if (count > 1) {
      users += 1;
    }
  }
  return users;
}

export interface InvariantSnapshot {
  verify: VerifyView;
  dashboard: DashboardView;
  overCapacity: number;
  doubleHolds: number;
  ok: boolean;
}

/** `verify` plus the client-side counters, read in one go. */
export async function invariantSnapshot(
  organiser: Account,
  orgId: string,
  wsId: string,
): Promise<InvariantSnapshot> {
  const [verify, dashboard] = await Promise.all([
    organiser.client.verify(orgId, wsId),
    organiser.client.dashboard(orgId, wsId),
  ]);
  const over = overCapacity(dashboard.sessions);
  const doubles = dashboard.workshop.mode === 'UNIFIED' ? doubleHolds(dashboard) : 0;
  return {
    verify,
    dashboard,
    overCapacity: over,
    doubleHolds: doubles,
    ok: verify.ok && over === 0 && doubles === 0,
  };
}

/** Deterministic PRNG (mulberry32) so that "random" preference lists are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** A non-empty preference list: a random permutation of a random non-empty subset. */
export function randomPreferences(sessionIds: readonly string[], random: () => number): string[] {
  const order = shuffle(sessionIds, random);
  const size = 1 + Math.floor(random() * order.length);
  return order.slice(0, size);
}

export function describeSettled(settled: SettledCommand): string {
  const { record } = settled;
  const registration = record.result?.registration;
  const state =
    registration === undefined
      ? ''
      : ` ${registration.status}${registration.currentOffer === undefined ? '' : `@${registration.currentOffer.sessionId}`}${registration.queuePosition === undefined ? '' : `#${registration.queuePosition}`}`;
  return `${record.type} → ${record.status}${record.reason === undefined ? '' : `(${record.reason})`}${state} [${settled.settleMs} ms]`;
}

export interface LatencySample {
  run: number;
  step: string;
  type: string;
  status: string;
  reason: string;
  acceptMs: number;
  settleMs: number;
  serverSettleMs: number | undefined;
  polls: number;
  [extra: string]: string | number | boolean | undefined;
}

/** One raw.csv row per settled command (client- and server-side settle latency, plan §1.3). */
export function latencySample(
  run: number,
  step: string,
  settled: SettledCommand,
  extra: Record<string, string | number | boolean | undefined> = {},
): LatencySample {
  return {
    run,
    step,
    type: settled.record.type,
    status: settled.record.status,
    reason: settled.record.reason ?? '',
    acceptMs: settled.acceptMs,
    settleMs: settled.settleMs,
    serverSettleMs: settled.serverSettleMs,
    polls: settled.polls,
    ...extra,
  };
}
