import type { AuthUser, Organization, Workshop } from '@seatrelay/contracts';
import { forbidden, notFound, unauthorized, validationError } from '../errors';
import type { ApiPorts } from '../ports';
import type { Route, RouteContext } from './http';

/** Everything a route handler needs: the API ports plus deployment settings. */
export interface ApiAppConfig extends ApiPorts {
  /** Keep `_fault` flags in command bodies (ALLOW_FAULT_FLAGS=true on dev only). */
  allowFaultFlags: boolean;
  /** Reported by GET /health. */
  stage: string;
  /** Reported by GET /health (default `seatrelay`). */
  serviceName?: string;
}

export type ApiRoute = Route<ApiAppConfig>;

export function requireUser(ctx: RouteContext): AuthUser {
  if (ctx.user === undefined) {
    throw unauthorized();
  }
  return ctx.user;
}

export function param(ctx: RouteContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    throw validationError(`Missing path parameter ${name}`);
  }
  return value;
}

export function isOrgMember(organization: Organization, userId: string): boolean {
  return organization.members.includes(userId);
}

/** C7: the organisation exists (else 404) and the caller is a member (else 403). */
export async function requireOrgMember(
  deps: ApiAppConfig,
  orgId: string,
  userId: string,
): Promise<Organization> {
  const organization = await deps.store.getOrganization(orgId);
  if (organization === undefined) {
    throw notFound('Organisation not found');
  }
  if (!isOrgMember(organization, userId)) {
    throw forbidden();
  }
  return organization;
}

export async function requireWorkshop(deps: ApiAppConfig, wsId: string): Promise<Workshop> {
  const workshop = await deps.store.getWorkshop(wsId);
  if (workshop === undefined) {
    throw notFound('Workshop not found');
  }
  return workshop;
}

/** The caller organises `workshop` (member of its organisation), else 403. */
export async function assertOrganiser(
  deps: ApiAppConfig,
  workshop: Workshop,
  userId: string,
): Promise<Organization> {
  const organization = await deps.store.getOrganization(workshop.orgId);
  if (organization === undefined || !isOrgMember(organization, userId)) {
    throw forbidden();
  }
  return organization;
}

export interface OrganiserScope {
  organization: Organization;
  workshop: Workshop;
}

/** `/workshops/{wsId}` organiser routes: workshop exists (404) and caller organises it (403). */
export async function requireWorkshopOrganiser(
  deps: ApiAppConfig,
  wsId: string,
  userId: string,
): Promise<OrganiserScope> {
  const workshop = await requireWorkshop(deps, wsId);
  const organization = await assertOrganiser(deps, workshop, userId);
  return { organization, workshop };
}

/**
 * `/orgs/{orgId}/workshops/{wsId}/…` routes: membership of `orgId` is checked first (403 for
 * outsiders), then the workshop must belong to that organisation (404 otherwise).
 */
export async function requireOrgWorkshop(
  deps: ApiAppConfig,
  orgId: string,
  wsId: string,
  userId: string,
): Promise<OrganiserScope> {
  const organization = await requireOrgMember(deps, orgId, userId);
  const workshop = await deps.store.getWorkshop(wsId);
  if (workshop === undefined || workshop.orgId !== orgId) {
    throw notFound('Workshop not found');
  }
  return { organization, workshop };
}
