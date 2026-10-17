import { PatchWorkshopBodySchema } from '@seatrelay/contracts';
import { notFound } from '../../errors';
import { workshopPublicView } from '../../views';
import { param, requireUser, requireWorkshopOrganiser, type ApiRoute } from '../context';
import { json, parseBody } from '../http';

export const workshopRoutes: ApiRoute[] = [
  {
    name: 'getWorkshop',
    method: 'GET',
    pattern: '/workshops/:wsId',
    auth: 'optional',
    handler: async (ctx, deps) => {
      const snapshot = await deps.store.loadSnapshot(param(ctx, 'wsId'));
      if (snapshot === undefined) {
        throw notFound('Workshop not found');
      }
      return json(200, workshopPublicView(snapshot, ctx.user?.userId));
    },
  },
  {
    name: 'patchWorkshop',
    method: 'PATCH',
    pattern: '/workshops/:wsId',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const wsId = param(ctx, 'wsId');
      await requireWorkshopOrganiser(deps, wsId, user.userId);
      const body = parseBody(PatchWorkshopBodySchema, ctx.req.body);
      const patch = {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      };
      const workshop = await deps.store.updateWorkshopInfo(wsId, patch);
      if (workshop === undefined) {
        throw notFound('Workshop not found');
      }
      return json(200, workshop);
    },
  },
];
