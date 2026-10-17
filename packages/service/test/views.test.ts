import type {
  Attendance,
  AuthUser,
  CommandResultView,
  DashboardView,
  MyRegistrationListView,
  NotificationListView,
  NotificationView,
  VerifyView,
} from '@seatrelay/contracts';
import { addMinutes } from '@seatrelay/core';
import { describe, expect, test, vi } from 'vitest';
import { csvCell, csvLine, myRegistrationViews } from '../src/index';
import {
  T0,
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
      {
        cause: 'CANCELLED_CONFIRMED',
        sessionId: s1,
        newUserId: carol.userId,
        latencyMs: 0,
        // named like the queue/offered/confirmed tables (carol has no display name)
        newHolderEmail: carol.email,
      },
    ]);
    expect(dashboard.backfills[0]).not.toHaveProperty('reallocatedAt');
    expect(dashboard.backfills[0]).not.toHaveProperty('newHolderEmail');
    expect(dashboard.backfills[1]).not.toHaveProperty('newHolderDisplayName');
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

  test('backfill log names the new holder from live or archived registrations', async () => {
    const { ports, orgId, wsId, s1 } = await scenario();
    const first = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const bobOffer = bodyOf<CommandResultView>(
      await call(ports, 'GET', `/commands/${first.commandId}`, { user: bob }),
    ).result?.registration?.currentOffer;
    // bob lets the 60 s hold run out: the seat is relayed to dave (live, OFFERED)
    ports.clock.advanceSeconds(61);
    await ports.fireDueTimers();
    const dashboardPath = `/orgs/${orgId}/workshops/${wsId}/dashboard`;
    let dashboard = bodyOf<DashboardView>(await call(ports, 'GET', dashboardPath, { user: alice }));
    expect(dashboard.backfills).toEqual([
      expect.objectContaining({
        cause: 'EXPIRED',
        releasedAt: bobOffer?.expiresAt,
        newUserId: dave.userId,
        newHolderEmail: dave.email,
        newHolderDisplayName: 'Dave',
      }),
    ]);
    // dave then cancels: his registration is archived, the record still names him
    await accepted(ports, dave, wsId, { type: 'CANCEL_REGISTRATION' });
    await ports.drain();
    dashboard = bodyOf<DashboardView>(await call(ports, 'GET', dashboardPath, { user: alice }));
    expect(dashboard.backfills.map((record) => record.newHolderDisplayName)).toEqual([
      'Dave',
      undefined,
    ]);
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
    // he gave up a confirmed seat: the ending names its session, no offer was settled with it
    expect(bobView.registrations[0]?.registration.ending).toEqual({ confirmedSessionId: s1 });
    // without the workshop history the ending is unknown, not "nothing was held"
    const snapshot = await ports.store.loadSnapshot(wsId);
    const bobRegistrations = await ports.store.listRegistrationsForUser(bob.userId);
    expect(snapshot).toBeDefined();
    expect(myRegistrationViews(snapshot!, bobRegistrations)[0]?.registration).not.toHaveProperty(
      'ending',
    );

    const carolView = bodyOf<MyRegistrationListView>(
      await call(ports, 'GET', '/me/registrations', { user: carol }),
    );
    expect(carolView.registrations[0]?.registration).toMatchObject({
      status: 'OFFERED',
      currentOffer: { sessionId: s1 },
    });
    expect(carolView.registrations[0]?.registration).not.toHaveProperty('ending');
    expect(
      bodyOf<MyRegistrationListView>(await call(ports, 'GET', '/me/registrations', { user: alice }))
        .registrations,
    ).toEqual([]);
  });

  test('GET /me/registrations says how a registration ended: expired, declined, cancelled while held, left the queue', async () => {
    const { ports, wsId, s1, s2 } = await scenario();
    const mine = async (user: typeof bob) =>
      bodyOf<MyRegistrationListView>(await call(ports, 'GET', '/me/registrations', { user }))
        .registrations;
    const offerOf = async (commandId: string, user: typeof bob) =>
      bodyOf<CommandResultView>(await call(ports, 'GET', `/commands/${commandId}`, { user })).result
        ?.registration?.currentOffer;

    // bob holds s1 and lets it expire; carol holds s2 and declines it; dave queues for s1
    const bobReg = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    const carolReg = await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s2] });
    await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain();
    const bobOffer = await offerOf(bobReg.commandId, bob);
    const carolOffer = await offerOf(carolReg.commandId, carol);
    ports.clock.advanceSeconds(10);
    await accepted(ports, carol, wsId, { type: 'DECLINE_OFFER', offerId: carolOffer?.id ?? '' });
    await ports.drain();
    const declinedAt = ports.clock.now();
    ports.clock.advanceSeconds(51);
    await ports.fireDueTimers(); // bob's hold expires, the seat goes to dave
    const expiredAt = ports.clock.now();

    const [bobEnded] = await mine(bob);
    expect(bobEnded?.registration).toMatchObject({
      status: 'ENDED',
      endReason: 'NO_ACCEPTABLE_SESSION',
      acceptable: [],
      updatedAt: expiredAt,
      ending: {
        offer: {
          id: bobOffer?.id,
          sessionId: s1,
          status: 'EXPIRED',
          expiresAt: bobOffer?.expiresAt,
          settledAt: expiredAt,
        },
      },
    });
    const [carolEnded] = await mine(carol);
    expect(carolEnded?.registration).toMatchObject({
      status: 'ENDED',
      endReason: 'NO_ACCEPTABLE_SESSION',
      ending: { offer: { sessionId: s2, status: 'DECLINED', settledAt: declinedAt } },
    });

    // dave cancels while the relayed seat is held for him; then queues again and leaves the queue
    await accepted(ports, dave, wsId, { type: 'CANCEL_REGISTRATION' });
    await ports.drain();
    ports.clock.advanceSeconds(1);
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] }); // bob holds s1 again
    await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [s1] }); // dave queues
    await ports.drain();
    ports.clock.advanceSeconds(1);
    await accepted(ports, dave, wsId, { type: 'CANCEL_REGISTRATION' });
    await ports.drain();
    const dave2 = await mine(dave);
    expect(dave2.map((entry) => [entry.registration.status, entry.registration.ending])).toEqual([
      ['CANCELLED', {}],
      ['CANCELLED', { offer: expect.objectContaining({ sessionId: s1, status: 'REVOKED' }) }],
    ]);
    // a live registration carries no ending
    expect((await mine(bob)).map((entry) => entry.registration.ending)).toEqual([
      undefined,
      expect.objectContaining({ offer: expect.objectContaining({ status: 'EXPIRED' }) }),
    ]);
  });

  test('GET /me/registrations reads only the caller’s archived offers, and none for a given-up confirmed seat', async () => {
    const { ports, wsId } = await populated();
    const history = vi.spyOn(ports.store, 'listHistory');
    const archivedOffers = vi.spyOn(ports.store, 'listArchivedOffersOfUser');
    const notices = vi.spyOn(ports.store, 'listNotificationsOfUserSince');
    const mine = async (user: typeof bob) =>
      bodyOf<MyRegistrationListView>(await call(ports, 'GET', '/me/registrations', { user }))
        .registrations;

    // bob's only ended registration gave up a confirmed seat: its ending needs no offer
    expect((await mine(bob))[0]?.registration.ending).toEqual({
      confirmedSessionId: expect.any(String),
    });
    expect(archivedOffers).not.toHaveBeenCalled();
    // dave is live only: no history read at all
    await mine(dave);
    expect(archivedOffers).not.toHaveBeenCalled();
    // carol declined s2 and is live again; bob's view is unaffected by her offers
    await mine(carol);
    expect(archivedOffers).not.toHaveBeenCalled();

    ports.clock.advanceSeconds(1);
    await accepted(ports, carol, wsId, { type: 'CANCEL_REGISTRATION' }); // gives up the held s1
    await ports.drain();
    const carolEntries = await mine(carol);
    expect(archivedOffers).toHaveBeenCalledTimes(1);
    expect(archivedOffers).toHaveBeenCalledWith(wsId, carol.userId);
    expect(carolEntries[0]?.registration.ending).toEqual({
      offer: expect.objectContaining({ status: 'REVOKED' }),
    });
    // the whole workshop history (archived registrations of everyone) is never read here, and
    // no notification either: no session of this workshop was cancelled
    expect(history).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
    // only the caller's offers are returned by the narrow read
    const offers = await ports.store.listArchivedOffersOfUser(wsId, carol.userId);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((offer) => offer.userId === carol.userId)).toBe(true);
  });

  test('a cancel that arrives after the hold expired (tick-first in the same decision) ends with the EXPIRED offer', async () => {
    // bob accepts s1 and s2; carol holds s2 (full), bob holds s1 and cancels 61 s later, before
    // any timer fires: the decision expires his hold first (back in the queue for s2), then
    // cancels. The ending names the expired offer; the web copy must not say "held for you".
    const { ports, wsId, s1, s2 } = await scenario();
    await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s2] });
    await ports.drain();
    await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1, s2] });
    await ports.drain();
    ports.clock.advanceSeconds(61);
    await accepted(ports, bob, wsId, { type: 'CANCEL_REGISTRATION' });
    await ports.drain();
    const [entry] = bodyOf<MyRegistrationListView>(
      await call(ports, 'GET', '/me/registrations', { user: bob }),
    ).registrations;
    expect(entry?.registration).toMatchObject({
      status: 'CANCELLED',
      ending: { offer: { sessionId: s1, status: 'EXPIRED', settledAt: ports.clock.now() } },
    });
    expect(
      Date.parse(entry?.registration.ending?.offer?.expiresAt ?? '') <
        Date.parse(entry?.registration.updatedAt ?? ''),
    ).toBe(true);
  });

  describe('an organiser session cancellation that ended a registration', () => {
    const erin: AuthUser = { userId: 'erin', email: 'erin@example.com' };
    const ended = async (ports: Scenario['ports'], user: AuthUser) =>
      bodyOf<MyRegistrationListView>(await call(ports, 'GET', '/me/registrations', { user }))
        .registrations[0]?.registration;
    const offerOf = async (ports: Scenario['ports'], commandId: string, user: AuthUser) =>
      bodyOf<CommandResultView>(await call(ports, 'GET', `/commands/${commandId}`, { user })).result
        ?.registration?.currentOffer?.id ?? '';

    test('is named, with the confirmed seat it took, when the rest is past the cut-off (not "cut-off before a seat")', async () => {
      // Early starts in 40 min (cut-off in 10 min), Late tomorrow; one seat each.
      const {
        ports,
        wsId,
        s1: early,
        s2: late,
      } = await scenario(
        {},
        workshopInput({
          sessions: [
            { title: 'Early', startsAt: addMinutes(T0, 40), capacity: 1 },
            { title: 'Late', startsAt: addMinutes(T0, 24 * 60), capacity: 1 },
          ],
        }),
      );
      // dave takes Early's seat; bob confirms Late (Early as a fallback); carol queues for both,
      // erin for Early only.
      const daveReg = await accepted(ports, dave, wsId, { type: 'REGISTER', acceptable: [early] });
      const bobReg = await accepted(ports, bob, wsId, {
        type: 'REGISTER',
        acceptable: [late, early],
      });
      await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [late, early] });
      await accepted(ports, erin, wsId, { type: 'REGISTER', acceptable: [early] });
      await ports.drain();
      for (const [user, reg] of [
        [dave, daveReg],
        [bob, bobReg],
      ] as const) {
        const offerId = await offerOf(ports, reg.commandId, user);
        await accepted(ports, user, wsId, { type: 'ACCEPT_OFFER', offerId });
      }
      await ports.drain();
      // Early's cut-off passes: the sweep ends erin (queued for Early only); Late keeps carol.
      ports.clock.advanceSeconds(11 * 60);
      await ports.sweep();
      await ports.drain();
      const cutoffAt = ports.clock.now();
      ports.clock.advanceSeconds(60);
      await accepted(ports, alice, wsId, { type: 'CANCEL_SESSION', sessionId: late });
      await ports.drain();
      const cancelledAt = ports.clock.now();

      const notices = vi.spyOn(ports.store, 'listNotificationsOfUserSince');
      // bob had a confirmed seat in Late: the ending names the cancellation and that seat
      expect(await ended(ports, bob)).toMatchObject({
        status: 'ENDED',
        endReason: 'CUTOFF',
        acceptable: [early],
        updatedAt: cancelledAt,
        ending: { cancelledSessionId: late, confirmedSessionId: late },
      });
      expect(notices).toHaveBeenLastCalledWith(bob.userId, wsId, cancelledAt);
      // carol was queued for Late: the cancellation, not the cut-off, ended her registration
      expect(await ended(ports, carol)).toMatchObject({
        status: 'ENDED',
        endReason: 'CUTOFF',
        updatedAt: cancelledAt,
        ending: { cancelledSessionId: late },
      });
      expect((await ended(ports, carol))?.ending).not.toHaveProperty('confirmedSessionId');
      // erin's cut-off came from the tick: nothing to name, although a session is cancelled now
      expect(await ended(ports, erin)).toMatchObject({
        status: 'ENDED',
        endReason: 'CUTOFF',
        updatedAt: cutoffAt,
        ending: {},
      });
      expect((await ended(ports, erin))?.ending).toEqual({});
      // dave is live: no history, no notification read for him
      notices.mockClear();
      await ended(ports, dave);
      expect(notices).not.toHaveBeenCalled();
    });

    test('a hold that expired in the same decision is not named as the cause', async () => {
      // bob holds Morning and also accepts Afternoon. His hold runs out, but the organiser's
      // cancellation of Afternoon is processed before any timer tick: the decision expires the
      // hold first (bob back in the queue for Afternoon), then the drain ends his registration.
      const { ports, wsId, s1, s2 } = await scenario();
      await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1, s2] });
      await ports.drain();
      ports.clock.advanceSeconds(61);
      await accepted(ports, alice, wsId, { type: 'CANCEL_SESSION', sessionId: s2 });
      await ports.drain();
      const registration = await ended(ports, bob);
      expect(registration).toMatchObject({
        status: 'ENDED',
        endReason: 'NO_ACCEPTABLE_SESSION',
        updatedAt: ports.clock.now(),
        ending: { cancelledSessionId: s2 },
      });
      expect(registration?.ending).not.toHaveProperty('offer');
      // the two notices of that decision say the same: back in the queue, then ended
      const kinds = bodyOf<NotificationListView>(
        await call(ports, 'GET', '/me/notifications', { user: bob }),
      ).notifications.map((notification) => notification.kind);
      expect(kinds).toEqual(expect.arrayContaining(['EXPIRED', 'SESSION_CANCELLED']));
    });

    test('PER_SESSION: the confirmed seat of the cancelled session is named, without a notification read', async () => {
      const { ports, wsId, s1 } = await scenario({}, workshopInput({ mode: 'PER_SESSION' }));
      const bobReg = await accepted(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
      await accepted(ports, carol, wsId, { type: 'REGISTER', acceptable: [s1] });
      await ports.drain();
      const offerId = await offerOf(ports, bobReg.commandId, bob);
      await accepted(ports, bob, wsId, { type: 'ACCEPT_OFFER', offerId });
      await ports.drain();
      ports.clock.advanceSeconds(5);
      await accepted(ports, alice, wsId, { type: 'CANCEL_SESSION', sessionId: s1 });
      await ports.drain();

      const notices = vi.spyOn(ports.store, 'listNotificationsOfUserSince');
      expect(await ended(ports, bob)).toMatchObject({
        status: 'ENDED',
        endReason: 'NO_ACCEPTABLE_SESSION',
        ending: { cancelledSessionId: s1, confirmedSessionId: s1 },
      });
      // carol was queued and never offered a seat: the session is not known, nothing is claimed
      expect((await ended(ports, carol))?.ending).toEqual({});
      expect(notices).not.toHaveBeenCalled();
    });
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
