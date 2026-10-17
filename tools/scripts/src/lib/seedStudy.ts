import type { CreateWorkshopInput, DashboardView, Workshop } from '@seatrelay/contracts';
import type { ApiClient } from './api';
import {
  cancelOrgWorkshops,
  confirmSeat,
  findOrCreateOrg,
  joinQueue,
  SeedStateError,
  type SeedLogger,
} from './seed';
import {
  STUDY_HOLD_SECONDS,
  STUDY_ORG_NAME,
  STUDY_PERSONAS,
  studyExpectation,
  studyRegistrants,
  studySessionStartsAt,
  studySessionTitle,
  studyState,
  type StudyDataset,
  type StudyTrack,
  type StudyWorkshopExpectation,
  type StudyWorkshopSpec,
} from './study';
import { provisionUsers, type ProvisionedUser, type UserProvider, type UserSpec } from './users';

/**
 * `seed-study` without the CLI: reset the study organisation and recreate one dataset's
 * tables through the API. Testable against the in-memory service with a fake provider.
 */

export interface SeededSession {
  key: string;
  id: string;
  title: string;
}

export interface SeededWorkshop {
  code: string;
  title: string;
  id: string;
  sessions: SeededSession[];
}

export interface SeedStudyOptions {
  /** Anonymous client of the target API (`withToken` is used per actor). */
  api: ApiClient;
  provider: UserProvider;
  track: StudyTrack;
  dataset: StudyDataset;
  password: string;
  orgName?: string;
  concurrency?: number;
  log?: SeedLogger;
}

export interface SeedStudySummary {
  track: StudyTrack;
  dataset: StudyDataset;
  orgId: string;
  orgName: string;
  cancelledWorkshops: { id: string; title: string }[];
  workshops: SeededWorkshop[];
  expectations: StudyWorkshopExpectation[];
  accounts: { password: string; organiser: string; participant: string; registrants: string[] };
  users: ProvisionedUser[];
  verify: { code: string; ok: boolean }[];
  /**
   * Unread in-app notifications of the two personas that the reset marked read (previous
   * rounds' offers, and the WORKSHOP_CANCELLED notices the reset itself causes). The API cannot
   * delete notifications or archived registrations: the personas' "Past" lists keep them.
   */
  personaNotificationsMarkedRead: number;
  /** Differences between the dashboard and the table; empty when the seed is exact. */
  problems: string[];
}

/** Marks every unread notification of the caller read; returns how many. */
export async function markAllNotificationsRead(client: ApiClient): Promise<number> {
  const { notifications } = await client.myNotifications();
  let marked = 0;
  for (const notification of notifications) {
    if (notification.readAt === undefined) {
      await client.markNotificationRead(notification.id);
      marked += 1;
    }
  }
  return marked;
}

export function studyCreateBody(workshop: StudyWorkshopSpec): CreateWorkshopInput {
  return {
    title: workshop.title,
    description: `User-study workshop ${workshop.code} (seeded by seed-study).`,
    mode: 'UNIFIED',
    holdSeconds: STUDY_HOLD_SECONDS,
    sessions: workshop.sessions.map((spec) => ({
      title: studySessionTitle(spec),
      startsAt: studySessionStartsAt(spec),
      capacity: spec.capacity,
    })),
  };
}

/** Creates the workshop, then confirms and queues the registrants in table order. */
export async function seedStudyWorkshop(
  api: ApiClient,
  organiser: ApiClient,
  orgId: string,
  workshop: StudyWorkshopSpec,
  tokens: Map<string, ProvisionedUser>,
  log: SeedLogger = () => undefined,
): Promise<SeededWorkshop> {
  const created = await organiser.createWorkshop(orgId, studyCreateBody(workshop));
  const wsId = created.workshop.id;
  const sessions: SeededSession[] = workshop.sessions.map((spec) => {
    const title = studySessionTitle(spec);
    const session = created.sessions.find((candidate) => candidate.title === title);
    if (session === undefined) {
      throw new SeedStateError(`${workshop.code}: created workshop has no session titled ${title}`);
    }
    return { key: spec.key, id: session.id, title };
  });
  const sessionId = (key: string): string => {
    const found = sessions.find((session) => session.key === key);
    if (found === undefined) {
      throw new SeedStateError(`${workshop.code}: unknown session key ${key}`);
    }
    return found.id;
  };
  const clientOf = (name: string): ApiClient => {
    const user = tokens.get(name);
    if (user === undefined) {
      throw new SeedStateError(`no token for ${name}`);
    }
    return api.withToken(user.idToken);
  };
  log('workshop created', { code: workshop.code, workshopId: wsId, title: workshop.title });

  for (const spec of workshop.sessions) {
    for (const name of spec.confirmed) {
      const { seq } = await confirmSeat(
        clientOf(name),
        wsId,
        sessionId(spec.key),
        `${workshop.code} ${name}`,
      );
      log('confirmed', { code: workshop.code, session: spec.key, name, seq });
    }
  }
  for (const [index, entry] of workshop.queue.entries()) {
    const { seq, queuePosition } = await joinQueue(
      clientOf(entry.name),
      wsId,
      entry.acceptable.map(sessionId),
      `${workshop.code} ${entry.name}`,
    );
    if (queuePosition !== index + 1) {
      throw new SeedStateError(
        `${workshop.code} ${entry.name}: queue position ${queuePosition}, expected ${index + 1}`,
      );
    }
    log('queued', { code: workshop.code, name: entry.name, seq, queuePosition });
  }
  return { code: workshop.code, title: workshop.title, id: wsId, sessions };
}

/** Compares the dashboard with the table; returns the differences (empty = exact match). */
export function diffStudyDashboard(
  expectation: StudyWorkshopExpectation,
  seeded: SeededWorkshop,
  dashboard: DashboardView,
): string[] {
  const problems: string[] = [];
  for (const expected of expectation.sessions) {
    const id = seeded.sessions.find((session) => session.key === expected.key)?.id;
    const actual = dashboard.sessions.find((session) => session.id === id);
    if (actual === undefined) {
      problems.push(`${expected.key}: missing on the dashboard`);
      continue;
    }
    if (
      actual.confirmed !== expected.confirmed ||
      actual.free !== expected.free ||
      actual.held !== 0
    ) {
      problems.push(
        `${expected.key}: confirmed ${actual.confirmed}/free ${actual.free}/held ${actual.held}, expected ${expected.confirmed}/${expected.free}/0`,
      );
    }
  }
  const queue = dashboard.queue.map((entry) => entry.email.toLowerCase());
  const expectedQueue = expectation.queue.map((entry) => entry.email.toLowerCase());
  if (queue.join(',') !== expectedQueue.join(',')) {
    problems.push(`queue [${queue.join(', ')}] expected [${expectedQueue.join(', ')}]`);
  }
  for (const [index, entry] of dashboard.queue.entries()) {
    if (entry.queuePosition !== index + 1) {
      problems.push(
        `queue position of ${entry.email} is ${entry.queuePosition}, expected ${index + 1}`,
      );
    }
  }
  if (dashboard.counts.offered !== 0) {
    problems.push(`${dashboard.counts.offered} offers outstanding, expected 0`);
  }
  if (dashboard.distinctParticipantsServed !== expectation.distinctConfirmed) {
    problems.push(
      `distinct participants ${dashboard.distinctParticipantsServed}, expected ${expectation.distinctConfirmed}`,
    );
  }
  return problems;
}

export function renderStudyTable(
  expectation: StudyWorkshopExpectation,
  seeded: SeededWorkshop,
): string {
  const lines = [`${seeded.code} — ${seeded.title}  (id ${seeded.id})`];
  for (const session of expectation.sessions) {
    const id = seeded.sessions.find((candidate) => candidate.key === session.key)?.id ?? '?';
    lines.push(
      `  ${session.key} ${session.title.padEnd(24)} cap ${session.capacity}  confirmed ${session.confirmed}  free ${session.free}  (${id})`,
    );
  }
  lines.push(
    expectation.queue.length === 0
      ? '  queue: (empty)'
      : `  queue: ${expectation.queue.map((q) => `${q.position}. ${q.name} [${q.acceptable.join(', ')}]`).join(' · ')}`,
  );
  return lines.join('\n');
}

/** The accounts a dataset needs: organiser persona, participant persona, dummy registrants. */
export function studyAccounts(
  track: StudyTrack,
  dataset: StudyDataset,
  password: string,
): {
  riley: UserSpec;
  jordan: UserSpec;
  registrants: UserSpec[];
} {
  const state = studyState(track, dataset);
  return {
    riley: { ...STUDY_PERSONAS.organiser, password },
    jordan: { ...STUDY_PERSONAS.participant, password },
    registrants: studyRegistrants(state).map((person) => ({ ...person, password })),
  };
}

export async function seedStudy(options: SeedStudyOptions): Promise<SeedStudySummary> {
  const log = options.log ?? (() => undefined);
  const orgName = options.orgName ?? STUDY_ORG_NAME;
  const state = studyState(options.track, options.dataset);
  const expectations = state.workshops.map(studyExpectation);
  const { riley, jordan, registrants } = studyAccounts(
    options.track,
    options.dataset,
    options.password,
  );

  const specs = [riley, jordan, ...registrants];
  const users = await provisionUsers(options.provider, specs, {
    concurrency: options.concurrency ?? 4,
  });
  const byName = new Map<string, ProvisionedUser>();
  for (const [index, spec] of specs.entries()) {
    const user = users[index];
    if (user !== undefined) {
      byName.set(spec.name ?? spec.email, user);
    }
  }
  const rileyUser = users[0];
  if (rileyUser === undefined) {
    throw new SeedStateError('organiser persona could not be provisioned');
  }
  log('accounts ready', {
    provider: options.provider.kind,
    users: users.length,
    created: users.filter((user) => user.created).length,
  });

  const organiser = options.api.withToken(rileyUser.idToken);
  const { organization } = await findOrCreateOrg(organiser, orgName, log);
  const cancelled: Workshop[] = await cancelOrgWorkshops(organiser, organization.id, { log });
  log('reset done', { cancelled: cancelled.length });

  const workshops = await Promise.all(
    state.workshops.map((workshop) =>
      seedStudyWorkshop(options.api, organiser, organization.id, workshop, byName, log),
    ),
  );

  const problems: string[] = [];
  const verify: { code: string; ok: boolean }[] = [];
  for (const [index, workshop] of workshops.entries()) {
    const expectation = expectations[index] as StudyWorkshopExpectation;
    const dashboard = await organiser.dashboard(organization.id, workshop.id);
    problems.push(
      ...diffStudyDashboard(expectation, workshop, dashboard).map(
        (problem) => `${workshop.code}: ${problem}`,
      ),
    );
    const report = await organiser.verify(organization.id, workshop.id);
    verify.push({ code: workshop.code, ok: report.ok });
    if (!report.ok) {
      problems.push(`${workshop.code}: verify → ${JSON.stringify(report.violations)}`);
    }
  }

  // Last, so the WORKSHOP_CANCELLED notices of the reset are already stored.
  let personaNotificationsMarkedRead = 0;
  for (const persona of [jordan, riley]) {
    const user = byName.get(persona.name ?? persona.email);
    if (user !== undefined) {
      personaNotificationsMarkedRead += await markAllNotificationsRead(
        options.api.withToken(user.idToken),
      );
    }
  }
  log('persona notifications marked read', { count: personaNotificationsMarkedRead });

  return {
    track: options.track,
    dataset: options.dataset,
    orgId: organization.id,
    orgName: organization.name,
    cancelledWorkshops: cancelled.map((workshop) => ({ id: workshop.id, title: workshop.title })),
    workshops,
    expectations,
    accounts: {
      password: options.password,
      organiser: riley.email,
      participant: jordan.email,
      registrants: registrants.map((spec) => spec.email),
    },
    users,
    verify,
    personaNotificationsMarkedRead,
    problems,
  };
}
