import { z } from 'zod';

/**
 * Configuration comes from environment variables only (CONVENTIONS §7). Every variable is
 * documented in README.md; defaults match docker-compose.yml.
 */

const bool = z
  .string()
  .optional()
  .transform((value) => value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()));

const intWithDefault = (fallback: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().min(min));

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

export const EnvSchema = z.object({
  PORT: intWithDefault(3000),
  HOST: z.string().default('0.0.0.0'),
  STAGE: z.string().default('local'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  PG_POOL_SIZE: intWithDefault(10),

  OIDC_ISSUER: z.string().min(1),
  OIDC_JWKS_URL: z.string().min(1),
  OIDC_AUDIENCE: csv,

  SMTP_URL: z.string().optional(),
  SENDER_EMAIL: z.string().default('seatrelay@local.test'),
  EMAIL_ENABLED: bool,

  ALLOW_FAULT_FLAGS: bool,
  WEB_ORIGIN: csv,

  WORKER_POLL_MS: intWithDefault(200, 10),
  WORKER_MAX_ATTEMPTS: intWithDefault(3),
  WORKER_RETRY_BACKOFF_MS: intWithDefault(1000, 0),
  TIMER_POLL_MS: intWithDefault(1000, 10),
  NOTIFIER_POLL_MS: intWithDefault(1000, 10),
  NOTIFIER_MAX_ATTEMPTS: intWithDefault(3),
  SWEEP_INTERVAL_MS: intWithDefault(5 * 60_000, 1000),
  JANITOR_INTERVAL_MS: intWithDefault(10 * 60_000, 1000),
  METRICS_FLUSH_MS: intWithDefault(60_000, 1000),
});

export type Env = z.infer<typeof EnvSchema>;

export interface LocalConfig {
  port: number;
  host: string;
  stage: string;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  pgPoolSize: number;
  oidc: { issuer: string; jwksUrl: string; audience: string[] };
  smtpUrl?: string;
  senderEmail: string;
  emailEnabled: boolean;
  allowFaultFlags: boolean;
  webOrigins: string[];
  workerPollMs: number;
  workerMaxAttempts: number;
  workerRetryBackoffMs: number;
  timerPollMs: number;
  notifierPollMs: number;
  notifierMaxAttempts: number;
  sweepIntervalMs: number;
  janitorIntervalMs: number;
  metricsFlushMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const config: LocalConfig = {
    port: e.PORT,
    host: e.HOST,
    stage: e.STAGE,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    pgPoolSize: e.PG_POOL_SIZE,
    oidc: { issuer: e.OIDC_ISSUER, jwksUrl: e.OIDC_JWKS_URL, audience: e.OIDC_AUDIENCE },
    senderEmail: e.SENDER_EMAIL,
    emailEnabled: e.EMAIL_ENABLED,
    allowFaultFlags: e.ALLOW_FAULT_FLAGS,
    webOrigins: e.WEB_ORIGIN,
    workerPollMs: e.WORKER_POLL_MS,
    workerMaxAttempts: e.WORKER_MAX_ATTEMPTS,
    workerRetryBackoffMs: e.WORKER_RETRY_BACKOFF_MS,
    timerPollMs: e.TIMER_POLL_MS,
    notifierPollMs: e.NOTIFIER_POLL_MS,
    notifierMaxAttempts: e.NOTIFIER_MAX_ATTEMPTS,
    sweepIntervalMs: e.SWEEP_INTERVAL_MS,
    janitorIntervalMs: e.JANITOR_INTERVAL_MS,
    metricsFlushMs: e.METRICS_FLUSH_MS,
  };
  if (e.SMTP_URL !== undefined && e.SMTP_URL !== '') {
    config.smtpUrl = e.SMTP_URL;
  }
  return config;
}
