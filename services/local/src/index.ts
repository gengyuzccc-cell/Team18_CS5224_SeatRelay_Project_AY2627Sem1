/**
 * @seatrelay/local — the on-premise reference deployment (plan §2.7): PostgreSQL adapters for
 * the service ports, the Fastify API adapter and the in-process worker / timer / notifier loops.
 * `src/main.ts` wires everything; these exports serve the tests and tooling.
 */
export {
  SCHEMA_SQL_PATH,
  atomic,
  createPool,
  iso,
  migrate,
  pgErrorCode,
  type Executor,
  type Queryable,
} from './adapters/postgres/db';
export { PostgresWorkshopStore } from './adapters/postgres/store';
export { PostgresCommandQueue, PostgresTimerScheduler } from './adapters/postgres/queue';
export { PostgresUserDirectory } from './adapters/postgres/users';
export {
  AuthError,
  bearerToken,
  createTokenVerifier,
  toAuthUser,
  type TokenVerifier,
  type TokenVerifierOptions,
} from './auth';
export { EnvSchema, loadConfig, type LocalConfig } from './config';
export { createLogger, errorFields, type LocalLogger, type LogLevel } from './logger';
export { createLoop, type Loop } from './loop';
export { LocalMetrics, type MetricSummary } from './metrics';
export { createJanitor, type JanitorReport } from './janitor';
export { createNotifier, smtpMailer, type Mailer, type Notifier, type NotifierBatch } from './notifier';
export { createServer, type ServerDeps } from './server';
export { createSweepLoop, createTimerLoop } from './timers';
export { createWorker, type Worker, type WorkerConfig, type WorkerStep } from './worker';
