import {
  AddMemberBodySchema,
  CreateOrgBodySchema,
  CreateWorkshopBodySchema,
  type Organization,
  type WorkshopListView,
} from '@seatrelay/contracts';
import { newSnapshot } from '@seatrelay/core';
import { notFound, validationError } from '../../errors';
import { workshopPublicView } from '../../views';
import { buildWorkshop } from '../../workshops';
import { param, requireOrgMember, requireUser, type ApiAppConfig, type ApiRoute } from '../context';
import { json, parseBody } from '../http';

async function resolveMemberUserId(
  deps: ApiAppConfig,
  body: { userId?: string; email?: string },
): Promise<string> {
  if (body.userId !== undefined) {
    return body.userId;
  }
  if (body.email === undefined) {
    throw validationError('Provide userId or email');
  }
  if (deps.userDirectory === undefined) {
    throw validationError('Adding members by email is not supported here; provide userId');
  }
  const userId = await deps.userDirectory.findUserIdByEmail(body.email);
  if (userId === undefined) {
    throw notFound('No user with that email');
  }
  return userId;
}

export const orgRoutes: ApiRoute[] = [
  {
    name: 'createOrganization',
    method: 'POST',
    pattern: '/orgs',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const body = parseBody(CreateOrgBodySchema, ctx.req.body);
      const organization: Organization = {
        id: deps.ids.newId(),
        name: body.name,
        ownerUserId: user.userId,
        members: [user.userId],
        createdAt: deps.clock.now(),
      };
      await deps.store.createOrganization(organization);
      deps.logger.info('organisation created', { orgId: organization.id, userId: user.userId });
      return json(201, organization);
    },
  },
  {
    name: 'addMember',
    method: 'POST',
    pattern: '/orgs/:orgId/members',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const orgId = param(ctx, 'orgId');
      await requireOrgMember(deps, orgId, user.userId);
      const body = parseBody(AddMemberBodySchema, ctx.req.body);
      const memberId = await resolveMemberUserId(deps, body);
      const organization = await deps.store.addMember(orgId, memberId);
      if (organization === undefined) {
        throw notFound('Organisation not found');
      }
      return json(200, organization);
    },
  },
  {
    name: 'listWorkshops',
    method: 'GET',
    pattern: '/orgs/:orgId/workshops',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const orgId = param(ctx, 'orgId');
      await requireOrgMember(deps, orgId, user.userId);
      const view: WorkshopListView = { workshops: await deps.store.listWorkshopsForOrg(orgId) };
      return json(200, view);
    },
  },
  {
    name: 'createWorkshop',
    method: 'POST',
    pattern: '/orgs/:orgId/workshops',
    auth: 'required',
    handler: async (ctx, deps) => {
      const user = requireUser(ctx);
      const orgId = param(ctx, 'orgId');
      await requireOrgMember(deps, orgId, user.userId);
      const body = parseBody(CreateWorkshopBodySchema, ctx.req.body);
      const { workshop, sessions } = buildWorkshop(body, orgId, {
        now: deps.clock.now(),
        newId: () => deps.ids.newId(),
      });
      await deps.store.createWorkshop(workshop, sessions);
      deps.logger.info('workshop created', {
        workshopId: workshop.id,
        orgId,
        userId: user.userId,
        sessions: sessions.length,
      });
      return json(201, workshopPublicView(newSnapshot(workshop, sessions)));
    },
  },
];
