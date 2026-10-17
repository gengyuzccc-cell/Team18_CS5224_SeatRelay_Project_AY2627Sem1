import { ErrorBodySchema } from '@seatrelay/contracts';

/**
 * Minimal fetch wrapper: bearer from the session, JSON in/out, responses parsed with the
 * @seatrelay/contracts zod schemas, every non-2xx `{ code, message }` body surfaced as
 * `ApiError` (CONVENTIONS §3 / §6).
 */

/** Structural subset of a zod schema (keeps `zod` out of this package's direct dependencies). */
export interface ParseSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export class ApiError extends Error {
  /** HTTP status; 0 when the request never reached the server. */
  readonly status: number;
  /**
   * Contracts `ErrorCode`, or `NETWORK` / `INVALID_RESPONSE` / `TOO_MANY_REQUESTS` /
   * `HTTP_<status>`.
   */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type AuthMode = 'required' | 'optional' | 'none';

export interface RequestOptions<T> {
  schema: ParseSchema<T>;
  body?: unknown;
  /** `required` (default): fail fast without a token instead of earning a 401. */
  auth?: AuthMode;
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(
    method: string,
    path: string,
    options: RequestOptions<T>,
  ): Promise<{ status: number; data: T }>;
  /** GET a text/* resource (CSV export) with the bearer. */
  text(path: string, signal?: AbortSignal): Promise<string>;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | undefined>;
  /**
   * Called on a 401 so the session can be renewed or dropped. `sentToken` is the bearer the
   * rejected request carried (`undefined` when there was none to send).
   */
  onUnauthorized?: (sentToken: string | undefined) => void;
  fetchImpl?: typeof fetch;
}

async function readBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A non-2xx body outside the `{ code, message }` contract. API Gateway answers its own
 * rejections, before the Lambda runs, with `{ "message": "Unauthorized" }` (JWT authorizer:
 * expired or invalid token) or `{ "message": "Too Many Requests" }` (stage throttling), so the
 * status decides the code and the gateway's `message` is kept.
 */
export function errorFromUncontractedBody(status: number, payload: unknown): ApiError {
  const text =
    typeof payload === 'string' && payload.trim().length > 0
      ? payload.trim()
      : isRecord(payload) && typeof payload.message === 'string' && payload.message.length > 0
        ? payload.message
        : `Request failed with status ${status}`;
  const message = text.slice(0, 200);
  if (status === 401) {
    return new ApiError(status, 'UNAUTHORIZED', message);
  }
  if (status === 429) {
    return new ApiError(status, 'TOO_MANY_REQUESTS', message);
  }
  return new ApiError(status, `HTTP_${status}`, message);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function send(
    method: string,
    path: string,
    body: unknown,
    auth: AuthMode,
    accept: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept };
    let token: string | undefined;
    if (auth !== 'none') {
      token = await options.getToken();
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      } else if (auth === 'required') {
        options.onUnauthorized?.(undefined);
        throw new ApiError(401, 'UNAUTHORIZED', 'Please sign in to continue');
      }
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        mode: 'cors',
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ApiError(
        0,
        'NETWORK',
        'Could not reach the server. Check your connection and retry.',
      );
    }
    if (!response.ok) {
      const payload = await readBody(response);
      const parsed = ErrorBodySchema.safeParse(payload);
      if (response.status === 401) {
        options.onUnauthorized?.(token);
      }
      if (parsed.success) {
        throw new ApiError(response.status, parsed.data.code, parsed.data.message);
      }
      throw errorFromUncontractedBody(response.status, payload);
    }
    return response;
  }

  return {
    baseUrl,
    async request(method, path, { schema, body, auth = 'required', signal }) {
      const response = await send(method, path, body, auth, 'application/json', signal);
      const payload = await readBody(response);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError(
          response.status,
          'INVALID_RESPONSE',
          `Unexpected response from ${method} ${path}: ${parsed.error.message}`,
        );
      }
      return { status: response.status, data: parsed.data };
    },
    async text(path, signal) {
      const response = await send(
        'GET',
        path,
        undefined,
        'required',
        'text/csv, text/plain',
        signal,
      );
      return response.text();
    },
  };
}
