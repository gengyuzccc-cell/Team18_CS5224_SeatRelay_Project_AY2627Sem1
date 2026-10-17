import { randomUUID } from 'node:crypto';
import type {
  AuthUser,
  CommandAcceptedView,
  CommandBody,
  CreateWorkshopInput,
  ErrorBody,
  Organization,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { addMinutes } from '@seatrelay/core';
import { expect } from 'vitest';
import {
  createInMemoryPorts,
  type ApiResponse,
  type InMemoryPorts,
  type InMemoryPortsOptions,
} from '../src/index';

export const T0 = '2026-11-03T06:00:00.000Z';

export const alice: AuthUser = { userId: 'alice', email: 'alice@example.com', name: 'Alice' };
export const bob: AuthUser = { userId: 'bob', email: 'bob@example.com', name: 'Bob' };
export const carol: AuthUser = { userId: 'carol', email: 'carol@example.com' };
export const dave: AuthUser = { userId: 'dave', email: 'dave@example.com', name: 'Dave' };

export function setup(options: InMemoryPortsOptions = {}): InMemoryPorts {
  return createInMemoryPorts({ now: T0, allowFaultFlags: true, ...options });
}

export interface CallOptions {
  user?: AuthUser;
  body?: unknown;
}

export function call(
  ports: InMemoryPorts,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<ApiResponse> {
  return ports.api.handle({
    method,
    path,
    headers: {},
    query: {},
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.user === undefined ? {} : { user: options.user }),
  });
}

export function bodyOf<T>(response: ApiResponse): T {
  return response.body as T;
}

export function expectError(response: ApiResponse, status: number, code: ErrorBody['code']): void {
  expect(response.status).toBe(status);
  expect(bodyOf<ErrorBody>(response).code).toBe(code);
}

export function workshopInput(overrides: Partial<CreateWorkshopInput> = {}): CreateWorkshopInput {
  return {
    title: 'Intro to Git',
    holdSeconds: 60,
    sessions: [
      { title: 'Morning', startsAt: addMinutes(T0, 24 * 60), capacity: 1 },
      { title: 'Afternoon', startsAt: addMinutes(T0, 26 * 60), capacity: 1 },
    ],
    ...overrides,
  };
}

export async function createOrg(
  ports: InMemoryPorts,
  user: AuthUser,
  name = 'Team 18',
): Promise<Organization> {
  const response = await call(ports, 'POST', '/orgs', { user, body: { name } });
  expect(response.status).toBe(201);
  return bodyOf<Organization>(response);
}

export async function createWorkshop(
  ports: InMemoryPorts,
  user: AuthUser,
  orgId: string,
  input: CreateWorkshopInput = workshopInput(),
): Promise<WorkshopPublicView> {
  const response = await call(ports, 'POST', `/orgs/${orgId}/workshops`, { user, body: input });
  expect(response.status).toBe(201);
  return bodyOf<WorkshopPublicView>(response);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type CommandInput = DistributiveOmit<CommandBody, 'commandId'> & { commandId?: string };

/** POSTs a command (fresh UUID unless given) and returns the raw response. */
export function postCommand(
  ports: InMemoryPorts,
  user: AuthUser,
  wsId: string,
  input: CommandInput,
): Promise<ApiResponse> {
  return call(ports, 'POST', `/workshops/${wsId}/commands`, {
    user,
    body: { commandId: randomUUID(), ...input },
  });
}

/** POSTs a command, expects 202 and returns the accepted view. */
export async function accepted(
  ports: InMemoryPorts,
  user: AuthUser,
  wsId: string,
  input: CommandInput,
): Promise<CommandAcceptedView> {
  const response = await postCommand(ports, user, wsId, input);
  expect(response.status).toBe(202);
  return bodyOf<CommandAcceptedView>(response);
}

export interface Scenario {
  ports: InMemoryPorts;
  orgId: string;
  wsId: string;
  /** Session ids in start order (Morning, Afternoon). */
  s1: string;
  s2: string;
}

/** Alice owns an organisation with one workshop: two sessions of capacity 1, hold 60 s. */
export async function scenario(
  options: InMemoryPortsOptions = {},
  input: CreateWorkshopInput = workshopInput(),
): Promise<Scenario> {
  const ports = setup(options);
  const org = await createOrg(ports, alice);
  const view = await createWorkshop(ports, alice, org.id, input);
  const [first, second] = view.sessions;
  if (first === undefined || second === undefined) {
    throw new Error('scenario needs two sessions');
  }
  return { ports, orgId: org.id, wsId: view.workshop.id, s1: first.id, s2: second.id };
}
