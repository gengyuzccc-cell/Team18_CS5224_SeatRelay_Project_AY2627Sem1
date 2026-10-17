# Part 5: evaluation results and cost

- **Speaker:** ZHU GENGYU (data and the local reference). You take over from the demo narrator
  (ZHANG TIANYI, [part-4.md](part-4.md)) at 11:00. You also answer Q&A on backup slide B6 (what the
  repeat-execution and failure-recovery runs recorded).
- **Clock:** 11:00–13:00 (2:00)
- **Slides:** 9 System results (Prelim. Table 3 = Final Table 5 verdicts, one tile per aspect), 10 Latency, backfill and
  mechanism comparison (k6 p95 by virtual users, replay charts, backfill line), 11 Cloud vs on-prem
  cost (table and crossover chart), in `report/Slides.tex`
- **Hands over to:** Part 6 (user study, pilot, limitations)

## What to say (about 280 spoken words, 1:50 at 150 words a minute)

**Slide 9, system results.** We ran every experiment of the Preliminary report's Table 3, our Table 5,
on the dev stage, three runs each, through the public API. All eight scripted experiments pass:
correctness, 672 of 672 checks with no session over capacity; preference order, plus a property test
over 2,000 random sequences; concurrency, 50 accounts racing for 5 seats; and repeat execution, expiry
race, failure recovery, access control and backfill.

These are re-runs. In our first series, kept in the results, concurrency and backfill failed with HTTP
503s. CloudWatch shows each was a throttled Lambda call: the new account allowed only ten at once.
With the quota raised to 1,000, we re-ran everything on the same code.

**Slide 10, latency.** Under load, every target was met up to 50 virtual users, with no errors. At the
95th percentile, settling took at most 0.8 seconds across workshops, and 3.2 seconds on one hot
workshop at 50 users, whose commands are serialised by design. A seat freed by an expired hold reached
the next person in 0.1 seconds at the 95th percentile, over 300 expiries. In our simulation of 1,000
workshops, one queue never let anyone hold two seats, against 34.6 duplicate holds per workshop with
per-session forms. That part is a simulation, not live traffic.

**Slide 11, cost.** At 1,000 registrations a month the modelled cloud costs US$13.30 at list price, 52
cents after the free tier, and nothing after credits. One on-prem mini-PC costs about US$29 a month, or
US$324 with a business line and labour. The cloud costs more than the bare machine above about 3,900
registrations a month, and more than the fully costed one above about 57,300. The machine has no
failover.

Next, LIANG ZIHAN.

## Key numbers

Table 3 rows come from the dev re-run at Lambda quota 1,000 quoted in the Final report (Table 5; run
ids and commits in `report/generated/numbers.tex`, provenance in
`results/2026-10-17-table3-dev-q1000-provenance.md`). On the slide each row is one tile: verdict,
aspect, key value.

| Number | Value | Source |
|---|---|---|
| Experiments passing | 8 of 8 (smoke 13/13 too), on the same deployed code as the first series | `report/generated/numbers.tex` (`\SeriesPassed`, `\SeriesExperiments`); `results/RUNS.md` |
| First series (quota 10), kept as evidence | concurrency FAIL 22/39 and backfill failed on a throttled workshop creation and lost REGISTERs; every HTTP 503 was an API Lambda throttle (76 and 63; account concurrency maximum 10) | `results/2026-10-17-throttling-evidence/summary.md` (`\ThrottleFirstConcurrencyChecksPassed`, `\ThrottleConcurrencyApiThrottles`, `\ThrottleBackfillApiThrottles`, `\ThrottleConcurrencyAccountConcurrencyMax`) |
| Correctness: verdict, scenarios × runs, checks, over-capacity, double holds, verify calls | PASS; 9 × 3; 672/672; 0; 0; 234 calls, 0 failed | `results/2026-10-17-correctness-2/summary.md` (`\CorrectnessVerdict`, `\CorrectnessChecksPassed`, `\CorrectnessOverCapacity`, `\CorrectnessDoubleHolds`, `\CorrectnessVerifications`) |
| Preference order: cases as predicted, unacceptable offers | PASS; 60/60 (20 × 3); 0 | `results/2026-10-17-preference-order-2/summary.md` (`\PrefOrderCasesPassed`, `\PrefOrderNonAcceptable`) |
| Core engine: tests, property test, coverage | 127/127 tests in 13 files; 2,000 random command sequences (84,983 steps), every invariant held after every step; branch coverage 99.8 %, statements 100 % | `results/2026-10-17-core-tests/` (`\CoreTestsPassed`, `\CorePropertySequences`, `\CorePropertySteps`, `\CoreBranchCoveragePct`) |
| Concurrency: verdict, checks, failed commands, same-account races, version-conflict retries, settle p95 server / client | PASS; 39/39; 0 of 210; 15/15 consistent; 0; 1,525 / 3,384 ms; `verify` found no violation after any phase | `results/2026-10-17-concurrency-2/summary.md` (`\ConcurrencyVerdict`, `\ConcurrencyTransportErrors`, `\ConcurrencyCommands`, `\ConcurrencySameAccountConsistent`, `\ConcurrencyMetaRetries`, `\ConcurrencySettleServerPNinetyFiveMs`) |
| Repeat execution: duplicate-submission probes (5 concurrent copies each), AFTER_COMMIT probes | PASS; 12/12; 6/6 (18/18 in all) | `results/2026-10-17-repeat-execution-2/summary.md` (`\RepeatDupProbesPassed`, `\RepeatAfterCommitPassed`, `\RepeatProbes`) |
| Expiry race: early applied, late rejected, stale ticks without effect | PASS; 3/3; 3/3; 3/3 | `results/2026-10-17-expiry-race-5/summary.md` (`\ExpiryRaceEarlyApplied`, `\ExpiryRaceLateRejected`, `\ExpiryRaceLateTicksNoEffect`) |
| Failure recovery: before commit, timer step, after commit, dead letters, notifier backlog (on dev e-mail is disabled, so the notifications are SKIPPED, not sent) | PASS; 3/3 and 3/3 settled on redelivery (median 120.1 s); 3/3 settled at once (median 0.1 s); 0; 10 processed ≤ 54 s after restore | `results/2026-10-17-failure-recovery-2/summary.md` (`\FailureVerdict`, `\FailureBeforeCommitSettleMedianS`, `\FailureDeadLetters`, `\FailureNotifierOutageMaxS`) |
| Access control: probes as expected (refusals and authorised 200 controls) | PASS; 165/165 in 7 groups | `results/2026-10-17-access-control-2/summary.md` (`\AccessProbesPassed`, `\AccessProbes`) |
| Expiry-driven backfill: n, p50, p95, max | PASS; 300; 0.05 s; 0.10 s; 0.33 s; 300/300 relayed, 0 outliers (target p95 ≤ 120 s) | `results/2026-10-17-backfill-2/summary.md` (`\BackfillVerdict`, `\BackfillExpiredN`, `\BackfillExpiredPFiftyS`, `\BackfillExpiredPNinetyFiveS`, `\BackfillExpiredMaxS`, `\BackfillOutliers`) |
| Timer-path relays in the smoke and failure-recovery runs | 4, at most 144 ms | `report/generated/numbers.tex` (`\TimerPathRelaysN`, `\TimerPathRelayMaxMs`) |
| Cancellation-driven backfill | 0 ms (relayed in the same transaction); 60 in the backfill run, max 0 ms | `results/2026-10-17-smoke-2/summary.md` (`\SmokeCancelBackfillMs`), `results/2026-10-17-backfill-2/summary.md` (`\BackfillCancelN`, `\BackfillCancelMaxMs`) |
| `SweepLateExpiries` | 0 (expected 0); the sweep ran 15 times during the series and never had to tick a workshop | `results/2026-10-17-backfill-2/summary.md` (`\BackfillSweepLateExpiries`), `results/2026-10-17-table3-dev-q1000-provenance.md` |
| k6 on dev (quota 1,000, commit `d121145`): levels meeting every target | 6 of 6 (up to 50 virtual users in both scenarios); 0.00 % HTTP errors in all 18 runs | `results/loadtest/2026-10-17/summary.md` (`\PerfDevLevelsMet`, `\PerfDevMaxVUsMet`) |
| k6 cross-workshop, 50 VUs: read p95, 202 p95, settle p95 server / client, errors, oldest message | 289 ms; 302 ms; 193 / 786 ms; 0.00 %; 0 s | same (`\PerfDevCrossVUFifty…`) |
| k6 hot spot, 50 VUs: settle p95 server / client, errors, deepest FIFO queue | 2,601 / 3,169 ms; 0.00 %; 35 messages | same (`\PerfDevHotspotVUFifty…`) |
| k6 first attempt at quota 10 (superseded) | targets met only at 10 VUs; 5,580 HTTP 503 = API Lambda throttles | same, "Superseded runs"; `results/2026-10-17-throttling-evidence/summary.md` (`\ThrottleKsixApiThrottles`) |
| k6 on the on-prem stack | every target met up to 50 VUs; peak 217 % CPU, 1,294 MiB | `results/loadtest/2026-10-17/summary.md` (`\PerfLocalLevelsMet`, `\PerfLocalCpuPeakPct`, `\PerfLocalMemPeakMiB`) |
| Distinct participants served per workshop (replay, 1,000 seeds) | UNIFIED 58.08 [56.71, 59.43] vs PER_SESSION 54.03 [52.84, 55.22]; paired Δ −4.04 [−4.25, −3.84] | `results/replay/summary.md` |
| Duplicate-hold events per workshop (replay) | 0.00 vs 34.57 [33.50, 35.61] | `results/replay/summary.md` |
| Seat refill time, mean of per-run p95 (replay, n = 847) | 9.45 min [8.89, 10.02] vs 63.31 min [46.22, 82.55] | `results/replay/summary.md` |
| Cloud cost at 1k / 10k / 100k registrations per month, list price | US$13.30 / 65.84 / 591.24 | `results/cost/model-summary.md` §1 |
| Cloud cost after free tier / after credits, 1k per month | US$0.52 / US$0.00 | same file |
| On-prem, increment only / fully amortised (3-year), 1k per month | US$29.32 / US$324.16 | same file |
| Crossover: list price vs on-prem increment / vs fully amortised | 3,898 / 57,278 registrations per month | same file §3 |
| Largest cloud item at 100k per month | Cognito, US$500 of US$591.24 at list price | same file §4 |
| Prices verified from the AWS Price List API | 30 of 31 | same file §8 |
| Measured usage of the experiment day, priced (CloudWatch, 2026-10-17 00:00–20:20 UTC, dev and pilot): list / after free tier | US$3.25 (of which 1.40 is the month's Cognito MAU charge) / US$1.19; no measured cost per registration (CloudWatch has no registration count) | `results/cost/usage-priced.md`, `results/cost/usage-2026-10-17-cloudwatch.md` (`\CostMeasuredListUsd`, `\CostMeasuredCognitoListUsd`, `\CostMeasuredAfterFreeUsd`) |

The cost workload per registration (commands per registration, Lambda durations, request units) is
still modelled (`docs/COST.md` §8): the measured day has no registration count. Say "modelled", not
"measured", for the tier numbers; only the experiment day's US$3.25 / 1.19 is measured.

## Likely questions

**Q1. Settling slowed down on the hot spot. Does SeatRelay scale?**
Across workshops, yes, as far as we measured: at 50 virtual users the server-side settle p95 was
193 ms, and every target was met at every level with no HTTP errors. By design, workshops run in
parallel: each workshop is its own message group, up to the worker's `MaximumConcurrency` (5, a cost
guard we can raise in `services/aws/templates/app.yaml`). Within one workshop, writes are serialised
on purpose: one writer per workshop gives the ordering and the single-lock argument
(`docs/ARCHITECTURE.md` §11). So on the hot spot at 50 VUs the server-side p95 rose to 2,601 ms, with
up to 35 commands waiting in its FIFO queue; the client-observed 3,169 ms still met the 5 s target.
The first matrix, at the account's Lambda quota of 10, fell behind from 25 VUs on everywhere;
CloudWatch showed throttling, not serialisation (`results/2026-10-17-throttling-evidence/`). On the
median of three rounds the local stack met the targets up to 50 VUs with the same engine, although
two single rounds at 50 VUs exceeded 5 s (cross-workshop round 1, hot-spot round 3); it also has no
network hop between client and server, so it is not a like-for-like comparison. The documented next
step is batching up to 10 messages per group with one shared snapshot.

**Q2. Is the cost measured or modelled?**
The unit prices are real: 30 of 31 come from the AWS Price List API for Singapore, retrieved on
2026-10-16. The workload per registration is modelled (`docs/COST.md` §3). The experiment day is
measured: its usage, read from CloudWatch (2026-10-17, 00:00–20:20 UTC, dev and pilot), costs US$3.25
at list price, of which US$1.40 is the month's Cognito charge for our test accounts, and US$1.19
after the free tier (`results/cost/usage-priced.md`). CloudWatch does not count registrations, so
that day gives no measured cost per registration. Cost Explorer's net cost shows 0 because credits
are subtracted per line item. That is why we compute the billing layer from usage, and why our
budgets set `IncludeCredit: false` (`services/aws/templates/auth.yaml`).

**Q3. How do you know the sweep is not doing the work and hiding slow timers?**
The worker counts `SweepLateExpiries`: offers that a sweep tick expired more than 60 s after their
`expiresAt` (`SWEEP_LATE_GRACE_MS` in `packages/service/src/worker/processCommand.ts`). In the backfill
re-run it was 0, as required, and the sweep, which ran 15 times during the series, never found an
overdue workshop: every expiry had already been relayed by its own timer
(`results/2026-10-17-table3-dev-q1000-provenance.md`). A sweep-driven expiry would also show up as a
latency of minutes, because the sweep runs only every 5 minutes; the maximum over 300 expiries was
0.33 s (`results/2026-10-17-backfill-2/summary.md`).
