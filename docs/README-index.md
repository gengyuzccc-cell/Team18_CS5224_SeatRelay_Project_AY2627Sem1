# SeatRelay repository index

A map of the pnpm workspace: one paragraph per package or service, with a link to its README. The
dependency direction is `contracts` ← `core` ← `service` ← {`aws`, `local`}; `apps/web` depends only
on `contracts`; the tools use the public API, or `core` for the replay (`docs/CONVENTIONS.md` §1).
The system design is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Libraries (`packages/`)

**[`@seatrelay/contracts`](../packages/contracts/README.md)** (`packages/contracts`).
The shared vocabulary of the system, written as zod schemas with the TypeScript types inferred from
them. It defines every enum once (workshop, session, registration, offer and command statuses,
reject reasons, backfill causes, fault flags) and the entities. It also defines the command bodies
the browser posts and the full commands the worker processes, including the internal TICK and
REALLOCATE. The request and response shapes of every API route, the error codes and their HTTP
statuses, and the shared constants (hold bounds, 2–5 sessions, 30-minute cut-off, poll hint, TTLs)
live here too. `buildCommand()` injects the actor from the verified token, so request bodies never
carry it. Depends on zod only.

**[`@seatrelay/core`](../packages/core/README.md)** (`packages/core`).
The pure domain engine; it does no I/O, reads no clock and generates no ids.
`decide(snapshot, command, { now, newId })` runs, in order:
1. tick-first expiry and cut-off handling;
2. the command itself, or a deterministic rejection;
3. draining of organiser cancellations;
4. seq-ordered allocation with `expiresAt = min(now + holdSeconds, cutoffAt)`;
5. the recomputation of `nextDueAt`.

It returns the writes, notifications, timers, backfill records and an optional REALLOCATE
continuation. The engine also includes `checkInvariants()` (C1, C2/R1, consistency,
no-starvation) and the PER_SESSION baseline strategy. Per-decision limits (12 offers, 12 expiries,
90 storage items) keep every commit inside one DynamoDB transaction. Tests: unit tests for every
rule and reject reason, plus a fast-check property test (2,000 random sequences) with ≥ 95 % branch
coverage.

**[`@seatrelay/service`](../packages/service/README.md)** (`packages/service`).
The framework-agnostic application layer that both deployments share. It contains:
- the **ports** that the AWS and on-prem adapters implement (`WorkshopStore`, `CommandQueue`,
  `TimerScheduler`, clock, ids, logger, metrics);
- the **HTTP route table** `createApiApp().handle(req)`: idempotent 202 command intake with a 503
  rollback, consistent polling of command results, the C7 organisation checks, the dashboard, CSV
  export, attendance and `verify`;
- the **worker orchestration** `processCommand`: load snapshot → decide → schedule timers → commit
  with retry on version conflicts → acknowledge already-settled redeliveries → continuation →
  metrics, plus fault injection;
- the sweep `runSweep`, the read models, and in-memory adapters with a test harness.

## Services (`services/`)

**[`@seatrelay/aws`](../services/aws/README.md)** (`services/aws`).
The cloud deployment. Three SAM templates:
- `auth.yaml`: Cognito user pool with `web` and `tooling` clients, hosted UI, SES identity,
  budgets. Deployed once.
- `app.yaml`, one stack per stage: DynamoDB single table, `commands.fifo` and its DLQ, the
  `expiry-delay` queue, five Lambda functions, the HTTP API with a JWT authorizer, alarms and the
  dashboard.
- `web.yaml`: private S3 bucket behind CloudFront with OAC.

The five thin Lambda handlers are `api`, `worker`, `expiryForwarder`, `sweep` and `notifier`. The
adapters cover:
- the DynamoDB key design with the live/history split;
- the single `TransactWriteItems` commit with the META version lock and the conditional CMD
  settlement;
- SQS deduplication ids and clamped delays;
- SES error classification.

`scripts/build.mjs` bundles one ESM file per function with esbuild for `nodejs22.x` on arm64. The
README lists every environment variable and the key table.

**[`@seatrelay/local`](../services/local/README.md)** (`services/local`).
The on-premise reference used for the cost comparison and the parity checks. One Node process runs
a Fastify API with `jose` JWT verification against Keycloak, plus in-process worker, timer, sweep,
notifier and janitor loops on PostgreSQL 16. The worker claims rows with `FOR UPDATE SKIP LOCKED`
and serialises each workshop with an advisory lock. The stack is run by Docker Compose together
with Keycloak 26, Mailpit and nginx serving the same SPA build. It runs the same `service` and
`core` code as AWS. The README maps each AWS component to its local counterpart and documents the
configuration, the smoke script and the store tests against a real database.

## Web app (`apps/`)

**[`@seatrelay/web`](../apps/web/README.md)** (`apps/web`).
The Vite + React single-page app; one build serves both CloudFront and the local nginx, with
runtime configuration from `/env.js`. Sign-in uses OIDC authorization code + PKCE against Cognito
or Keycloak (`authAdapter` handles the logout differences), and the ID token is sent to the API.
It includes:
- the public workshop page with the preference-ordered registration form;
- "My registrations" status cards with queue position, offer countdown and Accept / Decline /
  Cancel;
- the notification centre;
- the organiser area: organisations, a 3-step workshop wizard, and a dashboard with sessions,
  queue, offers, confirmations, backfill log, capacity and cancel actions, attendance, CSV export
  and "Verify invariants".

Commands use client-generated ids and poll with a 300 → 2000 ms backoff.

## Tools (`tools/`)

**[`@seatrelay/replay`](../tools/replay/README.md)** (`tools/replay`).
The mechanism-comparison simulation. For 1,000 seeded scenarios it replays the same arrivals and
participant behaviour through the real engine twice: once in UNIFIED mode, once in the PER_SESSION
baseline mode, with a simulated clock and ideal timers. It reports duplicate holds, distinct
participants served, wasted seats, relay latency and seat refill time, with bootstrap 95 % CIs and
paired differences. Output goes to `results/replay/` (`raw.csv`, `summary.md`, SVG charts).

**[`@seatrelay/loadtest`](../tools/loadtest/README.md)** (`tools/loadtest`).
The k6 performance matrix for the Table 3 "Performance" row. It has two scenarios, `cross-workshop`
(10 workshops) and `hotspot` (one workshop, one FIFO group), each run at 10 / 25 / 50 VUs × 3
rounds. Each VU iteration is read, REGISTER (202), poll every 200 ms, then CANCEL. The output
includes read, 202 and client- and server-side settle percentiles and the error rate. On dev the
matrix adds CloudWatch queue depth and age; locally it samples `docker stats`. `prepare-scenario`
creates the workshops, and `run-matrix` writes `results/loadtest/<date>/`.

**[`@seatrelay/experiments`](../tools/experiments/README.md)** (`tools/experiments`).
One script per functional Table 3 row: `correctness`, `preference-order`, `concurrency`,
`repeat-execution`, `expiry-race`, `failure-recovery`, `access-control` and `backfill`, plus the
acceptance `smoke` test. They share a harness: a common CLI, accounts with token caching,
side channels to the queues, metrics and logs, and an output directory per run under
`results/<date>-<name>/` with `summary.md`, `raw.csv` and `meta.json` (including the run id and the
commit). The package also contains `analysis/plot_results.py` for the latency plots and `cost/`
(the price list, the on-prem assumptions and `model.py`, the cloud vs on-prem cost model). The
procedures and the report traceability rules are in [EXPERIMENTS.md](EXPERIMENTS.md).

**[`@seatrelay/e2e`](../tools/e2e/README.md)** (`tools/e2e`).
The real-browser walkthrough of a deployed stage (dev by default). Four staged accounts (organiser,
Alice, Bob, Carol) sign in through the Cognito hosted UI in separate Chromium contexts and play
demo beats D1–D4: register with ranked preferences, the offer countdown, accept, a cancellation
backfill seen on the next person's page, an expiry backfill, and the dashboard checks (attendance,
CSV export, verify). Every visible state is asserted. A passing run writes the slide screenshots
(`docs/demo/screenshots/`), the captioned backup video (`docs/demo/backup-demo.mp4`) and
`results/<date>-web-walkthrough-<stage>/`. This is operational evidence, not user evidence.

**[`@seatrelay/scripts`](../tools/scripts/README.md)** (`tools/scripts`).
The operational scripts:
- `create-test-users` (Cognito accounts without e-mail, plus a token cache);
- `get-tokens-keycloak` (local accounts and tokens);
- `seed-demo` (the demo preset of [DEMO.md](DEMO.md));
- `seed-study` (resets a user-study round);
- the Bash helpers `deploy-all.sh`, `deploy-web.sh`, `teardown.sh`, `cost-snapshot.sh` and
  `activate-cost-tags.sh`.

It also exports the typed API client, the identity-provider helpers and the token-cache library
that `loadtest` and `experiments` reuse. All seeding goes through the public API, so the seeded
state is produced by the engine.

## Documentation (`docs/`)

| Document | Content |
|---|---|
| [plan/execution-plan.md](plan/execution-plan.md) | Functional specification and project plan (Chinese), the authority for rules and targets |
| [CONVENTIONS.md](CONVENTIONS.md) | Cross-package engineering decisions (binding) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design as implemented, rule and constraint enforcement map, failure modes, security, on-prem mapping, Mermaid figures A–C |
| [EXPERIMENTS.md](EXPERIMENTS.md) | Table 3 procedures, run checklist, `results/` convention, path of numbers into the report |
| [DEMO.md](DEMO.md) | Live-demo script, fallback and reset |
| [RUNBOOK.md](RUNBOOK.md) | Deployment, local stack, smoke test, fault injection, alarms |
| [COST.md](COST.md) | Cloud vs on-prem cost method and sources |
| [deployment-state.md](deployment-state.md) | Live stack identifiers (no secrets) |
| [aws-setup.md](aws-setup.md) | Account, IAM and credential setup |
| [ses-production-request.md](ses-production-request.md) | SES production-access request text |
| [market-sizing.md](market-sizing.md) | Market-size estimate for the report |
| [interviews/README.md](interviews/README.md) | Interview package (guides, record template) |
| [user-study/README.md](user-study/README.md) | User-study package (protocol, tasks, SUS, analysis) |
