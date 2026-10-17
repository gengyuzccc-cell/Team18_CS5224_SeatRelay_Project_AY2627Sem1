# @seatrelay/loadtest — k6 scenarios and the performance matrix

Plan §3 step 15 / §4 "Performance": two k6 scenarios, run at 10 / 25 / 50 VUs with a warm-up
and three measured rounds each, against the dev stage or the local compose stack with the
same scripts. Results land in `results/loadtest/<date>-<target>/` (raw CSV + summary.md).

```
scripts/cross-workshop.js   load spread over 10 workshops (VU v → workshop v mod 10)
scripts/hotspot.js          every VU on ONE workshop (one FIFO group, serialised path)
scripts/lib.js              shared VU flow, metrics, thresholds, summary (k6 runtime)
src/prepare.ts              creates the workshops (capacity 1000, hold 60 s) → .scenario.<target>.json
src/run-matrix.ts           runs the matrix with k6, collects raw.csv + summary.md (+ CloudWatch on dev)
src/docker-stats.ts         samples `docker stats` of the local containers (plan §2.7)
```

## VU flow and metrics

Each iteration: `GET /workshops/{id}` (tag `kind:read`) → `POST /workshops/{id}/commands`
REGISTER with a per-VU rotated preference list (`kind:command`, expects **202**) → poll
`GET /commands/{id}` every **200 ms** (`kind:poll`) until `APPLIED` / `REJECTED` → the same for
`CANCEL_REGISTRATION`, so VUs loop without exhausting seats. Requests are also tagged
`phase:warmup|measured`.

Custom metrics (measured phase only): `read_ms`, `command_ms` (the 202), `poll_ms`,
`settle_ms` (**client-observed** settle: POST start → poll that saw the terminal state, i.e.
including up to one 200 ms polling quantum), `server_settle_ms` (`settledAt − acceptedAt` from
the CommandResult), `polls_per_command`, `commands_failed` (non-202), `commands_rejected`
(engine rejections, tagged by reason), `settle_timeouts`, `iterations_measured`.

Thresholds (plan §4): `http_req_duration{kind:read,phase:measured}` and
`{kind:command,phase:measured}` p95 < 1000 ms, `read_ms` / `command_ms` p95 < 1000 ms,
`settle_ms` p95 < 5000 ms, `http_req_failed` rate < 1 %.

One k6 run = one `(VUS, ROUND)` pair: a `ramping-vus` scenario ramping 0 → VUS over `WARMUP`
(30 s) and holding VUS for `DURATION` (60 s). `handleSummary` writes
`OUT_DIR/<scenario>-<vus>-<round>.json` (k6 summary + a `seatrelay` block with the run
parameters) and prints a compact text summary.

Environment read by the scripts: `TARGET` (local|dev, default local), `TARGET_API`
(default `http://localhost:3000`), `TOKEN_CACHE` (default `../.token-cache.<target>.json`
relative to the script), `SCENARIO_FILE` (default `../.scenario.<target>.json`) or
`WORKSHOP_IDS='["id",…]'`, `VUS`, `ROUND`, `WARMUP`, `DURATION`, `OUT_DIR`
(default `results/loadtest`, must exist — k6 cannot create directories), `POLL_TIMEOUT_MS`
(30000), `THINK_TIME_S` (0).

`setup()` aborts with a clear message when the token cache is missing/expired, has fewer
users than VUs (every VU needs its own account, otherwise REGISTER is rejected with
`ALREADY_REGISTERED`), when a workshop is missing or not OPEN, or when `/health` fails.

## Running

```bash
# 1. accounts + tokens (one per VU; 60 covers the 50-VU level)
pnpm --filter @seatrelay/scripts get-tokens-keycloak -- --count 60 --prefix loaduser          # local
pnpm --filter @seatrelay/scripts create-test-users -- --count 60 --prefix loaduser --password 'Passw0rd!' --stage dev

# 2. workshops (10 for cross-workshop + 1 for hotspot, capacity 1000, hold 60 s)
pnpm --filter @seatrelay/loadtest prepare-scenario -- --target local        # or --target dev

# 3a. one run by hand
mkdir -p results/loadtest
TARGET=local VUS=10 ROUND=1 k6 run tools/loadtest/scripts/hotspot.js

# 3b. the whole matrix (2 scenarios × 10/25/50 VUs × 3 rounds, ~30 min)
pnpm --filter @seatrelay/loadtest run-matrix -- --target local
pnpm --filter @seatrelay/loadtest run-matrix -- --target dev
```

`prepare-scenario` (the pnpm script is not called `prepare` because pnpm would run that on
install) takes the organiser token from the token cache (`organiser@example.com` on local,
`loadtest.organiser@example.com` otherwise) or mints one, reuses/creates the organisation
"SeatRelay loadtest", cancels the workshops of the previous scenario file and writes
`tools/loadtest/.scenario.<target>.json` (git-ignored).

`run-matrix` options: `--scenarios`, `--vus`, `--rounds`, `--warmup`, `--duration`, `--pause`
(15 s between runs so queues drain), `--out`, `--date`, `--k6`, `--token-cache`,
`--scenario-file`, `--no-docker-stats`, `--no-cloudwatch`, `--stage`, `--dry-run` (prints the
18 k6 command lines). It writes after every run, so a partial matrix still has its rows.

### Output (`results/loadtest/<date>-<target>/`)

| File | Content |
| --- | --- |
| `raw.csv` | one row per run: scenario, VUs, round, timestamps, iterations, http_reqs, error rate, p50/p95 of read / 202 / poll / settle (client) / settle (server), polls per command, rejected, timeouts, k6 threshold result, SQS depth max, oldest message age max, CloudWatch `CommandSettledLatency` p95 and sample count |
| `summary.md` | per scenario a table of every run and a per-level table (median of the rounds) checked against the plan §4 targets; notes (e.g. CloudWatch skipped) |
| `summaries/*.json` | the k6 `handleSummary` files |
| `logs/*.log` | k6 output per run |
| `docker-stats.csv` | local only: `ts, container, cpuPercent, memUsageMiB, memLimitMiB, memPercent, netInputBytes, netOutputBytes, blockInputBytes, blockOutputBytes, pids` every 2 s for the `seatrelay-local-*` containers during the whole matrix |

CloudWatch (`--target dev`, needs credentials; skipped with a note otherwise): for each run's
measured window `GetMetricData` of `AWS/SQS ApproximateNumberOfMessagesVisible` /
`ApproximateAgeOfOldestMessage` (Maximum, queue `seatrelay-<stage>-commands.fifo`) and
`SeatRelay CommandSettledLatency` (p95 and SampleCount, dimension `service=worker`, the
Powertools service name of the worker function).

`docker-stats` standalone: `pnpm --filter @seatrelay/loadtest docker-stats -- --out results/loadtest/x/docker-stats.csv --duration 2m`.

## Checks

```bash
pnpm --filter @seatrelay/loadtest typecheck
pnpm --filter @seatrelay/loadtest test       # summary parsing, matrix/CSV/markdown, CloudWatch (aws-sdk-client-mock), docker stats parsing + sampler
k6 inspect tools/loadtest/scripts/hotspot.js
k6 inspect tools/loadtest/scripts/cross-workshop.js
```

The k6 scripts are excluded from ESLint (they run in the k6 runtime, not Node).
