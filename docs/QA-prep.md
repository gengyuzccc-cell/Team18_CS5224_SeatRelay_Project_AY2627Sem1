# Q&A preparation (10 minutes after the talk)

The 20 questions a TA is most likely to ask, each with a 3–5 sentence answer based on the code and
the docs. Each answer ends with **Where:** the files that prove it, so whoever answers can point to
them.

How to answer:
- One person answers; the owner of that topic in [walkthrough/](walkthrough/README.md) goes first.
- Give the answer first, then the evidence.
- If the honest answer is "we did not measure that" or "that is a limitation", say so.
- Every number comes from `results/` or a cited source. A value written [PENDING: …] does not exist
  yet: replace it from the named file before the rehearsal, or say "not measured yet".

## Numbers to have ready

| Topic | Value | Source |
|---|---|---|
| Dev smoke test, 2026-10-17 | PASS, 13/13 checks; server-side settle p50 45 ms (n = 6); expiry backfill 117 ms (n = 1) | `results/2026-10-17-smoke/summary.md` |
| Prelim. Table 3 rows, Final Table 5 (correctness … backfill) | [PENDING: verdicts and headline numbers of the dev report runs] | `results/<date>-<experiment>/summary.md`; macros in `report/generated/numbers.tex` |
| Performance (k6, 50 VUs, cross-workshop and hot spot) | [PENDING] | `results/loadtest/<date>/summary.md` |
| Mechanism comparison (1,000 seeds, UNIFIED vs PER_SESSION) | distinct served 58.08 vs 54.03; duplicate-hold events 0.00 vs 34.57; mean per-run p95 refill time 9.45 vs 63.31 min | `results/replay/summary.md` |
| Cloud cost at 1k registrations per month: list / after free tier / after credits | US$13.30 / 0.52 / 0.00 | `results/cost/model-summary.md` |
| Crossover: list price vs on-prem increment / fully amortised | 3,861 / 52,654 registrations per month | `results/cost/model-summary.md` §3 |
| User study, pilot, interviews | [PENDING] | `results/user-study/`, `results/pilot/`, `results/interviews/` |

---

### 1. Why polling and not WebSockets?

Writes are asynchronous by design: the API answers 202 and the worker settles the command later.
The browser learns the outcome by polling `GET /commands/{id}`, one strongly consistent read, after
300, 500 and 1000 ms, then every 2 s, and every 5 s after 30 s. The response carries the
participant's new status, so the page updates from it alone; changes caused by other people arrive
through a 10 s refresh while a registration is QUEUED or OFFERED. At our scale WebSockets would add a
second API type, a connection table and another failure point for no gain we could measure (the
server-side settle median in the dev smoke was 45 ms). Polling adds up to one interval, so we report
server-side settle (`settledAt − acceptedAt`) and client-observed settle separately.
**Where:** `apps/web/src/commands/backoff.ts`, `apps/web/src/api/queries.ts`, `packages/service/src/api/routes/commands.ts`, ARCHITECTURE §3, `results/2026-10-17-smoke/summary.md`.

### 2. Why an SQS delay queue plus a forwarder instead of EventBridge Scheduler?

The expiry must travel the same ordered per-workshop path as user commands, so that the single writer
serialises an ACCEPT and the expiry of the same offer. SQS FIFO queues "don't support timers on
individual messages", and message timers stop at 15 minutes (`aws-sqs-timers`). So the worker puts
one TICK per offer on a standard queue with `DelaySeconds = clamp(expiresAt − now, 0, 900)`, and
`expiryForwarder` moves it into the workshop's FIFO group (dedup id `tick#offerId#expiresAt`).
One-time EventBridge schedules have no 15-minute limit, but they add a service, a role for the
scheduler to assume, and a create and a delete call per offer, and they would still have to target
the FIFO queue. The 900 s default hold fits one SQS hop, and the forwarder re-delays longer holds in
hops of at most 900 s.
**Where:** `services/aws/src/adapters/sqs.ts` (`SqsTimerScheduler`, `delaySecondsFor`), `services/aws/src/handlers/expiryForwarder.ts`, plan §1.2, ARCHITECTURE §5.

### 3. Doesn't the 5-minute sweep bound your backfill latency? (TA comment 2)

Not any more. Each offer now has its own timer. The sweep runs every 5 minutes over a sparse index of
workshops whose `nextDueAt` has passed, and is only a safety net for lost timers, cut-offs and lost
continuations. An expiry-driven relay costs the SQS delay, the forwarder, the FIFO hop and one worker
transaction; a cancellation or decline relays in the same transaction (0 ms). To show that the sweep
is not doing the work, the worker counts `SweepLateExpiries`: offers that a sweep tick expired more
than 60 s after `expiresAt`. It must be 0 in normal operation: [PENDING: `\BackfillSweepLateExpiries`
from results/<date>-backfill/summary.md].
**Where:** `packages/service/src/worker/sweep.ts`, `services/aws/src/handlers/sweep.ts`, `computeNextDueAt()` in `packages/core/src/decide.ts`, `SWEEP_LATE_GRACE_MS` in `packages/service/src/worker/processCommand.ts`, ARCHITECTURE §6.

### 4. What happens when an ACCEPT races the expiry timer?

Expiry is decided by the server clock when the worker processes a message, not by which message
arrives first: every decision starts by expiring all offers with `expiresAt ≤ now` (`tickFirst()`).
- An ACCEPT processed before `expiresAt` wins, even if its timer tick is already queued.
- An ACCEPT processed after `expiresAt` is rejected `OFFER_EXPIRED`, whether the tick came earlier,
  later or never.
- A late or duplicate tick writes nothing.

The edge case is an ACCEPT that reaches the API just before `expiresAt` but is processed just after
it: it loses. The expiry-race experiment measures this with ACCEPTs 200 ms either side of
`expiresAt`: [PENDING: results/<date>-expiry-race/summary.md].
**Where:** `packages/core/src/tick.ts`, `lookupOwnLiveOffer()` in `packages/core/src/apply.ts`, `attachSettledOffer()` in `processCommand.ts`, ARCHITECTURE §5.1, §11.

### 5. How does idempotency work (C3)?

There are three layers:
1. The browser generates the `commandId` and reuses it on retries. The API's write of
   `CMD#{commandId}` is conditional, so a duplicate POST gets the existing record back without a
   second read.
2. The FIFO deduplication id is the same `commandId`, so SQS drops copies within 5 minutes.
3. The decisive layer is in the worker. It updates the command record only if the record is still
   ACCEPTED, inside the same `TransactWriteItems` as the seat changes. A second application therefore
   cancels the whole transaction, and the worker acknowledges it as `ALREADY_SETTLED`.

The repeat-execution experiment posts the same command five times at once and crashes the worker
after the commit: [PENDING: `\RepeatProbesPassed` of `\RepeatProbes`].
**Where:** `apps/web/src/commands/commandRunner.ts`, `postCommand` in `packages/service/src/api/routes/commands.ts`, `putCommandAccepted` and `commit` in `services/aws/src/adapters/dynamo/store.ts`, `dedupIdFor()` in `services/aws/src/adapters/sqs.ts`, ARCHITECTURE §11.

### 6. What happens if the worker crashes after the commit, or before it?

- **After the commit.** The effects and the settled command record are already durable together.
  SQS redelivers the undeleted message after the 120 s visibility timeout. The worker sees the record
  APPLIED, runs one clean-up tick in case a continuation was lost, and acknowledges.
- **Before the commit.** Nothing was written except possibly timers, which only cause harmless ticks,
  and the redelivery processes the command normally.

Either way only that workshop's message group waits. A message that fails 3 times goes to the
dead-letter queue and raises an alarm; alarms also fire on messages older than 120 s, Lambda errors
and API 5xx responses. We inject all three crash points with `_fault` flags on dev ([PENDING:
results/<date>-failure-recovery/summary.md]), and the demo shows AFTER_COMMIT live.
**Where:** `packages/service/src/worker/processCommand.ts`, `services/aws/src/handlers/worker.ts`, `services/aws/templates/app.yaml` (queues, alarms), ARCHITECTURE §12, `docs/RUNBOOK.md` §5.

### 7. How do you guarantee no over-booking under concurrency?

Each workshop has a single writer: its FIFO message group with `BatchSize: 1` means Lambda processes
one message per workshop at a time. As a second line of defence, every commit is conditional on the
workshop's version number. If two decisions ever overlapped, one transaction would fail, and that
worker would reload and decide again (up to 3 times, counted as `MetaConflictRetries`). Each decision
preserves C1 and C2 on a consistent snapshot and commits all its writes in one transaction. The
evidence:
- the property test: 2,000 random sequences, with the invariants checked after every step;
- `verify` after every experiment step;
- 50 accounts racing for 5 seats on dev: [PENDING: `\ConcurrencyVerdict`, `\ConcurrencyMetaRetries`].

**Where:** `services/aws/templates/app.yaml` (worker event source), `DynamoWorkshopStore.commit` in `store.ts`, `packages/core/src/invariants.ts`, `packages/core/test/property.test.ts`, ARCHITECTURE §11.

### 8. Isn't serialising each workshop a bottleneck? (hot-spot workshop)

Yes, by design. Per-workshop arrival order (R2) and the single-lock argument both need one writer per
workshop, so a hot workshop processes one decision plus one transaction at a time. Different
workshops run in parallel, up to the worker's `MaximumConcurrency` of 5, a cost guard that can be
raised. The k6 `hotspot` scenario puts every virtual user on one workshop to measure this limit, and
we report what we measured: [PENDING: `\PerfDevHotspotVUFiftyServerSettlePNinetyFiveMs`, next to the
cross-workshop value]. The documented next step is to batch up to 10 messages per group and decide
them against one shared snapshot in one transaction.
**Where:** ARCHITECTURE §11 "Ordering cost", `tools/loadtest/scripts/hotspot.js`, plan §2.4 / §9.

### 9. How was the backfill latency measured?

On the deployed dev stack, with server timestamps only. `backfill.ts` creates 10 workshops with a
60 s hold, gives 100 seats to holders who never answer, and queues a full layer of people behind
them. Each expiry writes a backfill record with two timestamps:
- `releasedAt`: the offer's `expiresAt`;
- `reallocatedAt`: the server time of the decision that made the next offer.

So the latency covers the timer delay, the forwarder, the FIFO queue and the worker. Three runs are
pooled and reported as n, p50, p95, p99 and max (nearest rank). Outliers are listed, and
cancellation-driven backfills (same transaction) are reported separately. Results: [PENDING:
`\BackfillExpiredPNinetyFiveS`, `\BackfillExpiredMaxS`]. The one expiry in the dev smoke took 117 ms,
which is a single sample, not a statistic.
**Where:** `tools/experiments/src/backfill.ts`, `docs/EXPERIMENTS.md` §3.8, `addBackfill` / `fillBackfill` in `packages/core/src/state.ts`.

### 10. How do you define fairness?

Fairness is arrival order within each session:
- Each registration gets a sequence number in the order the workshop's FIFO queue delivers it (R2).
- Each free seat goes to the lowest-numbered queued person who listed that session, following that
  person's own preference order (R3).

Nobody is offered a session they did not list, or skipped for one they did; the preference-order
experiment checks both. The order is queue order, not click time, so requests a few milliseconds
apart are ordered by SQS. Declining or missing an offer keeps your number for your other sessions
(R5), and cancelling then registering again puts you at the end (R6). One hold per person (C2) also
stops anyone from blocking several seats.
**Where:** `register()` in `packages/core/src/apply.ts`, `allocate()` in `packages/core/src/allocate.ts`, `tools/experiments/src/lib/preferenceCases.ts`.

### 11. What does one queue across sessions actually buy? Is that real data?

We replayed 1,000 generated workshops twice through the production engine. UNIFIED mode is one
queue; PER_SESSION mode mimics separate forms, where people sign up for every acceptable session.
Per workshop, UNIFIED against PER_SESSION:
- distinct people served: 58.08 vs 54.03 (paired difference −4.04, 95 % CI [−4.25, −3.84]);
- duplicate-hold events: 0 vs 34.57;
- mean of the per-run p95 seat refill time: 9.45 vs 63.31 minutes.

It is a simulation with a simulated clock and ideal timers. The behaviour parameters are stated
assumptions, and the plan's live replay on dev was not done (ARCHITECTURE §17). Infrastructure
latency is measured separately on the deployed system (question 9).
**Where:** `tools/replay/src/simulate.ts`, `packages/core/src/perSession.ts`, `results/replay/summary.md`.

### 12. How does the cloud cost compare with on-prem, and why does Cost Explorer show 0?

We price a modelled workload with AWS Price List prices for Singapore, in three layers. At 1,000
registrations a month:

| Option | US$ per month |
|---|---|
| Cloud, list price | 13.30 |
| Cloud, after the free tier | 0.52 |
| Cloud, after credits | 0.00 |
| On-prem mini-PC, hardware alone | 29.09 |
| On-prem, fully amortised with a business line and labour | 299.31 |

List-price cloud costs more than the bare machine above 3,861 registrations a month and more than
the fully costed machine above 52,654, although the mini-PC has no failover. Cost Explorer's net
cost subtracts credits line by line and shows 0 while credits last, so we compute the billing layer
from usage × price and set `IncludeCredit: false` on the budgets, which could otherwise never fire. The workload drivers are modelled until usage snapshots replace
them: [PENDING: results/cost/usage-priced.md].
**Where:** `docs/COST.md`, `tools/experiments/cost/model.py`, `results/cost/model-summary.md`, `services/aws/templates/auth.yaml`.

### 13. Why serverless and DynamoDB rather than EC2 and RDS?

The load is bursty and mostly idle. Pay-per-request services cost almost nothing between registration
windows (US$0.52 a month after the free tier at 1,000 registrations), and there is no instance to
patch and no VPC or NAT gateway. DynamoDB fits the access pattern:
- one partition per workshop;
- one consistent Query of its live items, kept small by the live/history key split;
- one transaction of up to 100 items per decision.

The costs are the 100-item limit (hence the engine's 90-item budget and REALLOCATE continuations) and
per-workshop serialisation. The on-prem reference runs the same engine on PostgreSQL, so the design
is not tied to DynamoDB.
**Where:** `services/aws/src/adapters/dynamo/keys.ts`, `store.ts`, `packages/core/src/state.ts`, `services/local/`, ARCHITECTURE §8, §13.

### 14. E-mail is in the SES sandbox. What happens to notifications?

Our SES production request was denied on 2026-10-17 because the sender identity was not yet verified.
Re-applying is a team action (`docs/deployment-state.md`); until then SES delivers only to verified
addresses, at most 200 a day and 1 per second. Notifications are written in the same transaction as
the state change, so every participant sees them in the in-app notification centre whatever happens
to e-mail. The notifier treats `MessageRejected` as permanent and marks the item FAILED without
retrying; throttling is transient and retried from the stream. Dev runs with `EmailEnabled=false`
(items SKIPPED). Cognito's own sign-up e-mail has a separate quota of 50 a day, so experiment and
demo accounts are created without e-mail.
**Where:** `services/aws/src/handlers/notifier.ts`, `classifySesError()` in `services/aws/src/adapters/ses.ts`, ARCHITECTURE §7, plan §9.

### 15. How do you protect personal data?

We store only the e-mail address and display name from the verified ID token. Passwords are handled
only by Cognito (Keycloak on-prem), and request bodies never carry the user's identity: the API takes
it from the token. Lambda events are never logged, logs are kept 14 days, and DynamoDB TTL deletes
command records after 30 days and notifications after 90. Traffic is HTTPS only, the S3 bucket is
private behind CloudFront Origin Access Control, and DynamoDB is encrypted at rest. Registration
history has no TTL because organisers need it for the export. Interview and study records use
participant codes only, with consent.
**Where:** `services/aws/src/lib/auth.ts`, `buildCommand()` in `packages/contracts/src/commands.ts`, `packages/contracts/src/constants.ts`, `services/aws/templates/app.yaml` (`POWERTOOLS_LOGGER_LOG_EVENT`, `TimeToLiveSpecification`), ARCHITECTURE §14, `docs/user-study/consent.md`.

### 16. Why a single region? What are your RPO and RTO?

Every managed service we use is multi-AZ within `ap-southeast-1`, which covers the loss of one
availability zone; a full region outage is not covered. We would then redeploy the stacks with
`deploy-all.sh` and restore the table from point-in-time recovery, so data loss (RPO) is minutes. We
have not measured the recovery time (RTO). Multi-region would need DynamoDB global tables, whose
default mode resolves concurrent writes by last writer wins. That would break our per-workshop
version lock, so each workshop would need a home region, or a strongly consistent multi-region mode
that we have not evaluated. Cognito user pools are regional too. At pilot scale this is not
justified, and the report states single-region operation as a limitation.
**Where:** `services/aws/templates/app.yaml` (`PointInTimeRecoverySpecification`), ARCHITECTURE §12 (last rows), `docs/COST.md` §5.

### 17. How do you stop someone accepting another person's offer or reading another organisation's dashboard?

API Gateway's JWT authorizer checks signature, issuer, audience and expiry before any Lambda runs;
only `/health` and the public workshop page are anonymous. Every organiser route and organiser command
checks organisation membership in the API (403). The worker checks it again (`REJECTED(FORBIDDEN)`)
in case a message bypasses the API. Further rules:
- a workshop addressed through the wrong organisation returns 404;
- a command result is visible only to its issuer and the workshop's organisers;
- accepting someone else's offer is rejected by the engine (`OFFER_NOT_YOURS`).

The access-control experiment runs negative probes for each case: [PENDING: `\AccessProbesPassed` of
`\AccessProbes`].
**Where:** `packages/service/src/api/context.ts`, `decideAuthorised()` in `processCommand.ts`, `services/aws/templates/app.yaml` (`CognitoJwt`), `tools/experiments/src/access-control.ts`.

### 18. How big is the market really? (TA comment 1)

We sized it bottom-up from official counts. Five of the six autonomous universities list at least
693 student organisations. That is a lower bound: "more than X" counts as X, and the polytechnics are
excluded. The campus TAM is 693 × p × S$120, about S$83,000 × p a year, where p is the share of
organisers who run multi-session sign-ups, taken from our interviews: [PENDING:
`\InterviewPEventWeightedPct`]. That market is small, so the case rests on value per organiser: the
hours saved per multi-session event must be worth more than S$120 a year ([PENDING:
`\InterviewHoursMedian`]). Repeated sessions do occur: on the NUS Libraries calendar, 11 of 37
workshop events were repeats of two titles.
**Where:** `docs/market-sizing.md`, `report/references.bib`, `docs/interviews/README.md`.

### 19. What did you leave out of the 10-page report, and why?

The plan's page budget (plan §7.1) spends the space on what a reader must be able to check:
- the three TA comments (market size, per-offer timers, the settle protocol);
- the architecture and its rules;
- the evaluation, as targets against measured values.

Material that supports a conclusion without changing it lives in the repository, linked from the
Code Explanation section: the full failure-mode table, the DynamoDB key design, each experiment's
procedure and the per-service cost breakdown. Every number in the PDF is generated from `results/` by
`report/tools/report_numbers.py`, so the shorter text loses no traceability. The build check fails on more
than 10 pages, overfull boxes, undefined references or leftover placeholders.
**Where:** plan §7.1, `report/build.sh`, `report/generated/README.md`, `docs/ARCHITECTURE.md`, `docs/EXPERIMENTS.md`, `docs/COST.md`.

### 20. How did you use AI, and how did you make sure the result is correct?

Answer from the AI usage declaration in the Final report, and say no more than it says. An AI coding
assistant generated the code, templates, tests, scripts, desk research, documentation and first drafts,
and it ran the deployment, experiment, load-test, replay and cost scripts with the team's credentials.
The scope, rules R1–R7, constraints C1–C7 and acceptance targets are the team's, from the Preliminary
report. The interviews, the user study and the pilot are run by the team: [PENDING: their status on
the day; none had run on 2026-10-17]. How each member reviewed the generated work and what they
learned is in their own statement in the declaration ([PENDING: each member's confirmed statement]).
Correctness does not rest on trusting generated code; it rests on independent checks:
- the engine's property test and 95 % coverage threshold;
- CI on every push;
- the Prelim. Table 3 experiments (Final Table 5) against the deployed system, with `verify` after every step;
- report numbers generated only from `results/`.

Failed runs are kept and reported.
**Where:** Final report (AI usage declaration), `.github/workflows/ci.yml`, `packages/core/vitest.config.ts`, `docs/EXPERIMENTS.md` §6–8.
