# Part 5: evaluation results and cost

- **Speaker:** (team member). You are also the demo operator, and you narrate D5b and D4 in
  [part-4.md](part-4.md) before this part.
- **Clock:** 11:00–13:00 (2:00)
- **Slides:** 9 System results (Table 3: target, measured, runs, source), 10 Latency and mechanism
  comparison (backfill CDF, performance p95 by VU level, replay charts), 11 Cloud vs on-prem cost
  (tier table and crossover chart)
- **Hands over to:** Part 6 (user study, pilot, limitations)

## What to say (about 340 words)

**Slide 9, system results.** We measured every Table 3 target on the dev stage, three runs each,
with scripts that use the public API exactly like the browser. Every number here is copied from a
results file in our repository, and failed runs are kept, not deleted.

- Correctness: [PENDING: scenarios × runs and checks], with [PENDING: over-capacity and
  double-hold counts].
- Concurrency: 50 accounts racing for 5 seats, [PENDING: verdict and number of lock conflicts].
- Repeat execution: the same command five times at once, plus a crash after commit:
  [PENDING: probes passed, each applied once].
- Expiry race, failure recovery and access control: [PENDING: one line each from their
  summary.md].

**Slide 10, latency.** First, the TA's main concern: how fast an expired hold reaches the next
person. The 95th percentile was [PENDING] seconds, against a 120-second target. A cancellation hands
the seat on inside the same transaction, so it takes zero milliseconds. The sweep had to step in
[PENDING: expected 0] times.

Under load with 50 virtual users spread over ten workshops, read and 202 responses had a p95 of
[PENDING], and settling had a p95 of [PENDING]. In the hot-spot test all 50 users hit one workshop,
which is serialised by design. Its settle time was [PENDING], and we report it as measured.

We also replayed 1,000 simulated workshops through the same engine, once with one queue and once
with per-session forms:
- One queue served 58.1 distinct people per workshop on average, against 54.0.
- Nobody ever held two seats, against 34.6 duplicate-hold events per workshop.
- The 95th-percentile time to refill a released seat was 9.5 minutes, against 63.3.

This part is a simulation, not live traffic.

**Slide 11, cost.** We priced a modelled workload with Singapore list prices, in three layers. At
1,000 registrations a month the cloud costs US$13.30 at list price, US$0.52 after the free tier, and
zero after credits. That zero is why Cost Explorer shows nothing, and why our budgets exclude
credits.

One on-prem mini-PC costs about US$29 a month for hardware alone, or about US$300 with a business
line and labour. The list-price cloud costs more than the bare machine above about 3,900
registrations a month, and more than the fully costed machine above about 52,700. The machine also
has no failover.

Next, [Speaker 6] presents the user study.

## Key numbers

Table 3 rows come from the dev report runs. The run started on 2026-10-17
(`results/2026-10-17-table3-dev.status`) was still in progress when these notes were written.

| Number | Value | Source |
|---|---|---|
| Correctness: verdict, scenario runs, checks, over-capacity, double holds | [PENDING] | `results/<date>-correctness/summary.md` (`\CorrectnessVerdict`, `\CorrectnessScenarioRunsPassed`, `\CorrectnessChecksPassed`, `\CorrectnessOverCapacity`, `\CorrectnessDoubleHolds`) |
| Preference order: cases as predicted, non-acceptable offers | [PENDING] | `results/<date>-preference-order/summary.md` (`\PrefOrderCasesPassed`, `\PrefOrderNonAcceptable`) |
| Concurrency: verdict, META conflict retries, settle p95 | [PENDING] | `results/<date>-concurrency/summary.md` (`\ConcurrencyVerdict`, `\ConcurrencyMetaRetries`, `\ConcurrencySettleServerPNinetyFiveMs`) |
| Repeat execution: duplicate-submission probes (5 concurrent copies each), AFTER_COMMIT probes (one POST, then redelivery) | [PENDING] | `results/<date>-repeat-execution/summary.md` (`\RepeatDupProbesPassed`/`\RepeatDupProbes`, `\RepeatAfterCommitPassed`/`\RepeatAfterCommitCases`) |
| Expiry race: early applied, late rejected, stale ticks without effect | [PENDING] | `results/<date>-expiry-race/summary.md` (`\ExpiryRaceEarlyApplied`, `\ExpiryRaceLateRejected`, `\ExpiryRaceLateTicksNoEffect`) |
| Failure recovery: fault cases, notifier backlog processed after restore (on dev e-mail is disabled, so the notifications are SKIPPED, not sent) | [PENDING] | `results/<date>-failure-recovery/summary.md` (`\FailureVerdict`, `\FailureNotifierOutageMaxS`) |
| Access control: negative probes as expected | [PENDING] | `results/<date>-access-control/summary.md` (`\AccessProbesPassed`, `\AccessProbes`) |
| Expiry-driven backfill: n, p50, p95, max | [PENDING] (target p95 ≤ 120 s) | `results/<date>-backfill/summary.md` (`\BackfillExpiredN`, `\BackfillExpiredPNinetyFiveS`, `\BackfillExpiredMaxS`) |
| Cancellation-driven backfill | [PENDING] (0 ms by construction) | same file (`\BackfillCancelMaxMs`) |
| `SweepLateExpiries` | [PENDING] (expected 0) | same file (`\BackfillSweepLateExpiries`) |
| k6 cross-workshop, 50 VUs: read p95, 202 p95, settle p95 (client), server settle p95, errors | [PENDING] (targets < 1 s, < 1 s, < 5 s, < 1 %) | `results/loadtest/<date>/summary.md` (`\PerfDevCrossVUFifty…`) |
| k6 hot spot, 50 VUs: same metrics | [PENDING] | same file (`\PerfDevHotspotVUFifty…`) |
| Distinct participants served per workshop (replay, 1,000 seeds) | UNIFIED 58.08 [56.71, 59.43] vs PER_SESSION 54.03 [52.84, 55.22]; paired Δ −4.04 [−4.25, −3.84] | `results/replay/summary.md` |
| Duplicate-hold events per workshop (replay) | 0.00 vs 34.57 [33.50, 35.61] | `results/replay/summary.md` |
| Seat refill time, mean of per-run p95 (replay, n = 847) | 9.45 min [8.89, 10.02] vs 63.31 min [46.22, 82.55] | `results/replay/summary.md` |
| Cloud cost at 1k / 10k / 100k registrations per month, list price | US$13.30 / 65.84 / 591.24 | `results/cost/model-summary.md` §1 |
| Cloud cost after free tier / after credits, 1k per month | US$0.52 / US$0.00 | same file |
| On-prem, increment only / fully amortised (3-year), 1k per month | US$29.09 / US$299.31 | same file |
| Crossover: list price vs on-prem increment / vs fully amortised | 3,861 / 52,654 registrations per month | same file §3 |
| Largest cloud item at 100k per month | Cognito, US$500 of US$591.04 at list price | same file §4 |
| Prices verified from the AWS Price List API | 30 of 31 | same file §8 |
| Measured usage priced (from Cost Explorer snapshots) | [PENDING] | `results/cost/usage-priced.md` |

The cost workload (commands per registration, Lambda durations, request units) is modelled until the
usage snapshots exist (`docs/COST.md` §8). Say "modelled", not "measured", for the tier numbers.

## Likely questions

**Q1. The hot-spot latency is higher. Does SeatRelay scale?**
Across workshops, yes: each workshop is its own message group, and groups run in parallel up to the
worker's `MaximumConcurrency` (5, a cost guard we can raise in `services/aws/templates/app.yaml`).
Within one workshop, no, by design. One writer per workshop is what gives ordering and the
single-lock argument, so throughput is one decision plus one transaction at a time
(`docs/ARCHITECTURE.md` §11). We report the hot-spot number as measured: [PENDING]. The documented
next step is batching up to 10 messages per group with one shared snapshot.

**Q2. Is the cost measured or modelled?**
The unit prices are real: 30 of 31 come from the AWS Price List API for Singapore, retrieved on
2026-10-16. The workload per registration is modelled (`docs/COST.md` §3), and it is replaced by
measured usage quantities from our Cost Explorer snapshots: [PENDING:
results/cost/usage-priced.md]. Cost Explorer's net cost shows 0 because credits are subtracted per
line item. That is why we compute the billing layer from usage, and why our budgets set
`IncludeCredit: false` (`services/aws/templates/auth.yaml`).

**Q3. How do you know the sweep is not doing the work and hiding slow timers?**
The worker counts `SweepLateExpiries`: offers that a sweep tick expired more than 60 s after their
`expiresAt` (`SWEEP_LATE_GRACE_MS` in `packages/service/src/worker/processCommand.ts`). In the backfill
experiment it must be 0: [PENDING]. A sweep-driven expiry would also show up as a latency of
minutes, because the sweep runs only every 5 minutes. The maximum latency shows whether any such
tail exists: [PENDING: max from results/<date>-backfill/summary.md].
