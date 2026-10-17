import type {
  MeView,
  MyRegistrationView,
  Notification,
  Offer,
  Registration,
} from '@seatrelay/contracts';
import { compareIso, type WorkshopSnapshot } from '@seatrelay/core';
import { notFound } from '../../errors';
import {
  endingNoticesSince,
  isArchivedRegistration,
  myRegistrationViews,
  notificationView,
} from '../../views';
import { param, requireUser, type ApiRoute } from '../context';
import { json } from '../http';

/**
 * The archived offers that `ending` needs for these registrations of one workshop: none when
 * nothing ended (`undefined`: no `ending` is computed), and no read when every ended
 * registration had a confirmed seat (a CONFIRMED registration holds no offer, so the ending is
 * that seat alone: `[]`).
 */
async function settledOffersFor(
  mine: readonly Registration[],
  read: () => Promise<Offer[]>,
): Promise<Offer[] | undefined> {
  const archived = mine.filter(isArchivedRegistration);
  if (archived.length === 0) {
    return undefined;
  }
  return archived.every((registration) => registration.confirmedSessionId !== undefined)
    ? []
    : read();
}

/**
 * The user's notifications that tell which session cancellation ended some of these
 * registrations: read only when one of them may have ended that way (the workshop has a
 * cancelled session), from the earliest such ending on (`endingNoticesSince`).
 */
async function endingNoticesFor(
  snapshot: WorkshopSnapshot | undefined,
  mine: readonly Registration[],
  read: (since: string) => Promise<Notification[]>,
): Promise<Notification[]> {
  const since = snapshot === undefined ? undefined : endingNoticesSince(snapshot, mine);
  return since === undefined ? [] : read(since);
}

export const meRoutes: ApiRoute[] = [
  {
    name: 'me',
    method: 'GET',
    pattern: '/me',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const view: MeView = {
        userId: user.userId,
        email: user.email,
        ...(user.name !== undefined ? { name: user.name } : {}),
        organizations: await deps.store.listOrganizationsForUser(user.userId),
      };
      return json(200, view);
    },
  },
  {
    name: 'myRegistrations',
    method: 'GET',
    pattern: '/me/registrations',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const registrations = await deps.store.listRegistrationsForUser(user.userId);
      const byWorkshop = new Map<string, Registration[]>();
      for (const registration of registrations) {
        const list = byWorkshop.get(registration.workshopId) ?? [];
        list.push(registration);
        byWorkshop.set(registration.workshopId, list);
      }
      // The workshops are read in parallel: one live snapshot each, plus this user's archived
      // offers where one of their registrations ended in a way an offer can explain, and (once
      // the snapshot shows a cancelled session) their notifications of the decisions that a
      // session cancellation may have ended a registration in.
      const perWorkshop = await Promise.all(
        [...byWorkshop].map(async ([wsId, mine]) => {
          const snapshotRead = deps.store.loadSnapshot(wsId);
          const [snapshot, settledOffers, notices] = await Promise.all([
            snapshotRead,
            settledOffersFor(mine, () => deps.store.listArchivedOffersOfUser(wsId, user.userId)),
            snapshotRead.then((loaded) =>
              endingNoticesFor(loaded, mine, (since) =>
                deps.store.listNotificationsOfUserSince(user.userId, wsId, since),
              ),
            ),
          ]);
          return snapshot === undefined
            ? []
            : myRegistrationViews(snapshot, mine, settledOffers, notices);
        }),
      );
      const views: MyRegistrationView[] = perWorkshop.flat();
      views.sort(
        (a, b) =>
          compareIso(b.registration.updatedAt, a.registration.updatedAt) ||
          b.registration.seq - a.registration.seq,
      );
      return json(200, { registrations: views });
    },
  },
  {
    name: 'myNotifications',
    method: 'GET',
    pattern: '/me/notifications',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const notifications = await deps.store.listNotificationsForUser(user.userId);
      notifications.sort((a, b) => compareIso(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : -1));
      return json(200, { notifications: notifications.map(notificationView) });
    },
  },
  {
    name: 'markNotificationRead',
    method: 'POST',
    pattern: '/me/notifications/:notificationId/read',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const notification = await deps.store.markNotificationRead(
        user.userId,
        param(ctx, 'notificationId'),
        deps.clock.now(),
      );
      if (notification === undefined) {
        throw notFound('Notification not found');
      }
      return json(200, notificationView(notification));
    },
  },
];
