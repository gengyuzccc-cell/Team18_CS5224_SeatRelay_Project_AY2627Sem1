import type { CreateWorkshopInput, RegistrationSummary } from '@seatrelay/contracts';
import type { ApiClient } from './api';
import { DAY_MS, HOUR_MS, isoFromNow } from './cli';
import { findOrCreateOrg, registerAny, type SeedLogger } from './seed';
import { provisionUsers, type ProvisionedUser, type UserProvider, type UserSpec } from './users';

/**
 * The demo preset (docs/DEMO.md): one organisation, one workshop with three sessions of
 * capacity 2 / 2 / 1 and a short hold (60 s by default so an expiry can be shown live), and
 * N participants registered with varied preference lists.
 */

export const DEMO_SESSIONS = [
  { title: 'Session 1', capacity: 2, offsetMs: 0 },
  { title: 'Session 2', capacity: 2, offsetMs: 4 * HOUR_MS },
  { title: 'Session 3', capacity: 1, offsetMs: DAY_MS + 4 * HOUR_MS },
] as const;

const PREFERENCE_PATTERNS: readonly (readonly number[])[] = [
  [0, 1, 2],
  [1, 2],
  [2, 0],
  [0],
  [1, 0, 2],
  [2],
];

/** `3` → demo.p1 … demo.p3@example.com; `a@x,b@y` → those accounts. */
export function demoParticipants(spec: string, password: string): UserSpec[] {
  const trimmed = spec.trim();
  if (/^\d+$/.test(trimmed)) {
    const count = Number(trimmed);
    return Array.from({ length: count }, (_, i) => ({
      email: `demo.p${i + 1}@example.com`,
      name: `Demo Participant ${i + 1}`,
      password,
    }));
  }
  return trimmed
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0)
    .map((email) => ({ email, password }));
}

/** Preference list of participant `index` (cycles through six patterns). */
export function demoPreferences(index: number, sessionIds: readonly string[]): string[] {
  const pattern = PREFERENCE_PATTERNS[index % PREFERENCE_PATTERNS.length] as readonly number[];
  return pattern.map((i) => sessionIds[i]).filter((id): id is string => id !== undefined);
}

export interface SeedDemoOptions {
  api: ApiClient;
  provider: UserProvider;
  organiser: UserSpec;
  participants: UserSpec[];
  orgName: string;
  title: string;
  holdSeconds: number;
  startsInDays: number;
  log?: SeedLogger;
  now?: number;
}

export interface DemoParticipantResult {
  email: string;
  acceptable: string[];
  status: RegistrationSummary['status'];
  session?: string;
  offerExpiresAt?: string;
  queuePosition?: number;
  settleMs: number;
}

export interface SeedDemoSummary {
  orgId: string;
  workshopId: string;
  sessions: {
    key: string;
    id: string;
    title: string;
    capacity: number;
    startsAt: string;
    free: number;
  }[];
  holdSeconds: number;
  organiser: ProvisionedUser;
  participants: DemoParticipantResult[];
  verify: boolean;
  paths: { publicWorkshop: string; dashboard: string };
}

export function demoWorkshopBody(
  options: Pick<SeedDemoOptions, 'title' | 'holdSeconds' | 'startsInDays' | 'now'>,
): CreateWorkshopInput {
  const now = options.now ?? Date.now();
  return {
    title: options.title,
    description: `Demo preset seeded on ${new Date(now).toISOString()} (hold ${options.holdSeconds} s).`,
    mode: 'UNIFIED',
    holdSeconds: options.holdSeconds,
    sessions: DEMO_SESSIONS.map((session) => ({
      title: session.title,
      capacity: session.capacity,
      startsAt: isoFromNow(options.startsInDays * DAY_MS + session.offsetMs, now),
    })),
  };
}

export async function seedDemo(options: SeedDemoOptions): Promise<SeedDemoSummary> {
  const log = options.log ?? (() => undefined);
  const [organiserUser, ...participantUsers] = await provisionUsers(options.provider, [
    options.organiser,
    ...options.participants,
  ]);
  if (organiserUser === undefined) {
    throw new Error('organiser account could not be provisioned');
  }
  log('accounts ready', {
    provider: options.provider.kind,
    organiser: organiserUser.email,
    participants: participantUsers.length,
    created: [organiserUser, ...participantUsers].filter((user) => user.created).length,
  });

  const organiserClient = options.api.withToken(organiserUser.idToken);
  const { organization } = await findOrCreateOrg(organiserClient, options.orgName, log);
  const created = await organiserClient.createWorkshop(organization.id, demoWorkshopBody(options));
  const sessionIds = created.sessions.map((session) => session.id);
  const keyOf = (id: string): string => `S${sessionIds.indexOf(id) + 1}`;
  log('workshop created', { workshopId: created.workshop.id, sessions: sessionIds });

  const participants: DemoParticipantResult[] = [];
  for (const [index, user] of participantUsers.entries()) {
    const acceptable = demoPreferences(index, sessionIds);
    const { registration, settled } = await registerAny(
      options.api.withToken(user.idToken),
      created.workshop.id,
      acceptable,
      user.email,
    );
    const row: DemoParticipantResult = {
      email: user.email,
      acceptable: acceptable.map(keyOf),
      status: registration.status,
      settleMs: settled.settleMs,
    };
    if (registration.currentOffer !== undefined) {
      row.session = keyOf(registration.currentOffer.sessionId);
      row.offerExpiresAt = registration.currentOffer.expiresAt;
    }
    if (registration.queuePosition !== undefined) {
      row.queuePosition = registration.queuePosition;
    }
    participants.push(row);
    log('registered', { ...row });
  }

  const verify = await organiserClient.verify(organization.id, created.workshop.id);
  return {
    orgId: organization.id,
    workshopId: created.workshop.id,
    sessions: created.sessions.map((session, i) => ({
      key: `S${i + 1}`,
      id: session.id,
      title: session.title,
      capacity: session.capacity,
      startsAt: session.startsAt,
      free: session.free,
    })),
    holdSeconds: options.holdSeconds,
    organiser: organiserUser,
    participants,
    verify: verify.ok,
    paths: {
      publicWorkshop: `/workshops/${created.workshop.id}`,
      dashboard: `/orgs/${organization.id}/workshops/${created.workshop.id}/dashboard`,
    },
  };
}
