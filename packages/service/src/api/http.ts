import { IdSchema, type AuthUser, type ErrorBody, type ErrorCode } from '@seatrelay/contracts';
import { ZodError } from 'zod';
import { ApiError } from '../errors';
import type { Logger } from '../ports';

/**
 * Framework-agnostic HTTP primitives (CONVENTIONS §5). The Lambda `api` handler and the
 * Fastify server translate their native request into an `ApiRequest`, call `handle()` and
 * write the `ApiResponse` back. Authentication (JWT verification) happens in those adapters;
 * they pass the verified identity as `user`.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequest {
  method: string;
  /** Path without query string, e.g. `/workshops/abc/commands`. */
  path: string;
  query?: Record<string, string | undefined>;
  /** Header names lower-cased. */
  headers?: Record<string, string | undefined>;
  /** Parsed JSON body, or undefined. */
  body?: unknown;
  /** Verified identity, or undefined for anonymous requests. */
  user?: AuthUser;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** A JSON-serialisable value (content-type application/json) or a string (text/*). */
  body?: unknown;
}

/** `none`: never needs a user; `optional`: user used when present; `required`: 401 without. */
export type RouteAuth = 'none' | 'optional' | 'required';

export interface RouteDefinition {
  name: string;
  method: HttpMethod;
  /** Fastify-style pattern, e.g. `/orgs/:orgId/workshops/:wsId/dashboard`. */
  pattern: string;
  auth: RouteAuth;
}

export interface RouteContext {
  req: ApiRequest;
  /** Decoded path parameters, each validated as a non-empty id. */
  params: Record<string, string>;
  /** Present when the route requires auth, or when optional and a user was supplied. */
  user?: AuthUser;
}

export type RouteHandler<Deps> = (ctx: RouteContext, deps: Deps) => Promise<ApiResponse>;

export interface Route<Deps> extends RouteDefinition {
  handler: RouteHandler<Deps>;
}

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ApiResponse {
  return { status, headers: { 'content-type': JSON_CONTENT_TYPE, ...headers }, body };
}

export function text(
  status: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): ApiResponse {
  return { status, headers: { 'content-type': contentType, ...headers }, body };
}

export function errorResponse(code: ErrorCode, message: string): ApiResponse {
  const error = new ApiError(code, message);
  return json(error.status, error.toBody());
}

/** What the thin adapters write to the wire. */
export function toWireResponse(response: ApiResponse): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  const body =
    response.body === undefined
      ? ''
      : typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body);
  return { status: response.status, headers: response.headers, body };
}

/** Lower-case keys, drop undefined values. */
export function normaliseHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/** Strips a query string and a trailing slash; guarantees a leading slash. */
export function normalisePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  const withSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

export interface RouteMatch<Deps> {
  route: Route<Deps>;
  params: Record<string, string>;
}

function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i] ?? '';
    const actual = pathParts[i] ?? '';
    if (expected.startsWith(':')) {
      if (actual.length === 0) {
        return undefined;
      }
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

/** First route whose method and pattern match (table order); `undefined` when none does. */
export function matchRoute<Deps>(
  routes: readonly Route<Deps>[],
  method: string,
  path: string,
): RouteMatch<Deps> | undefined {
  const upper = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== upper) {
      continue;
    }
    const params = matchPattern(route.pattern, path);
    if (params !== undefined) {
      return { route, params };
    }
  }
  return undefined;
}

/** Every path parameter must be a plausible id (non-empty, bounded length). */
export function validateParams(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!IdSchema.safeParse(value).success) {
      throw new ApiError('VALIDATION_ERROR', `Invalid path parameter ${name}`);
    }
  }
}

/** Maps any thrown value to an error response; unexpected errors are logged and become 500. */
export function mapError(
  error: unknown,
  logger: Logger,
  fields: Record<string, unknown>,
): ApiResponse {
  if (error instanceof ApiError) {
    return json(error.status, error.toBody());
  }
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    const body: ErrorBody = { code: 'VALIDATION_ERROR', message };
    return json(400, body);
  }
  logger.error('unhandled error in API route', {
    ...fields,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return errorResponse('INTERNAL', 'Internal error');
}

/** Parses a request body with a zod schema; failures surface as VALIDATION_ERROR. */
export function parseBody<T>(schema: { parse: (input: unknown) => T }, body: unknown): T {
  if (body === undefined || body === null) {
    throw new ApiError('VALIDATION_ERROR', 'Request body required');
  }
  return schema.parse(body);
}
