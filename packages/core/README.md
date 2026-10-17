# @seatrelay/core

The pure domain engine of SeatRelay (plan §2.2). No I/O, no clock, no ids of its own:

```ts
decide(snapshot: WorkshopSnapshot, command: Command, ctx: { now, newId, limits? }): Decision
```

| module            | contents                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `snapshot.ts`     | `WorkshopSnapshot` (workshop + sessions + live registrations + live offers + pending backfill records, plus the optional per-command `settledOffers`) and read helpers: `freeSeats`, `isAllocatable`, `queuePosition`, `queueLength`, `registrationSummary`, `distinctConfirmedUsers` |
| `changes.ts`      | `Change` union written by a decision, `COMMIT_ITEM_COST` / `estimateCommitItems()` (the storage item budget) and the pure `applyChanges()` used by tests, the in-memory store and the replay |
| `decide.ts`       | the steps (tick-first, apply, drain, allocate, nextDueAt/version), `Decision`, `computeNextDueAt` |
| `tick.ts`         | tick-first: expire due offers, end registrations past every cut-off                          |
| `apply.ts`        | every command and every `RejectReason`, `commandItemReserve`                                 |
| `drain.ts`        | budget-sized drains of CANCEL_SESSION / CANCEL_WORKSHOP (CANCELLING → CANCELLED)             |
| `allocate.ts`     | seq-ordered allocation, `expiresAt = min(now + holdSeconds, cutoffAt)`, backfill attribution |
| `invariants.ts`   | `checkInvariants(snapshot, now)` → C1, C2/R1, offer/registration consistency, no-starvation  |
| `perSession.ts`   | the PER_SESSION baseline strategy (per-session queues and uniqueness)                        |
| `factories.ts`    | `newWorkshop`, `newSession` (`cutoffAt = startsAt − 30 min`), `newSnapshot`                   |
| `time.ts`         | ISO-string arithmetic (`addSeconds`, `minIso`, `compareIso`, …)                              |

## Decision contract

- `status` / `reason`: APPLIED, or REJECTED with a deterministic `RejectReason`. TICK and
  REALLOCATE are always APPLIED (on a CANCELLING/CANCELLED workshop they only drain, every user
  command is REJECTED(WORKSHOP_CANCELLED)).
- `writes`: at most one `Change` per entity, `PUT_WORKSHOP_STATE` first (engine-owned fields
  only: `status`, `seq`, `version = snapshot.version + 1`, `nextDueAt`, `updatedAt`). It is
  emitted when anything changed, when `nextDueAt` changed (compared by instant), or when a user
  command was applied. A rejected command without tick-first effects, or an idle internal
  command, writes nothing. The commit of any decision needs at most `MAX_ITEMS_PER_DECISION`
  (90) storage items under `COMMIT_ITEM_COST` (see Limits).
- `notifications`: drafts for OFFER, CONFIRMED, EXPIRED, DECLINED, REVOKED, SESSION_CANCELLED,
  WORKSHOP_CANCELLED (one per user), ENDED (cut-off). A participant's own cancel is silent.
- `timers`: one `{ offerId, expiresAt }` per new offer; schedule them **before** committing.
- `backfills`: records created, relayed or closed in this decision (also in `writes` as
  PUT_BACKFILL / PUT_PENDING_BACKFILL / ARCHIVE_BACKFILL). `latencyMs = reallocatedAt −
  releasedAt`; `releasedAt` is the offer's `expiresAt` for EXPIRED and `now` otherwise.
  CAPACITY_UP is recorded only when a queued participant takes the seat. SESSION_CANCELLED
  records are released seats that can never be relayed. A release that finds no taker while a
  continuation is pending stays a live pending record (`snapshot.pendingBackfills`): whichever
  decision relays the seat next — the continuation, a timer tick or a user command that was
  already queued — attributes it, oldest release first; once the chain ends it is closed
  (final, never relayed).
- `continuation`: a `REALLOCATE` when a limit stopped the work (offers, expiries, cut-off
  endings, cancellation drains, the item budget). It carries only the SET_CAPACITY seats not yet
  taken (`pendingCapacityUp`); while it is pending `nextDueAt = now`, so the 5-minute sweep
  finishes the chain if the enqueued message is lost.
- `metrics`: `offersCreated`, `offersExpired`, `backfillLatenciesMs`, `sweepLate` (a
  `TICK{source:'SWEEP'}` that had to expire something — the timer path was late).
- `resultForCommand`: `{ offersCreated, registration? }` for applied user commands; the
  registration summary is the same shape as the public view's `me`.

## Limits

`ctx.limits` (defaults `DEFAULT_DECISION_LIMITS`): `maxOffersPerDecision = 12` (plan §2.2),
`maxExpiriesPerDecision = 12` and `maxItemsPerDecision = 90`. The item budget is what keeps one
commit inside the DynamoDB transaction limit (100 items): the engine counts the storage items
of the work done so far with `COMMIT_ITEM_COST` (PUT_WORKSHOP_STATE 1, PUT_SESSION 1,
PUT_REGISTRATION 2 — live item + R1 marker —, ARCHIVE_REGISTRATION 3, PUT_OFFER 1,
ARCHIVE_OFFER 2, backfill records 1, ARCHIVE_BACKFILL 2) plus one item per notification and
one for the CommandResult, and every bounded step (tick-first expiries and cut-off endings,
cancellation drains, allocations, closing of pending records) stops before the next unit
would cross it; tick-first additionally keeps the command's own worst case free
(`commandItemReserve`). `estimateCommitItems(decision)` is the same formula for adapters and
tests. The remainder is carried over by the REALLOCATE continuation (and by the sweep, since
`nextDueAt = now` meanwhile). CANCEL_SESSION and CANCEL_WORKSHOP are bounded the same way: the
command flips the status to CANCELLING and the drain archives/revokes in budget-sized steps
until the status becomes CANCELLED.

## Semantics worth knowing

- **Tick-first** (plan §1.2): every decision first expires offers with `expiresAt <= now` and
  ends QUEUED registrations whose sessions all passed cut-off. Late/duplicate ticks are no-ops;
  an ACCEPT after `expiresAt` is rejected (OFFER_EXPIRED) whether the timer tick arrived before
  it (the offer is then found among `snapshot.settledOffers`, which the service loads for
  ACCEPT/DECLINE of a non-live offer), in the same decision, or not at all. A second answer to
  an ACCEPTED/DECLINED/REVOKED offer is OFFER_NOT_ACTIVE; an unknown id is OFFER_NOT_FOUND.
- **R1** one live registration per user per workshop (UNIFIED) or per user per session
  (PER_SESSION). **R2** `seq = workshop.seq + 1` at REGISTER; a re-registration after cancel
  gets a new seq. **R3** allocation scans QUEUED registrations by seq and takes the first
  OPEN, pre-cut-off session with a free seat in the participant's preference order.
- **R5** DECLINE/EXPIRE/REVOKE remove that session from the preferences; the registration goes
  back to QUEUED with its seq, or ends with NO_ACCEPTABLE_SESSION (nothing left) or CUTOFF
  (everything left has passed its cut-off).
- **R6** CANCEL_REGISTRATION from any live status releases the held/confirmed seat
  (CANCELLED_OFFER / CANCELLED_CONFIRMED backfill) and the seat is relayed in the same decision.
- **R7** SET_CAPACITY rejects `capacity < 1` (INVALID_CAPACITY) and
  `capacity < confirmed + held` (CAPACITY_BELOW_USAGE); raising allocates immediately.
- CANCEL_SESSION revokes its offers, re-queues its confirmed participants (same seq) and drops
  the session from every preference list; CANCEL_WORKSHOP ends everything. Both run as drains
  (status CANCELLING until done); an ACCEPT/DECLINE of an offer on a session being cancelled is
  rejected with SESSION_CANCELLED.
- REGISTER drops CANCELLED/CANCELLING sessions and sessions past their cut-off from the list
  silently (none of them can ever be offered, R4) and rejects NO_ACCEPTABLE_SESSION when
  nothing usable remains.
- `nextDueAt = min(earliest live offer expiresAt, earliest future cutoffAt of an OPEN session
  with QUEUED/OFFERED demand, now while a continuation is pending)`, `undefined` when nothing
  is pending (sparse DUE index, whatever the workshop status).
- `ctx.now` is normalised to ISO UTC with milliseconds; `decide()` throws when
  `command.workshopId` is not the snapshot's workshop (a routing bug, never a reject reason).
- **Authorisation is not the engine's job**: organiser commands are accepted only after the API
  checked org membership (C7); `RejectReason.FORBIDDEN` is reserved for that layer. The engine
  also never validates command payload shape (the API does, with `@seatrelay/contracts`).
- `actorEmail` (and optional `actorDisplayName`) come from the JWT via `buildCommand()`; the
  engine stores them on the registration and uses them for notification drafts.

## Tests

`pnpm --filter @seatrelay/core test` runs vitest with v8 coverage (thresholds 95 % for
branches, lines, functions and statements over `src/**`): one test per rule and reject reason,
tick-first and cut-off scenarios, the 12-offer cap with continuation, the item budget on the
experiment-sized shapes (`budget.test.ts`), the cancellation drains, PER_SESSION mode, every
invariant code, and a fast-check model-based property test (2,000 random command sequences of
up to 200 steps, 2–5 sessions, up to 40 users, random clock advances and limits, random
commands interleaved before continuations) asserting `checkInvariants`, the item budget of
every commit, purity and determinism after every step.
