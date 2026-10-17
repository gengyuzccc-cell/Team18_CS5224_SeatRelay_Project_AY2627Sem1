import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2,
  AttributeValue as StreamAttributeValue,
  DynamoDBRecord,
  SQSRecord,
} from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import type {
  AuthUser,
  CommandAcceptedView,
  CommandBody,
  CreateWorkshopInput,
  Organization,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { addMinutes } from '@seatrelay/core';
import {
  createInMemoryPorts,
  type ApiResponse,
  type InMemoryPorts,
  type InMemoryPortsOptions,
} from '@seatrelay/service';
import { expect } from 'vitest';
import type { Item } from '../src/adapters/dynamo/mapping';
import { T0 } from './fixtures';

/* ---------- identities ---------- */

export const alice: AuthUser = { userId: 'alice', email: 'alice@example.com', name: 'Alice' };
export const bob: AuthUser = { userId: 'bob', email: 'bob@example.com', name: 'Bob' };
export const carol: AuthUser = { userId: 'carol', email: 'carol@example.com' };

/** The JWT claims API Gateway's authorizer exposes for a signed-in user (Cognito ID token). */
export function claimsOf(user: AuthUser): Record<string, unknown> {
  return {
    sub: user.userId,
    email: user.email,
    ...(user.name === undefined ? {} : { name: user.name }),
    aud: 'web-client',
    iss: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_test',
    token_use: 'id',
  };
}

/* ---------- Lambda events ---------- */

export interface ApiEventInput {
  method?: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON-serialised into the body. */
  body?: unknown;
  /** Verbatim body (malformed JSON tests). */
  rawBody?: string;
  base64?: boolean;
  /** Present on routes behind the JWT authorizer. */
  claims?: Record<string, unknown>;
}

export function apiEvent(input: ApiEventInput): APIGatewayProxyEventV2 {
  const method = input.method ?? 'GET';
  const rawBody =
    input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
  const body =
    rawBody === undefined
      ? undefined
      : input.base64 === true
        ? Buffer.from(rawBody, 'utf8').toString('base64')
        : rawBody;
  const event = {
    version: '2.0',
    routeKey: `${method} /{proxy+}`,
    rawPath: input.path,
    rawQueryString: new URLSearchParams(input.query ?? {}).toString(),
    headers: { 'content-type': 'application/json', ...input.headers },
    ...(input.query === undefined ? {} : { queryStringParameters: input.query }),
    requestContext: {
      accountId: '123456789012',
      apiId: 'api1',
      domainName: 'api1.execute-api.ap-southeast-1.amazonaws.com',
      domainPrefix: 'api1',
      http: {
        method,
        path: input.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: `req-${randomUUID()}`,
      routeKey: `${method} /{proxy+}`,
      stage: '$default',
      time: '03/Nov/2026:06:00:00 +0000',
      timeEpoch: Date.parse(T0),
      ...(input.claims === undefined
        ? {}
        : { authorizer: { jwt: { claims: input.claims, scopes: [] } } }),
    },
    ...(body === undefined ? {} : { body }),
    isBase64Encoded: input.base64 === true,
  };
  return event as unknown as APIGatewayProxyEventV2;
}

export interface SqsRecordOptions {
  messageId?: string;
  /** SQS `ApproximateReceiveCount` (1-based delivery attempt). */
  receiveCount?: number;
  groupId?: string;
}

export function sqsRecord(body: unknown, options: SqsRecordOptions = {}): SQSRecord {
  const messageId = options.messageId ?? `msg-${randomUUID()}`;
  return {
    messageId,
    receiptHandle: `rh-${messageId}`,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: String(options.receiveCount ?? 1),
      SentTimestamp: String(Date.parse(T0)),
      SenderId: 'AIDAEXAMPLE',
      ApproximateFirstReceiveTimestamp: String(Date.parse(T0)),
      ...(options.groupId === undefined ? {} : { MessageGroupId: options.groupId }),
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-1:123456789012:seatrelay-test-commands.fifo',
    awsRegion: 'ap-southeast-1',
  };
}

/** A DynamoDB Streams record (NEW_AND_OLD_IMAGES view) for a document-form item. */
export function streamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  image: Item,
  sequenceNumber: string,
): DynamoDBRecord {
  const marshalled = marshall(image, { removeUndefinedValues: true }) as unknown as Record<
    string,
    StreamAttributeValue
  >;
  const keys = marshall({ PK: image.PK, SK: image.SK }) as unknown as Record<
    string,
    StreamAttributeValue
  >;
  return {
    eventID: `evt-${sequenceNumber}`,
    eventName,
    eventSource: 'aws:dynamodb',
    eventVersion: '1.1',
    awsRegion: 'ap-southeast-1',
    eventSourceARN:
      'arn:aws:dynamodb:ap-southeast-1:123456789012:table/seatrelay-test/stream/2026-11-03',
    dynamodb: {
      Keys: keys,
      ...(eventName === 'REMOVE' ? { OldImage: marshalled } : { NewImage: marshalled }),
      SequenceNumber: sequenceNumber,
      SizeBytes: 256,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
  };
}

/* ---------- in-memory application (service harness) ---------- */

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

export interface Scenario {
  ports: InMemoryPorts;
  orgId: string;
  wsId: string;
  s1: string;
  s2: string;
}

/** Alice owns an organisation with one workshop: two sessions of capacity 1, hold 60 s. */
export async function scenario(options: InMemoryPortsOptions = {}): Promise<Scenario> {
  const ports = setup(options);
  const org = await call(ports, 'POST', '/orgs', { user: alice, body: { name: 'Team 18' } });
  expect(org.status).toBe(201);
  const orgId = bodyOf<Organization>(org).id;
  const created = await call(ports, 'POST', `/orgs/${orgId}/workshops`, {
    user: alice,
    body: workshopInput(),
  });
  expect(created.status).toBe(201);
  const view = bodyOf<WorkshopPublicView>(created);
  const [first, second] = view.sessions;
  if (first === undefined || second === undefined) {
    throw new Error('scenario needs two sessions');
  }
  return { ports, orgId, wsId: view.workshop.id, s1: first.id, s2: second.id };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributiveOmit<CommandBody, 'commandId'> & { commandId?: string };

/** POSTs a command through the in-memory API (202) and returns the accepted view. */
export async function postCommand(
  ports: InMemoryPorts,
  user: AuthUser,
  wsId: string,
  input: CommandInput,
): Promise<CommandAcceptedView> {
  const response = await call(ports, 'POST', `/workshops/${wsId}/commands`, {
    user,
    body: { commandId: randomUUID(), ...input },
  });
  expect(response.status).toBe(202);
  return bodyOf<CommandAcceptedView>(response);
}
