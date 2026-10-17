# @seatrelay/replay

Mechanism-comparison simulation (plan §2.2 PER_SESSION baseline, §4 "Mechanism comparison"):
the same arrival and behaviour stream is replayed through the real engine (`@seatrelay/core`
`decide()`; its `Change[]` is applied to the live snapshot by `src/store.ts`, the in-place
equivalent of `applyChanges()`, verified against it in the tests) under **UNIFIED** mode (one registration with the full preference
list, one queue, at most one hold per person) and under **PER_SESSION** mode (one registration per
acceptable session, one queue per session, no cross-session constraint). Pure core, simulated
clock, no AWS, no `Math.random`.

```
pnpm replay                       # 1,000 seeds → <repo>/results/replay/{raw.csv,summary.md,*.svg}
pnpm replay --seeds 50            # quick run
pnpm replay --seeds 200 --out /tmp/replay --workers 2 --bootstrap 500 --check
```

| flag | default | meaning |
| --- | --- | --- |
| `--seeds <n>` | 1000 | number of scenarios (each replayed under both modes) |
| `--start-seed <n>` | 1 | first seed |
| `--out <dir>` | `<repo>/results/replay` | output directory (created) |
| `--workers <n>` | available CPUs | worker threads (seeds are handed out largest-first to idle workers; output order is by seed) |
| `--bootstrap <n>` | 2000 | resamples for the 95 % bootstrap CIs (PRNG seed 20261016) |
| `--check` | off | run `checkInvariants` after every decision (slow); off = at the end of every run |

## Modules

| file | contents |
| --- | --- |
| `src/prng.ts` | mulberry32 PRNG, `mixSeed` for derived streams |
| `src/generator.ts` | `generateScenario(seed)`: 2–5 sessions (capacity 5–30), 1.2–3× oversubscription, front-loaded arrivals over 1–72 h, 1–3 acceptable sessions per participant drawn by session popularity, holdSeconds 60–900, cut-offs 30 min before start, and a pre-drawn behaviour stream per participant (accept / decline / no-response per session with a response delay, cancellation, abandonment, PER_SESSION clean-up and "second offer" reaction) |
| `src/simulate.ts` | discrete-event loop: arrivals → REGISTER, OFFER notifications → ACCEPT/DECLINE after the participant's delay, every engine timer / `nextDueAt` / cut-off → TICK, CONFIRMED → optional cancellation and clean-up; every state change is a `decide()` call, continuations included |
| `src/store.ts` | `applyChangesInPlace()`: the replay's storage adapter (same mapping as core's `applyChanges()`, without the second deep copy per decision) |
| `src/metrics.ts` | per-run metrics (below) computed from the engine's writes, snapshots and backfill records |
| `src/stats.ts` | mean / quantiles / seeded percentile bootstrap |
| `src/report.ts` | `raw.csv` (one row per seed × mode), `summary.md` (mean, median, 95 % CI per metric and mode, paired difference), dependency-free SVG box charts |
| `src/runner.ts`, `src/worker.ts`, `src/worker-entry.mjs`, `src/main.ts` | seed runner (worker threads, largest seeds first, handed out dynamically) and the CLI |

## Metrics (per run)

- **duplicate holds**: a (user, moment) where the user holds ≥ 2 OFFERED/CONFIRMED seats across sessions — `dup_hold_events` (user reaches ≥ 2 holds), `dup_hold_peak_users`, `dup_hold_seat_hours` (∫ Σ max(0, holds − 1) dt). UNIFIED forbids this (C2), so 0 doubles as an invariant check.
- **distinct participants served** (`distinct_served`): distinct users CONFIRMED after the last cut-off; `duplicate_confirmed` = confirmed seats − distinct users (the organiser's manual clean-up proxy); `fill_rate` = served / total capacity.
- **seats wasted** (`seats_wasted`): Σ sessions (capacity − confirmed) read at each session's cut-off.
- **backfill relay latency** (`backfill_relay_ms_*`): `reallocatedAt − releasedAt` of the engine's BackfillRecords. Timers are ideal in the replay, so this is the pure engine latency (0 ms: relayed in the same decision); infrastructure latency is measured on the deployed system.
- **seat refill time** (`seat_refill_min_*`): for every released seat (expiry, decline, cancellation) with somebody waiting, minutes until the relay chain ends in a confirmation by a participant who does not already hold a confirmed seat (released → offered → expired/declined → re-offered → … → accepted; a hoarded duplicate acceptance is followed to its later cancellation); chains that never reach a genuine confirmation are counted as censored.
- plus offer / cancellation / cut-off counts, decisions, rejections and `invariant_violations`.

`summary.md` reports mean, median and 95 % bootstrap CI per metric and mode, the paired per-seed difference PER_SESSION − UNIFIED with its CI, pooled sample statistics, the scenario parameter distribution and sanity totals.

## Determinism and tests

A seed fully determines the scenario and both replays (the event queue is ordered by time and
scheduling sequence; ids are counters). `pnpm --filter @seatrelay/replay test` checks that one seed
reproduces identical output twice, that `checkInvariants` holds after every decision in both modes,
that no due offer is ever left live, that UNIFIED has zero duplicate holds, and that the report is
deterministic.
