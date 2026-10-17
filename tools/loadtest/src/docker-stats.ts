#!/usr/bin/env tsx
import path from 'node:path';
import { intOption, log, parseCli, RESULTS_DIR, runMain, stringOption } from '@seatrelay/scripts';
import { createDockerStatsSampler, DEFAULT_CONTAINER_PREFIX } from './lib/dockerStats';
import { durationToMs } from './lib/matrix';

const USAGE = `
docker-stats — sample \`docker stats\` (CPU %, memory, network, block I/O, PIDs) of the local
containers into a CSV while a load test runs (plan §2.7). run-matrix does this by itself for
--target local; use this standalone when running k6 by hand.

  pnpm --filter @seatrelay/loadtest docker-stats -- [options]

Options
  --out FILE           CSV file (default results/loadtest/<date>-local/docker-stats.csv)
  --interval MS        sampling interval in ms (default 2000)
  --prefix NAME        container name prefix to keep (default seatrelay-local-)
  --duration DUR       stop after this long (default: run until Ctrl-C / SIGTERM)
`;

runMain(async () => {
  const { values } = parseCli(
    {
      out: { type: 'string' },
      interval: { type: 'string' },
      prefix: { type: 'string' },
      duration: { type: 'string' },
    },
    USAGE,
  );
  const date = new Date().toISOString().slice(0, 10);
  const outFile = path.resolve(
    stringOption(values, 'out') ??
      path.join(RESULTS_DIR, 'loadtest', `${date}-local`, 'docker-stats.csv'),
  );
  const prefix = stringOption(values, 'prefix', DEFAULT_CONTAINER_PREFIX) as string;
  const sampler = createDockerStatsSampler({
    outFile,
    intervalMs: intOption(values, 'interval', 2000),
    filter: (name) => name.startsWith(prefix),
    onError: (error) =>
      log('sample failed', { error: error instanceof Error ? error.message : String(error) }),
  });
  log('sampling', { outFile, prefix });
  sampler.start();

  const durationText = stringOption(values, 'duration');
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (durationText !== undefined) {
      setTimeout(stop, durationToMs(durationText));
    }
  });
  await sampler.stop();
  log('stopped', { samples: sampler.samples, errors: sampler.errors });
  process.stdout.write(
    `${JSON.stringify({ outFile, samples: sampler.samples, errors: sampler.errors })}\n`,
  );
});
