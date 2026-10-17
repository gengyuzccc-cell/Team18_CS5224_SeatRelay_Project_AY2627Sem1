import type { ApiAppConfig, ApiRoute } from './context';
import {
  mapError,
  matchRoute,
  normalisePath,
  validateParams,
  type ApiRequest,
  type ApiResponse,
  type RouteContext,
  type RouteDefinition,
} from './http';
import { notFound, unauthorized } from '../errors';
import { commandRoutes } from './routes/commands';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { organiserRoutes } from './routes/organiser';
import { orgRoutes } from './routes/orgs';
import { workshopRoutes } from './routes/workshops';

/**
 * The complete route table (plan §2.5), in matching order. Both thin adapters mount it: the
 * Lambda `api` handler forwards every `GET|POST|PUT|PATCH|DELETE /{proxy+}` request to
 * `handle()`, and the Fastify server registers one route per entry (`pattern` is already in
 * Fastify's `:param` syntax) that delegates to `handle()`.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  ...healthRoutes,
  ...meRoutes,
  ...orgRoutes,
  ...workshopRoutes,
  ...commandRoutes,
  ...organiserRoutes,
];

/** Method/pattern/auth of every route, without handlers (for adapters and docs). */
export const API_ROUTE_TABLE: readonly RouteDefinition[] = API_ROUTES.map(
  ({ name, method, pattern, auth }) => ({ name, method, pattern, auth }),
);

export interface ApiApp {
  handle(req: ApiRequest): Promise<ApiResponse>;
  routes: readonly RouteDefinition[];
}

export function createApiApp(config: ApiAppConfig): ApiApp {
  return {
    routes: API_ROUTE_TABLE,
    async handle(req: ApiRequest): Promise<ApiResponse> {
      const method = req.method.toUpperCase();
      const path = normalisePath(req.path);
      const fields = {
        method,
        path,
        ...(req.user === undefined ? {} : { userId: req.user.userId }),
      };
      try {
        const match = matchRoute(API_ROUTES, method, path);
        if (match === undefined) {
          throw notFound(`No route for ${method} ${path}`);
        }
        validateParams(match.params);
        const { route, params } = match;
        if (route.auth === 'required' && req.user === undefined) {
          throw unauthorized();
        }
        const ctx: RouteContext = { req: { ...req, method, path }, params };
        if (route.auth !== 'none' && req.user !== undefined) {
          ctx.user = req.user;
        }
        return await route.handler(ctx, config);
      } catch (error) {
        return mapError(error, config.logger, fields);
      }
    },
  };
}
