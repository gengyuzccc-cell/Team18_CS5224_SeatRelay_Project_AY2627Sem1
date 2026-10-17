# Part 3: architecture, request path, timers, transactions

- **Speaker:** LIN JIE (AWS and monitoring)
- **Clock:** 4:00–6:00 (2:00)
- **Slides:** 5 Architecture (Final report Fig. 2), 6 Request path and transaction (Fig. 3a), 7 Timers
  and sweep (Fig. 3b), in `report/Slides.tex`. Sources: `docs/ARCHITECTURE.md` §1.2, §3.2, §5.3.
- **Hands over to:** Part 4 (live demo: ZHANG TIANYI narrates, LI ZONGZE operates)

## What to say (about 280 spoken words, 1:50 at 150 words a minute)

**Slide 5, Fig. 2.** SeatRelay is built from three CloudFormation templates in the Singapore region: an
auth stack with the Cognito user pool, deployed once, and a web stack and an app stack for each stage,
dev and pilot. The web stack is a private S3 bucket behind CloudFront; the app stack holds the HTTP
API, five Lambda functions, two queues, one DynamoDB table and SES, all pay-per-request.

**Slide 6, Fig. 3a.** The TA asked how the browser learns that a 202 has settled. The browser posts a command
with its own id. The API records it, puts it on the FIFO queue with the workshop as
the message group, and answers 202. The browser polls that record, first after 300 milliseconds, then
backing off to every two seconds, until it turns APPLIED or REJECTED, with the new status. At our
scale, WebSockets would only add a connection table and a failure point.

The message group gives each workshop one writer. The worker commits seats, offers, notifications and
the command's result in one transaction, which succeeds only if the workshop's version is unchanged and
the command is still ACCEPTED, so a redelivered command is harmless.

**Slide 7, Fig. 3b.** The TA also noted that a sweep would slow the relay. So every offer now
gets its own timer on an SQS delay queue, sent before the commit. A small
forwarder moves the due tick into the workshop's FIFO group, and the worker first expires whatever is
due by the server clock, then offers the seat to the next person. A late or duplicate tick finds
nothing to do. The five-minute sweep is only a safety net, and we count every expiry it performs.

Now let's see it live. Over to ZHANG TIANYI.

## Key numbers

| Number | Value | Source |
|---|---|---|
| Browser polling | after 300, 500, 1000, then every 2000 ms; every 5 s after 30 s | `apps/web/src/commands/backoff.ts` (configuration) |
| Status page refresh while QUEUED or OFFERED | 10 s, paused in hidden tabs | `apps/web/src/api/queries.ts` (`LIVE_REFRESH_MS`) |
| Worker | `BatchSize` 1, `MaximumConcurrency` 5, 1024 MB, 20 s timeout; queue visibility timeout 120 s (≥ 6 × 20 s); DLQ after 3 receives | `services/aws/templates/app.yaml` |
| Timer | `DelaySeconds = clamp(expiresAt − now, 0, 900)` | `services/aws/src/adapters/sqs.ts` (`delaySecondsFor`) |
| Transaction size | ≤ 100 items (DynamoDB limit); the engine budgets 90 | `packages/core/src/state.ts`, `services/aws/src/adapters/dynamo/store.ts` |
| Sweep | every 5 min, sparse DUE index | `app.yaml` (`ScheduleV2`), `packages/service/src/worker/sweep.ts` |
| Smoke test on dev, 2026-10-17 | PASS, 13/13 checks | `results/2026-10-17-smoke-2/summary.md` |
| Settle latency in that smoke run (n = 6, one run, not a statistic) | server-side p50 57 ms, max 767 ms; client-observed p50 858 ms, max 1,765 ms | `results/2026-10-17-smoke-2/summary.md` (`\SmokeSettleServerPFiftyMs`, `\SmokeSettleServerMaxMs`, `\SmokeSettleClientPFiftyMs`, `\SmokeSettleClientMaxMs`) |
| Read and settle latency under load (k6, dev) | reads and 202 responses p95 at most 315 ms at every level; every target met in 6 of 6 levels, up to 50 virtual users in both scenarios (Part 5 quotes these) | `results/loadtest/2026-10-17/summary.md` (`\PerfDevCrossVUTenAcceptPNinetyFiveMs`, `\PerfDevLevelsMet`, `\PerfDevMaxVUsMet`) |

## Likely questions

**Q1. Why an SQS delay queue plus a forwarder, and not EventBridge Scheduler?**
The expiry has to travel through the same ordered per-workshop path as user commands, so that
accepting and expiring the same offer are serialised. SQS FIFO queues do not support per-message
timers, and the timer maximum is 15 minutes (`aws-sqs-timers` in `report/references.bib`). So the
tick waits on a standard queue and the forwarder moves it into the FIFO group, with deduplication id
`tick#offerId#expiresAt` (`services/aws/src/handlers/expiryForwarder.ts`). One-time EventBridge
schedules have no 15-minute limit, but they would add a service, a role for the scheduler to assume,
and a create and delete call per offer, and they would still have to target the FIFO queue. Our
default hold fits in one SQS hop, and longer holds are re-delayed in hops of at most 15 minutes.

**Q2. What if the worker crashes right after committing?**
The seat changes and the settled command record were committed together, so nothing is lost. The
message was not deleted, so SQS hands it to a worker again after the 120 s visibility timeout. The
worker sees the record already APPLIED, runs one internal clean-up tick and acknowledges
(`processCommand()` in `packages/service/src/worker/processCommand.ts`). Only that workshop's queue
waits meanwhile. The demo shows this live, and the failure-recovery experiment injects crashes
before the commit, after it, and while sending the timer.

**Q3. Why one DynamoDB table and not a relational database?**
The access pattern is one partition per workshop. The worker reads the workshop's live items with
one consistent Query and writes up to 100 items atomically. Live and history items have different
key prefixes, so that read stays small as history grows (`services/aws/src/adapters/dynamo/keys.ts`).
On-demand DynamoDB needs no instance, VPC or NAT, and is multi-AZ by default. The cost is the
100-item transaction limit, hence the engine's 90-item budget. The same engine runs on PostgreSQL in
our on-prem reference (`services/local`), so the design is not tied to DynamoDB.
