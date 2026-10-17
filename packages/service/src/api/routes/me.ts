import type { MeView, MyRegistrationView, Registration } from '@seatrelay/contracts';
import { compareIso } from '@seatrelay/core';
import { notFound } from '../../errors';
import { myRegistrationViews, notificationView } from '../../views';
import { param, requireUser, type ApiRoute } from '../context';
import { json } from '../http';

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
      const views: MyRegistrationView[] = [];
      for (const [wsId, mine] of byWorkshop) {
        const snapshot = await deps.store.loadSnapshot(wsId);
        if (snapshot !== undefined) {
          views.push(...myRegistrationViews(snapshot, mine));
        }
      }
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
