import { createApiApp, systemClock, uuidIdGen } from '@seatrelay/service';
import { createPool, migrate } from './adapters/postgres/db';
import { PostgresCommandQueue, PostgresTimerScheduler } from './adapters/postgres/queue';
import { PostgresWorkshopStore } from './adapters/postgres/store';
import { PostgresUserDirectory } from './adapters/postgres/users';
import { createTokenVerifier } from './auth';
import { loadConfig } from './config';
import { createJanitor } from './janitor';
import { createLogger, errorFields } from './logger';
import type { Loop } from './loop';
import { LocalMetrics } from './metrics';
import { createNotifier, smtpMailer } from './notifier';
import { createServer } from './server';
import { createSweepLoop, createTimerLoop } from './timers';
import { createWorker } from './worker';

/**
 * The on-premise reference process (plan §2.7): schema migration, the Fastify API and the
 * in-process worker / timer / sweep / notifier / janitor loops, with graceful shutdown.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: 'seatrelay-local', stage: config.stage });

  const pool = createPool({ connectionString: config.databaseUrl, max: config.pgPoolSize });
  pool.on('error', (error) => logger.error('idle postgres client error', errorFields(error)));
  await migrate(pool);
  logger.info('schema applied');

  const store = new PostgresWorkshopStore(pool);
  const queue = new PostgresCommandQueue(pool);
  const timers = new PostgresTimerScheduler(pool);
  const users = new PostgresUserDirectory(pool);
  const metrics = new LocalMetrics();
  const clock = systemClock;
  const ids = uuidIdGen;

  const api = createApiApp({
    store,
    queue,
    clock,
    ids,
    logger: logger.child({ component: 'api' }),
    userDirectory: users,
    allowFaultFlags: config.allowFaultFlags,
    stage: config.stage,
    serviceName: 'seatrelay-local',
  });
  const verifier = createTokenVerifier(config.oidc);
  const server = await createServer({
    api,
    verifier,
    logger: logger.child({ component: 'http' }),
    metrics,
    webOrigins: config.webOrigins,
    users,
  });

  if (config.emailEnabled && config.smtpUrl === undefined) {
    logger.warn('EMAIL_ENABLED=true but SMTP_URL is not set; notifications will be SKIPPED');
  }
  const mailer =
    config.emailEnabled && config.smtpUrl !== undefined
      ? smtpMailer(config.smtpUrl, config.senderEmail)
      : undefined;

  const loops: Loop[] = [
    createWorker({
      pool,
      store,
      queue,
      timers,
      clock,
      ids,
      logger: logger.child({ component: 'worker' }),
      metrics,
      config: {
        pollMs: config.workerPollMs,
        maxAttempts: config.workerMaxAttempts,
        retryBackoffMs: config.workerRetryBackoffMs,
        faultInjection: config.allowFaultFlags,
      },
    }),
    createTimerLoop({ pool, logger: logger.child({ component: 'timers' }), pollMs: config.timerPollMs }),
    createSweepLoop({
      store,
      queue,
      clock,
      logger: logger.child({ component: 'sweep' }),
      intervalMs: config.sweepIntervalMs,
    }),
    createNotifier({
      pool,
      logger: logger.child({ component: 'notifier' }),
      metrics,
      pollMs: config.notifierPollMs,
      maxAttempts: config.notifierMaxAttempts,
      ...(mailer === undefined ? {} : { mailer }),
    }),
    createJanitor({ pool, logger: logger.child({ component: 'janitor' }), intervalMs: config.janitorIntervalMs }),
  ];

  await server.listen({ port: config.port, host: config.host });
  logger.info('api listening', {
    port: config.port,
    host: config.host,
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    webOrigins: config.webOrigins,
    allowFaultFlags: config.allowFaultFlags,
    emailEnabled: mailer !== undefined,
  });
  for (const loop of loops) {
    loop.start();
  }
  const flush = setInterval(() => {
    logger.info('metrics', metrics.snapshot());
  }, config.metricsFlushMs);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });
    clearInterval(flush);
    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    forceExit.unref();
    try {
      await Promise.all(loops.map((loop) => loop.stop()));
      await server.close();
      await pool.end();
      logger.info('metrics', metrics.snapshot());
      logger.info('bye');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', errorFields(error));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'startup failed', ...errorFields(error) })}\n`,
  );
  process.exit(1);
});
