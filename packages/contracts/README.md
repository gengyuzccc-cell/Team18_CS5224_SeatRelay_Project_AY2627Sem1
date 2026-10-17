# @seatrelay/contracts

zod 3 schemas and the TypeScript types inferred from them, shared by `core`, `service`,
`aws`, `local`, `web` and the tools. Depends on `zod` only.

| module         | contents                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `constants.ts` | hold-seconds bounds, 2–5 sessions, cutoff offset, poll hint, TTLs, length limits                              |
| `enums.ts`     | every string-literal union (`XXX_VALUES` const array + `XxxSchema` + `Xxx` type)                              |
| `entities.ts`  | Organization, Workshop, Session, Registration, Offer, CommandResult, Notification, Backfill, Attendance       |
| `commands.ts`  | `CommandBodySchema` (what the browser posts), `CommandSchema` (full, incl. TICK/REALLOCATE), `buildCommand()` |
| `api.ts`       | request bodies and response views for every route in plan §2.5                                                |
| `errors.ts`    | `ErrorCode`, `ErrorBody`, HTTP status map                                                                     |

Conventions baked in:

- Timestamps are ISO-8601 UTC with milliseconds (`IsoTimestampSchema`). API inputs accept any
  ISO datetime (with offset) through `IsoDateTimeInputSchema`, which normalises to UTC + ms.
- `commandId` is a client-generated UUID v4. `workshopId`, `actorUserId`, `actorEmail` and
  `actorDisplayName` are never read from the request body: the API injects them with
  `buildCommand(body, workshopId, authUser)`.
- `RejectReason.FORBIDDEN` is reserved for the service layer (organiser commands are authorised
  by the API/worker through org membership); `decide()` never emits it.
- `CANCELLING` (workshop and session) is the transient state while an organiser cancellation
  is drained in budget-sized commits; clients show it as "cancelling", everything else treats
  it like CANCELLED (never offered, user commands rejected).
- `CommandAcceptedSchema` is the same schema as `CommandAcceptedViewSchema`: the 202 body
  carries the record's current state, which is `APPLIED`/`REJECTED` on an idempotent re-POST.
