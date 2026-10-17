/**
 * @seatrelay/aws — Lambda handlers and the DynamoDB / SQS / SES adapters that implement the
 * ports of `@seatrelay/service` (plan §2.3 / §2.4). The handler entry points are
 * `src/handlers/{api,worker,expiryForwarder,sweep,notifier}.ts` (each exports `handler`);
 * this index exposes the building blocks for tooling and tests.
 */
export * from './adapters/dynamo/keys';
export * from './adapters/dynamo/mapping';
export * from './adapters/dynamo/errors';
export {
  DEFAULT_TRANSIENT_RETRIES,
  DynamoWorkshopStore,
  MAX_TRANSACTION_ITEMS,
  TRANSIENT_BACKOFF_BASE_MS,
  TransactionTooLargeError,
  UniqueMarkerConflictError,
  type DynamoWorkshopStoreOptions,
} from './adapters/dynamo/store';
export {
  DynamoNotificationStatusStore,
  type NotificationStatusStore,
} from './adapters/dynamo/notifications';
export * from './adapters/sqs';
export * from './adapters/ses';
export * from './lib/env';
export * from './lib/auth';
export * from './lib/email';
export * from './lib/tokenBucket';
export { LambdaLogger, errorFields } from './lib/logger';
export {
  LambdaMetrics,
  METRICS_NAMESPACE,
  OPERATIONAL_METRIC_NAMES,
  type OperationalMetricName,
  type OperationalMetricsSink,
} from './lib/metrics';
export {
  createLambdaRuntime,
  lazy,
  noopLifecycle,
  type InvocationLifecycle,
  type LambdaRuntime,
} from './lib/runtime';
export {
  createApiHandler,
  parseEventBody,
  unusableCommandIdentity,
  type ApiHandler,
  type ApiHandlerDeps,
} from './handlers/api';
export {
  createWorkerHandler,
  deliveryAttemptOf,
  messageIdentifiers,
  parseCommandBody,
  type WorkerHandler,
  type WorkerHandlerDeps,
} from './handlers/worker';
export {
  RE_DELAY_THRESHOLD_MS,
  createExpiryForwarderHandler,
  parseTickBody,
  remainingMs,
  type ExpiryForwarderDeps,
  type ExpiryForwarderHandler,
} from './handlers/expiryForwarder';
export {
  createSweepHandler,
  type SweepHandler,
  type SweepHandlerDeps,
  type SweepSummary,
} from './handlers/sweep';
export {
  SENT_STATUS_WRITE_ATTEMPTS,
  createNotifierHandler,
  notificationOfRecord,
  type NotifierDeps,
  type NotifierHandler,
  type NotifierSummary,
} from './handlers/notifier';
