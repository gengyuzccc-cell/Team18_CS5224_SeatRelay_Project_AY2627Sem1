// hotspot: every VU hammers the SAME workshop (one FIFO message group, one serialised path).
//
//   TARGET=local TARGET_API=http://localhost:3000 VUS=10 ROUND=1 WARMUP=30s DURATION=60s \
//   OUT_DIR=results/loadtest k6 run tools/loadtest/scripts/hotspot.js
//
// Needs tools/loadtest/.token-cache.<target>.json (get-tokens-keycloak / create-test-users)
// and tools/loadtest/.scenario.<target>.json (pnpm --filter @seatrelay/loadtest prepare-scenario),
// or WORKSHOP_IDS='["<wsId>"]'. OUT_DIR must exist.
import { buildOptions, makeSummaryHandler, runIteration, setupScenario } from './lib.js';

const NAME = 'hotspot';

export const options = buildOptions(NAME);

export function setup() {
  const data = setupScenario(NAME);
  return Object.assign({}, data, { workshopIds: data.workshopIds.slice(0, 1) });
}

export default function (data) {
  runIteration(data, data.workshopIds[0]);
}

export const handleSummary = makeSummaryHandler(NAME);
