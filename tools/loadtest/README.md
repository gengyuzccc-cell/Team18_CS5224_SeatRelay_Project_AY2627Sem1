# @seatrelay/loadtest — k6 scenarios and the performance matrix

Plan §3 step 15 / §4 "Performance": two k6 scenarios, run at 10 / 25 / 50 VUs with a warm-up
and three measured rounds each, against the dev stage or the local compose stack with the
same scripts. Results land in `results/loadtest/<date>/` (raw CSV + summary.md; one directory
per day collects every target and invocation).

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

Environment read by the k6 scripts:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET` | `local` | name used for the default cache / scenario file and the summary tags |
| `TARGET_API` | `http://localhost:3000` | API base URL |
| `TOKEN_CACHE` | `../.token-cache.<TARGET>.json` | token cache; relative paths are resolved from `scripts/` (k6 `open()`) |
| `SCENARIO_FILE` | `../.scenario.<TARGET>.json` | written by `prepare-scenario` |
| `WORKSHOP_IDS` | – | overrides the scenario file: JSON array `'["id1","id2"]'` or `id1,id2` |
| `WORKSHOP_COUNT` | all | use only the first N workshops (e.g. cross-workshop over 5 of the 10) |
| `VUS`, `ROUND` | `10`, `1` | plateau VUs and the round label of the output file |
| `WARMUP`, `DURATION` | `30s`, `60s` | warm-up ramp and measured plateau |
| `OUT_DIR` | `results/loadtest` | where `handleSummary` writes `<scenario>-<vus>-<round>.json`, relative to the **current directory**; it must exist (k6 cannot create directories and only logs an error when it is missing) |
| `POLL_TIMEOUT_MS` | `30000` | give up polling one command (counted in `settle_timeouts`) |
| `THINK_TIME_S` | `0` | pause between iterations |

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

# 3a. one run by hand (from the repository root; OUT_DIR must exist)
mkdir -p results/loadtest
TARGET=local VUS=10 ROUND=1 k6 run tools/loadtest/scripts/hotspot.js
TARGET=local VUS=2 ROUND=1 WARMUP=5s DURATION=15s k6 run tools/loadtest/scripts/hotspot.js   # 20 s smoke

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
18 k6 command lines). Before the first run it checks that the token cache has one account per
VU of the largest level and that the tokens outlive the estimated matrix (~35 min for the
default matrix), and that `docker stats` works (local; otherwise a note and no sampling). It
writes after every run, so a partial matrix still has its rows. Relative path options are
resolved against the directory the command was typed in.

### Output (`results/loadtest/<date>/`)

One directory per day. Every invocation merges its rows into `runs.json` (a re-run of the
same target / scenario / VUs / round replaces the older row) and rebuilds `raw.csv` and
`summary.md` from all of them, so the local and the dev matrix of the same day end up side by
side and a failed run can be repeated alone (`--scenarios hotspot --vus 50 --rounds 1` replaces
round 1 of that level).

| File | Content |
| --- | --- |
| `raw.csv` | one row per run: scenario, target, VUs, round, timestamps (start, start of the measured phase, end), warm-up / duration, git commit (`-dirty` when tracked files differed from HEAD), iterations, http_reqs, error rate, p50/p95 of read / 202 / poll / settle (client) / settle (server), polls per command, rejected, timeouts, k6 threshold result, SQS depth max, oldest message age max, CloudWatch `CommandSettledLatency` p95 and sample count, k6 exit note |
| `summary.md` | per target and scenario a table of every run and a per-level table (median of the rounds) checked against the plan §4 targets; the target's API and notes (e.g. CloudWatch skipped) |
| `runs.json` | the accumulated rows + API/notes per target (source of the two files above) |
| `k6/<target>/*.json` | the k6 `handleSummary` files (`<scenario>-<vus>-<round>.json`) |
| `logs/<target>/*.log` | k6 output per run |
| `docker-stats.csv` | local only: `ts, container, cpuPercent, memUsageMiB, memLimitMiB, memPercent, netInputBytes, netOutputBytes, blockInputBytes, blockOutputBytes, pids` every 2 s for the `seatrelay-local-*` containers while the matrix runs (appended; join on each run's start/end) |

CloudWatch (`--target dev`, needs credentials; skipped with a note otherwise): for each run's
measured window `GetMetricData` of `AWS/SQS ApproximateNumberOfMessagesVisible` /
`ApproximateAgeOfOldestMessage` (Maximum, queue `seatrelay-<stage>-commands.fifo`) and
`SeatRelay CommandSettledLatency` (p95 and SampleCount, dimension `service=worker`, the
Powertools service name of the worker function).

`docker-stats` standalone (when running k6 by hand): `pnpm --filter @seatrelay/loadtest
docker-stats -- [--out FILE] [--interval 2000] [--prefix seatrelay-local-] [--duration 2m]`
appends to `results/loadtest/<date>/docker-stats.csv` until Ctrl-C or `--duration`. It exits
at once with a clear message when Docker is not reachable and warns when no
`seatrelay-local-*` container is running. A sample is skipped rather than overlapped when the
previous `docker stats` call (≈ 2 s itself) is still running.

### Node tooling environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TARGET_API` | prepare-scenario, run-matrix | API base URL (`--api` wins; default per target / `ApiUrl` of `seatrelay-app-<stage>`) |
| `K6_BIN` | run-matrix | k6 binary (`--k6` wins; default `k6` on PATH) |
| `AWS_REGION` / `AWS_DEFAULT_REGION`, `AWS_PROFILE`, … | run-matrix (dev), prepare-scenario (dev) | stack lookup and CloudWatch; without credentials the CloudWatch columns are skipped with a note |
| `KEYCLOAK_*`, `COGNITO_*` | prepare-scenario | identity provider of the organiser account (see `tools/scripts/README.md`) |

## Checks

```bash
pnpm --filter @seatrelay/loadtest typecheck
pnpm --filter @seatrelay/loadtest test       # summary parsing, matrix/CSV/markdown, CloudWatch (aws-sdk-client-mock), docker stats parsing + sampler
k6 inspect tools/loadtest/scripts/hotspot.js
k6 inspect tools/loadtest/scripts/cross-workshop.js
```

The k6 scripts are excluded from ESLint (they run in the k6 runtime, not Node).
