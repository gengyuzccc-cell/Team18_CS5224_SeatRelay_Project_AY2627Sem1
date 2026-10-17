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
| `csv.ts`                   | `registrationsCsv` (organiser export)                                                                                    |
| `memory/*`                 | `InMemoryWorkshopStore`, `InMemoryCommandQueue`, `InMemoryTimerScheduler`, `ManualClock`, `createInMemoryPorts` harness |

## Ports (what the adapters implement)

- `WorkshopStore.loadSnapshot(wsId)` — consistent read of the live items only.
- `WorkshopStore.commit({ wsId, expectedVersion, writes, notifications, commandResult? })` —
  one transaction. `PUT_WORKSHOP_STATE` updates engine-owned fields only and is conditioned on
  `version === expectedVersion` (→ `{ ok: false, conflict: 'VERSION' }`); `commandResult` is
  the full settled `CommandResult`, written only if the stored record is missing or still
  `ACCEPTED` (→ `conflict: 'COMMAND_ALREADY_SETTLED'`). Nothing is conditioned on items that
  are not written. Notifications arrive as full entities (status `PENDING`).
- `updateWorkshopInfo` writes title/description only (the API edits them outside the worker lock).
- `putCommandAccepted` is a conditional insert that returns the existing record;
  `deleteCommandIfAccepted` is the 503 rollback.
- `listDueWorkshops(now)` = workshops with `nextDueAt <= now` (the sparse DUE index).
- `CommandQueue.enqueue(cmd)` — FIFO, group `commandGroupId(cmd)`, dedup `commandDedupId(cmd)`
  (or a fresh UUID when it returns undefined).
- `TimerScheduler.schedule(wsId, timers)` — called **before** the commit; extra ticks are harmless.
- `UserDirectory` (optional) resolves `POST /orgs/{orgId}/members` by email.

## Worker semantics (`processCommand(ports, command, options)`)

1. User commands: read the ACCEPTED record (for `CommandSettledLatency`); if it is already
   settled, return `ALREADY_SETTLED`.
2. `loadSnapshot` → organiser commands re-check org membership (`REJECTED(FORBIDDEN)` otherwise)
   → `decide(snapshot, command, { now: clock.now(), newId })`.
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
throws `FaultInjectedError` at `TIMER_SEND` (instead of scheduling), `BEFORE_COMMIT` or
`AFTER_COMMIT`. Pass the queue's receive count as `deliveryAttempt` so the redelivery recovers.

## API behaviours (`createApiApp({ store, queue, clock, ids, logger, userDirectory?, allowFaultFlags, stage })`)

- `ApiRequest = { method, path, query?, headers?, body?, user? }`; the adapter verifies the JWT
  and passes `user: AuthUser`. `handle()` never throws: errors become `{ code, message }`
  with the status from `ERROR_HTTP_STATUS` (zod failures → 400 `VALIDATION_ERROR`).
- Routes = plan §2.5 (`API_ROUTE_TABLE` lists method/pattern/auth). `GET /health` needs no
  user; `GET /workshops/{wsId}` is public with a `me` section when signed in.
- `POST /workshops/{wsId}/commands`: validate `CommandBodySchema`, strip `_fault` unless
  `allowFaultFlags`, organiser command types need org membership (403), `putCommandAccepted`
  (existing → 202 with the record's current state), enqueue (failure → delete record, 503
  `QUEUE_UNAVAILABLE`), 202 `{ commandId, type, workshopId, status, acceptedAt, href,
  pollAfterMs }`.
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
