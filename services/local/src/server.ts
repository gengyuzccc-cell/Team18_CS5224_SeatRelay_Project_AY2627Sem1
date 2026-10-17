import cors from '@fastify/cors';
import type { ErrorBody } from '@seatrelay/contracts';
import { normaliseHeaders, toWireResponse, type ApiApp, type ApiRequest } from '@seatrelay/service';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { PostgresUserDirectory } from './adapters/postgres/users';
import { AuthError, bearerToken, type TokenVerifier } from './auth';
import { errorFields, type LocalLogger } from './logger';
import type { LocalMetrics } from './metrics';

export interface ServerDeps {
  api: ApiApp;
  verifier: TokenVerifier;
  logger: LocalLogger;
  metrics: LocalMetrics;
  /** Allowed browser origins (CORS); empty = any origin (dev convenience). */
  webOrigins: readonly string[];
  /** Records the identity of each authenticated request for the e-mail → userId lookup. */
  users?: PostgresUserDirectory;
}

const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Routes polled by browsers/k6 at high rate: logged at debug level only. */
const QUIET_PATHS = [/^\/commands\/[^/]+$/, /^\/health$/, /^\/metrics$/];

/**
 * Fastify 5 as a thin adapter around `createApiApp().handle` (CONVENTIONS §5): one catch-all
 * route per method converts the request to an `ApiRequest` (JWT verified here, identity passed
 * as `user`), and writes the `ApiResponse` back. Plus `/public/workshops/:wsId` (anonymous view,
 * never touches the token) and `/metrics` (the in-process metric summary).
 */
export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { api, verifier, logger, metrics, webOrigins, users } = deps;
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: true });

  await app.register(cors, {
    origin: webOrigins.length > 0 ? [...webOrigins] : true,
    methods: [...API_METHODS, 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });

  // Accept an empty JSON body (e.g. `POST /me/notifications/:id/read`) as "no body".
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim().length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error('Malformed JSON body') as FastifyError;
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    const body: ErrorBody =
      status >= 500
        ? { code: 'INTERNAL', message: 'Internal error' }
        : { code: 'VALIDATION_ERROR', message: error.message };
    if (status >= 500) {
      logger.error('unhandled server error', {
        method: request.method,
        path: request.url,
        ...errorFields(error),
      });
    }
    void reply.code(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` };
    void reply.code(404).send(body);
  });

  app.get('/metrics', async () => metrics.snapshot());

  app.get<{ Params: { wsId: string } }>('/public/workshops/:wsId', async (request, reply) => {
    const response = await api.handle({
      method: 'GET',
      path: `/workshops/${encodeURIComponent(request.params.wsId)}`,
      headers: {},
      query: {},
    });
    return send(reply, response);
  });

  app.route({
    method: [...API_METHODS],
    url: '/*',
    handler: async (request, reply) => {
      const startedAt = process.hrtime.bigint();
      const path = request.url.split('?')[0] ?? '/';
      const apiRequest: ApiRequest = {
        method: request.method,
        path,
        headers: normaliseHeaders(flattenHeaders(request.headers)),
        query: flattenQuery(request.query),
      };
      if (request.body !== undefined && request.body !== null) {
        apiRequest.body = request.body;
      }

      const token = bearerToken(request.headers.authorization);
      if (token !== undefined) {
        try {
          apiRequest.user = await verifier.verify(token);
        } catch (error) {
          const message = error instanceof AuthError ? error.message : 'invalid token';
          logger.info('request rejected: unauthorized', { method: request.method, path, reason: message });
          const body: ErrorBody = { code: 'UNAUTHORIZED', message };
          return reply.code(401).send(body);
        }
        if (users !== undefined) {
          users.touch(apiRequest.user).catch((error: unknown) => {
            logger.warn('user directory update failed', errorFields(error));
          });
        }
      }

      const response = await api.handle(apiRequest);
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const quiet = QUIET_PATHS.some((pattern) => pattern.test(path));
      const line = {
        method: request.method,
        path,
        status: response.status,
        latencyMs: Math.round(latencyMs * 10) / 10,
        ...(apiRequest.user === undefined ? {} : { userId: apiRequest.user.userId }),
      };
      if (response.status >= 500) {
        logger.error('request failed', line);
      } else if (quiet && response.status < 400) {
        logger.debug('request', line);
      } else {
        logger.info('request', line);
      }
      return send(reply, response);
    },
  });

  return app;
}

function send(reply: FastifyReply, response: Parameters<typeof toWireResponse>[0]): FastifyReply {
  const wire = toWireResponse(response);
  void reply.code(wire.status);
  for (const [name, value] of Object.entries(wire.headers)) {
    void reply.header(name, value);
  }
  return reply.send(wire.body);
}

function flattenHeaders(headers: FastifyRequest['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function flattenQuery(query: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (typeof query !== 'object' || query === null) {
    return out;
  }
  for (const [name, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[name] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      out[name] = value[0];
    }
  }
  return out;
}
