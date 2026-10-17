import type { LogFields, Logger } from '@seatrelay/service';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LocalLogger extends Logger {
  debug(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. `{ component: 'worker' }`). */
  child(fields: LogFields): LocalLogger;
}

/**
 * Structured JSON lines (CONVENTIONS §7): one object per line with `time`, `level`, `msg` and
 * the fields (`commandId`, `workshopId`, … where available). Lines at or above `level` only.
 */
export function createLogger(level: LogLevel = 'info', base: LogFields = {}): LocalLogger {
  const threshold = LEVEL_RANK[level];
  const write = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[entryLevel] < threshold) {
      return;
    }
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...base,
      ...fields,
    });
    if (entryLevel === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error: error.message, errorName: error.name, stack: error.stack };
  }
  return { error: String(error) };
}
