import { Logger as PowertoolsLogger } from '@aws-lambda-powertools/logger';
import type { Context } from 'aws-lambda';
import type { LogFields, Logger } from '@seatrelay/service';
import { SERVICE_NAME } from './env';

/**
 * Structured JSON logs through Powertools (CONVENTIONS §7). The service port only needs
 * info/warn/error with a fields object; `bind()` attaches the Lambda context (request id,
 * cold start) for one invocation and `unbind()` drops per-invocation keys.
 */
export class LambdaLogger implements Logger {
  readonly powertools: PowertoolsLogger;

  constructor(powertools?: PowertoolsLogger) {
    this.powertools = powertools ?? new PowertoolsLogger({ serviceName: SERVICE_NAME() });
  }

  info(message: string, fields: LogFields = {}): void {
    this.powertools.info(message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.powertools.warn(message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.powertools.error(message, fields);
  }

  bind(context: Context | undefined, keys: LogFields = {}): void {
    if (context !== undefined) {
      this.powertools.addContext(context);
    }
    if (Object.keys(keys).length > 0) {
      this.powertools.appendKeys(keys);
    }
  }

  unbind(): void {
    this.powertools.resetKeys();
  }
}

/** `{ error, stack }` fields for a caught value (the stack never leaves the log). */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error: error.message, errorName: error.name, stack: error.stack };
  }
  return { error: String(error) };
}
