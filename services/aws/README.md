# @seatrelay/aws

Lambda handlers and the DynamoDB / SQS / SES adapters that implement the ports of
`@seatrelay/service` on AWS (plan §2.3 / §2.4). The SAM templates in `templates/` describe the
three stacks; `scripts/build.mjs` bundles one `dist/<fn>/index.mjs` per function with esbuild.

```
HTTP API (Cognito JWT) ─► api ─► commands.fifo (group = workshopId) ─► worker ─► DynamoDB (one table)
                                       ▲                                   │
                     expiryForwarder ───┘ (FIFO, dedup tick#offerId#expiresAt)  │ TransactWriteItems
                            ▲                                              ▼
                 expiry-delay (standard, DelaySeconds ≤ 900)   DynamoDB Streams ─► notifier ─► SES
                            ▲
   worker (SendMessageBatch before commit)      EventBridge rate(5 min) ─► sweep ─► commands.fifo
```

## Layout

| Path                                  | Role                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/handlers/api.ts`                 | `APIGatewayProxyEventV2` → `ApiRequest` → `createApiApp().handle` → `APIGatewayProxyResultV2`. Routes `GET /public/workshops/{wsId}` (no authorizer) to the public workshop route. |
| `src/handlers/worker.ts`              | SQS FIFO consumer: `processCommand` per record, `batchItemFailures` for infrastructure errors only (FIFO rule: the failed record and every following one).                           |
| `src/handlers/expiryForwarder.ts`     | Delay queue → FIFO. Ticks that are still early (holds > 15 min, or an early delivery) go back to the delay queue with the remaining delay (1–900 s), so no tick reaches the worker before its `expiresAt`. |
| `src/handlers/sweep.ts`               | EventBridge `rate(5 minutes)`: `listDueWorkshops(now)` on the sparse DUE index, one `TICK{source: 'SWEEP'}` per due workshop.                                                        |
| `src/handlers/notifier.ts`            | DynamoDB Streams (INSERT of `entityType = NOTIFICATION` only) → SES, paced by a token bucket; marks SENT / FAILED / SKIPPED on the item.                                              |
| `src/adapters/dynamo/keys.ts`         | Single-table key builders (table below).                                                                                                                                             |
| `src/adapters/dynamo/mapping.ts`      | Entity ⇄ item, 1:1; every item carries `entityType`; reads validate with the contracts schemas.                                                                                      |
| `src/adapters/dynamo/store.ts`        | `WorkshopStore`: consistent live-prefix snapshot, the single `TransactWriteItems` commit, command results, read models.                                                              |
| `src/adapters/dynamo/notifications.ts`| The notifier's status updates on notification items.                                                                                                                                 |
| `src/adapters/sqs.ts`                 | `CommandQueue` (FIFO, explicit dedup ids) and `TimerScheduler` (`SendMessageBatch`, 10 per call, clamped `DelaySeconds`).                                                            |
| `src/adapters/ses.ts`                 | `SendEmail` with permanent-vs-transient error classification.                                                                                                                        |
| `src/lib/`                            | env, Powertools logger/metrics (EMF), JWT claims → `AuthUser`, e-mail rendering, token bucket, lazy production wiring (`ports.ts`).                                                   |
| `templates/auth.yaml`                 | Cognito user pool + clients + hosted UI domain, SES sender identity, budgets. Deployed once as `seatrelay-auth`.                                                                      |
| `templates/app.yaml`                  | Per-stage application stack (`seatrelay-app-dev` / `-pilot`): table, queues, functions, HTTP API, alarms, dashboard.                                                                 |
| `templates/web.yaml`                  | Private S3 + CloudFront (OAC) for the SPA.                                                                                                                                           |

## Environment variables

All configuration comes from the environment (set by `templates/app.yaml`).

| Variable                         | Used by                 | Meaning                                                                                                    |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TABLE_NAME`                     | api, worker, sweep, notifier | The single DynamoDB table (`seatrelay-{stage}`).                                                      |
| `COMMANDS_QUEUE_URL`             | api, worker, forwarder, sweep | `commands.fifo` (message group = `workshopId`).                                                      |
| `EXPIRY_DELAY_QUEUE_URL`         | worker, forwarder       | Standard `expiry-delay` queue for per-offer timers (`DelaySeconds` ≤ 900).                                 |
| `ALLOW_FAULT_FLAGS`              | api, worker             | `true` keeps `_fault` in command bodies (api) and honours it (worker). `false` on pilot.                   |
| `EMAIL_ENABLED`                  | notifier                | `true` sends through SES; anything else records notifications as `SKIPPED` (in-app only).                  |
| `SENDER_EMAIL`                   | notifier                | Verified SES sender (defaults to the auth stack export).                                                   |
| `EMAIL_RATE_PER_SEC`             | notifier                | Token-bucket rate for SES calls (default `1`).                                                             |
| `STAGE`                          | all                     | `dev` / `pilot`; reported by `GET /health` and the EMF `stage` dimension.                                  |
| `POWERTOOLS_SERVICE_NAME`        | all                     | Logger `service` field and the EMF `service` dimension (`api`, `worker`, `expiryForwarder`, `sweep`, `notifier`). |
| `POWERTOOLS_METRICS_NAMESPACE`   | all                     | `SeatRelay`.                                                                                               |
| `POWERTOOLS_LOG_LEVEL`           | all                     | `INFO` by default.                                                                                         |
| `POWERTOOLS_LOGGER_LOG_EVENT`    | all                     | `false`: events are never logged verbatim (they carry JWT claims and e-mails).                             |
| `WEB_ORIGIN`                     | api                     | Informational; CORS is answered by API Gateway's `CorsConfiguration`, not by the handler.                  |
| `NODE_OPTIONS`                   | all                     | `--enable-source-maps` so stack traces point at TypeScript.                                                |

Metrics (namespace `SeatRelay`, dimensions `service` and `stage`, i.e. one dimension set
`[service, stage]`): `CommandSettledLatency`, `BackfillLatency`, `OffersCreated`, `OffersExpired`,
`SweepLateExpiries`, `MetaConflictRetries` (worker) and `NotificationFailures` (notifier), plus the
adapter-level `WorkerRecordFailures` (worker: records it could not settle, see below). The dev and
pilot stacks share one account and region; the `stage` dimension keeps their series apart, so every
reader must query `{service, stage}` (the dashboard does; a `{service}`-only query returns nothing).

## Build, validate, deploy

```sh
pnpm --filter @seatrelay/aws typecheck
pnpm --filter @seatrelay/aws test          # vitest + aws-sdk-client-mock (no AWS access needed)
pnpm --filter @seatrelay/aws build         # dist/{api,worker,expiryForwarder,sweep,notifier}/index.mjs
pnpm --filter @seatrelay/aws validate      # sam validate --lint for the three templates

cd services/aws
sam deploy --config-env auth --parameter-overrides SenderEmail=team@example.com BudgetEmail=team@example.com
sam deploy --config-env dev                # seatrelay-app-dev   (AllowFaultFlags=true,  EmailEnabled=false)
sam deploy --config-env web-dev            # seatrelay-web-dev
sam deploy --config-env pilot              # seatrelay-app-pilot (AllowFaultFlags=false, EmailEnabled=true)
sam deploy --config-env web-pilot
```

`sam deploy` uploads the esbuild output directly (`CodeUri: ../dist/<fn>`, no `BuildMethod`): the
bundles are ESM, target `node22`, `@aws-sdk/*` left external (provided by the `nodejs22.x`
runtime), with source maps. Each bundle is about 350 KiB. `samconfig.toml` holds the stack names,
region (`ap-southeast-1`) and parameter overrides per environment.

## DynamoDB key design (plan §2.3)

One table `seatrelay-{stage}` (PK/SK strings, on-demand, PITR, Streams `NEW_AND_OLD_IMAGES`, TTL
attribute `ttl`). Live (`L#`) and history (`H#`) prefixes are separated inside the `WS#` partition so
that the worker snapshot never grows with settled data. Every item carries `entityType`.

| Item                          | PK                | SK                                               | GSI1PK        | GSI1SK             | Notes                                                                 |
| ----------------------------- | ----------------- | ------------------------------------------------ | ------------- | ------------------ | --------------------------------------------------------------------- |
| Organization                  | `ORG#{orgId}`     | `META`                                           |               |                    | `members[]`                                                           |
| Org membership (one per member)| `ORG#{orgId}`    | `M#{userId}`                                     | `U#{userId}`  | `ORG#{orgId}`      | "my organisations"                                                    |
| Workshop                      | `WS#{wsId}`       | `L#META`                                         | `ORG#{orgId}` | `WS#{createdAt}`   | engine fields `status/seq/version/nextDueAt` + title/description      |
| DUE marker (sparse)           | `WS#{wsId}`       | `L#DUE`                                          | `DUE`         | `{nextDueAt}#{wsId}`| present iff `nextDueAt` is set; written in the same transaction      |
| Session                       | `WS#{wsId}`       | `L#S#{sessionId}`                                |               |                    | capacity / confirmed / held / cutoffAt                                |
| Registration (live)           | `WS#{wsId}`       | `L#R#{seq:08d}`                                  | `U#{userId}`  | `WS#{wsId}`        | QUEUED / OFFERED / CONFIRMED                                          |
| R1 unique marker              | `WS#{wsId}`       | `L#U#{userId}` (UNIFIED) / `L#U#{userId}#{sessionId}` (PER_SESSION) |   |         | `{seq, status}`; conditional upsert with the registration, deleted on archive |
| Offer (live)                  | `WS#{wsId}`       | `L#O#{offerId}`                                  |               |                    | OFFERED only                                                          |
| Backfill (pending, live)      | `WS#{wsId}`       | `L#BF#{releasedAt}#{id}`                         |               |                    | returned as `snapshot.pendingBackfills`                               |
| Registration / Offer (history)| `WS#{wsId}`       | `H#R#{seq:08d}` / `H#O#{offerId}`                | `U#{userId}` (reg.) | `WS#{wsId}`  | archive = Delete live + Put history in the same transaction           |
| Backfill (history)            | `WS#{wsId}`       | `H#BF#{releasedAt}#{id}`                         |               |                    | dashboard, `latencyMs`                                                |
| Attendance                    | `WS#{wsId}`       | `H#A#{userId}`                                   |               |                    | synchronous API write                                                 |
| CommandResult                 | `CMD#{commandId}` | `META`                                           |               |                    | `ttl` = acceptedAt + 30 d                                             |
| Notification                  | `U#{userId}`      | `N#{createdAt}#{id}`                             |               |                    | `entityType = NOTIFICATION` (stream filter), `ttl` = createdAt + 90 d |

The plan lists the DUE index on the workshop META item itself; with a single GSI that item already
carries the per-organisation listing key, so the DUE key lives on a separate `L#DUE` item that is
put/deleted in the same `TransactWriteItems` as the META update (one extra item per commit; the
engine leaves 10 of the 100 for such extras). `listDueWorkshops` queries the index and confirms each
candidate with a consistent read of its META.

### The commit (`DynamoWorkshopStore.commit`)

One `TransactWriteItems` per decision:

- `L#META`: `Update` of the engine-owned fields only (`status`, `seq`, `version`, `nextDueAt`,
  `updatedAt`) with `ConditionExpression: version = :expectedVersion` (the optimistic lock of the
  whole workshop); `L#DUE` put or deleted alongside. Title/description are never touched here
  (`updateWorkshopInfo` writes them, unconditioned on the version).
- `CMD#…`: `Update` with `attribute_not_exists(PK) OR status = ACCEPTED` (C3).
- `PUT_SESSION` / `PUT_REGISTRATION` / `PUT_PENDING_BACKFILL`: unconditional puts (upserts).
- R1 marker (plan §2.2, conditional write): `PUT_REGISTRATION` also puts `L#U#{scope}` with
  `attribute_not_exists(PK) OR seq = :seq` — created, or updated by the registration that holds it.
  When the same decision archives a registration of the same scope (an expired offer ended by
  tick-first, then the user's new REGISTER), the two touch one marker (a transaction may touch an
  item once): a single put with `seq IN (:new, :archived)`. A failed marker condition is a storage
  vs engine disagreement: `UniqueMarkerConflictError` is thrown (redelivery, then the DLQ alarm)
  instead of breaking R1.
- `PUT_OFFER`, `PUT_BACKFILL`, notifications and every history item: `attribute_not_exists(PK)`.
- `ARCHIVE_*`: `Delete` live + `Put` history (+ `Delete` of the R1 marker for registrations). In
  PER_SESSION the marker key needs the session the registration was bound to, but the engine
  archives a registration whose session was dropped (decline, expiry, cancelled session) with
  `acceptable: []`. The store therefore remembers each live registration's scope from
  `loadSnapshot` (the worker always loads before committing) and from registration puts, and on a
  miss reads it from the live `L#R#{seq}` item (consistent `GetItem`); a registration that was never
  stored live has no marker to delete.
- Conditions only on written items, never a `ConditionCheck` on untouched ones.
- `TransactionCanceledException` → `CancellationReasons[i].Code`: `ConditionalCheckFailed` on the
  CMD item → `{ ok: false, conflict: 'COMMAND_ALREADY_SETTLED' }` (checked first), on META →
  `{ ok: false, conflict: 'VERSION' }`, on an R1 marker → `UniqueMarkerConflictError`. A
  cancellation whose reasons are all transient (`TransactionConflict`, `ThrottlingError`,
  `ProvisionedThroughputExceeded`; nothing was written) is retried in-process, the identical
  transaction up to 3 times with jittered backoff (25/50/100 ms × 1–2), because the SDK does not
  retry it (plan §2.4: DynamoDB transient errors are retried in-process). Anything else is thrown
  (the message is redelivered).
- The engine keeps `estimateCommitItems(decision) ≤ 90`; the adapter asserts the real size ≤ 100
  and throws `TransactionTooLargeError` otherwise (never sends a partial commit).

`putCommandAccepted` is a `PutItem` with `attribute_not_exists(PK)` and
`ReturnValuesOnConditionCheckFailure: ALL_OLD`: a duplicate POST gets the existing record from the
exception payload without a second read. A put that races the worker's transaction on the same CMD
item is rejected with `TransactionConflictException`; it is retried with the same backoff and, if
the conflict persists, answered from a consistent read of the record (`deleteCommandIfAccepted`
and `updateWorkshopInfo` retry the same way). `deleteCommandIfAccepted` is a conditional delete on
`status = ACCEPTED` (enqueue-failure rollback → `503 QUEUE_UNAVAILABLE`).

## Messaging

- `commands.fifo`: `MessageGroupId = workshopId`; `MessageDeduplicationId` = `commandId` for user
  commands, `tick#{offerId}#{expiresAt}` for timer ticks, `sweep#{wsId}#{minute}` for sweep ticks,
  a fresh UUID for REALLOCATE continuations (they carry no natural key; duplicates are no-ops).
- `expiry-delay` (standard): the worker sends one `TICK{workshopId, source: 'TIMER', offerId,
  expiresAt}` per new offer **before** the commit with `DelaySeconds = clamp(ceil((expiresAt −
  now)/1000), 0, 900)`; a timer whose decision never commits is a harmless no-op tick. The
  forwarder re-delays every tick that arrives before its `expiresAt` (by at least 1 s), so holds
  longer than 15 minutes work and an early delivery never reaches the worker, where tick-first
  would expire nothing and leave the offer to the 5-minute sweep.
- Worker failure policy: deterministic rejections settle the command as REJECTED and never throw;
  malformed messages are logged (with whatever `type`/`commandId`/`workshopId` they carry) and
  dropped; only infrastructure errors (DynamoDB/SQS failures, exhausted version retries, injected
  faults) are reported in `batchItemFailures`, for the failed record and every following one. The
  invocation itself succeeds either way, so `AWS/Lambda Errors` stays 0: every dropped message and
  every infrastructure error (not an injected fault) is counted as `WorkerRecordFailures`.
- The API refuses `POST /workshops/{id}/commands` with `400 VALIDATION_ERROR` when the caller's
  `email` claim fails the contracts `EmailSchema` (Cognito accepts some addresses zod does not): the
  worker could only drop such a command, and its record would stay ACCEPTED forever.

## Fault injection (experiments, dev only)

A command body may carry `_fault: 'BEFORE_COMMIT' | 'AFTER_COMMIT' | 'TIMER_SEND'`. With the stack
parameter `AllowFaultFlags=true` (`ALLOW_FAULT_FLAGS` env) the API keeps the field and the worker
throws `FaultInjectedError` at that point **on the first delivery only** (SQS
`ApproximateReceiveCount = 1`): the record is reported failed, SQS redelivers it after the
visibility timeout, and the second delivery runs normally (`AFTER_COMMIT` then hits
`COMMAND_ALREADY_SETTLED` and is acknowledged, C3). On pilot (`AllowFaultFlags=false`) the API strips
the field, so nothing can be injected.

## Notifier

The stream event source filters `INSERT` records whose `NewImage.entityType = NOTIFICATION`, so the
notifier's own status updates (MODIFY) and TTL deletes (REMOVE) never re-trigger it. Per record:
`EMAIL_ENABLED != true` → mark `SKIPPED`; otherwise check the item is still `PENDING` (retried
batches), wait for a token (`EMAIL_RATE_PER_SEC`), `SendEmail` (text + minimal HTML, subject by
kind), mark `SENT`. A permanent SES error (`MessageRejected`, e.g. an unverified address in the
sandbox) marks `FAILED` with `lastError` and continues; a transient one (throttling, 5xx) stops the
batch at that record and reports it (`batchItemFailures`), so the stream retries from there
(`BisectBatchOnFunctionError`, 20 attempts, then `notify-dlq`). `NotificationFailures` counts both.
Once SES has accepted an e-mail the record is never reported for redelivery, which would send it a
second time: the `SENT` status write is retried in-process (3 attempts) and, if it still fails, the
item stays `PENDING` with an error log.

`EMAIL_RATE_PER_SEC` paces each notifier instance. The stream invokes one instance per shard, so with
several shards the aggregate rate can exceed the SES sandbox's 1 message/s; the excess gets SES
`Throttling`, which is transient and retried from the stream (no e-mail is lost, iterator age
grows). `ReservedConcurrentExecutions: 1` would make the pace global but is not set: it needs
unreserved account concurrency headroom, and the failure-recovery experiment toggles the notifier's
reserved concurrency (0, then delete).

## Alarms and IAM

Alarms (SNS topic `seatrelay-{stage}-alarms`): DLQ depth > 0 (commands, expiry-delay, notify),
commands oldest message > 120 s, `AWS/Lambda Errors >= 1` for api and worker (timeouts, crashes,
init failures), notifier iterator age > 60 s, and two that see the failures the handlers turn into
normal returns: `AWS/ApiGateway 5xx >= 1` (the api handler answers every unexpected error with a
500; `503 QUEUE_UNAVAILABLE` counts too) and `SeatRelay/WorkerRecordFailures{service=worker,
stage} >= 1`.

Least privilege per function (plan §2.4): api and worker `DynamoDBCrudPolicy` + their queue sends;
forwarder FIFO + delay queue sends; sweep `dynamodb:Query` on `table/index/GSI1` +
`dynamodb:BatchGetItem` on the table (the DUE query and its consistent META confirmation) + FIFO
send; notifier `dynamodb:GetItem`/`UpdateItem` on the table, `ses:SendEmail` on this account's SES
identities (`identity/*`: the sender, and the verified recipients the sandbox also authorises
against) and the notify DLQ send (stream reads come from SAM's DynamoDB event source policy).

## Tests

`pnpm --filter @seatrelay/aws test` runs vitest with `aws-sdk-client-mock` (no credentials, no
network): key builders, item round trips, the exact `TransactWriteItems` a commit sends and the
cancellation-reason mapping, `putCommandAccepted` / `deleteCommandIfAccepted`, snapshot pagination,
the DUE query, the SQS dedup/delay rules, the API event mapping (401 without claims, public route,
500 without stack traces, no CORS headers), the worker's batch-failure semantics (via the in-memory
service harness), the forwarder's re-delay logic, the sweep and the notifier's status handling.

`test/dynamodbLocal.test.ts` is an opt-in integration suite against DynamoDB Local (skipped unless
`DYNAMODB_LOCAL_ENDPOINT` is set). It drives the real `processCommand` and checks what mocks cannot:
that DynamoDB accepts and evaluates the condition expressions, that the live prefix holds no orphan
R1 marker after PER_SESSION declines, expiries and cancelled sessions, that a stale marker fails the
commit, and a differential run (random commands, clock jumps, timers, sweeps; both modes) in which
the snapshot, the R1 markers, command results, history, backfills, timers and per-user listings
must match the in-memory reference store after every step:

```sh
docker run --rm -d -p 8000:8000 amazon/dynamodb-local:2.5.4 -jar DynamoDBLocal.jar -inMemory
pnpm --filter @seatrelay/aws test:ddb-local            # DYNAMODB_LOCAL_ENDPOINT defaults to http://localhost:8000
FUZZ_SEEDS=8 FUZZ_STEPS=200 pnpm --filter @seatrelay/aws test:ddb-local   # a longer differential run
```
