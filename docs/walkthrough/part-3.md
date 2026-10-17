# Part 3: architecture, request path, timers, transactions

- **Speaker:** (team member)
- **Clock:** 4:00–6:00 (2:00)
- **Slides:** 5 Architecture (Figure A), 6 Request path and transaction (Figure B), 7 Timers and
  sweep (Figure C). Sources: `docs/ARCHITECTURE.md` §1.2, §3.2, §5.3.
- **Hands over to:** Part 4 (live demo)

## What to say (about 340 words)

**Slide 5, Figure A.** SeatRelay is three CloudFormation stacks in the Singapore region:
- a web stack: a private S3 bucket behind CloudFront;
- an auth stack: a Cognito user pool;
- an app stack with everything else: an HTTP API with a JWT authorizer, five Lambda functions, a
  FIFO command queue, a delay queue, one DynamoDB table, and SES for e-mail.

*(optional)* Everything is pay-per-request, so a workshop nobody is using costs almost nothing.

**Slide 6, Figure B.** The TA asked how the browser learns that a 202 has settled.
1. The browser makes up a command id and posts the command.
2. The API writes a command record, puts the command on the FIFO queue with the workshop as the
   message group, and answers 202 Accepted.
3. The browser polls that record, first after 300 milliseconds, then backing off to every two
   seconds.
4. The record turns APPLIED or REJECTED. The answer carries the participant's new status, so the
   page updates from the poll alone.

We chose polling over WebSockets. At our scale a socket adds a connection table and another failure
point, and gains nothing we could measure.

The message group gives each workshop exactly one writer at a time. The worker runs our decision
function on the workshop's live state, then commits seats, offers, notifications and the command's
result in one DynamoDB transaction. It succeeds only if the workshop's version is unchanged and the
command is still unsettled, which makes a retried or redelivered command harmless.

**Slide 7, Figure C.** The TA also noted that a periodic sweep would limit how fast a freed seat
moves on. So every offer now gets its own timer:
- Before committing, the worker puts a tick on an SQS delay queue, due when the offer expires.
- A small forwarder moves the tick into the workshop's FIFO group.
- The worker always expires whatever is due by the server clock first, then offers the seat to the
  next person.

A late or duplicate tick finds nothing to do. The five-minute sweep is only a safety net, and we
count every expiry it performs. *(optional)* The same engine also runs on-premise, on
PostgreSQL and Keycloak, for the cost comparison.

Now let's see it live. Over to [Speaker 4].

## Key numbers

| Number | Value | Source |
|---|---|---|
| Browser polling | after 300, 500, 1000, then every 2000 ms; every 5 s after 30 s | `apps/web/src/commands/backoff.ts` (configuration) |
| Status page refresh while QUEUED or OFFERED | 10 s, paused in hidden tabs | `apps/web/src/api/queries.ts` (`LIVE_REFRESH_MS`) |
| Worker | `BatchSize` 1, `MaximumConcurrency` 5, 1024 MB, 20 s timeout; queue visibility timeout 120 s (≥ 6 × 20 s); DLQ after 3 receives | `services/aws/templates/app.yaml` |
| Timer | `DelaySeconds = clamp(expiresAt − now, 0, 900)` | `services/aws/src/adapters/sqs.ts` (`delaySecondsFor`) |
| Transaction size | ≤ 100 items (DynamoDB limit); the engine budgets 90 | `packages/core/src/state.ts`, `services/aws/src/adapters/dynamo/store.ts` |
| Sweep | every 5 min, sparse DUE index | `app.yaml` (`ScheduleV2`), `packages/service/src/worker/sweep.ts` |
| Smoke test on dev, 2026-10-17 | PASS, 13/13 checks | `results/2026-10-17-smoke/summary.md` |
| Settle latency in that smoke run (n = 6, one run, not a statistic) | server-side p50 45 ms, max 904 ms; client-observed p50 848 ms, max 1,815 ms | `results/2026-10-17-smoke/summary.md` (`\SmokeSettleServerPFiftyMs`, `\SmokeSettleClientPFiftyMs`) |
| Settle and read latency under load | [PENDING: k6 matrix] | `results/loadtest/<date>/summary.md` (Part 5 quotes these) |

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
