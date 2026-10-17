# @seatrelay/experiments

The system experiments of plan §4 (Table 3): one script per Table 3 row, plus the acceptance smoke
test, the metric fetchers and the Python analysis. Every script talks to a running deployment
through the public API exactly like the browser does (client-generated `commandId`, `POST` → `202`,
then `GET /commands/{id}` polling with the plan §1.3 backoff 300 → 500 → 1000 → 2000 ms, every 5 s
after 30 s). It reads state back only through the API and checks invariants after every step, both
with the organiser `verify` endpoint and with counters computed client-side from the dashboard
(over-capacity, double holds).

Results are the only source of the numbers in the report. Each run writes a directory that is
never overwritten:

```
results/<YYYY-MM-DD>-<name>[-<n>]/
  raw.csv      one row per sample or assertion (what the plots read)
  summary.md   verdict, pass criterion, headline numbers, tables, failed checks, skipped steps
  meta.json    run id, start/end time, target (name, API URL), commit hash + dirty flag + branch,
               parameters, check counts, headline numbers
  *.csv        extra tables of some scripts (checks.csv, latency.csv, notifier.csv, late-tick.csv)
```

A script exits with code 1 when any check fails (or its latency target is missed), 2 on a usage error.

## Scripts

| Script | Table 3 row (plan §4) | What it does | Pass criterion |
|---|---|---|---|
| `smoke.ts` | Acceptance test of both deployments (RUNBOOK §3, plan §3 step 12) | Register → offer → accept; a cancellation relays the seat in the same settlement; an offer left to expire is relayed to the next person by the timer path; a late `ACCEPT` is rejected; `verify` and dead letters | Every step as asserted; cancellation backfill 0 ms; expiry relayed within 15 s; late ACCEPT → `OFFER_EXPIRED`; verify ok; DLQ / `FAILED` rows empty. Dead letters not readable: a **failed** step on dev/pilot (an acceptance criterion there), "Skipped on this target" locally (no psql access) |
| `correctness.ts` | Core correctness | Nine scripted scenarios, one fresh workshop each: register/confirm, deterministic rejections, decline (R5), cancel from each state (R6), capacity up, capacity down (R7), cancel session, cancel workshop, close/open registration. `verify` plus the client-side counters after **every** step | Every step as expected; verify ok after every step; **0 over-capacity, 0 double holds**; summary lists each scenario pass/fail |
| `preference-order.ts` | Preference, order (deployment half; the 2,000-sequence half is the core fast-check property test) | 20 fixed cases (`src/lib/preferenceCases.ts`): filler accounts occupy seats, the participant registers with a preference list, optionally a seat is released | The allocated session is always the first acceptable session with a free seat; a non-acceptable session is never offered; verify ok |
| `concurrency.ts` | Concurrency | 50 accounts race in parallel for 3 sessions with 5 seats in total (plan §4 "3 场共 5 席": capacities 2/2/1, `--capacities`); every offer holder fires `ACCEPT`, `DECLINE` and `CANCEL` at the same time; the accounts the queue moved up accept at once. Client- and server-side settle latency of every command | verify ok, 0 over-capacity, 0 double holds after each phase; confirmed ≤ capacity per session; no transport errors; META conflict retries reported (expected 0) |
| `repeat-execution.ts` | Repeat execution (C3) | The same `commandId` POSTed 5× concurrently for `REGISTER`, `ACCEPT`, `CANCEL`, `DECLINE`; reuse of a `commandId` by another user (409) or with another body; with fault flags `_fault: AFTER_COMMIT` (crash after the commit), its redelivery traced as in failure-recovery | One record, settled once, identical on every read and re-POST; the effect exactly once (seq, seats, backfill records, notifications); AFTER_COMMIT redelivered (≥ 2 deliveries; on AWS shown by the worker logs, otherwise the case fails) and applying nothing twice |
| `expiry-race.ts` | Expiry race (tick-first, plan §1.2) | holdSeconds 60. `ACCEPT` timed to reach the API at `expiresAt − 200 ms` and at `expiresAt + 200 ms` (server clock offset estimated from `/health`); afterwards a stale `TICK` for the expired offer is injected straight into the command queue (local: `commands` row; dev: SQS `SendMessage` on the FIFO). Expiry is judged when the worker processes the ACCEPT, so an early ACCEPT the queue delays past `expiresAt` is correctly rejected: that attempt is **inconclusive** (reported with its worker pickup latency `settledAt − acceptedAt`) and repeated on a fresh workshop, up to `--early-attempts` (3) per run | Early ACCEPT applied in every run (inconclusive attempts listed, not failures); late ACCEPT `REJECTED(OFFER_EXPIRED)` whichever pass relayed the seat (timer tick before the ACCEPT arrived / while it was queued / the ACCEPT's own tick-first: recorded); outcomes consistent with the server timestamps; the late tick changes nothing (no commit, newer offer unchanged and still acceptable) |
| `failure-recovery.ts` | Failure recovery | `_fault: BEFORE_COMMIT`, `AFTER_COMMIT`, `TIMER_SEND`, each followed through its redelivery (traced via the `commands` row locally; on AWS by two Logs Insights queries on the worker log group: the lines naming the command, including the "injected fault" line with its SQS `messageId`, then the per-message lines of that message, whose `deliveryAttempt` gives the count; the trace lines go to raw.csv `trace` and summary.md); the TIMER_SEND offer must still expire through the timer path. Dev/pilot: notifier reserved concurrency 0 (`PutFunctionConcurrency`), notifications generated, restored, time until every one is SENT / SKIPPED / FAILED. Local: the notifier loop is in-process and not externally controllable → documented as skipped; the no-outage baseline is measured on both | Each faulted command settles exactly once after ≥ 2 deliveries and the effect is applied once; on AWS a redelivery the logs do not show **fails** the case, and BEFORE_COMMIT / TIMER_SEND must settle ≥ 0.8 × the 120 s visibility timeout after acceptance (they can only commit on the redelivery); notifier backlog drained **< 5 min** after the restore (seconds reported); dead letters unchanged |
| `access-control.ts` | Access control (C7) | Negative cases only: no token and a tampered token on every authenticated route; accept / decline someone else's offer; an organiser of another organisation and a plain participant on the dashboard, CSV export, verify, attendance, workshop list/create/edit, membership and every organiser command; the victim's workshop through the attacker's own organisation; another user's command; unknown resources; malformed bodies | 401 / 403 `FORBIDDEN` / 404 / `REJECTED(OFFER_NOT_YOURS)` / 409 / 400 exactly as listed; workshop, membership and the victim's offer untouched; verify ok |
| `backfill.ts` | Backfill latency | holdSeconds 60. 100 offers (10 workshops × 2 sessions × 5 seats) left to expire with a full layer of people queued behind; latency = `reallocatedAt − releasedAt` of each dashboard backfill record (`releasedAt` = `expiresAt`). Then a few holders cancel: cancellation-driven backfills reported separately. Dev: `SweepLateExpiries` sum from CloudWatch for the window (local: `GET /metrics`) | Expiry-driven **p95 ≤ 120 s** (single-digit seconds expected), every expiry relayed, outliers listed; cancellation-driven ≈ 0 ms; `SweepLateExpiries` = 0 |

The Performance (k6) row lives in `tools/loadtest`, Mechanism comparison in `tools/replay`, Cost in
`cost/` here (see below).

## Running

Prerequisites: `pnpm install`; a running target; accounts with tokens.

- **local** = the docker compose stack (`pnpm local:up`, API `http://localhost:3000`, Keycloak
  `http://localhost:8080`). Accounts are created in the Keycloak realm on first use (password grant
  of the `tooling` client) and cached in `tools/loadtest/.token-cache.local.json`. The organiser is
  `organiser@example.com`. Side channel: `docker exec seatrelay-local-postgres-1 psql …` (override
  with `PG_CONTAINER`) for the `commands` table (FAILED rows = DLQ, late-tick injection,
  redelivery traces) and `GET /metrics` for the in-process metric sums.
- **dev** / **pilot** = the AWS stacks. The API URL comes from `--api` / `TARGET_API` or the
  `ApiUrl` output of `seatrelay-app-<stage>` (needs AWS credentials). Tokens come from the Cognito
  token cache written by `pnpm --filter @seatrelay/scripts create-test-users`
  (`tools/loadtest/.token-cache.<stage>.json`); missing or stale ones are minted with
  `InitiateAuth` (and created with admin credentials unless `--no-create`). With `--no-create`
  no admin credentials are needed: `InitiateAuth` is unsigned (pass `--pool-id` / `--client-id`
  to skip the `seatrelay-auth` stack lookup as well). `create-test-users` creates only
  `<prefix>-1 … <prefix>-N`; the default dev organiser and outsider
  (`<prefix>-organiser@…`, `<prefix>-outsider@…`) are created on the first experiment run, which
  therefore needs admin credentials once (or pass existing accounts with `--organiser` /
  `--outsider`). Side channels need AWS credentials: SQS (DLQ depths, late TICK), Lambda
  (notifier concurrency), CloudWatch Logs Insights (redelivery trace) and `GetMetricData`
  (`SeatRelay` namespace, SQS, Lambda). Without credentials most of those steps are listed under
  "Skipped on this target" in summary.md instead of failing the run (the verdict line counts
  them); the exceptions are the AWS acceptance evidence: the smoke's dead-letter check and the
  fault cases' redelivery trace fail instead. Fault flags are honoured only by dev
  (`AllowFaultFlags=true`); they are off for pilot.

```bash
# acceptance test of a deployment
pnpm --filter @seatrelay/experiments smoke --target local
pnpm --filter @seatrelay/experiments smoke --target dev --api https://<id>.execute-api.ap-southeast-1.amazonaws.com

# Table 3, three rounds each (plan §3 step 21)
pnpm --filter @seatrelay/experiments correctness --target dev --runs 3
pnpm --filter @seatrelay/experiments preference-order --target dev --runs 3
pnpm --filter @seatrelay/experiments concurrency --target dev --runs 3 --accounts 50
pnpm --filter @seatrelay/experiments repeat-execution --target dev --runs 3
pnpm --filter @seatrelay/experiments expiry-race --target dev --runs 3 --hold 60
pnpm --filter @seatrelay/experiments failure-recovery --target dev --runs 3 --outage 60
pnpm --filter @seatrelay/experiments access-control --target dev --runs 3
pnpm --filter @seatrelay/experiments backfill --target dev --runs 3 --offers 100

# a single correctness scenario, results somewhere else
pnpm --filter @seatrelay/experiments correctness --target local --scenarios cancel,decline --out /tmp/try
```

Common options (every script; `--help` prints them with the script's own):

| Option | Meaning |
|---|---|
| `--target local\|dev\|pilot` | default `local` |
| `--api URL` | API base URL (default `http://localhost:3000` locally, else the stack output; `TARGET_API` works too) |
| `--out DIR` | results base directory (default `<repo>/results`; relative paths are resolved against the directory the command was typed in) |
| `--runs N` | repetitions (default 1; the report uses 3) |
| `--hold S` | holdSeconds of the workshops created (min 30; default 60 for smoke / expiry-race / failure-recovery / backfill, 900 elsewhere) |
| `--prefix`, `--domain` | participant accounts `<prefix>-<n>@<domain>` (default `loaduser`, `example.com`) |
| `--organiser`, `--outsider` | organiser account, organiser of another organisation (cross-org cases) |
| `--password`, `--cache`, `--no-create` | account creation / token cache |
| `--faults auto\|on\|off` | use `_fault` flags (auto: on for local and dev, off for pilot) |
| `--settle-timeout MS` | give up polling a command (default 60 000 local, 300 000 AWS) |
| `--metrics-wait S` | wait for CloudWatch ingestion before reading metrics (default 90 on AWS) |
| `--redelivery-wait S` | wait for a crashed delivery to be redelivered (default 10 local, 150 AWS: SQS visibility 120 s) |
| `--pool-id`, `--client-id`, `--region`, `--keycloak` | identity provider overrides |
| `--label TEXT` | free text stored in meta.json |

Script-specific options: `correctness --scenarios a,b`; `preference-order --parallel N`;
`concurrency --accounts --capacities (or --sessions --capacity) --seed`; `repeat-execution --copies`;
`expiry-race --margin-ms --tick-wait --early-attempts`; `failure-recovery --outage --notifications --recovery-limit`;
`backfill --offers --workshops --sessions --rounds --cancellations --outlier-ms --wait-extra --keep --seed`.

Approximate duration per run: smoke ≈ hold + 20 s; expiry-race ≈ hold + 15 s (runs in parallel;
plus one hold per repeated early attempt);
failure-recovery ≈ hold + 20 s locally, ≈ 2 × 120 s + hold (+ outage + drain) on AWS; backfill
≈ rounds × hold + 30 s; the others a few seconds to a minute.

## Library (`src/lib`)

| File | Responsibility |
|---|---|
| `run.ts` | The harness: CLI, target resolution, account pool, results directory, summary/meta writers, `check` / `skip` bookkeeping, exit code |
| `accounts.ts` | Accounts with ID tokens from the shared k6 token cache; minting/creating through Keycloak or Cognito; transparent token refresh |
| `poll.ts` | Polling primitives beyond `ApiClient.sendCommand()` (from `@seatrelay/scripts`, which holds the typed API client): poll a known commandId, concurrent duplicate POSTs, settled-record fingerprints |
| `scenario.ts`, `steps.ts` | Workshop creation, invariant snapshot (verify + over-capacity + double holds), scripted step runner, clock offset, seeded randomness, latency samples |
| `preferenceCases.ts` | The 20 preference cases and their oracle |
| `backfillLayout.ts`, `httpProbe.ts` | Backfill experiment layout; raw HTTP status probes of the access-control experiment |
| `ops.ts`, `redelivery.ts` | Per-target side channels: dead letters, late-TICK injection, redelivery traces (`analyseWorkerTrace` reads the worker's log shapes), notifier pause/resume, metric deltas; redelivery verdicts |
| `capacities.ts`, `expiryRace.ts` | Session capacities of the concurrency experiment; early/late verdicts of the expiry race (PASS / INCONCLUSIVE / FAIL, relay order) |
| `cloudwatch.ts`, `metrics.ts` | `GetMetricData` for the `SeatRelay` namespace (`CommandSettledLatency`, `BackfillLatency`, `OffersCreated/Expired`, `SweepLateExpiries`, `MetaConflictRetries`, `NotificationFailures`) and the SQS / Lambda metrics over a window; degrades to "not fetched" without credentials |
| `results.ts` | Directory naming, CSV/Markdown/JSON writers, nearest-rank percentiles, summaries, outliers, `git rev-parse` commit info |

## Tests and dry runs

```bash
pnpm --filter @seatrelay/experiments typecheck
pnpm --filter @seatrelay/experiments test        # vitest: results/percentile helpers, polling client
                                                 # (mocked fetch), library helpers, HTTP fixture
```

`test/helpers/memoryServer.ts` serves the real route table and worker orchestration of
`@seatrelay/service` on its in-memory adapters over HTTP (wall clock, background worker with
SQS-like redelivery, timer loop, sweep, notifier, HS256 tokens). Any script can be dry-run against
it without Docker or AWS:

```bash
pnpm --filter @seatrelay/experiments fixture --port 3999 --cache /tmp/fixture-tokens.json
PG_CONTAINER= pnpm --filter @seatrelay/experiments backfill --target local \
  --api http://127.0.0.1:3999 --cache /tmp/fixture-tokens.json --no-create --out /tmp/dry --hold 30
```

Numbers obtained against the fixture only show that a script runs; they are not measurements and
must never be quoted. (`PG_CONTAINER=` keeps the local side channel away from a compose Postgres
that may be running at the same time.)

## Analysis (Python)

`pip install -r tools/experiments/requirements.txt` (pandas, matplotlib, scipy).

`analysis/plot_results.py` renders the latency columns (`*Ms`, `*Seconds`) of any results
directory into a histogram, an empirical CDF with the p95 line and a per-group stats table
(`<run>/plots/`), grouping by `cause` / `phase` / `variant` / … when present:

```bash
python3 tools/experiments/analysis/plot_results.py                          # every results/*/
python3 tools/experiments/analysis/plot_results.py results/2026-10-30-backfill --value latencyMs --group cause
python3 tools/experiments/analysis/plot_results.py results/*-concurrency --value settleMs --group phase --log-x
python3 tools/experiments/analysis/plot_results.py results/2026-10-30-backfill results/2026-10-31-backfill \
  --value latencyMs --combine --out results/plots                          # runs overlaid
python3 tools/experiments/analysis/plot_results.py --loadtest              # k6 matrix: p95 vs VUs
```

A `raw.csv` without any header (a run that produced no sample rows, e.g. failure-recovery with
fault flags off or an aborted trial) is skipped with a note instead of stopping the batch.
`--loadtest` reads `results/loadtest/<date>/raw.csv` of `tools/loadtest` run-matrix (default:
every date) and plots, per target and scenario, the median over the rounds of the per-run p95 of
reads, 202s, client-observed and server-side settle against the VU level, with the plan §4
targets (1 s, 5 s) as reference lines (`<date>/plots/loadtest-<target>-<scenario>-p95.png`);
superseded attempts are left out.

`cost/model.py` is the cloud vs on-premise cost model of plan §6 (`docs/COST.md`); it writes
`results/cost/`. With `--from-snapshot` it states in `usage-priced.md` whether the snapshot's usage
by type was filtered to the `Project=SeatRelay` cost allocation tag (`tools/scripts/bin/cost-snapshot.sh`
records it; older snapshots were not filtered).

## Environment variables

| Variable | Used for |
|---|---|
| `TARGET_API` | API base URL when `--api` is not given |
| `PG_CONTAINER` | Postgres container of the compose stack (default `seatrelay-local-postgres-1`; empty disables the local side channel) |
| `KEYCLOAK_BASE`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT`, `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD` | Keycloak overrides for local accounts |
| `AWS_REGION` / `AWS_PROFILE` (or `--region`) | AWS side channels and Cognito (default `ap-southeast-1`) |
