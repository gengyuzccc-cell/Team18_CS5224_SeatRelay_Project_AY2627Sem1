# SeatRelay system experiments (Table 3)

How every Table 3 acceptance target of the Final report is measured: the script, the exact
commands for the local (Docker Compose) and the dev (AWS) target, the metrics, the pass criterion,
the output files, and how a number travels from a run directory into the report. The source is
plan §4 (`docs/plan/execution-plan.md`); the architecture behind the metrics is in
`docs/ARCHITECTURE.md`.

**Ground rules.**

- No number enters the report unless it is in a file under `results/` that a script produced.
- Failed and aborted runs are kept and listed in the run register (section 6). They are never
  deleted or overwritten.
- Report runs are made from a clean checkout (`meta.json` → `commit.dirty: false`), against a
  stack deployed from the same commit.
- Results produced against the in-memory fixture (section 2.4) prove only that a script runs. They
  are never measurements.

---

## 1. Overview

| Table 3 row | Script / command | Targets | Pass criterion (plan §4) | Output |
|---|---|---|---|---|
| (pre-check) Smoke | `experiments smoke` | local, dev | Every RUNBOOK §3 step asserts; cancellation backfill 0 ms; expiry relayed by the timer path; late ACCEPT → `OFFER_EXPIRED`; verify ok; DLQ empty | `results/<date>-smoke/` |
| Core correctness | `experiments correctness` | local, dev | 0 over-capacity, 0 double holds, every scenario step as expected, verify ok after every step | `results/<date>-correctness/` |
| Preference, order | `core` property test + `experiments preference-order` | (unit), local, dev | Never offers a non-acceptable session; preference order respected | `results/<date>-core-tests/`, `results/<date>-preference-order/` |
| Concurrency | `experiments concurrency` | local, dev | Final state satisfies every invariant; META conflict retries recorded (expected 0) | `results/<date>-concurrency/` |
| Repeat execution | `experiments repeat-execution` | local, dev | No double booking or release; one CMD record, APPLIED once; `AFTER_COMMIT` redelivery applies nothing twice | `results/<date>-repeat-execution/` |
| Expiry race | `experiments expiry-race` | local, dev | ACCEPT at `expiresAt − 200 ms` succeeds; at `+ 200 ms` it is `REJECTED(OFFER_EXPIRED)` whatever the timer did; a late TICK leaves the newer offer untouched | `results/<date>-expiry-race/` |
| Failure recovery | `experiments failure-recovery` | local (faults), dev (faults + notifier outage) | Recoverable and traceable; settles exactly once; notifier backlog delivered < 5 min after restore (seconds reported) | `results/<date>-failure-recovery/` |
| Access control | `experiments access-control` | local, dev | 401 / 403 / 404 / `OFFER_NOT_YOURS` all correct; nothing changed | `results/<date>-access-control/` |
| Performance | `loadtest run-matrix` (k6) | local, dev | Read and 202 p95 < 1 s; settle p95 < 5 s (server- and client-side reported separately); error rate; queue depth | `results/loadtest/<date>/` |
| Backfill latency | `experiments backfill` | local, dev | Expiry-driven p95 ≤ 120 s (single-digit seconds expected); outliers listed; cancellation-driven separately; `SweepLateExpiries = 0` | `results/<date>-backfill/` |
| Cost | `cost-snapshot.sh` + `cost/model.py` | dev (usage), model | Unit cost and trend by scale; three layers (list / after free tier / after credits); on-prem comparison | `results/cost/` |
| Mechanism comparison | `pnpm replay` | simulation | Duplicate holds, distinct served and backfill/refill time compared with 95 % CIs | `results/replay/` (or `results/<date>-replay/`) |
| (not a Table 3 row) Staged pilot rehearsal — **synthetic accounts, operational evidence only, not user evidence** (Prelim §5: rehearsed events logged separately) | `experiments pilot-rehearsal -- --target pilot` | pilot | One workshop (UNIFIED, hold 120 s, 2 sessions × 6), 20 SES-mailbox-simulator accounts, strictly sequential at 1–3 s pacing: every scripted command as expected; verify / 0 over-capacity / 0 double holds after every phase; decline, timer-driven expiry, capacity +1 and cancellation backfills relayed; every notification leaves PENDING (simulator: SENT), in-app status = dashboard (C6); DLQs unchanged; no alarm entered ALARM | `results/<date>-pilot-rehearsal/` (`raw.csv`, `checks.csv`, `backfills.csv`, `notifications.csv`, `invariants.csv`, `export.csv`, `summary.md`, `meta.json`) |

Script names: `experiments X` = `pnpm --filter @seatrelay/experiments X -- <options>`;
`loadtest X` = `pnpm --filter @seatrelay/loadtest X -- <options>`. Every script prints its full
option list with `--help`.

---

## 2. Environments and one-time setup

### 2.1 Local (on-prem reference)

```bash
corepack enable && pnpm install
pnpm local:up                                                  # docker compose up --build -d
docker compose -f services/local/docker-compose.yml ps         # wait until "server" is healthy (~60 s, Keycloak first)
curl -s http://localhost:3000/health                           # {"ok":true,...}
# 60 participant accounts + token cache (tools/loadtest/.token-cache.local.json); enough for every script and 50 VUs
pnpm --filter @seatrelay/scripts get-tokens-keycloak -- --count 60 --prefix loaduser
```

The organiser is `organiser@example.com` (realm user, password `Passw0rd!`). The local stack runs
with `ALLOW_FAULT_FLAGS=true` and `EMAIL_ENABLED=true` (mail lands in Mailpit, http://localhost:8025).
The side channels that scripts use need the `docker` CLI:

- the `commands` table: FAILED rows act as the DLQ, and late ticks are injected through
  `docker exec … psql` into the container `seatrelay-local-postgres-1` (override with `PG_CONTAINER`);
- `GET /metrics`.

Keycloak ID tokens live 60 minutes. The harness re-mints expired ones automatically through the
password grant.

### 2.2 Dev (AWS)

```bash
aws sts get-caller-identity                                    # credentials of seatrelay-deployer, region ap-southeast-1
aws cloudformation describe-stacks --stack-name seatrelay-app-dev \
  --query 'Stacks[0].[StackStatus,LastUpdatedTime,Parameters[?ParameterKey==`AllowFaultFlags`].ParameterValue|[0]]' --output text
# expect UPDATE_COMPLETE/CREATE_COMPLETE … true
API=$(aws cloudformation describe-stacks --stack-name seatrelay-app-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text); curl -s "$API/health"
# 60 Cognito test accounts (no e-mail sent) + token cache tools/loadtest/.token-cache.dev.json (ID tokens valid 12 h)
pnpm --filter @seatrelay/scripts create-test-users -- --count 60 --prefix loaduser --stage dev   # password: $SEATRELAY_TEST_PASSWORD
```

- **Test-account password.** The repository is public, so on dev and pilot every tool takes the
  test accounts' password from `SEATRELAY_TEST_PASSWORD` (or `--password`) and refuses the local
  stack's documented default. Export a private value before running anything; to move existing
  accounts to it, run `tools/scripts/bin/reset-test-passwords.sh` (it also signs them out), then
  delete `tools/loadtest/.token-cache.*.json`. Never write the password into the repository.
- **Accounts.** The organiser `loaduser-organiser@example.com` and the outsider
  `loaduser-outsider@example.com` are created by the harness on first use. This is a signed Cognito
  admin call, so it needs the credentials.
- **What else needs credentials.** The CloudWatch metric reads (`--metrics-wait`, default 90 s for
  EMF ingestion), the DLQ depths, the late-TICK injection on the FIFO, the Logs Insights command
  traces, and the notifier pause (`PutFunctionConcurrency`).
- **Without credentials** those steps are reported as *skipped* in `summary.md`. They are not
  counted as passed. A run with skipped steps is not a report run.
- **Stage settings.** Dev runs with `AllowFaultFlags=true` and `EmailEnabled=false`, so
  notifications end as `SKIPPED`. Pilot strips `_fault`: never run fault experiments against pilot.

### 2.3 Common harness (`tools/experiments/src/lib/run.ts`)

Every Table 3 script shares one CLI and one output layout:

| Option | Default | Meaning |
|---|---|---|
| `--target` | `local` | `local` (compose stack, Keycloak) or `dev` / `pilot` (Cognito; API URL from the stack output `ApiUrl`) |
| `--api URL` | per target | override the API base (also `TARGET_API`) |
| `--runs N` | 1 | repetitions inside one invocation (rows carry a `run` column) |
| `--hold S` | 60 for expiry-driven scripts, 900 otherwise | `holdSeconds` of the workshops the script creates (≥ 30) |
| `--prefix` / `--domain` | `loaduser` / `example.com` | participant accounts `<prefix>-<i>@<domain>` |
| `--faults auto\|on\|off` | auto (on for local and dev) | use `_fault` flags |
| `--settle-timeout MS` | 60,000 local / 300,000 dev | give up polling one command |
| `--metrics-wait S` | 0 local / 90 dev | wait for CloudWatch ingestion before reading metrics |
| `--redelivery-wait S` | 10 local / 150 dev | wait for a crashed delivery to come back (SQS visibility timeout 120 s) |
| `--out DIR` | `<repo>/results` | results base directory |
| `--label TEXT` | — | free text stored in `meta.json` |

Behaviour:

- Each script creates its own workshops in the organiser's organisation **"SeatRelay experiments"**.
  Commands are sent exactly as the browser sends them: client `commandId`, POST → 202 → poll with
  the plan §1.3 backoff.
- Each script asserts with check rows and calls `verify` where its scenario defines it.
- The exit code is 1 when any check failed, 2 on a usage error. `summary.md` says PASS or FAIL in
  its first lines. Per-script details are in `tools/experiments/README.md`.
- Every invocation writes a new directory `results/<YYYY-MM-DD>-<name>[-<n>]/` (section 7).

### 2.4 Dry run without Docker or AWS (script check only)

```bash
pnpm --filter @seatrelay/experiments exec tsx test/helpers/serve-memory.ts --port 3999 \
  --cache /tmp/fixture-tokens.json --count 120 &
pnpm --filter @seatrelay/experiments correctness -- --target local --api http://127.0.0.1:3999 \
  --cache /tmp/fixture-tokens.json --no-create --out /tmp/dry
```

The fixture is the in-memory service behind HTTP. Always write to a scratch `--out`, never to
`results/`.

---

## 3. Functional rows

For every row: run on **local first** (fast feedback, no cost). Then make the report run on **dev**
with `--runs 3`, followed by the post-run checklist (section 6). Durations are approximate wall-clock
times per run.

### 3.0 Smoke (acceptance pre-check, every deployment and before each experiment day)

- **Goal.** Prove that the deployment works end to end before spending time on experiments
  (plan §3 step 12, `docs/RUNBOOK.md` §3).
- **Script.** `tools/experiments/src/smoke.ts`.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments smoke -- --target local
  pnpm --filter @seatrelay/experiments smoke -- --target dev
  ```
  Each run creates a workshop with 2 sessions × capacity 1 and `holdSeconds` 60, and waits for one
  hold to elapse (≈ 75 s).
- **Metrics.** Settle latency (client and server), the expiry backfill latency, verify, dead letters.
- **Pass.** Every step asserts. The cancellation backfill happens in the same settlement (0 ms). The
  expiry is relayed by the timer path within 15 s. A late ACCEPT gets `OFFER_EXPIRED`. verify is ok.
  The DLQs (dev) and the FAILED rows (local) are empty.
- **Output.** `results/<date>-smoke/{summary.md, meta.json, raw.csv (latency samples), checks.csv}`.
- **Into the report.** Not a Table 3 row. It is cited as deployment evidence in §3/§4 ("smoke passed
  on dev, run id …"). The earlier manual dev evidence is `results/2026-10-17-smoke-dev/`.

### 3.1 Core correctness

- **Goal.** Every organiser and participant operation leaves the workshop consistent: no
  over-capacity, no double hold, and the expected outcome or deterministic rejection.
- **Script.** `tools/experiments/src/correctness.ts`. Scenarios: `register-confirm`, `rejections`,
  `decline`, `cancel`, `capacity-up`, `capacity-down`, `cancel-session`, `cancel-workshop`,
  `close-open`. Each scenario uses a fresh workshop (2 sessions, hold 900) and participants
  `<prefix>-1…5`.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments correctness -- --target local
  pnpm --filter @seatrelay/experiments correctness -- --target dev --runs 3        # ≈ 5–10 min
  # one scenario only: --scenarios cancel-session
  ```
- **Metrics.**
  - Per step: expected vs actual status/reason, `verify` ok, client-side over-capacity and
    double-hold counters.
  - Totals: `overCapacity`, `doubleHolds`, `verifications`, `verifyFailures`.
  - Settle latency samples (client and server).
- **Pass.** All checks pass, `overCapacity = 0`, `doubleHolds = 0`, `verifyFailures = 0`.
- **Output.** `summary.md` (per-scenario table), `raw.csv` (check rows), `latency.csv`, `meta.json`
  (`extra`: scenarios, totals, settle latencies).
- **Into the report.** System-results table row "Core correctness": *n scenarios × 3 runs, n checks,
  0 over-capacity, 0 double holds* (from `meta.json`), with the PASS/FAIL verdict.

### 3.2 Preference, order

- **Goal.** Allocation never offers a session the participant did not accept, and always gives the
  first acceptable session (in preference order) that has a free seat (R3).
- **Part A: random sequences (engine).** The fast-check model test in
  `packages/core/test/property.test.ts` runs 2,000 random command sequences of up to 200 steps with
  random clock advances, and asserts `checkInvariants` after every step.
  ```bash
  D=results/$(date -u +%F)-core-tests; mkdir -p "$D"
  pnpm --filter @seatrelay/core test 2>&1 | tee "$D/run.log"
  cp packages/core/coverage/coverage-summary.json "$D/"
  git rev-parse HEAD > "$D/commit.txt"
  ```
- **Part B: deployment replay.** `tools/experiments/src/preference-order.ts` replays the 20 fixed
  cases of `lib/preferenceCases.ts` through the API. Each case creates a 5-session workshop, fills
  seats with filler accounts, registers the participant with a preference list and optionally
  releases a seat.
  ```bash
  pnpm --filter @seatrelay/experiments preference-order -- --target local
  pnpm --filter @seatrelay/experiments preference-order -- --target dev --runs 3   # --parallel 5 cases in flight (default)
  ```
- **Metrics.** Per case: expected vs actual session (before and after the release),
  `offeredNonAcceptable`, verify. Settle latency.
- **Pass.**
  - Part A: the vitest run is green, with 0 invariant violations and branch coverage ≥ 95 %.
  - Part B: 20/20 cases per run, `offeredNonAcceptable = 0`, verify ok.
- **Output.** Part A: `results/<date>-core-tests/{run.log, coverage-summary.json, commit.txt}`.
  Part B: `results/<date>-preference-order/{summary.md, raw.csv (one row per case), latency.csv, meta.json}`.
- **Into the report.** "2,000 random sequences, 0 violations; 20 fixed cases × 3 runs on dev, 0
  non-acceptable offers."

### 3.3 Concurrency

- **Goal.** The invariants hold under real parallelism, both across accounts and within one account.
- **Script.** `tools/experiments/src/concurrency.ts`. The run has three phases:
  1. 50 accounts race in parallel for 3 sessions × 5 seats.
  2. Every holder fires ACCEPT, DECLINE and CANCEL for its offer at the same time.
  3. The accounts the queue moved up accept at once.
  After each phase `verify` runs.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments concurrency -- --target local
  pnpm --filter @seatrelay/experiments concurrency -- --target dev --runs 3        # --accounts 50 --sessions 3 --capacity 5 --seed 1
  ```
- **Metrics.**
  - verify ok, over-capacity and double holds after each phase.
  - Which of the racing commands won (`raceFirst`).
  - Client and server settle latency of every command.
  - `MetaConflictRetries` for the run window: CloudWatch on dev (needs credentials), `GET /metrics`
    on local.
- **Pass.** Every invariant holds after every phase. META conflict retries are recorded; the
  expected value is 0, because there is one FIFO consumer per workshop. A non-zero value is
  reported, not hidden.
- **Output.** `summary.md`, `raw.csv` (one row per command: phase, account, type, status, reason,
  `acceptMs`, `settleMs`, `serverSettleMs`, polls), `meta.json` (`extra.metaConflictRetries`,
  `settleMs`, `serverSettleMs`, `raceFirst`).
- **Into the report.** "50 concurrent accounts / 15 seats × 3 runs: 0 violations, N META retries;
  settle p95 = X ms (server), Y ms (client)."

### 3.4 Repeat execution (C3)

- **Goal.** A command applies at most once, whatever the duplication: concurrent duplicate POSTs,
  client retries, or a worker crash after the commit.
- **Script.** `tools/experiments/src/repeat-execution.ts`.
  - The same `commandId` is POSTed `--copies` (default 5) times concurrently, for each command type
    probed.
  - With fault flags, `_fault: AFTER_COMMIT` crashes the worker right after its commit. The
    redelivery must be acknowledged as already settled.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments repeat-execution -- --target local
  pnpm --filter @seatrelay/experiments repeat-execution -- --target dev --runs 3    # waits for SQS redelivery (≈ 2.5 min per AFTER_COMMIT case)
  ```
- **Metrics.**
  - Number of 202s, distinct `created` statuses, final status.
  - Identical reads and identical re-POST.
  - An effect check: one registration, one confirmed seat, one released seat, one notification.
  - Deliveries observed: local `commands.attempts`; dev worker log lines through Logs Insights.
- **Pass.** One command record, settled once. Every GET and re-POST returns the identical record.
  The effect is applied exactly once, including after the `AFTER_COMMIT` redelivery.
- **Output.** `summary.md`, `raw.csv` (one row per probe: case, commandId, copies, `accepted202`,
  `finalStatus`, `identicalReads`, `repostIdentical`, `effectOk`, `deliveries`), `meta.json`.
- **Into the report.** "N probes × 5 copies × 3 runs, every command settled once; AFTER_COMMIT
  redelivered after ~120 s and acknowledged as already settled."

### 3.5 Expiry race (tick-first, C5)

- **Goal.** Show that expiry is decided by server time at processing, independent of timer arrival.
  A late TICK cannot affect a newer offer.
- **Script.** `tools/experiments/src/expiry-race.ts` with `holdSeconds` 60:
  - **early**: an ACCEPT reaches the API at `expiresAt − margin`;
  - **late**: an ACCEPT reaches it at `expiresAt + margin`;
  - **late tick**: a stale TICK for the expired offer is injected straight into the queue (local:
    `commands` row; dev: SQS `SendMessage` on the FIFO; needs credentials).

  The send instant is corrected by the measured server clock offset (NTP-style on `/health`).
  Outcomes are cross-checked against the server's `acceptedAt` / `settledAt`.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments expiry-race -- --target local --runs 3
  pnpm --filter @seatrelay/experiments expiry-race -- --target dev --runs 3        # --margin-ms 200 --tick-wait 20; runs staggered, ≈ hold + 15 s each
  ```
- **Metrics.**
  - Per trial: variant, `expiresAt`, estimated server send time, `acceptedAt`, `settledAt`,
    arrival and settle offsets, status, reason.
  - Which message reached the worker first (timer TICK or ACCEPT), read from the backfill record.
  - For the late tick: commit or no commit, and whether the newer offer is unchanged.
- **Pass.**
  - early → APPLIED, late → `REJECTED(OFFER_EXPIRED)` in every run, in both orders of arrival.
  - The late TICK produces no commit, and the newer offer is still OFFERED and acceptable.
- **Output.** `summary.md`, `raw.csv` (trial rows), `late-tick.csv`, `meta.json` (`clockOffset`,
  `orders`, `lateTicks`).
- **Into the report.** The §3 C5 paragraph and the results table: "6 trials × 3 runs: early accepted,
  late rejected `OFFER_EXPIRED` (timer first in k of n runs), late tick: no effect."

### 3.6 Failure recovery

- **Goal.** Injected crashes at each point of the worker protocol recover by redelivery, settle
  exactly once, and can be traced. A notifier outage delays e-mail but loses nothing.
- **Script.** `tools/experiments/src/failure-recovery.ts`:
  - `_fault: BEFORE_COMMIT`: nothing written; redelivered; settles once.
  - `_fault: AFTER_COMMIT`: already settled; acknowledged; effects once.
  - `_fault: TIMER_SEND`: crash while scheduling the timer; the redelivery schedules it and
    commits; the offer still expires through the **timer path** (not the sweep).
  - **Notifier outage (dev only).** Reserved concurrency 0 on `seatrelay-dev-notifier`; N
    notifications generated stay PENDING; the concurrency is restored; the time until all reach
    SENT / SKIPPED / FAILED is measured. Locally the notifier is an in-process loop: documented as
    skipped, and only the baseline is measured.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments failure-recovery -- --target local --runs 3
  pnpm --filter @seatrelay/experiments failure-recovery -- --target dev --runs 3   # --outage 60 --notifications 10 --recovery-limit 300; ≈ 2 × 120 s + hold per fault case
  # afterwards on dev, confirm the notifier is not left throttled (must print nothing / no ReservedConcurrentExecutions):
  aws lambda get-function-concurrency --function-name seatrelay-dev-notifier
  ```
- **Metrics.**
  - Per fault: status, server settle latency (`settledAt − acceptedAt`, which includes the
    redelivery delay for BEFORE_COMMIT / TIMER_SEND), deliveries, how the redelivery was observed,
    the effect check.
  - Notifier: PENDING count at restore, and the recovery seconds after restore (outage) or after
    settlement (baseline).
  - Dead letters before and after.
- **Pass.** Each fault settles exactly once and the trace shows two deliveries. The notifier backlog
  is delivered < 300 s after the restore. The DLQs and FAILED rows are unchanged.
- **Output.** `summary.md`, `raw.csv` (fault rows), `notifier.csv`, `meta.json` (`faults`,
  `notifierRecoverySeconds`, `notifierBaselineSeconds`).
- **Into the report.** Results table: "3 fault points × 3 runs recovered (2 deliveries each);
  notifier backlog of 10 delivered in X s after restore (target < 300 s)." The failure-mode table in
  §3 of the report references `docs/ARCHITECTURE.md` §12.

### 3.7 Access control (C7)

- **Goal.** Every unauthorised action is refused with the right status, and nothing changes.
- **Script.** `tools/experiments/src/access-control.ts`. Negative probes only:
  - no token or a tampered token → 401 on every authenticated route;
  - accept or decline someone else's offer → `REJECTED(OFFER_NOT_YOURS)`;
  - an organiser of another organisation (and a plain participant) on dashboard, export, verify,
    attendance, workshop list and creation, membership, PATCH and every organiser command → 403;
  - the victim's workshop addressed through the attacker's own organisation → 404;
  - another user's command → 404;
  - unknown ids → 404, malformed body → 400.

  Afterwards capacity, status and the victim's offer must be unchanged, and verify ok. On AWS the
  401s come from the API Gateway JWT authorizer, before the Lambda.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments access-control -- --target local
  pnpm --filter @seatrelay/experiments access-control -- --target dev --runs 3
  ```
- **Metrics.** One row per probe: group, probe, who, method, path, expected, actual.
- **Pass.** Every probe matches its expected status or code. The workshop is untouched.
- **Output.** `summary.md`, `raw.csv` (probe rows), `meta.json` (`probes`, `passed`).
- **Into the report.** "N negative probes × 3 runs, all 401/403/404/`OFFER_NOT_YOURS` as expected."

### 3.8 Backfill latency

- **Goal.** Measure how fast an expired hold reaches the next person through the timer path, and
  show that the 5-minute sweep is not on the latency path.
- **Script.** `tools/experiments/src/backfill.ts` with `holdSeconds` 60.
  - Defaults: `--offers 100` expiry samples over `--workshops 10` × `--sessions 2`. Capacity is
    derived from these.
  - Every session is acceptable in a seeded random order. A full layer of people is queued behind
    the holders, who never answer.
  - Latency per sample = `reallocatedAt − releasedAt` of the dashboard backfill record, where
    `releasedAt` = the offer's `expiresAt`.
  - Then `--cancellations 20` holders cancel. These cancellation-driven backfills happen in the same
    settlement and are reported separately.
  - `SweepLateExpiries` for the run window: CloudWatch on dev, `GET /metrics` on local.
- **Procedure.**
  ```bash
  pnpm --filter @seatrelay/experiments backfill -- --target local
  pnpm --filter @seatrelay/experiments backfill -- --target dev --runs 3           # ≈ hold + up to 420 s per run (waits long enough to see sweep-caught expiries)
  # options: --rounds R (expiry layers), --outlier-ms 10000, --wait-extra S, --keep (do not cancel the workshops), --seed 1
  ```
- **Metrics.**
  - Expiry-driven latency: n, p50, p95, p99, max, mean.
  - Outliers above `max(--outlier-ms, p95)`, listed individually.
  - Cancellation-driven latency (≈ 0 ms), and every expiry relayed (no lost seat).
  - `SweepLateExpiries`.
- **Pass.** Expiry-driven p95 ≤ 120 s. Every expiry is relayed. `SweepLateExpiries = 0`. Outliers
  are listed, not dropped.
- **Output.** `summary.md`, `raw.csv` (one row per backfill record: cause, `releasedAt`,
  `reallocatedAt`, `latencyMs`), `checks.csv`, `meta.json` (`expiredLatencyMs`, `cancelLatencyMs`,
  `outliers`, `sweepLateExpiries`, `layout`).
  - Plot: `python3 tools/experiments/analysis/plot_results.py results/<date>-backfill --value latencyMs --group cause`.
    It writes `<run>/plots/raw-latencyMs-{hist,cdf}.png` and `…-stats.csv`, using the same
    nearest-rank percentiles as `summary.md`. To pool several run directories into one figure, add
    `--combine --out results/plots`.
- **Into the report.**
  - The latency-distribution figure (§4) and the results-table row "Backfill p95 = X s (pooled
    3 × 100 expiries), max Y s; cancellation-driven 0 ms; SweepLateExpiries 0".
  - The plan §1.2 latency-budget table cites the same run.

---

## 4. Performance (k6)

- **Goal.** Measure the read latency, the 202 latency, and the end-to-end settle latency
  (server-side and client-observed) under load. Do this for load spread over many workshops and for
  one hot workshop (one FIFO group, serialised by design).
- **Script.** `tools/loadtest`. The scenarios are `scripts/cross-workshop.js` (10 workshops) and
  `scripts/hotspot.js` (one workshop).
  - Each VU iteration: `GET /workshops/{id}`, then REGISTER (expects 202), then poll every 200 ms
    until settled, then CANCEL (polled the same way).
  - The matrix is 10 / 25 / 50 VUs × 3 rounds per scenario, with a 30 s warm-up and a 60 s measured
    plateau per run.
  - Details: `tools/loadtest/README.md`.
- **Procedure.**
  ```bash
  # local (accounts from 2.1)
  pnpm --filter @seatrelay/loadtest prepare-scenario -- --target local
  pnpm --filter @seatrelay/loadtest run-matrix -- --target local --dry-run      # prints the 18 k6 command lines
  pnpm --filter @seatrelay/loadtest run-matrix -- --target local                # ≈ 35 min; samples docker stats every 2 s
  # dev (accounts from 2.2; the tooling-client ID tokens last 12 h)
  pnpm --filter @seatrelay/loadtest prepare-scenario -- --target dev
  pnpm --filter @seatrelay/loadtest run-matrix -- --target dev                  # ≈ 35 min; adds CloudWatch SQS depth/age + CommandSettledLatency per run
  # repeat one failed cell only: --scenarios hotspot --vus 50 --rounds 1
  ```
- **Before a dev matrix.**
  - Stage throttling is 300 rps / 500 burst. 50 VUs polling every 200 ms ≈ 250 rps, so the matrix
    must never run against pilot (50 / 100).
  - Check that the budget alarms are quiet.
  - Run the matrix last in the day; it creates the most items.
- **Metrics.**
  - Per run: `read_ms`, `command_ms` (202), `poll_ms`, `settle_ms` (client-observed, includes up to
    one 200 ms poll interval), `server_settle_ms` (`settledAt − acceptedAt`), polls per command,
    rejected, timeouts, `http_req_failed`.
  - Dev: SQS depth max, oldest message age max, CloudWatch `CommandSettledLatency` p95.
  - Local: `docker-stats.csv` (CPU, memory, network per container).
- **Pass** (plan §4, also the k6 thresholds):
  - read p95 < 1 s and 202 p95 < 1 s;
  - settle p95 < 5 s, reported separately for server-side and client-observed;
  - error rate < 1 %.

  If the hot-spot level misses the settle target, report the number and explain the serialisation
  of one workshop (`docs/ARCHITECTURE.md` §11). The documented optimisation is BatchSize 10 with a
  shared snapshot (plan §2.4 / §9).
- **Output.** `results/loadtest/<date>/`:
  - `raw.csv`: one row per run, including the git commit;
  - `summary.md`: per target and scenario, all runs plus the per-level median of rounds against the
    targets;
  - `runs.json`;
  - `k6/<target>/*.json` and `logs/<target>/*.log`;
  - `docker-stats.csv` (local only).
- **Into the report.** The performance figure (p95 by VU level, two scenarios, two targets) and the
  results-table row are built from `summary.md`. `docker-stats.csv` sizes the on-prem machine in the
  cost model (`docs/COST.md`).

---

## 5. Cost and mechanism comparison

### 5.1 Cost

- **Goal.** Report the cloud cost in three layers (list price, after free tier, after credits) from
  **measured usage**, the unit cost per 1,000 registrations by scale, and the on-prem comparison and
  crossover (plan §6, method in `docs/COST.md`).
- **Procedure.**
  ```bash
  tools/scripts/bin/cost-snapshot.sh                                            # daily during experiments and pilot → results/cost/snapshots/<date>.json
  python3 tools/experiments/cost/model.py                                       # tiers 1k/10k/100k → results/cost/model-summary.md, crossover.png, unit-cost.png, crossover-curve.csv
  python3 tools/experiments/cost/model.py --from-snapshot results/cost/snapshots/<date>.json   # measured usage priced → results/cost/usage-priced.md
  python3 tools/experiments/cost/cloudwatch_usage.py --date <day> --price      # same day from CloudWatch (read-only), no billing lag → results/cost/usage-<day>-cloudwatch.{json,md}, usage-priced.md
  ```
- **Notes.**
  - Cost Explorer's net (after-credits) cost shows 0 while credits last. The billing layer is
    therefore computed as usage × unit price (`pricing.json`, retrieved 2026-10-16).
  - Cost-allocation tag `Project` is active (`tools/scripts/bin/activate-cost-tags.sh`).
  - Cost Explorer lags about a day, so the experiment day (17 October) was priced from CloudWatch
    metrics instead: `results/cost/usage-2026-10-17-cloudwatch.md` lists every metric, conversion and
    bound (SQS requests, data transfer, Cognito MAU). Whichever path ran last writes
    `usage-priced.md`, which the report quotes; CloudWatch has no registration count, so that path
    gives no measured unit cost.
- **Pass** (a reporting criterion, not a threshold): every price has a source and a verification
  flag; usage comes from a snapshot or CloudWatch file; the crossover is computed, not estimated by hand.
- **Into the report.** The §2 cost table (tiers × layers), the crossover figure, and the unit cost.
  Each figure cites `results/cost/model-summary.md` and the snapshot date.

### 5.2 Mechanism comparison (UNIFIED vs PER_SESSION)

- **Goal.** Quantify what the unified queue buys over per-session forms: duplicate holds, distinct
  participants served, seats wasted, and seat refill time.
- **Script.** `tools/replay`. Each seed's identical arrival and behaviour stream goes through the
  real engine in both modes, with a simulated clock and ideal timers.
- **Procedure.**
  ```bash
  pnpm replay                                                                   # 1,000 seeds → results/replay/{raw.csv, summary.md, *.svg}
  pnpm replay --seeds 1000 --out results/$(date -u +%F)-replay                 # re-run without overwriting the existing results/replay/
  ```
- **Status.** `results/replay/summary.md` already holds a 1,000-seed run (generated
  2026-10-17T01:48Z). Re-run only after an engine change, and keep the old directory: `pnpm replay`
  without `--out` overwrites `results/replay/`, so use a dated `--out` for any later run.
- **The plan's "one real replay per mode on dev" has no script.** If the team wants it, the minimal
  manual version is:
  1. Create one UNIFIED and one PER_SESSION workshop with the wizard.
  2. Run `smoke`-sized traffic.
  3. Export both CSVs into `results/<date>-mechanism-dev/`.

  Otherwise the report states that the comparison is a simulation on the production engine.
- **Pass** (reporting): means, medians and 95 % bootstrap CIs per mode, plus paired differences. In
  UNIFIED mode the duplicate holds must be exactly 0, which doubles as an invariant check.
- **Into the report.** The mechanism-comparison figure (the SVGs, redrawn) and the headline table of
  `summary.md`.

---

## 6. Run checklist

**Before a session of runs**

1. `git status` must be clean. `git rev-parse HEAD` must equal the commit the stack was deployed from
   (recorded in `docs/deployment-state.md`). The harness writes `commit.hash` and `commit.dirty` to
   `meta.json`; a dirty run is not a report run.
2. Record the deployed code:
   ```bash
   aws cloudformation describe-stacks --stack-name seatrelay-app-dev --query 'Stacks[0].[StackStatus,LastUpdatedTime]' --output text
   aws lambda get-function-configuration --function-name seatrelay-dev-worker --query '[CodeSha256,LastModified]' --output text
   ```
3. Run `smoke` (section 3.0). It must PASS.
4. Check that no alarm is in ALARM:
   `aws cloudwatch describe-alarms --alarm-name-prefix seatrelay-dev- --state-value ALARM --query 'MetricAlarms[].AlarmName'`.

**After every run** (wait until the command queue has drained first)

1. Read the verdict at the top of `summary.md`, and the `skipped` section. Skipped steps make the
   run incomplete.
2. **Queues and dead letters.** `commands.fifo` must be drained, and all DLQs 0. `expiry-delay` may
   hold timers of offers that are still live.
   ```bash
   STAGE=dev
   for q in commands.fifo commands-dlq.fifo expiry-delay expiry-delay-dlq notify-dlq; do
     url=$(aws sqs get-queue-url --queue-name "seatrelay-$STAGE-$q" --query QueueUrl --output text)
     aws sqs get-queue-attributes --queue-url "$url" \
       --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
       --query Attributes --output json | jq -c --arg q "$q" '{queue: $q} + .'
   done
   ```
   Local equivalent: FAILED must be 0, and PENDING 0 once drained.
   ```bash
   docker exec seatrelay-local-postgres-1 psql -U seatrelay -d seatrelay -c \
     "select status, count(*) from commands group by status order by 1"
   ```
3. **Verify every live experiment workshop.** All must report `ok: true`; `verify` is only
   meaningful once the queue is drained.
   ```bash
   # TOKEN = organiser ID token:
   #   local: curl -s -X POST http://localhost:8080/realms/seatrelay/protocol/openid-connect/token \
   #            -d grant_type=password -d client_id=tooling -d username=organiser@example.com \
   #            -d 'password=Passw0rd!' -d scope=openid | jq -r .id_token
   #   dev:   jq -r '.users[] | select(.email=="loaduser-organiser@example.com") | .idToken' tools/loadtest/.token-cache.dev.json
   ORG=$(curl -s "$API/me" -H "authorization: Bearer $TOKEN" \
     | jq -r '.organizations[] | select(.name=="SeatRelay experiments") | .id')
   curl -s "$API/orgs/$ORG/workshops" -H "authorization: Bearer $TOKEN" \
     | jq -r '.workshops[] | select(.status=="OPEN" or .status=="CLOSED") | .id' \
     | while read -r WS; do
         printf '%s ' "$WS"
         curl -s "$API/orgs/$ORG/workshops/$WS/verify" -H "authorization: Bearer $TOKEN" \
           | jq -c '{ok, violations: (.violations | length)}'
       done
   ```
4. Dev, after `failure-recovery`: `aws lambda get-function-concurrency --function-name seatrelay-dev-notifier`
   must show no reserved concurrency.
5. Append one line to the run register `results/RUNS.md` (create it on the first run with this
   header):

   ```markdown
   | start (UTC) | experiment | target / stack (LastUpdatedTime, worker CodeSha256) | commit (dirty?) | run id | runs | verdict | verify sweep | DLQ / FAILED | results dir | notes |
   |---|---|---|---|---|---|---|---|---|---|---|
   ```

   Take `run id`, start time, target and commit from `meta.json`, the stack fields from step 2 of
   "Before", and the verify and DLQ results from steps 2–3 above.

**If a run fails:** keep its directory and register line, and open an issue with the failing check
rows. Fix the cause, redeploy if needed (new register line with the new stack fields), then re-run.
The report states the number of attempts when a row needed more than one.

**Suggested order** for a dev experiment day (lowest risk first; about 3 h including waits):

1. smoke
2. access-control
3. correctness
4. preference-order
5. repeat-execution
6. expiry-race
7. concurrency
8. backfill
9. failure-recovery
10. the k6 matrix (last)
11. `cost-snapshot.sh` the next morning (Cost Explorer lags about a day)

---

## 7. `results/` directory convention

```
results/
  RUNS.md                                  run register: one line per invocation, failed ones included (append-only)
  <YYYY-MM-DD>-<experiment>[-<n>]/         one directory per harness invocation; never overwritten (-2, -3 … when it exists)
    summary.md      verdict, pass criterion, run id, target, commit, headline tables      ← the report quotes this
    meta.json       runId, startedAt/finishedAt, target {name, stage, apiBase}, commit {hash, dirty, branch},
                    runs, holdSeconds, faults, label, params, checks {total, passed, failed, skipped}, headline numbers
    raw.csv         one row per sample / probe / trial (or per check when the script has no samples)
    checks.csv      the assertions (when raw.csv holds samples)
    latency.csv | late-tick.csv | notifier.csv   script-specific extras
    plots/          <file>-<column>-{hist,cdf}.png + -stats.csv from analysis/plot_results.py (never edited by hand)
  <YYYY-MM-DD>-core-tests/                 vitest log + coverage-summary.json + commit.txt (engine property test)
  <YYYY-MM-DD>-smoke-dev/                  manual smoke evidence of 2026-10-17 (run.log, meta.json, script copy)
  loadtest/<YYYY-MM-DD>/                   k6 matrix: raw.csv, summary.md, runs.json, k6/<target>/, logs/<target>/, docker-stats.csv
  replay/                                  mechanism comparison (1,000 seeds): raw.csv, summary.md, *.svg
  cost/                                    model-summary.md, crossover.png, unit-cost.png, crossover-curve.csv,
                                           usage-priced.md, snapshots/<date>.json
  interviews/                              interview records (docs/interviews/README.md)
  user-study/                              study CSV outputs, summary.md, charts (docs/user-study/README.md)
```

Rules:

- Scripts create the directories. Nothing under `results/` is edited by hand, except `RUNS.md` and
  the free-text notes the study package names.
- Dates are UTC (the harness uses `toISOString()`).
- `results/` is excluded from Prettier and ESLint (`.prettierignore`, `eslint.config.js`). It is
  committed together with the code that produced it. `packages/core/coverage/` is git-ignored,
  which is why the core-tests directory keeps a copy of `coverage-summary.json`.

---

## 8. From a run directory to the report

1. **One source per number.** Every number in `report/Final.tex` (tables and text) is copied from a
   `summary.md` or `meta.json`. A LaTeX comment on the same line names the file, e.g.
   `% src: results/2026-11-01-backfill/summary.md (expired p95)`. `report/build.sh` fails on
   placeholders (`TODO`, `TBD`, `??`).
2. **System-results table (§4): "target vs measured".** One row per Table 3 entry. Columns: target
   (the pass criterion above), measured value (headline number), runs (e.g. `3/3 PASS`), and the
   source directory.
   - Use the **dev** runs for the table.
   - Local runs appear only in the cloud vs on-prem parity sentence and in the performance and cost
     comparison.
3. **Aggregation across runs.**
   - Functional rows report `passed/total` runs, and totals summed over runs (checks, probes,
     violations).
   - Latency rows pool the samples of all runs in the cited directory (`raw.csv`). They report n,
     p50, p95 and max with the nearest-rank percentile the scripts use (`lib/results.ts`
     `percentile`).
   - Performance uses the per-level median of the 3 rounds from `results/loadtest/<date>/summary.md`.
4. **Figures.** They are generated from the raw files:
   - latency histograms and CDFs with `tools/experiments/analysis/plot_results.py`;
   - performance p95 by VU from `results/loadtest/<date>/raw.csv`;
   - the replay SVGs and the cost crossover PNG from their own tools.

   They are copied to `report/figures/` under a name that keeps the source directory in the caption. They are never redrawn by hand with different data. The
   architecture and sequence figures are redrawn from the Mermaid sources in
   `docs/ARCHITECTURE.md` (Figures A–C).
5. **Honesty.** A missed target is reported as missed, with the measured value and the explanation
   (e.g. hot-spot serialisation). Skipped steps (no credentials, local-only limits such as the
   notifier outage) are named in the table footnote.
