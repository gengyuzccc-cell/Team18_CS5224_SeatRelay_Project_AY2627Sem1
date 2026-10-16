# @seatrelay/core

The pure domain engine of SeatRelay (plan §2.2). No I/O, no clock, no ids of its own:

```ts
decide(snapshot: WorkshopSnapshot, command: Command, ctx: { now, newId, limits? }): Decision
```

| module            | contents                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `snapshot.ts`     | `WorkshopSnapshot` (workshop + sessions + live registrations + live offers) and read helpers: `freeSeats`, `isAllocatable`, `queuePosition`, `queueLength`, `registrationSummary`, `distinctConfirmedUsers` |
| `changes.ts`      | `Change` union written by a decision and the pure `applyChanges()` used by tests, the in-memory store and the replay |
| `decide.ts`       | the four steps (tick-first, apply, allocate, nextDueAt/version), `Decision`, `computeNextDueAt` |
| `tick.ts`         | tick-first: expire due offers, end registrations past every cut-off                          |
| `apply.ts`        | every command and every `RejectReason`                                                       |
| `allocate.ts`     | seq-ordered allocation, `expiresAt = min(now + holdSeconds, cutoffAt)`, backfill attribution |
| `invariants.ts`   | `checkInvariants(snapshot, now)` → C1, C2/R1, offer/registration consistency, no-starvation  |
| `perSession.ts`   | the PER_SESSION baseline strategy (per-session queues and uniqueness)                        |
| `factories.ts`    | `newWorkshop`, `newSession` (`cutoffAt = startsAt − 30 min`), `newSnapshot`                   |
| `time.ts`         | ISO-string arithmetic (`addSeconds`, `minIso`, `compareIso`, …)                              |

## Decision contract

- `status` / `reason`: APPLIED, or REJECTED with a deterministic `RejectReason`. TICK and
  REALLOCATE are always APPLIED (except on a CANCELLED workshop, where only TICK is accepted).
- `writes`: at most one `Change` per entity, `PUT_WORKSHOP_STATE` first (engine-owned fields
  only: `status`, `seq`, `version = snapshot.version + 1`, `nextDueAt`, `updatedAt`). It is
  emitted when anything changed, when `nextDueAt` changed, or when a user command was applied.
  A rejected command without tick-first effects, or an idle internal command, writes nothing.
- `notifications`: drafts for OFFER, CONFIRMED, EXPIRED, DECLINED, REVOKED, SESSION_CANCELLED,
  WORKSHOP_CANCELLED (one per user), ENDED (cut-off). A participant's own cancel is silent.
- `timers`: one `{ offerId, expiresAt }` per new offer; schedule them **before** committing.
- `backfills`: records created or relayed in this decision (also in `writes` as PUT_BACKFILL).
  `latencyMs = reallocatedAt − releasedAt`; `releasedAt` is the offer's `expiresAt` for EXPIRED
  and `now` otherwise. CAPACITY_UP is recorded only when a queued participant takes the seat.
  SESSION_CANCELLED records are released seats that can never be relayed.
- `continuation`: a `REALLOCATE` when a limit stopped the work. It carries the releases of this
  decision that found no taker (`pendingBackfills`, `pendingCapacityUp`) so the next decision
  attributes its offers to them.
- `metrics`: `offersCreated`, `offersExpired`, `backfillLatenciesMs`, `sweepLate` (a
  `TICK{source:'SWEEP'}` that had to expire something — the timer path was late).
- `resultForCommand`: `{ offersCreated, registration? }` for applied user commands; the
  registration summary is the same shape as the public view's `me`.

## Limits

`ctx.limits` (defaults `DEFAULT_DECISION_LIMITS`): `maxOffersPerDecision = 12` (plan §2.2) and
`maxExpiriesPerDecision = 12`. Both exist to keep one commit inside the DynamoDB transaction
limit (100 items); the remainder is carried over by the continuation. CANCEL_SESSION and
CANCEL_WORKSHOP are not bounded (rare organiser actions); adapters must chunk if a session is
larger than the transaction allows.

## Semantics worth knowing

- **Tick-first** (plan §1.2): every decision first expires offers with `expiresAt <= now` and
  ends QUEUED registrations whose sessions all passed cut-off. Late/duplicate ticks are no-ops;
  an ACCEPT after `expiresAt` is rejected (OFFER_EXPIRED) even if no timer arrived.
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
  the session from every preference list; CANCEL_WORKSHOP ends everything.
- REGISTER drops CANCELLED sessions from the list silently and rejects NO_ACCEPTABLE_SESSION
  when nothing usable remains; sessions past cut-off stay listed but are never offered.
- `nextDueAt = min(earliest live offer expiresAt, earliest future cutoffAt of an OPEN session
  with QUEUED/OFFERED demand)`, `undefined` when nothing is pending (sparse DUE index).
- **Authorisation is not the engine's job**: organiser commands are accepted only after the API
  checked org membership (C7); `RejectReason.FORBIDDEN` is reserved for that layer. The engine
  also never validates command payload shape (the API does, with `@seatrelay/contracts`).
- `actorEmail` (and optional `actorDisplayName`) come from the JWT via `buildCommand()`; the
  engine stores them on the registration and uses them for notification drafts.

## Tests

`pnpm --filter @seatrelay/core test` runs vitest with v8 coverage (thresholds 95 % for
branches, lines, functions and statements over `src/**`): one test per rule and reject reason,
tick-first and cut-off scenarios, the 12-offer cap with continuation, PER_SESSION mode, every
invariant code, and a fast-check model-based property test (2,000 random command sequences of
up to 200 steps, 2–5 sessions, up to 40 users, random clock advances and limits) asserting
`checkInvariants` plus purity and determinism after every step.
