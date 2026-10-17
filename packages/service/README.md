# @seatrelay/service

The framework-agnostic application layer (CONVENTIONS §5): storage/queue/timer **ports**, the
HTTP **route table** (`createApiApp`), the worker **orchestration** (`processCommand`), the
read models and in-memory adapters for tests. Depends on `contracts` and `core` only; it is
consumed by `services/aws` (Lambda + DynamoDB/SQS) and `services/local` (Fastify + Postgres).

| module                     | contents                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ports.ts`                 | `WorkshopStore`, `CommandQueue`, `TimerScheduler`, `Clock`, `IdGen`, `Logger`, `MetricsSink`, `UserDirectory`, `CommitArgs` |
| `api/http.ts`              | `ApiRequest` / `ApiResponse`, route table types, `matchRoute`, JSON/CSV helpers, error mapping                          |
| `api/app.ts`               | `API_ROUTES` (table-driven, Fastify-style `:param` patterns) and `createApiApp(config).handle(req)`                     |
| `api/routes/*.ts`          | one file per route group (health, me, orgs, workshops, commands, organiser)                                              |
| `worker/processCommand.ts` | load → decide → schedule timers → commit (retry / ack) → continuation → metrics; fault injection                          |
| `worker/sweep.ts`          | `runSweep`: TICK every workshop whose `nextDueAt` passed                                                                 |
| `commands.ts`              | `acceptedCommandResult`, `materializeNotification`, `commandDedupId`, `tickForTimer`, `sweepTick`                        |
| `views.ts`                 | `workshopPublicView`, `dashboardView`, `myRegistrationViews`, `commandResultView`, `notificationView`                    |
| `csv.ts`                   | `registrationsCsv` (organiser export; UTF-8 BOM, confirmed session only while CONFIRMED)                                  |
| `memory/*`                 | `InMemoryWorkshopStore`, `InMemoryCommandQueue`, `InMemoryTimerScheduler`, `ManualClock`, `createInMemoryPorts` harness |

## Ports (what the adapters implement)

- `WorkshopStore.loadSnapshot(wsId)` — consistent read of the live items only (workshop,
  sessions, live registrations, live offers, pending backfill records).
- `WorkshopStore.getArchivedOffer(wsId, offerId)` — one point read of a settled offer; the
  worker attaches it as `snapshot.settledOffers` for an ACCEPT/DECLINE of a non-live offer.
- `WorkshopStore.commit({ wsId, expectedVersion, writes, notifications, commandResult? })` —
  one transaction. `PUT_WORKSHOP_STATE` updates engine-owned fields only and is conditioned on
  `version === expectedVersion` (→ `{ ok: false, conflict: 'VERSION' }`); `commandResult` is
  the full settled `CommandResult`, written only if the stored record is missing or still
  `ACCEPTED` (→ `conflict: 'COMMAND_ALREADY_SETTLED'`). Nothing is conditioned on items that
  are not written. Notifications arrive as full entities (status `PENDING`). Pending backfill
  records are live items (`PUT_PENDING_BACKFILL` / `ARCHIVE_BACKFILL`). The engine keeps every
  commit within 90 items under core's `COMMIT_ITEM_COST` (+1 per notification, +1 for the
  CommandResult), so the plan §2.3 item mapping, R1 marker included, fits the 100-item
  `TransactWriteItems`; the marker must be keyed per registration scope (`registrationScopeKey`).
- `updateWorkshopInfo` writes title/description and `updatedAt` only (the API edits them
  outside the worker lock).
- `putCommandAccepted` is a conditional insert that returns the existing record;
  `deleteCommandIfAccepted` is the 503 rollback.
- `listDueWorkshops(now)` = workshops with `nextDueAt <= now` (the sparse DUE index, derived
  from the presence of `nextDueAt` whatever the workshop status).
- `CommandQueue.enqueue(cmd)` — FIFO, group `commandGroupId(cmd)`, dedup `commandDedupId(cmd)`
  (or a fresh UUID when it returns undefined).
- `TimerScheduler.schedule(wsId, timers)` — called **before** the commit; extra ticks are harmless.
- `UserDirectory` (optional) resolves `POST /orgs/{orgId}/members` by email.

## Worker semantics (`processCommand(ports, command, options)`)

1. User commands: read the ACCEPTED record (for `CommandSettledLatency`); if it is already
   settled, run one internal TICK pass on the workshop (the first delivery may have crashed
   between its commit and the enqueue of its REALLOCATE continuation; the pass is a NOOP
   otherwise) and return `ALREADY_SETTLED`.
2. `loadSnapshot` (+ `getArchivedOffer` for an ACCEPT/DECLINE whose offer is not live) →
   organiser commands re-check org membership (`REJECTED(FORBIDDEN)` otherwise) →
   `decide(snapshot, command, { now: clock.now(), newId })`.
3. Internal command with no writes → `NOOP` (no commit).
4. Timers scheduled before the commit; `commit(...)`; on `VERSION` reload and retry up to
   `maxVersionRetries` (default 3, `MetaConflictRetries` per conflict, then
   `VersionConflictError`); on `COMMAND_ALREADY_SETTLED` ack with `ALREADY_SETTLED`.
5. Enqueue `decision.continuation` (REALLOCATE), emit `CommandSettledLatency`,
   `OffersCreated`, `OffersExpired`, `BackfillLatency`, and `SweepLateExpiries` for
   sweep-originated TICKs (expiries more than 60 s after `expiresAt`).
6. Deterministic rejections settle as `REJECTED` and never throw. Only infrastructure errors
   (and injected faults) throw, which makes the queue redeliver the message.

Fault injection: with `faultInjection: true` and `deliveryAttempt <= 1`, a `_fault` flag
throws `FaultInjectedError` at `TIMER_SEND` (at the timer-scheduling point, whether or not the
decision created timers), `BEFORE_COMMIT` or `AFTER_COMMIT`. Pass the queue's receive count as
`deliveryAttempt` so the redelivery recovers. An `AFTER_COMMIT`-faulted command emits no
`CommandSettledLatency` sample (it simulates a crash); its server-side latency is still
`settledAt − acceptedAt` on the CMD record.

`verify` reads the live snapshot outside the worker: while a REALLOCATE continuation is still
queued (any decision that hit a per-decision limit) it may report `NO_STARVATION`, so experiment
scripts call it once the workshop's queue is drained (SQS `ApproximateNumberOfMessages` 0, or
the local `commands` table empty).

## API behaviours (`createApiApp({ store, queue, clock, ids, logger, userDirectory?, allowFaultFlags, stage })`)

- `ApiRequest = { method, path, query?, headers?, body?, user? }`; the adapter verifies the JWT
  and passes `user: AuthUser`. `handle()` never throws: errors become `{ code, message }`
  with the status from `ERROR_HTTP_STATUS` (zod failures → 400 `VALIDATION_ERROR`).
- Routes = plan §2.5 (`API_ROUTE_TABLE` lists method/pattern/auth). `GET /health` needs no
  user; `GET /workshops/{wsId}` is public with a `me` section when signed in (`auth:
  'optional'`): it must not sit behind a mandatory JWT authorizer. The adapter verifies an
  `Authorization` header itself when one is present (e.g. `aws-jwt-verify` / `jose`) and passes
  `user` only on success.
- `POST /orgs/{orgId}/workshops` rejects (400) a session whose registration cut-off (30 min
  before start) has already passed. `PATCH /workshops/{wsId}` also sets `updatedAt` and
  returns the public workshop shape.
- `POST /workshops/{wsId}/commands`: validate `CommandBodySchema`, strip `_fault` unless
  `allowFaultFlags`, organiser command types need org membership (403), `putCommandAccepted`
  (existing → 202 with the record's current state; a record still `ACCEPTED` is enqueued
  again, the FIFO dedup id being the commandId, so an orphaned record is never polled forever),
  enqueue (failure → delete record, 503 `QUEUE_UNAVAILABLE`, also when the rollback itself
  fails), 202 `{ commandId, type, workshopId, status, acceptedAt, href, pollAfterMs }`.
- `GET /commands/{id}`: 404 unless the caller issued it or organises the workshop.
- `/orgs/{orgId}/workshops/{wsId}/…`: 403 for non-members of `orgId`, 404 when the workshop is
  not in that organisation.

Deployment settings map to the config: `ALLOW_FAULT_FLAGS` → `allowFaultFlags`,
`STAGE` → `stage`. This package reads no environment variables itself.

## Tests

`pnpm --filter @seatrelay/service typecheck` and `pnpm --filter @seatrelay/service test`
(vitest against the in-memory adapters: API auth/403/404/202/503/idempotency, worker happy
path, VERSION retry, already-settled ack, fault injection, ticks/sweep/continuations,
dashboard/verify/CSV views).
