import { AttendanceBodySchema, type Attendance, type VerifyView } from '@seatrelay/contracts';
import { checkInvariants } from '@seatrelay/core';
import { registrationsCsv } from '../../csv';
import { notFound } from '../../errors';
import { dashboardView } from '../../views';
import { param, requireOrgWorkshop, requireUser, type ApiRoute } from '../context';
import { CSV_CONTENT_TYPE, json, parseBody, text } from '../http';

const BASE = '/orgs/:orgId/workshops/:wsId';

export const organiserRoutes: ApiRoute[] = [
  {
    name: 'dashboard',
    method: 'GET',
    pattern: `${BASE}/dashboard`,
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const wsId = param(ctx, 'wsId');
      await requireOrgWorkshop(deps, param(ctx, 'orgId'), wsId, user.userId);
      const [snapshot, history, backfills, attendance] = await Promise.all([
        deps.store.loadSnapshot(wsId),
        deps.store.listHistory(wsId),
        deps.store.listBackfills(wsId),
        deps.store.listAttendance(wsId),
      ]);
      if (snapshot === undefined) {
        throw notFound('Workshop not found');
      }
      return json(200, dashboardView(snapshot, history, backfills, attendance));
    },
  },
  {
    name: 'putAttendance',
    method: 'PUT',
    pattern: `${BASE}/attendance/:userId`,
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const wsId = param(ctx, 'wsId');
      const participantId = param(ctx, 'userId');
      await requireOrgWorkshop(deps, param(ctx, 'orgId'), wsId, user.userId);
      const body = parseBody(AttendanceBodySchema, ctx.req.body);
      const [snapshot, history] = await Promise.all([
        deps.store.loadSnapshot(wsId),
        deps.store.listHistory(wsId),
      ]);
      const registered =
        snapshot !== undefined &&
        [...snapshot.registrations, ...history.registrations].some(
          (registration) => registration.userId === participantId,
        );
      if (!registered) {
        throw notFound('No registration of that user in this workshop');
      }
      const record: Attendance = {
        workshopId: wsId,
        userId: participantId,
        attended: body.attended,
        markedAt: deps.clock.now(),
        markedBy: user.userId,
      };
      await deps.store.putAttendance(record);
      return json(200, record);
    },
  },
  {
    name: 'exportCsv',
    method: 'GET',
    pattern: `${BASE}/export.csv`,
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const wsId = param(ctx, 'wsId');
      await requireOrgWorkshop(deps, param(ctx, 'orgId'), wsId, user.userId);
      const [snapshot, history, attendance] = await Promise.all([
        deps.store.loadSnapshot(wsId),
        deps.store.listHistory(wsId),
        deps.store.listAttendance(wsId),
      ]);
      if (snapshot === undefined) {
        throw notFound('Workshop not found');
      }
      return text(200, registrationsCsv(snapshot, history, attendance), CSV_CONTENT_TYPE, {
        'content-disposition': `attachment; filename="seatrelay-${wsId}.csv"`,
      });
    },
  },
  {
    name: 'verify',
    method: 'GET',
    pattern: `${BASE}/verify`,
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const wsId = param(ctx, 'wsId');
      await requireOrgWorkshop(deps, param(ctx, 'orgId'), wsId, user.userId);
      const snapshot = await deps.store.loadSnapshot(wsId);
      if (snapshot === undefined) {
        throw notFound('Workshop not found');
      }
      const checkedAt = deps.clock.now();
      const report = checkInvariants(snapshot, checkedAt);
      const view: VerifyView = { ok: report.ok, checkedAt, violations: report.violations };
      return json(200, view);
    },
  },
];
