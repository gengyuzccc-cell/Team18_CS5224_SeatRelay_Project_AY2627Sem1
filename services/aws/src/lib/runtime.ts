import type { Context } from 'aws-lambda';
import type { LogFields } from '@seatrelay/service';
import { LambdaLogger } from './logger';
import { LambdaMetrics } from './metrics';

/**
 * Per-invocation lifecycle shared by every handler: bind the Lambda context to the logger at
 * the start, flush metrics and drop per-invocation log keys at the end (also on errors).
 */
export interface InvocationLifecycle {
  begin(context: Context | undefined, keys?: LogFields): void;
  end(): void;
}

export const noopLifecycle: InvocationLifecycle = {
  begin: () => undefined,
  end: () => undefined,
};

export interface LambdaRuntime extends InvocationLifecycle {
  logger: LambdaLogger;
  metrics: LambdaMetrics;
}

export function createLambdaRuntime(): LambdaRuntime {
  const logger = new LambdaLogger();
  const metrics = new LambdaMetrics();
  return {
    logger,
    metrics,
    begin: (context, keys) => logger.bind(context, keys),
    end: () => {
      try {
        metrics.flush();
      } finally {
        logger.unbind();
      }
    },
  };
}

/** Memoises an expensive default (clients, ports) until first use, so tests never build it. */
export function lazy<T>(factory: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = factory();
      built = true;
    }
    return value as T;
  };
}
