import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, errorFromUncontractedBody } from '../src/api/client';
import { describeError } from '../src/util/errors';

const okSchema = {
  safeParse: (input: unknown) => ({ success: true as const, data: input }),
};

/** `token: null` = signed out (no bearer to send). */
function clientAnswering(status: number, body: string, token: string | null = 'id-token-1') {
  const onUnauthorized = vi.fn();
  const fetchImpl = vi.fn(
    async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
  );
  const client = createApiClient({
    baseUrl: 'https://api.example.test/',
    getToken: async () => token ?? undefined,
    onUnauthorized,
    fetchImpl,
  });
  return { client, onUnauthorized, fetchImpl };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('API client error bodies', () => {
  it('maps the API Gateway JWT authorizer 401 to UNAUTHORIZED (session-expired copy)', async () => {
    const { client, onUnauthorized } = clientAnswering(401, '{"message":"Unauthorized"}');
    const error = await failure(client.request('GET', '/me', { schema: okSchema }));
    expect(error.code).toBe('UNAUTHORIZED');
    expect(describeError(error)).toBe('Your session has expired; please sign in again.');
    expect(onUnauthorized).toHaveBeenCalledWith('id-token-1');
  });

  it('maps API Gateway throttling (429) to TOO_MANY_REQUESTS', async () => {
    const { client } = clientAnswering(429, '{"message":"Too Many Requests"}');
    const error = await failure(client.request('GET', '/me', { schema: okSchema }));
    expect(error.code).toBe('TOO_MANY_REQUESTS');
    expect(describeError(error)).toBe(
      'Too many requests right now; please wait a moment and retry.',
    );
  });

  it("keeps the gateway's message for other statuses", () => {
    const error = errorFromUncontractedBody(503, { message: 'Service Unavailable' });
    expect(error).toMatchObject({ status: 503, code: 'HTTP_503', message: 'Service Unavailable' });
    expect(errorFromUncontractedBody(502, undefined).message).toBe(
      'Request failed with status 502',
    );
    expect(errorFromUncontractedBody(500, '  upstream timeout ').message).toBe('upstream timeout');
  });

  it('still uses the { code, message } contract when the API itself answers', async () => {
    const { client } = clientAnswering(
      403,
      '{"code":"FORBIDDEN","message":"Not an organiser of this workshop"}',
    );
    const error = await failure(client.request('GET', '/orgs/o/workshops', { schema: okSchema }));
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('reports a missing token without sending the request', async () => {
    const { client, onUnauthorized, fetchImpl } = clientAnswering(200, '{}', null);
    const error = await failure(client.request('GET', '/me', { schema: okSchema }));
    expect(error.code).toBe('UNAUTHORIZED');
    expect(onUnauthorized).toHaveBeenCalledWith(undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
