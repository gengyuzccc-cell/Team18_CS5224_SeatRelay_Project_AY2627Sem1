import type {
  Attendance,
  CommandResultView,
  DashboardView,
  MyRegistrationListView,
  NotificationListView,
  NotificationView,
  VerifyView,
} from '@seatrelay/contracts';
import { describe, expect, test } from 'vitest';
import { csvCell, csvLine } from '../src/index';
import {
  accepted,
  alice,
  bob,
  bodyOf,
  call,
  carol,
  dave,
  scenario,
  workshopInput,
  type Scenario,
} from './helpers';

/**
 * bob [s1], carol [s1, s2], dave [s1] → bob OFFERED s1, carol OFFERED s2, dave QUEUED.
 * bob accepts; carol declines s2 (back to the queue ahead of dave); bob cancels → carol gets s1.
 */
async function populated(): Promise<Scenario & { bobOfferId: string }> {
  const sc = await scenario();
  const { ports, wsId, s1, s2 } = sc;
  const register = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
  const carolReg = await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1, s2] });
  await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [s1] });
  await ports.drain();
  const offerOf = async (commandId: string, user = bob) =>
    bodyOf<CommandResultView>(await call(ports, 'GET', `/commands/${commandId}`, { user })).result
      ?.registration?.currentOffer?.id ?? '';
  const bobOfferId = await offerOf(register.commandId);
  const carolOfferId = await offerOf(carolReg.commandId, carol);
  ports.clock.advanceSeconds(5);
  await accepted(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId: bobOfferId });
  await accepted(ports, carol, wsId, { type: 'DECLINE_OFFER', offerId: carolOfferId });
  await ports.drain();
  ports.clock.advanceSeconds(5);
  await accepted(ports, bob, wsId, { type: 'CANCEL_REGISTRATION' });
  await ports.drain();
  return { ...sc, bobOfferId };
}

describe('dashboard, verify and attendance', () => {
  test('dashboard sections, counts, distinct participants currently served and backfill latencies', async () => {
    const { ports, orgId, wsId, s1, s2 } = await populated();
    const base = `/orgs/${orgId}/workshops/${wsId}`;
    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `${base}/dashboard`, { user: alice }),
    );

    expect(dashboard.workshop).toMatchObject({ id: wsId, seq: 3, version: 6 });
    expect(
      dashboard.sessions.map((s) => [s.id, s.confirmed, s.held, s.free, s.queueLength]),
    ).toEqual([
      [s1, 0, 1, 0, 1],
      [s2, 0, 0, 1, 0],
    ]);
    expect(dashboard.queue).toEqual([
      {
        seq: 3,
        userId: dave.userId,
        email: dave.email,
        displayName: 'Dave',
        acceptable: [s1],
        status: 'QUEUED',
        queuePosition: 1,
      },
    ]);
    expect(dashboard.offered).toEqual([
      {
        seq: 2,
        userId: carol.userId,
        email: carol.email,
        acceptable: [s1],
        status: 'OFFERED',
        offer: { id: expect.any(String), sessionId: s1, expiresAt: expect.any(String) },
      },
    ]);
    expect(dashboard.confirmed).toEqual([]);
    // bob cancelled his confirmed seat and carol is only OFFERED: nobody holds a seat now
    // (the same definition as core's distinctConfirmedUsers and the replay's distinct_served)
    expect(dashboard.distinctParticipantsServed).toBe(0);
    expect(dashboard.backfills).toMatchObject([
      { cause: 'DECLINED', sessionId: s2 },
      { cause: 'CANCELLED_CONFIRMED', sessionId: s1, newUserId: carol.userId, latencyMs: 0 },
    ]);
    expect(dashboard.backfills[0]).not.toHaveProperty('reallocatedAt');
    expect(dashboard.counts).toEqual({
      queued: 1,
      offered: 1,
      confirmed: 0,
      backfills: 2,
      backfillsReallocated: 1,
      attended: 0,
    });
    expect(dashboard.attendance).toEqual([]);

    const verify = bodyOf<VerifyView>(await call(ports, 'GET', `${base}/verify`, { user: alice }));
    expect(verify).toEqual({ ok: true, checkedAt: ports.clock.now(), violations: [] });
  });

  test('PER_SESSION: one person with two confirmed seats counts once in distinctParticipantsServed', async () => {
    const { ports, orgId, wsId, s1, s2 } = await scenario(
      {},
      workshopInput({ mode: 'PER_SESSION' }),
    );
    const first = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    const second = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s2] });
    await ports.drain();
    for (const commandId of [first.commandId, second.commandId]) {
      const view = bodyOf<CommandResultView>(
        await call(ports, 'GET', `/commands/${commandId}`, { user: bob }),
      );
      await accepted(ports, bob, wsId, {
        type: 'ACCEPT_OFFER',
        offerId: view.result?.registration?.currentOffer?.id ?? '',
      });
    }
    await ports.drain();
    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`, { user: alice }),
    );
    expect(dashboard.counts.confirmed).toBe(2);
    expect(dashboard.distinctParticipantsServed).toBe(1);
  });

  test('attendance can be marked for anyone who ever registered, 404 otherwise', async () => {
    const { ports, orgId, wsId } = await populated();
    const base = `/orgs/${orgId}/workshops/${wsId}`;
    const marked = await call(ports, 'PUT', `${base}/attendance/${bob.userId}`, {
      user: alice,
      body: { attended: true },
    });
    expect(marked.status).toBe(200);
    expect(bodyOf<Attendance>(marked)).toEqual({
      workshopId: wsId,
      userId: bob.userId,
      attended: true,
      markedAt: ports.clock.now(),
      markedBy: alice.userId,
    });
    expect(
      (
        await call(ports, 'PUT', `${base}/attendance/${carol.userId}`, {
          user: alice,
          body: { attended: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(ports, 'PUT', `${base}/attendance/zed`, {
          user: alice,
          body: { attended: true },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(ports, 'PUT', `${base}/attendance/${bob.userId}`, {
          user: alice,
          body: { attended: 'yes' },
        })
      ).status,
    ).toBe(400);

    const dashboard = bodyOf<DashboardView>(
      await call(ports, 'GET', `${base}/dashboard`, { user: alice }),
    );
    expect(dashboard.attendance.map((a) => [a.userId, a.attended])).toEqual([
      [bob.userId, true],
      [carol.userId, false],
    ]);
    expect(dashboard.counts.attended).toBe(1);
  });

  test('verify reports violations on a corrupted snapshot', async () => {
    const { ports, orgId, wsId, s1 } = await populated();
    await ports.store.commit({
      wsId,
      expectedVersion: 6,
      writes: [
        {
          kind: 'PUT_WORKSHOP_STATE',
          workshopId: wsId,
          status: 'OPEN',
          seq: 3,
          version: 7,
          updatedAt: ports.clock.now(),
        },
        {
          kind: 'PUT_SESSION',
          session: {
            id: s1,
            workshopId: wsId,
            title: 'Morning',
            startsAt: '2026-11-04T06:00:00.000Z',
            cutoffAt: '2026-11-04T05:30:00.000Z',
            capacity: 1,
            confirmed: 1,
            held: 1,
            status: 'OPEN',
          },
        },
      ],
      notifications: [],
    });
    const verify = bodyOf<VerifyView>(
      await call(ports, 'GET', `/orgs/${orgId}/workshops/${wsId}/verify`, { user: alice }),
    );
    expect(verify.ok).toBe(false);
    expect(verify.violations.map((v) => v.code)).toContain('C1_OVER_CAPACITY');
  });
});

describe('CSV export', () => {
  test('one row per live or archived registration, by seq, with attendance', async () => {
    const { ports, orgId, wsId, s1, s2 } = await populated();
    const base = `/orgs/${orgId}/workshops/${wsId}`;
    await call(ports, 'PUT', `${base}/attendance/${bob.userId}`, {
      user: alice,
      body: { attended: true },
    });
    const response = await call(ports, 'GET', `${base}/export.csv`, { user: alice });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="seatrelay-${wsId}.csv"`,
    );
    const body = response.body as string;
    expect(body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM: Excel reads non-ASCII names correctly
    const lines = body.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'seq,userId,email,displayName,status,endReason,acceptable,confirmedSessionId,confirmedSessionTitle,currentOfferId,offerSessionId,offerExpiresAt,attended,createdAt,updatedAt',
    );
    const rows = lines.slice(1, 4).map((line) => line.split(','));
    expect(rows.map((row) => row.slice(0, 5))).toEqual([
      ['1', 'bob', 'bob@example.com', 'Bob', 'CANCELLED'],
      ['2', 'carol', 'carol@example.com', '', 'OFFERED'],
      ['3', 'dave', 'dave@example.com', 'Dave', 'QUEUED'],
    ]);
    // a cancelled registration holds no seat: no confirmed session in the export
    expect(rows[0]?.slice(6, 9)).toEqual([s1, '', '']);
    expect(rows[0]?.[12]).toBe('yes');
    expect(rows[1]?.[6]).toBe(s1);
    expect(rows[1]?.[10]).toBe(s1);
    expect(rows[2]?.[12]).toBe('');
    expect(lines[4]).toBe('');
    void s2;
  });

  test('cells are quoted and formula-guarded', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(3)).toBe('3');
    expect(csvLine([1, 'x,y', undefined])).toBe('1,"x,y",');
  });
});

describe('my registrations and notifications', () => {
  test('GET /me/registrations lists live and archived registrations with queue positions', async () => {
    const { ports, wsId, s1 } = await populated();
    const daveView = bodyOf<MyRegistrationListView>(
      await call(ports, 'GET', '/me/registrations', { user: dave }),
    );
    expect(daveView.registrations).toHaveLength(1);
    expect(daveView.registrations[0]).toMatchObject({
      workshop: { id: wsId, title: 'Intro to Git' },
      registration: { status: 'QUEUED', seq: 3, queuePosition: 1, acceptable: [s1] },
    });
    expect(daveView.registrations[0]?.workshop).not.toHaveProperty('version');
    expect(daveView.registrations[0]?.sessions.map((s) => s.free)).toEqual([0, 1]);

    const bobView = bodyOf<MyRegistrationListView>(
      await call(ports, 'GET', '/me/registrations', { user: bob }),
    );
    expect(bobView.registrations[0]?.registration).toMatchObject({
      status: 'CANCELLED',
      seq: 1,
    });
    expect(bobView.registrations[0]?.registration).not.toHaveProperty('confirmedSessionId');
    expect(bobView.registrations[0]?.registration).not.toHaveProperty('queuePosition');

    const carolView = bodyOf<MyRegistrationListView>(
      await call(ports, 'GET', '/me/registrations', { user: carol }),
    );
    expect(carolView.registrations[0]?.registration).toMatchObject({
      status: 'OFFERED',
      currentOffer: { sessionId: s1 },
    });
    expect(
      bodyOf<MyRegistrationListView>(await call(ports, 'GET', '/me/registrations', { user: alice }))
        .registrations,
    ).toEqual([]);
  });

  test('GET /me/notifications is newest first; read marks are per owner', async () => {
    const { ports } = await populated();
    const carolNotifications = bodyOf<NotificationListView>(
      await call(ports, 'GET', '/me/notifications', { user: carol }),
    ).notifications;
    expect(carolNotifications.map((n) => n.kind)).toEqual(['OFFER', 'DECLINED', 'OFFER']);
    expect(
      (carolNotifications[0]?.createdAt ?? '') >= (carolNotifications[2]?.createdAt ?? ''),
    ).toBe(true);
    expect(carolNotifications[0]).not.toHaveProperty('readAt');
    expect(carolNotifications[0]).not.toHaveProperty('email');

    const bobNotifications = bodyOf<NotificationListView>(
      await call(ports, 'GET', '/me/notifications', { user: bob }),
    ).notifications;
    expect(bobNotifications.map((n) => n.kind).sort()).toEqual(['CONFIRMED', 'OFFER']);

    const target = carolNotifications[1]?.id ?? '';
    expect(
      (await call(ports, 'POST', `/me/notifications/${target}/read`, { user: bob })).status,
    ).toBe(404);
    const read = await call(ports, 'POST', `/me/notifications/${target}/read`, { user: carol });
    expect(read.status).toBe(200);
    expect(bodyOf<NotificationView>(read)).toMatchObject({ id: target, readAt: ports.clock.now() });
    const after = bodyOf<NotificationListView>(
      await call(ports, 'GET', '/me/notifications', { user: carol }),
    ).notifications;
    expect(after.find((n) => n.id === target)?.readAt).toBe(ports.clock.now());
  });
});
