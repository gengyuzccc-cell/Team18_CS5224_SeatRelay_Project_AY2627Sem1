import {
  createApiApp,
  systemClock,
  uuidIdGen,
  type ApiApp,
  type ApiAppConfig,
  type WorkerPorts,
} from '@seatrelay/service';
import { DynamoWorkshopStore } from '../adapters/dynamo/store';
import { SqsCommandQueue, SqsTimerScheduler } from '../adapters/sqs';
import { documentClient, sqsClient } from './clients';
import { STAGE, envFlag, requireEnv } from './env';
import { createLambdaRuntime, lazy, type LambdaRuntime } from './runtime';

/**
 * Production wiring of the service ports on AWS (plan §2.4). Everything is created lazily on
 * first use so that importing a handler module never needs the environment.
 */
export const runtime = lazy((): LambdaRuntime => createLambdaRuntime());

export const store = lazy(() => new DynamoWorkshopStore(documentClient(), requireEnv('TABLE_NAME')));

export const commandQueue = lazy(
  () => new SqsCommandQueue(sqsClient(), requireEnv('COMMANDS_QUEUE_URL'), systemClock),
);

export const timerScheduler = lazy(
  () => new SqsTimerScheduler(sqsClient(), requireEnv('EXPIRY_DELAY_QUEUE_URL'), systemClock),
);

export const workerPorts = lazy(
  (): WorkerPorts => ({
    store: store(),
    queue: commandQueue(),
    timers: timerScheduler(),
    clock: systemClock,
    ids: uuidIdGen,
    logger: runtime().logger,
    metrics: runtime().metrics,
  }),
);

export const apiConfig = lazy(
  (): ApiAppConfig => ({
    store: store(),
    queue: commandQueue(),
    clock: systemClock,
    ids: uuidIdGen,
    logger: runtime().logger,
    allowFaultFlags: envFlag('ALLOW_FAULT_FLAGS'),
    stage: STAGE(),
    serviceName: 'seatrelay',
  }),
);

export const apiApp = lazy((): ApiApp => createApiApp(apiConfig()));
