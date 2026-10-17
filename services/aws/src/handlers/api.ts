import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { EmailSchema, type AuthUser, type ErrorBody } from '@seatrelay/contracts';
import {
  JSON_CONTENT_TYPE,
  toWireResponse,
  type ApiApp,
  type ApiRequest,
  type Logger,
} from '@seatrelay/service';
import { userFromEvent } from '../lib/auth';
import { errorFields } from '../lib/logger';
import { apiApp, runtime } from '../lib/ports';
import { lazy, noopLifecycle, type InvocationLifecycle } from '../lib/runtime';

export interface ApiHandlerDeps {
  app: ApiApp;
  logger: Logger;
  lifecycle?: InvocationLifecycle;
  /** Identity extraction (default: JWT authorizer claims). */
  userFromEvent?: (event: APIGatewayProxyEventV2) => AuthUser | undefined;
}

export type ApiHandler = (
  event: APIGatewayProxyEventV2,
  context?: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

/** `GET /public/workshops/{wsId}` (no authorizer) is served by the public workshop route. */
const PUBLIC_WORKSHOP = /^\/public(\/workshops\/[^/]+)\/?$/;

/** `POST /workshops/{wsId}/commands`: the only route that copies the identity into a command. */
const COMMAND_INTAKE = /^\/workshops\/[^/]+\/commands\/?$/;

/**
 * A command carries the caller's e-mail (`actorEmail`, contracts `EmailSchema`) and the worker
 * parses every message with the command schema. An identity whose `email` claim that schema
 * rejects (Cognito accepts some RFC 5322 forms zod does not) would get a 202 for a command the
 * worker can only drop, leaving its record ACCEPTED forever; refuse it at the door instead.
 */
export function unusableCommandIdentity(
  method: string,
  path: string,
  user: AuthUser | undefined,
): boolean {
  return (
    user !== undefined &&
    method.toUpperCase() === 'POST' &&
    COMMAND_INTAKE.test(path) &&
    !EmailSchema.safeParse(user.email).success
  );
}

function errorResult(status: number, body: ErrorBody): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  };
}

/** Parses the (possibly base64) JSON body; `{ ok: false }` on malformed JSON. */
export function parseEventBody(
  event: APIGatewayProxyEventV2,
): { ok: true; body: unknown } | { ok: false } {
  if (event.body === undefined || event.body === null || event.body === '') {
    return { ok: true, body: undefined };
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (raw.trim() === '') {
    return { ok: true, body: undefined };
  }
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Thin adapter: APIGatewayProxyEventV2 → `ApiRequest` → `createApiApp().handle` →
 * APIGatewayProxyResultV2. No CORS headers (API Gateway's CorsConfiguration answers them), no
 * stack traces on the wire: unexpected errors are logged and answered `500 { code: 'INTERNAL' }`.
 */
export function createApiHandler(deps: ApiHandlerDeps): ApiHandler {
  const lifecycle = deps.lifecycle ?? noopLifecycle;
  const identify = deps.userFromEvent ?? userFromEvent;
  return async (event, context) => {
    const startedAt = Date.now();
    const method = event.requestContext?.http?.method ?? 'GET';
    const rawPath = event.rawPath ?? '/';
    lifecycle.begin(context, { requestId: event.requestContext?.requestId });
    try {
      const publicMatch = PUBLIC_WORKSHOP.exec(rawPath);
      const path = publicMatch?.[1] ?? rawPath;
      const user = publicMatch === null ? identify(event) : undefined;
      const parsed = parseEventBody(event);
      if (!parsed.ok) {
        return errorResult(400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' });
      }
      if (unusableCommandIdentity(method, path, user)) {
        deps.logger.warn('command refused: identity e-mail fails the command schema', {
          method,
          path,
          userId: user?.userId,
        });
        return errorResult(400, {
          code: 'VALIDATION_ERROR',
          message: 'The e-mail address of this account cannot be used to submit commands',
        });
      }
      const request: ApiRequest = {
        method,
        path,
        query: event.queryStringParameters ?? {},
        headers: event.headers ?? {},
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
        ...(user === undefined ? {} : { user }),
      };
      const response = await deps.app.handle(request);
      const wire = toWireResponse(response);
      deps.logger.info('request handled', {
        method,
        path,
        status: wire.status,
        latencyMs: Date.now() - startedAt,
        ...(user === undefined ? {} : { userId: user.userId }),
      });
      return { statusCode: wire.status, headers: wire.headers, body: wire.body };
    } catch (error) {
      deps.logger.error('unhandled error in api handler', {
        method,
        path: rawPath,
        ...errorFields(error),
      });
      return errorResult(500, { code: 'INTERNAL', message: 'Internal error' });
    } finally {
      lifecycle.end();
    }
  };
}

const defaultHandler = lazy(() =>
  createApiHandler({ app: apiApp(), logger: runtime().logger, lifecycle: runtime() }),
);

export const handler: ApiHandler = (event, context) => defaultHandler()(event, context);
