import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api';

const FAST = { sleep: async () => undefined };
import { seedStudy } from '../src/lib/seedStudy';
import {
  STUDY_PERSONAS,
  studyEmail,
  studyExpectation,
  studyRegistrants,
  studySessionStartsAt,
  studySessionTitle,
  studyState,
  studyWorkshopTitles,
} from '../src/lib/study';
import { createInMemoryApi, fakeUserProvider } from './helpers/inMemoryApi';

describe('study tables (docs/user-study/tasks-*.md §1)', () => {
  it('derives first.last@example.com e-mails like control-condition-setup.md §5', () => {
    expect(studyEmail('Mei Lin Chua')).toBe('meilin.chua@example.com');
    expect(studyEmail('Aiden Tan')).toBe('aiden.tan@example.com');
    expect(studyEmail('Farah Ismail')).toBe('farah.ismail@example.com');
    expect(studyEmail('Siti Nurul')).toBe('siti.nurul@example.com');
  });

  it('participant datasets: one free seat in W1, full W2 with the stated queue', () => {
    const a = studyState('participant', 'A');
    const [w1a, w2a] = a.workshops.map(studyExpectation);
    expect(w1a?.sessions.map((s) => s.free)).toEqual([0, 1, 0]);
    expect(w1a?.queue).toEqual([]);
    expect(w2a?.sessions.map((s) => s.free)).toEqual([0, 0, 0]);
    expect(w2a?.queue.map((q) => `${q.position}. ${q.name}`)).toEqual([
      '1. Wei Jie Ong',
      '2. Sara Ahmed',
    ]);
    // T2 answer key: Jordan queues at position 3 (A) and 4 (B).
    expect((w2a?.queuedTotal ?? 0) + 1).toBe(3);
    const b = studyState('participant', 'B');
    const [w1b, w2b] = b.workshops.map(studyExpectation);
    expect(w1b?.sessions.map((s) => s.free)).toEqual([0, 0, 1]);
    expect((w2b?.queuedTotal ?? 0) + 1).toBe(4);
    expect(studyRegistrants(a)).toHaveLength(16);
    expect(studyRegistrants(b)).toHaveLength(17);
  });

  it('organiser datasets: 9 confirmed distinct and 3 / 4 queued', () => {
    const [w3a] = studyState('organiser', 'A').workshops.map(studyExpectation);
    const [w3b] = studyState('organiser', 'B').workshops.map(studyExpectation);
    expect(w3a?.distinctConfirmed).toBe(9);
    expect(w3a?.queuedTotal).toBe(3);
    expect(w3b?.distinctConfirmed).toBe(9);
    expect(w3b?.queuedTotal).toBe(4);
    expect(studyWorkshopTitles()).toEqual([
      'Data Visualisation Basics',
      'Git Basics',
      'Resume Clinic',
      'Python for Data Analysis',
      'Excel Power Tools',
      'Public Speaking Lab',
    ]);
  });

  it('renders session titles and Singapore-time start timestamps', () => {
    const session = studyState('participant', 'A').workshops[0]?.sessions[1];
    expect(session && studySessionTitle(session)).toBe('Tue 17 Nov 14:00–15:30');
    expect(session && studySessionStartsAt(session)).toBe('2026-11-17T14:00:00+08:00');
  });
});

describe('seedStudy against the in-memory service', () => {
  it('participant A: seeds the tables, re-running resets, and the T1/T2 answer keys hold', async () => {
    const api = createInMemoryApi();
    const provider = fakeUserProvider(api);
    const client = new ApiClient({ baseUrl: api.baseUrl, fetch: api.fetch, commandOptions: FAST });
    const first = await seedStudy({
      api: client,
      provider,
      track: 'participant',
      dataset: 'A',
      password: 'pw',
    });
    expect(first.problems).toEqual([]);
    expect(first.verify.every((v) => v.ok)).toBe(true);
    expect(first.cancelledWorkshops).toEqual([]);
    expect(first.workshops.map((w) => w.code)).toEqual(['W1-A', 'W2-A']);
    expect(first.users.map((u) => u.email)).toContain(STUDY_PERSONAS.participant.email);

    // Jordan, logged in: T1 → OFFERED on Tue (S2); T2 → QUEUED position 3.
    const jordanToken =
      first.users.find((u) => u.email === STUDY_PERSONAS.participant.email)?.idToken ?? '';
    const jordan = client.withToken(jordanToken);
    const [w1, w2] = first.workshops;
    const sessionId = (w: typeof w1, key: string) =>
      w?.sessions.find((s) => s.key === key)?.id ?? '';
    const t1 = await jordan.sendCommand(w1?.id ?? '', {
      type: 'REGISTER',
      acceptable: [sessionId(w1, 'S3'), sessionId(w1, 'S2')],
    });
    expect(t1.record.result?.registration?.status).toBe('OFFERED');
    expect(t1.record.result?.registration?.currentOffer?.sessionId).toBe(sessionId(w1, 'S2'));
    const t2 = await jordan.sendCommand(w2?.id ?? '', {
      type: 'REGISTER',
      acceptable: [sessionId(w2, 'S1'), sessionId(w2, 'S3')],
    });
    expect(t2.record.result?.registration?.status).toBe('QUEUED');
    expect(t2.record.result?.registration?.queuePosition).toBe(3);

    // Reset: the previous two workshops are cancelled, the tables are exact again.
    const second = await seedStudy({
      api: client,
      provider,
      track: 'participant',
      dataset: 'B',
      password: 'pw',
    });
    expect(second.cancelledWorkshops.map((w) => w.title).sort()).toEqual([
      'Data Visualisation Basics',
      'Git Basics',
    ]);
    expect(second.problems).toEqual([]);
    expect(second.orgId).toBe(first.orgId);
    expect(second.workshops.map((w) => w.code)).toEqual(['W1-B', 'W2-B']);
    const mine = await jordan.myRegistrations();
    const live = mine.registrations.filter((r) =>
      ['QUEUED', 'OFFERED', 'CONFIRMED'].includes(r.registration.status),
    );
    expect(live).toEqual([]);
    // T1's offer notice and the reset's WORKSHOP_CANCELLED notices are no longer unread.
    expect(second.personaNotificationsMarkedRead).toBeGreaterThanOrEqual(3);
    const { notifications } = await jordan.myNotifications();
    expect(notifications.map((n) => n.kind)).toEqual(
      expect.arrayContaining(['OFFER', 'WORKSHOP_CANCELLED']),
    );
    expect(notifications.filter((n) => n.readAt === undefined)).toEqual([]);
  });

  it('organiser A: Mei Lin cancels → Hui Min is offered Monday (O2), Samuel is first for Wednesday (O3)', async () => {
    const api = createInMemoryApi();
    const provider = fakeUserProvider(api);
    const client = new ApiClient({ baseUrl: api.baseUrl, fetch: api.fetch, commandOptions: FAST });
    const summary = await seedStudy({
      api: client,
      provider,
      track: 'organiser',
      dataset: 'A',
      password: 'pw',
    });
    expect(summary.problems).toEqual([]);
    const w3 = summary.workshops[0];
    const tokenOf = (email: string) => summary.users.find((u) => u.email === email)?.idToken ?? '';
    const meiLin = client.withToken(tokenOf(studyEmail('Mei Lin Chua')));
    const cancel = await meiLin.sendCommand(w3?.id ?? '', { type: 'CANCEL_REGISTRATION' });
    expect(cancel.record.status).toBe('APPLIED');
    expect(cancel.record.result?.offersCreated).toBe(1);

    const riley = client.withToken(tokenOf(STUDY_PERSONAS.organiser.email));
    const dashboard = await riley.dashboard(summary.orgId, w3?.id ?? '');
    const s1 = w3?.sessions.find((s) => s.key === 'S1')?.id;
    const s3 = w3?.sessions.find((s) => s.key === 'S3')?.id;
    expect(dashboard.offered.map((o) => [o.email, o.offer.sessionId])).toEqual([
      [studyEmail('Hui Min Teo'), s1],
    ]);
    expect(dashboard.queue.map((q) => q.email)).toEqual([
      studyEmail('Yusuf Ali'),
      studyEmail('Samuel Goh'),
    ]);
    expect(dashboard.sessions.find((s) => s.id === s3)?.queueLength).toBe(1);
    expect(dashboard.distinctParticipantsServed).toBe(8);
    expect(dashboard.backfills.map((b) => b.cause)).toEqual(['CANCELLED_CONFIRMED']);
  });
});
