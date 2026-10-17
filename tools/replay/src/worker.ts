import { parentPort, workerData } from 'node:worker_threads';
import { runSeed, type WorkerMessage, type WorkerTask } from './runner';

/** Worker-thread entry: runs the seeds the main thread hands out, one message per seed. */
const { checkInvariants } = workerData as { checkInvariants: boolean };
const port = parentPort;
if (port === null) {
  throw new Error('worker.ts must run in a worker thread');
}
port.on('message', (task: WorkerTask) => {
  if ('done' in task) {
    port.close();
    return;
  }
  const message: WorkerMessage = { seed: task.seed, rows: runSeed(task.seed, checkInvariants) };
  port.postMessage(message);
});
