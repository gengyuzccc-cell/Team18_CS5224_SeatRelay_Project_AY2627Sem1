# SeatRelay: code explanation (Team 18, NUS CS5224, AY2026/27 Sem 1)

SeatRelay runs registration for one workshop offered in 2–5 equivalent sessions: a participant registers
once with an ordered list of acceptable sessions, joins one queue, holds at most one seat, and a released
seat is offered automatically to the next person in line with a time limit to confirm (a timed hold).

This README is the source of Final report §6 (Code Explanation). The design as implemented is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the full plan (Chinese) is
[docs/plan/execution-plan.md](docs/plan/execution-plan.md).

## 1. Live deployments

| What | URL | Notes |
|---|---|---|
| Public repository | https://github.com/gengyuzccc-cell/Team18_CS5224_SeatRelay_Project_AY2627Sem1 | this code |
| Web app, pilot stage | https://diiztwl34x7s1.cloudfront.net | real participants; fault flags off, e-mail on |
| Web app, dev stage | https://d2ni5e1z674t04.cloudfront.net | experiments and demo; fault flags on, e-mail off |
| API, dev | https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com | `GET /health` is public; everything else needs a Cognito ID token |
| API, pilot | https://dx40kccif3.execute-api.ap-southeast-1.amazonaws.com | as above |

Region `ap-southeast-1`. Stack outputs and parameters: [docs/deployment-state.md](docs/deployment-state.md).
The dev stage is an experiment stage and can be torn down after the presentation (plan §3 step 29);
the pilot stage and the repository stay up.

## 2. Repository layout

pnpm workspace (Node 22, TypeScript, ESM). Dependency direction: `contracts` ← `core` ← `service` ←
{`aws`, `local`}; `apps/web` depends only on `contracts` ([docs/CONVENTIONS.md](docs/CONVENTIONS.md) §1).

| Path | Package | One line |
|---|---|---|
| `packages/contracts` | `@seatrelay/contracts` | zod schemas and types shared by every layer: entities, enums, commands, API bodies, error codes, constants (hold bounds, cut-off, TTLs) |
| `packages/core` | `@seatrelay/core` | the pure engine: `decide()` (tick-first), `allocate()`, `checkInvariants()`, the PER_SESSION baseline; no I/O, no clock |
| `packages/service` | `@seatrelay/service` | ports, the HTTP route table (`createApiApp`), the worker protocol (`processCommand`), the sweep (`runSweep`), read models, in-memory adapters |
| `services/aws` | `@seatrelay/aws` | SAM templates (`auth`, `app`, `web`), five Lambda handlers, DynamoDB / SQS / SES adapters, esbuild bundler |
| `services/local` | `@seatrelay/local` | on-prem reference: Fastify + PostgreSQL + Keycloak + Mailpit + nginx (Docker Compose), same `service` and `core` code |
| `apps/web` | `@seatrelay/web` | React SPA (Vite); one build for CloudFront and for the local nginx; OIDC code + PKCE; command polling |
| `tools/e2e` | `@seatrelay/e2e` | Playwright walkthrough of the deployed SPA (hosted-UI sign-in, polling, dashboard) by four staged accounts; writes `docs/demo/screenshots/`, `docs/demo/backup-demo.mp4` and `results/<date>-web-walkthrough-<stage>/` |
| `tools/experiments` | `@seatrelay/experiments` | one script per Table 3 row plus `smoke`; `bin/run-table3.sh`; `analysis/plot_results.py`; `cost/` (prices, on-prem inputs, `model.py`) |
| `tools/loadtest` | `@seatrelay/loadtest` | k6 scenarios `cross-workshop` and `hotspot`, `prepare-scenario`, `run-matrix` |
| `tools/replay` | `@seatrelay/replay` | mechanism comparison: the same arrivals replayed through the real engine in UNIFIED and PER_SESSION mode, 1,000 seeds |
| `tools/scripts` | `@seatrelay/scripts` | test accounts and token caches, `seed-demo`, `seed-study`, and the Bash deploy / web publish / teardown / cost-snapshot scripts |
| `docs/` | | architecture, conventions, runbook, experiments, cost, demo, market sizing, interview and user-study packages, talk notes |
| `results/` | | raw outputs of every run (the only source of report numbers), see section 9 |
| `report/` | | Final report sources, `report/build.sh` (page and placeholder checks; `-s` builds the git-ignored Canvas copy with student numbers), `report/tools/report_numbers.py` (numbers file generator) |
| `.github/workflows/ci.yml` | | CI: lint, typecheck, tests (with core coverage), web and Lambda builds, `pnpm audit`, `sam validate --lint` |

Each package has its own README with module tables and environment variables; an index is in
[docs/README-index.md](docs/README-index.md).

## 3. How the pieces fit

```
sign-in      browser (apps/web) ──OIDC code + PKCE──> Cognito ──> ID token
request      browser ──POST /workshops/{id}/commands──> HTTP API (JWT authorizer) ──> api
                 api ──> DynamoDB: put CMD#{commandId} if absent (ACCEPTED)
                 api ──> commands.fifo (group = workshopId, dedup = commandId) ──> 202 to the browser
polling      browser ──GET /commands/{id}──> api ──> DynamoDB (consistent read) ──> ACCEPTED | APPLIED | REJECTED
worker       commands.fifo ──> worker: load live items ──> decide() ──> send timers ──> one TransactWriteItems
timers       worker ──TICK, DelaySeconds ≤ 900──> expiry-delay ──> expiryForwarder ──> commands.fifo
safety net   EventBridge Scheduler rate(5 min) ──> sweep ──query DUE index──> commands.fifo
notify       DynamoDB Streams (INSERT of NOTIFICATION) ──> notifier ──> SES (≤ 1 e-mail/s)
```

**Layering.** Every business rule is in `packages/core`. `decide(snapshot, command, { now, newId })`
returns writes, notifications, timers, backfill records and an optional REALLOCATE continuation
(`packages/core/src/decide.ts`). `packages/service` holds the API behaviour and the worker protocol.
The AWS and Postgres adapters map each engine `Change` to fixed items or rows and contain no rules.
The Lambda handlers in `services/aws/src/handlers/` are thin wrappers.

**Request path** (ARCHITECTURE §3, Figure B):
1. The SPA signs in with authorization code + PKCE and sends the Cognito ID token. API Gateway's JWT
   authorizer checks it before any Lambda runs.
2. Reads and organisation/workshop CRUD are synchronous. Every change to a workshop's live state is a
   command: `POST /workshops/{id}/commands` with a client-generated `commandId`.
3. The API writes the command record `CMD#{commandId}` conditionally (status ACCEPTED). It then enqueues
   the command on `commands.fifo` (group = workshop, dedup id = `commandId`) and answers **202**. If the
   enqueue fails, the record is deleted and the API answers 503.
4. The browser polls `GET /commands/{id}` (consistent read) after 300, 500, 1000, then every 2000 ms,
   and every 5 s after 30 s, until APPLIED or REJECTED. Changes caused by other people reach the
   status page through a 10 s refresh while a registration is QUEUED or OFFERED.

**Worker path** (ARCHITECTURE §4): FIFO delivers one message per workshop group at a time, so each
workshop has one serial writer. `processCommand` runs these steps:
1. If the command is already settled, acknowledge it.
2. Load the live snapshot (`begins_with(SK,'L#')`, consistent).
3. Run `decide()`: tick-first, apply, drain, allocate, `nextDueAt`.
4. Send the offers' timers.
5. Commit one `TransactWriteItems` with `version = expected` on the workshop item and
   `status = ACCEPTED` on the command record.
6. Enqueue the continuation and emit the metrics.

**Timers** (ARCHITECTURE §5): for each new offer the worker sends a TICK to the standard queue
`expiry-delay` with `DelaySeconds = clamp(expiresAt − now, 0, 900)` **before** the commit. FIFO queues
have no per-message timers. `expiryForwarder` moves a due TICK into the workshop's FIFO group with
dedup id `tick#offerId#expiresAt`. A TICK that is still early goes back to the delay queue (at least
1 s, at most 900 s), which also covers holds longer than 15 minutes.

**Sweep** (ARCHITECTURE §6): every commit maintains `nextDueAt` and a sparse index item (`L#DUE`).
EventBridge Scheduler runs `sweep` every 5 minutes, which sends a TICK to every workshop whose
`nextDueAt` has passed. It catches lost timers, cut-offs and lost continuations. It is not on the
latency path: `SweepLateExpiries` counts the expiries it had to do.

**Notifier** (ARCHITECTURE §7): notifications are written in the same transaction as the state change
and appear in-app at once. A DynamoDB Streams filter (INSERT, `entityType = NOTIFICATION`) invokes
`notifier`, which sends through SES at most 1 e-mail/s and marks each item SENT, FAILED or SKIPPED.

## 4. Build and test

Prerequisites: Node 22 and pnpm 10 (`corepack enable`). Docker with Compose v2 for the on-prem stack.
AWS CLI v2 and SAM CLI for deployment. k6 for the load test. Python 3 with pandas, matplotlib and
scipy for the analysis (`tools/experiments/requirements.txt`). Versions are listed in
[docs/RUNBOOK.md](docs/RUNBOOK.md) §0.

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test        # every package (what CI runs)
pnpm --filter @seatrelay/web build              # SPA → apps/web/dist
pnpm --filter @seatrelay/aws build              # Lambda bundles → services/aws/dist/<fn>/index.mjs
pnpm --filter @seatrelay/aws validate           # sam validate --lint on the three templates
```

| Command | What it checks |
|---|---|
| `pnpm --filter @seatrelay/core test` | One unit test per rule and per reject reason. A fast-check property test runs 2,000 random command sequences (up to 200 steps, random clock jumps) and checks `checkInvariants` after every step. v8 coverage thresholds are **95 %** for branches, lines, functions and statements (`packages/core/vitest.config.ts`); the summary is in `packages/core/coverage/coverage-summary.json`. |
| `pnpm --filter @seatrelay/service test` | API 401/403/404/202/503, idempotent `commandId`, worker retry on version conflict, acknowledging an already-settled command, fault injection, sweep, views |
| `pnpm --filter @seatrelay/aws test` | Exact `TransactWriteItems` contents and cancellation-reason mapping, SQS dedup ids and delays, forwarder re-delay, notifier status handling (`aws-sdk-client-mock`, no AWS access) |
| `pnpm --filter @seatrelay/aws test:ddb-local` | Opt-in. Runs against DynamoDB Local and compares the result with the in-memory reference store (`services/aws/README.md`). |
| `pnpm --filter @seatrelay/web test` | Polling backoff, command runner retries, settled-result cache merge, session renewal |

## 5. Deploy (AWS)

Three stacks: `seatrelay-auth` (Cognito, SES identity, budgets; deployed once, never deleted),
`seatrelay-app-<stage>` and `seatrelay-web-<stage>` for `<stage>` = `dev` or `pilot`. The
`samconfig.toml` environments are in `services/aws/samconfig.toml`.

```bash
STAGE=dev ALARM_EMAIL=team@example.com tools/scripts/bin/deploy-all.sh
#   bundles → sam deploy web-<stage> → sam deploy <stage> (WebOrigin = CloudFront URL)
#   → registers the URL as Cognito callback/logout URL → tools/scripts/bin/deploy-web.sh (SPA upload + invalidation)
STAGE=dev tools/scripts/bin/teardown.sh           # empties the bucket, deletes web + app stacks, keeps auth
```

| `--config-env` | Stack | Template | Stage parameters |
|---|---|---|---|
| `auth` | `seatrelay-auth` | `templates/auth.yaml` | budgets US$20/month and US$60/year |
| `dev` | `seatrelay-app-dev` | `templates/app.yaml` | `AllowFaultFlags=true`, `EmailEnabled=false`, throttle 300 rps / 500 burst, no table deletion protection |
| `pilot` | `seatrelay-app-pilot` | `templates/app.yaml` | `AllowFaultFlags=false`, `EmailEnabled=true`, throttle 50 / 100, deletion protection on |
| `web-dev`, `web-pilot` | `seatrelay-web-<stage>` | `templates/web.yaml` | private S3 bucket + CloudFront with Origin Access Control |

`sam deploy` uploads the esbuild output directly (`CodeUri: ../dist/<fn>`, runtime `nodejs22.x`,
arm64). Test accounts without e-mail:
`pnpm --filter @seatrelay/scripts create-test-users --count 60 --prefix loaduser --password '<pw>' --stage dev`.
Procedures and alarms: [docs/RUNBOOK.md](docs/RUNBOOK.md). Account setup:
[docs/aws-setup.md](docs/aws-setup.md).

## 6. On-premise reference (Docker Compose)

```bash
pnpm local:up        # docker compose -f services/local/docker-compose.yml up --build -d
pnpm local:down      # stop and drop the data volume
```

| URL | Service |
|---|---|
| http://localhost:8081 | the same SPA build behind nginx |
| http://localhost:3000/health | Fastify API with in-process worker, timer, sweep, notifier and janitor loops |
| http://localhost:8080 | Keycloak 26, realm `seatrelay` (users `organiser@`, `alice@`, `bob@`, `carol@example.com`) |
| http://localhost:8025 | Mailpit (all outgoing e-mail) |

The worker claims rows with `FOR UPDATE SKIP LOCKED` and serialises each workshop with
`pg_advisory_xact_lock`. Timers are rows in a `timers` table, and the sweep is the same `runSweep`. The
component-by-component mapping is in ARCHITECTURE §15 and `services/local/README.md`. This stack is the
"same functionality" side of the cost comparison ([docs/COST.md](docs/COST.md)).

## 7. Run the experiments

Procedures, pass criteria and the run checklist are in [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md).
Every script talks to a deployment only through the public API (POST → 202 → poll), as the browser
does.

```bash
TARGET=dev tools/experiments/bin/run-table3.sh                       # all Table 3 rows × 3 runs, then the k6 matrix
TARGET=dev ONLY="backfill expiry-race" tools/experiments/bin/run-table3.sh
SKIP_K6=1 TARGET=local tools/experiments/bin/run-table3.sh            # against the Docker Compose stack
```

| Table 3 row | Command (`--target local` or `dev`, `--runs N`, `--help` on every script) | Output |
|---|---|---|
| Smoke (pre-check) | `pnpm --filter @seatrelay/experiments smoke --target dev` | `results/<date>-smoke/` |
| Core correctness | `pnpm --filter @seatrelay/experiments correctness --target dev --runs 3` | `results/<date>-correctness/` |
| Preference, order | `pnpm --filter @seatrelay/core test` (property test) and `pnpm --filter @seatrelay/experiments preference-order --target dev --runs 3` | `results/<date>-core-tests/`, `results/<date>-preference-order/` |
| Concurrency | `pnpm --filter @seatrelay/experiments concurrency --target dev --runs 3 --accounts 50` | `results/<date>-concurrency/` |
| Repeat execution | `pnpm --filter @seatrelay/experiments repeat-execution --target dev --runs 3` | `results/<date>-repeat-execution/` |
| Expiry race | `pnpm --filter @seatrelay/experiments expiry-race --target dev --runs 3 --hold 60` | `results/<date>-expiry-race/` |
| Failure recovery | `pnpm --filter @seatrelay/experiments failure-recovery --target dev --runs 3 --outage 60` | `results/<date>-failure-recovery/` |
| Access control | `pnpm --filter @seatrelay/experiments access-control --target dev --runs 3` | `results/<date>-access-control/` |
| Backfill latency | `pnpm --filter @seatrelay/experiments backfill --target dev --runs 3 --offers 100` | `results/<date>-backfill/` |
| Performance (k6) | `pnpm --filter @seatrelay/loadtest prepare-scenario --target dev` then `pnpm --filter @seatrelay/loadtest run-matrix --target dev` (2 scenarios × 10/25/50 VUs × 3 rounds) | `results/loadtest/<date>/` |
| Mechanism comparison | `pnpm replay --seeds 1000 --out results/<date>-replay` (without `--out` it overwrites `results/replay/`) | `results/replay/` |
| Cost | `tools/scripts/bin/cost-snapshot.sh`, then `python3 tools/experiments/cost/model.py [--from-snapshot results/cost/snapshots/<date>.json]` | `results/cost/` |

| Analysis | Command | Output |
|---|---|---|
| Latency histogram and CDF | `python3 tools/experiments/analysis/plot_results.py results/<date>-backfill --value latencyMs --group cause` | `<run>/plots/` |
| User study (completion, paired task time with Wilcoxon, SUS) | `python3 docs/user-study/analysis.py` | `results/user-study/` |
| Demo and study presets | `pnpm --filter @seatrelay/scripts seed-demo --target dev --hold 3600`, `seed-study --track participant --dataset A` | stdout (JSON) |
| Report numbers and figures | `python3 -I report/tools/report_numbers.py`, `python3 -I report/tools/make_figures.py` | `report/generated/numbers.tex`, `report/figures/generated/` |

Fault flags (`_fault: BEFORE_COMMIT | AFTER_COMMIT | TIMER_SEND`) only work on dev. The pilot API strips
them. Never run the k6 matrix against pilot: its throttle is 50 rps.

## 8. Claim → code

Paths are relative to the repository root. "Evidence" names the test or experiment that checks the
claim. Experiment outputs are in `results/` (section 9).

| Report claim | Implemented in | Evidence |
|---|---|---|
| **R1** one live registration per account per workshop (per session in PER_SESSION mode) | `register()` in `packages/core/src/apply.ts`, `registrationConflicts()` in `packages/core/src/perSession.ts`. Mirrored by the `L#U#{userId}` marker (`uniqueMarkerItem`, `services/aws/src/adapters/dynamo/mapping.ts`; conditional put in `DynamoWorkshopStore.buildTransaction`, `.../dynamo/store.ts`) and by the unique index `registrations_r1_idx` (`services/local/sql/schema.sql`) | `packages/core/test/register.test.ts`; invariant `R1_DUPLICATE_REGISTRATION`; correctness `register-confirm` |
| **R2** queue order = FIFO arrival order = `seq` assigned by the worker | `register()`: `seq = workshop.seq + 1`; `commandGroupId()` in `packages/service/src/commands.ts` (group = workshop); `SqsCommandQueue` in `services/aws/src/adapters/sqs.ts`; worker `BatchSize: 1` in `services/aws/templates/app.yaml` | `register.test.ts`; correctness `cancel` (re-registration gets a new seq at the tail) |
| **R3** allocation in `seq` order, first acceptable session in preference order with a free seat | `allocate()` and `firstAllocatableSession()` in `packages/core/src/allocate.ts`; `isAllocatable()` in `packages/core/src/snapshot.ts` | `packages/core/test/allocate.test.ts`; `preference-order` (20 fixed cases) |
| **R4** `expiresAt = min(now + holdSeconds, cutoffAt)`, `cutoffAt = startsAt − 30 min`, nothing offered after cut-off | `offerExpiry()` (`allocate.ts`), `cutoffFor()` (`packages/core/src/factories.ts`), `endCutoffRegistrations()` (`packages/core/src/tick.ts`), creation check in `packages/service/src/api/routes/orgs.ts` | `tick.test.ts` (cut-off handling); invariant `OFFER_AFTER_CUTOFF` |
| **R5** decline or expiry removes that session; back to QUEUED with the same `seq`, or ENDED | `declineOffer()` (`apply.ts`), `expireOffer()` (`tick.ts`), `dropSessionFromRegistration()` (`packages/core/src/state.ts`) | `offers.test.ts`, `tick.test.ts`; correctness `decline` |
| **R6** cancellation exits completely; the seat is relayed in the same decision | `cancelRegistration()` and `cancelOne()` (`apply.ts`) | `cancel.test.ts`; smoke step 4 (backfill latency 0 ms) |
| **R7** capacity below `confirmed + held` rejected; an increase allocates at once; session cancel revokes and re-queues | `setCapacity()`, `cancelSession()` (`apply.ts`); `drainCancellations()` (`packages/core/src/drain.ts`) | `organizer.test.ts`; correctness `capacity-up`, `capacity-down`, `cancel-session`, `cancel-workshop` |
| **C1** no over-capacity: `confirmed + held ≤ capacity` | offers only when `freeSeats() > 0` (`snapshot.ts`); counters change only inside `decide()` and are committed atomically under the version lock; `checkInvariants()` codes `C1_*` (`packages/core/src/invariants.ts`), exposed by `GET …/verify` (`packages/service/src/api/routes/organiser.ts`) | `packages/core/test/property.test.ts`; correctness and concurrency (verify after every step) |
| **C2** at most one OFFERED/CONFIRMED hold per account per workshop | R1, one `currentOfferId` per registration, `allocate()` offers only to QUEUED registrations; `C2_DUPLICATE_HOLD` with `holdScopeKey()` (`perSession.ts`) | property test; replay (UNIFIED duplicate holds must be 0) |
| **C3** a command is applied at most once, whatever the duplication | client `commandId` (`apps/web/src/commands/commandRunner.ts`); `postCommand` (`packages/service/src/api/routes/commands.ts`); `putCommandAccepted` with `attribute_not_exists(PK)` + `ALL_OLD` and the settlement `commandResultUpdate` (`attribute_not_exists(PK) OR status = ACCEPTED`) in the same transaction as the effects (`services/aws/src/adapters/dynamo/store.ts`); FIFO dedup `dedupIdFor()` (`sqs.ts`); settled check in `processCommand()` (`packages/service/src/worker/processCommand.ts`) | `packages/service/test/worker.test.ts`; `repeat-execution` (5 concurrent copies, `AFTER_COMMIT` redelivery) |
| **C4, C6** | Their wording is in the Preliminary report, which is not in this repository. ARCHITECTURE §10 lists the enforced properties to map them to: per-workshop ordering, cut-off, durable notifications, auditability. | |
| **C5** expiry decided by server time at processing; a late tick never affects a newer offer | `tickFirst()` (`tick.ts`) at the start of every `decide()` (`decide.ts`); `lookupOwnLiveOffer()` checks `expiresAt` (`apply.ts`); `attachSettledOffer()` (`processCommand.ts`) → `OFFER_EXPIRED`; ticks never expire by id | `tick.test.ts`; `expiry-race` (ACCEPT at `expiresAt ± 200 ms`, injected stale TICK) |
| **C7** organiser actions only for members of the workshop's organisation | `requireOrgMember`, `assertOrganiser`, `requireOrgWorkshop` (`packages/service/src/api/context.ts`); organiser command check in `postCommand`; re-check in `decideAuthorised()` (`processCommand.ts`); `GET /commands/{id}` returns 404 to others; `OFFER_NOT_YOURS` in the engine | `packages/service/test/api.test.ts`; `access-control` |
| **Tick semantics**: TICK is only a wake-up; late or duplicate ticks are no-ops | `tickFirst()`; NOOP without commit for an internal command with no writes (`processCommand.ts`); `tickForTimer()`, `sweepTick()` (`packages/service/src/commands.ts`) | `tick.test.ts`, `worker.test.ts`; `expiry-race` stale TICK |
| **Polling protocol**: 202 + `pollAfterMs`; backoff 300 → 500 → 1000 → 2000 ms, 5 s after 30 s; consistent read; status pages refresh every 10 s | `apps/web/src/commands/{backoff,pollCommand,commandRunner}.ts`; `LIVE_REFRESH_MS` (`apps/web/src/api/queries.ts`); `COMMAND_POLL_AFTER_MS` (`packages/contracts/src/constants.ts`); `getCommand` route (`commands.ts`) with `ConsistentRead` (`store.ts`) | `apps/web/test/{backoff,pollCommand,commandRunner}.test.ts`; k6 `settle_ms` vs `server_settle_ms` |
| **Idempotent intake and 503 rollback**: no orphan record is ever polled | `postCommand` → `enqueueOrFail` → `deleteCommandIfAccepted` (`commands.ts`, `store.ts`) | `packages/service/test/api.test.ts` |
| **Single writer per workshop + optimistic lock + one transaction per decision** | FIFO group = workshop, `BatchSize: 1`, `VisibilityTimeout: 120` (≥ 6 × the 20 s worker timeout) in `app.yaml`; `DynamoWorkshopStore.commit` (`#version = :expectedVersion` on `L#META`, ≤ 100 items, `TransactionTooLargeError`); retry on `VERSION` up to 3 times (`processCommand.ts`) | `services/aws/test/store.test.ts`; concurrency (`MetaConflictRetries` expected 0) |
| **Per-offer timers before the commit** | `SqsTimerScheduler`, `delaySecondsFor()` (`services/aws/src/adapters/sqs.ts`); `timers.schedule` before `store.commit` (`processCommand.ts`); `services/aws/src/handlers/expiryForwarder.ts`; on-prem `createTimerLoop` (`services/local/src/timers.ts`) | `services/aws/test/{sqs,expiryForwarder}.test.ts`; `backfill`, `failure-recovery` `TIMER_SEND` |
| **Sweep safety net, not on the latency path** | `computeNextDueAt()` (`decide.ts`); `L#DUE` item with `GSI1PK = DUE` (`services/aws/src/adapters/dynamo/keys.ts`, `store.ts`); `listDueWorkshops()`; `runSweep()` (`packages/service/src/worker/sweep.ts`); `services/aws/src/handlers/sweep.ts`; `ScheduleV2 rate(5 minutes)` (`app.yaml`); `SweepLateExpiries` with `SWEEP_LATE_GRACE_MS` (`processCommand.ts`) | `services/aws/test/sweep.test.ts`; `backfill` (`SweepLateExpiries` = 0) |
| **Per-decision limits** keep every commit inside one DynamoDB transaction | `DEFAULT_DECISION_LIMITS` (12 offers, 12 expiries, 90 items) in `packages/core/src/state.ts`; `COMMIT_ITEM_COST` (`packages/core/src/changes.ts`); REALLOCATE continuation | `packages/core/test/budget.test.ts` |
| **Failure policy and fault injection** | `createWorkerHandler` (`services/aws/src/handlers/worker.ts`): deterministic rejections settle and never throw; `batchItemFailures` for the failed record and every later one; `activeFault()` on the first delivery only (`processCommand.ts`) | `services/aws/test/worker.test.ts`; `failure-recovery` |
| **Notifications decoupled from state changes** | `materializeNotification()` in the same transaction; Streams `FilterCriteria` INSERT + `NOTIFICATION` (`app.yaml`); `services/aws/src/handlers/notifier.ts`; `classifySesError()` (`services/aws/src/adapters/ses.ts`) | `services/aws/test/{notifier,ses}.test.ts`; `failure-recovery` notifier outage |
| **Budgets that ignore credits** | `MonthlyBudget` / `AnnualBudget` with `IncludeCredit: false` (`services/aws/templates/auth.yaml`) | [docs/COST.md](docs/COST.md) §2 |
| **Scoped IAM role per function** | `Policies` of each function in `app.yaml`: api and worker CRUD on the table (SAM's table-level template, broader than the actions they use) + their queue sends; forwarder sends only (no table access); sweep `dynamodb:Query` on `GSI1` + `BatchGetItem` + FIFO send; notifier `GetItem`/`UpdateItem` + `ses:SendEmail` + notify-DLQ send | `pnpm --filter @seatrelay/aws validate`; `access-control` (API side) |
| **PII minimisation and retention** | Only e-mail, display name and the Cognito user id (`sub`) from the verified token (`userFromEvent`, `services/aws/src/lib/auth.ts`; `buildCommand()`, `packages/contracts/src/commands.ts`); the HTTP API access log records source IP and user agent (`AccessLogSettings` in `app.yaml`); `POWERTOOLS_LOGGER_LOG_EVENT: 'false'` (`app.yaml`); TTL 30 d for command records and 90 d for notifications (`packages/contracts/src/constants.ts`, `packages/service/src/commands.ts`, `TimeToLiveSpecification` in `app.yaml`; on-prem `services/local/src/janitor.ts`); log retention 14 d (`LogRetentionDays`) | `packages/contracts/test/schemas.test.ts`; ARCHITECTURE §14 |
| **Mechanism comparison** uses the production engine | `tools/replay/src/simulate.ts` drives `decide()` in UNIFIED and PER_SESSION mode (`perSession.ts`) with a simulated clock | `tools/replay/test/replay.test.ts`; `results/replay/summary.md` |

Known deviations from the plan, with reasons, are in ARCHITECTURE §17. The main ones: Lambda runs on
`nodejs22.x`; the DUE key is on its own item; the mechanism comparison is a simulation only, with no
replay on dev.

## 9. Where results live

| Path | Content |
|---|---|
| `results/<YYYY-MM-DD>-<experiment>[-<n>]/` | One directory per harness invocation, never overwritten. `summary.md` gives the verdict, pass criterion, run id, commit and headline tables. `meta.json` holds the run metadata and headline numbers. `raw.csv` has one row per sample, probe or check. Some scripts add `checks.csv`, `latency.csv`, `late-tick.csv` or `notifier.csv`. |
| `results/<date>-table3-<target>.{log,status}` | Console log and one status line per experiment from `run-table3.sh` |
| `results/<date>-core-tests/` | vitest log, `coverage-summary.json`, `commit.txt` (property test and coverage; EXPERIMENTS §3.2) |
| `results/2026-10-17-smoke-dev/` | the first manual smoke on dev (`run.log`, `meta.json`, script copy) |
| `results/loadtest/<date>/` | k6 matrix: `raw.csv`, `summary.md`, `runs.json`, per-run k6 JSON and logs, `docker-stats.csv` (local) |
| `results/replay/` | mechanism comparison, 1,000 seeds: `raw.csv`, `summary.md`, SVG charts |
| `results/cost/` | `model-summary.md`, `crossover.png`, `unit-cost.png`, `crossover-curve.csv`; `snapshots/<date>.json` and `usage-priced.md` from measured usage |
| `results/user-study/`, `results/interviews/`, `results/pilot/` | study CSVs and `analysis.py` output, coded interview records and `summary.md`, pilot CSV exports. The team produces these; none exists yet. |
| `results/RUNS.md` | run register, one line per invocation, failed runs included (EXPERIMENTS §6). It is created by the first report run. |

Rules (EXPERIMENTS §7–8):
- Scripts create these directories, and nothing in them is edited by hand.
- Dates are UTC. A run made from a dirty working tree is not a report run.
- Failed and aborted runs are kept.
- Every number in the Final report comes from one of these files. `report/tools/report_numbers.py` turns them
  into one LaTeX macro per number (`report/generated/numbers.tex`). A number with no data yet is printed
  as a visible `\pending{…}` placeholder, and the submission build must find none left.

## 10. Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | design as implemented, Figures A–C (Mermaid), rule and constraint map, failure modes, security, on-prem mapping |
| [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) | Table 3 procedures, run checklist, path of a number into the report |
| [docs/COST.md](docs/COST.md) | three-layer cloud cost, on-prem model, crossover, sources |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | deployment, local stack, smoke, fault injection, alarms |
| [docs/DEMO.md](docs/DEMO.md) | live-demo script, fallback, reset |
| [docs/walkthrough/](docs/walkthrough/README.md), [docs/QA-prep.md](docs/QA-prep.md) | per-speaker talk notes and Q&A preparation |
| [docs/market-sizing.md](docs/market-sizing.md) | market-size inputs with sources, competitor scan |
| [docs/interviews/](docs/interviews/README.md), [docs/user-study/](docs/user-study/README.md) | interview and user-study packages (protocol, consent, tasks, SUS, analysis) |
| [docs/deployment-state.md](docs/deployment-state.md), [docs/aws-setup.md](docs/aws-setup.md), [docs/ses-production-request.md](docs/ses-production-request.md) | live identifiers, account setup, SES request |
