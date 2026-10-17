#!/usr/bin/env tsx
/**
 * Serves the in-memory self-test target (see memoryServer.ts) until interrupted and writes a
 * token cache for it, so that any experiment script can be dry-run without Docker/AWS:
 *
 *   pnpm --filter @seatrelay/experiments exec tsx test/helpers/serve-memory.ts \
 *     --port 3999 --cache /tmp/fixture-tokens.json --count 120
 *   pnpm --filter @seatrelay/experiments correctness --target local \
 *     --api http://127.0.0.1:3999 --cache /tmp/fixture-tokens.json --no-create --out /tmp/dry
 *
 * Results obtained this way only show that a script runs; they are not measurements.
 */
import { parseArgs } from 'node:util';
import { startMemoryServer, writeFixtureTokenCache } from './memoryServer';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '3999' },
    cache: { type: 'string' },
    count: { type: 'string', default: '120' },
    'redelivery-ms': { type: 'string', default: '1000' },
    'sweep-ms': { type: 'string', default: '60000' },
  },
});
const server = await startMemoryServer({
  port: Number(values.port),
  redeliveryDelayMs: Number(values['redelivery-ms']),
  sweepMs: Number(values['sweep-ms']),
});
if (values.cache !== undefined) {
  writeFixtureTokenCache(values.cache, server, { count: Number(values.count) });
}
process.stderr.write(`memory fixture listening on ${server.url}${values.cache === undefined ? '' : `; token cache ${values.cache}`}\n`);
const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
