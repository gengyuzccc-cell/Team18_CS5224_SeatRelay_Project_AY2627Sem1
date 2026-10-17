# Part 5: evaluation results and cost

- **Speaker:** LIANG ZIHAN. You are also the demo operator, and you narrate D5b and D4 in
  [part-4.md](part-4.md) before this part.
- **Clock:** 11:00–13:00 (2:00)
- **Slides:** 9 System results (Prelim. Table 3 = Final Table 5 verdicts, one tile per aspect), 10 Latency, backfill and
  mechanism comparison (k6 p95 by virtual users, replay charts, backfill line), 11 Cloud vs on-prem
  cost (table and crossover chart), in `report/Slides.tex`
- **Hands over to:** Part 6 (user study, pilot, limitations)

## What to say (about 280 spoken words, 1:50 at 150 words a minute)

**Slide 9, system results.** We ran every experiment of the Preliminary report's Table 3, our Table 5,
on the dev stage, three runs each, through the public API like the browser; failed runs are kept. Six
of the eight scripted experiments pass: correctness, with 672 of 672 checks and no session over capacity; preference order, on its dev
part, because the engine's property-test record is still pending; and repeat execution, expiry race,
failure recovery and access control.

Two fail, and we report them as failures. In the concurrency test, 76 of 209 requests got HTTP 503
responses, although no invariant was violated, and the backfill run aborted at its first request with
the same error. We have not found the cause yet; the re-runs wait for a Lambda quota increase.

**Slide 10, latency.** Under load, reads stayed near 300 milliseconds at every level, but settling met
the 5-second target only at 10 virtual users; at 50, its 95th percentile was 29 to 30 seconds, across
workshops as well as in the hot spot. So far, four timer relays on dev took at most 982 milliseconds.
In our simulation of 1,000 workshops, one queue never let anyone hold two seats, against 34.6
duplicate holds per workshop with per-session forms. That part is a simulation, not live traffic.

**Slide 11, cost.** At 1,000 registrations a month the modelled cloud costs US$13.30 at list price, 52
cents after the free tier, and nothing after credits. One on-prem mini-PC costs about US$29 a month, or
US$324 with a business line and labour. The cloud costs more than the bare machine above about 3,900
registrations a month, and more than the fully costed one above about 57,300. The machine has no
failover.

Next, ZHANG TIANYI.

## Key numbers

Table 3 rows come from the dev runs quoted in the Final report (Table 5; run ids and commits in
`report/generated/numbers.tex`). On the slide each row is one tile: verdict, aspect, key value.

| Number | Value | Source |
|---|---|---|
| Experiments passing | 6 of 8 (failed: concurrency, backfill) | `report/generated/numbers.tex` (`\SeriesPassed`, `\SeriesExperiments`, `\SeriesFailedNames`) |
| Correctness: verdict, scenarios × runs, checks, over-capacity, double holds, verify calls | PASS; 9 × 3; 672/672; 0; 0; 234 calls, 0 failed | `results/2026-10-17-correctness/summary.md` (`\CorrectnessVerdict`, `\CorrectnessChecksPassed`, `\CorrectnessOverCapacity`, `\CorrectnessDoubleHolds`, `\CorrectnessVerifications`) |
| Preference order: cases as predicted, unacceptable offers | PASS (dev part); 60/60 (20 × 3); 0. The engine property-test record is still [PENDING] | `results/2026-10-17-preference-order/summary.md` (`\PrefOrderCasesPassed`, `\PrefOrderNonAcceptable`) |
| Concurrency: verdict, HTTP 503s, checks, server settle p95 | FAIL; 76 of 209 requests; 22/39 checks; 6,349 ms; `verify` found no violation after any phase; version-conflict reading inconclusive | `results/2026-10-17-concurrency/summary.md` (`\ConcurrencyVerdict`, `\ConcurrencyTransportErrors`, `\ConcurrencyCommands`, `\ConcurrencySettleServerPNinetyFiveMs`) |
| Repeat execution: duplicate-submission probes (5 concurrent copies each), AFTER_COMMIT probes | PASS; 12/12; 6/6 (18/18 in all) | `results/2026-10-17-repeat-execution/summary.md` (`\RepeatDupProbesPassed`, `\RepeatAfterCommitPassed`, `\RepeatProbes`) |
| Expiry race: early applied, late rejected, stale ticks without effect | PASS; 3/3; 3/3; 3/3 | `results/2026-10-17-expiry-race-4/summary.md` (`\ExpiryRaceEarlyApplied`, `\ExpiryRaceLateRejected`, `\ExpiryRaceLateTicksNoEffect`) |
| Failure recovery: before commit, timer step, after commit, dead letters, notifier backlog (on dev e-mail is disabled, so the notifications are SKIPPED, not sent) | PASS; 3/3 and 3/3 settled on redelivery (median 120.1 s); 3/3 settled at once (median 0.1 s); 0; 10 processed ≤ 52 s after restore | `results/2026-10-17-failure-recovery/summary.md` (`\FailureVerdict`, `\FailureBeforeCommitSettleMedianS`, `\FailureDeadLetters`, `\FailureNotifierOutageMaxS`) |
| Access control: negative probes as expected | PASS; 165/165 in 7 groups | `results/2026-10-17-access-control/summary.md` (`\AccessProbesPassed`, `\AccessProbes`) |
| Expiry-driven backfill: n, p50, p95, max | FAIL: run aborted (HTTP 503 creating its workshop); [PENDING: re-run] (target p95 ≤ 120 s) | `results/2026-10-17-backfill/` (`\BackfillVerdict`, `\BackfillExpiredPNinetyFiveS`) |
| Timer-path relays so far (smoke and failure-recovery runs) | 4, at most 982 ms | `report/generated/numbers.tex` (`\TimerPathRelaysN`, `\TimerPathRelayMaxMs`) |
| Cancellation-driven backfill | 0 ms (relayed in the same transaction) | `results/2026-10-17-smoke/summary.md` (`\SmokeCancelBackfillMs`) |
| `SweepLateExpiries` | [PENDING] (expected 0; not fetched) | `results/<date>-backfill/` (`\BackfillSweepLateExpiries`) |
| k6 on dev: levels meeting every target | 2 of 6 (10 virtual users in both scenarios) | `results/loadtest/2026-10-17/summary.md` (`\PerfDevLevelsMet`, `\PerfDevMaxVUsMet`) |
| k6 cross-workshop, 50 VUs: read p95, 202 p95, settle p95 server / client, errors, oldest message | 284 ms; 300 ms; 28,460 / 29,127 ms; 9.81 %; 17 s | same (`\PerfDevCrossVUFifty…`) |
| k6 hot spot, 50 VUs: settle p95 server / client, errors | 29,335 / 29,943 ms; 8.01 % | same (`\PerfDevHotspotVUFifty…`) |
| k6 on the on-prem stack | every target met up to 50 VUs; peak 217 % CPU, 1,294 MiB | same (`\PerfLocalLevelsMet`, `\PerfLocalCpuPeakPct`, `\PerfLocalMemPeakMiB`) |
| Distinct participants served per workshop (replay, 1,000 seeds) | UNIFIED 58.08 [56.71, 59.43] vs PER_SESSION 54.03 [52.84, 55.22]; paired Δ −4.04 [−4.25, −3.84] | `results/replay/summary.md` |
| Duplicate-hold events per workshop (replay) | 0.00 vs 34.57 [33.50, 35.61] | `results/replay/summary.md` |
| Seat refill time, mean of per-run p95 (replay, n = 847) | 9.45 min [8.89, 10.02] vs 63.31 min [46.22, 82.55] | `results/replay/summary.md` |
| Cloud cost at 1k / 10k / 100k registrations per month, list price | US$13.30 / 65.84 / 591.24 | `results/cost/model-summary.md` §1 |
| Cloud cost after free tier / after credits, 1k per month | US$0.52 / US$0.00 | same file |
| On-prem, increment only / fully amortised (3-year), 1k per month | US$29.32 / US$324.16 | same file |
| Crossover: list price vs on-prem increment / vs fully amortised | 3,898 / 57,278 registrations per month | same file §3 |
| Largest cloud item at 100k per month | Cognito, US$500 of US$591.24 at list price | same file §4 |
| Prices verified from the AWS Price List API | 30 of 31 | same file §8 |
| Measured usage priced (from Cost Explorer snapshots) | [PENDING] | `results/cost/usage-priced.md` |

The cost workload (commands per registration, Lambda durations, request units) is modelled until the
usage snapshots exist (`docs/COST.md` §8). Say "modelled", not "measured", for the tier numbers.

## Likely questions

**Q1. Settling fell behind at 25 and 50 users. Does SeatRelay scale?**
Not yet as measured, and we say so. By design, workshops run in parallel: each workshop is its own
message group, up to the worker's `MaximumConcurrency` (5, a cost guard we can raise in
`services/aws/templates/app.yaml`). Within one workshop, writes are serialised on purpose: one
writer per workshop gives the ordering and the single-lock argument (`docs/ARCHITECTURE.md` §11).
But at 50 virtual users the cross-workshop settle p95 (28,460 ms server side) was almost as high as
the hot spot's (29,335 ms), with commands up to 17 s old in the queue, so per-workshop serialisation
alone does not explain it (Final report §4.2). One factor we know of is the account's Lambda
concurrency quota of 10, shared by both stages; the cause is not confirmed, and the re-run waits
for the quota increase. On the median of three rounds the local stack met the targets up to 50 VUs
with the same engine, although two single rounds at 50 VUs exceeded 5 s (cross-workshop round 1,
hot-spot round 3); it also has no network hop between client and server, so it is not a like-for-like
comparison. The
documented next step is batching up to 10 messages per group with one shared snapshot.

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
experiment it must be 0: [PENDING: the backfill run aborted]. A sweep-driven expiry would also
show up as a latency of minutes, because the sweep runs only every 5 minutes. The maximum latency
shows whether any such tail exists: [PENDING: max from results/<date>-backfill/summary.md]. So
far, the four timer-path relays we have took at most 982 ms, which no sweep could produce.
