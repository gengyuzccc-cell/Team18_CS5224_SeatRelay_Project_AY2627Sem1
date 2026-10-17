// cross-workshop: the load is spread over N (default 10) workshops; VU v always uses workshop
// v mod N, so the per-workshop serialisation is not the bottleneck.
//
//   TARGET=local TARGET_API=http://localhost:3000 VUS=10 ROUND=1 WARMUP=30s DURATION=60s \
//   OUT_DIR=results/loadtest k6 run tools/loadtest/scripts/cross-workshop.js
//
// Same prerequisites as hotspot.js; WORKSHOP_IDS='["id1","id2",…]' overrides the scenario file.
import exec from 'k6/execution';
import { buildOptions, makeSummaryHandler, runIteration, setupScenario } from './lib.js';

const NAME = 'cross-workshop';

export const options = buildOptions(NAME);

export function setup() {
  return setupScenario(NAME);
}

export default function (data) {
  const wsId = data.workshopIds[(exec.vu.idInTest - 1) % data.workshopIds.length];
  runIteration(data, wsId);
}

export const handleSummary = makeSummaryHandler(NAME);
