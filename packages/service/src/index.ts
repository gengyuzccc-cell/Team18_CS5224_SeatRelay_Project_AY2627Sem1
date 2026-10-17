/**
 * @seatrelay/service — framework-agnostic application layer (CONVENTIONS §5):
 * ports, the HTTP route table (`createApiApp`), worker orchestration (`processCommand`),
 * read models, CSV export and in-memory adapters for tests.
 */
export * from './ports';
export * from './errors';
export * from './commands';
export * from './workshops';
export * from './views';
export * from './csv';
export {
  CSV_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  errorResponse,
  json,
  mapError,
  matchRoute,
  normaliseHeaders,
  normalisePath,
  parseBody,
  text,
  toWireResponse,
  validateParams,
  type ApiRequest,
  type ApiResponse,
  type HttpMethod,
  type Route,
  type RouteAuth,
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
  type RouteMatch,
} from './api/http';
export {
  assertOrganiser,
  isOrgMember,
  requireOrgMember,
  requireOrgWorkshop,
  requireWorkshop,
  requireWorkshopOrganiser,
  type ApiAppConfig,
  type ApiRoute,
  type OrganiserScope,
} from './api/context';
export { API_ROUTES, API_ROUTE_TABLE, createApiApp, type ApiApp } from './api/app';
export { commandAcceptedView } from './api/routes/commands';
export {
  DEFAULT_MAX_VERSION_RETRIES,
  FaultInjectedError,
  SWEEP_LATE_GRACE_MS,
  VersionConflictError,
  isOrganizerCommandType,
  processCommand,
  rejectedDecision,
  type ProcessCommandOptions,
  type ProcessCommandResult,
  type ProcessOutcome,
} from './worker/processCommand';
export { runSweep, type SweepPorts, type SweepResult } from './worker/sweep';
export * from './memory/index';
