# AI declaration: "what I learned" paragraphs (DRAFTS)

> **Every member must confirm or rewrite their own paragraph before submission.** These paragraphs
> were drafted by the AI coding assistant, not by the members. A paragraph becomes a member's
> statement only after that member has read it, changed whatever is not true for them, and ticked
> the box below. Rewriting in your own words is encouraged; keep it to **at most 45 words, first
> person**, and keep it about something that really happened (the "Grounded in" column lists the
> project record each draft uses). When all six boxes are ticked, copy the final text into
> `report/sections/07-declaration.tex` and delete the `\pending{...}` after "What we learned".
> Until then the report prints **none** of these drafts and no name-to-line mapping (Final report, AI
> usage declaration; slide 13 shows the mapping as provisional). In the same statement, say how you
> reviewed the generated code and whether you approved deployments: the report no longer asserts
> either on the members' behalf.

The Preliminary report (§4) lists six work lines but does not assign them to names. The drafts
below assign the lines **in the order the names appear on the title page**. **If the real
assignment differs, correct the mapping here and in `report/sections/07-declaration.tex`** (and
then rewrite the affected paragraphs, because each draft is written for its line).

| # | Member | Work line (Prelim §4) | Confirmed by the member |
|---|---|---|---|
| 1 | LI ZONGZE | product and front end | [ ] |
| 2 | CHEN YANG | allocation logic and API | [ ] |
| 3 | LIN JIE | AWS and monitoring | [ ] |
| 4 | ZHU GENGYU | data and the local reference | [ ] |
| 5 | LIANG ZIHAN | user research and evaluation tooling | [ ] |
| 6 | ZHANG TIANYI | organiser dashboard, cross-cutting QA and documentation | [ ] |

## Drafts

### 1. LI ZONGZE (product and front end), 43 words

A 202 response is not a result. I learned to build the interface around three states (request
received, queued with a position, seat confirmed), to poll with back-off rather than add WebSockets,
and to check generated code against the rules before accepting it.

*Grounded in:* the polling protocol and the "request received" vs "seat confirmed" distinction
(Final §3.4, `apps/web/src/commands/{backoff,pollCommand,commandRunner}.ts`); commit `86b6179`
"fix(web): apply settled command results directly, CANCELLING states".

### 2. CHEN YANG (allocation logic and API), 43 words

I learned that DynamoDB allows 100 actions per transaction, so a decision is capped (12 offers, 12
expiries) and continues as a follow-up command, and that judging expiry by server time at processing
makes a late or duplicate timer harmless to newer offers.

*Grounded in:* the `TransactWriteItems` limit of 100 actions and the 12/12/90 decision cap with the
internal REALLOCATE continuation (Final §3.2; commit `633336a` "engine: review fixes (… commit item
budget …)"); tick-first expiry and the strengthened C5 (Final §3.4, `packages/core/src/tick.ts`).

### 3. LIN JIE (AWS and monitoring), 45 words

During the load tests we found that the account's Lambda concurrency quota was 10, shared by every
function of both stages; I learned to check service quotas before measuring. A second stage failed
to deploy because SAM gave both stages' sweep schedules the same name.

*Grounded in:* `aws lambda get-account-settings` on 2026-10-17 (`ConcurrentExecutions: 10`, ten
functions across `dev` and `pilot`) and the quota increase to 1,000, approved the same day, after
which the whole Table 3 series was re-run (`docs/deployment-state.md`, "2026-10-17 evening: quota,
re-run, redeploy, test-account passwords"; `results/2026-10-17-table3-dev-q1000-provenance.md`); the
`ScheduleV2` name collision between the dev and pilot sweep schedules, fixed with
`Name: !Sub seatrelay-${Stage}-sweep` (`docs/deployment-state.md`, commit `be219aa`). The cause of
the HTTP 503 responses (Lambda throttling under the quota of 10) is established in Final §4.2, "The
first series failed, and why." (`results/2026-10-17-throttling-evidence/summary.md`).

### 4. ZHU GENGYU (data and the local reference), 43 words

Running our engine on PostgreSQL showed me that a fair cloud versus on-premise comparison needs equal
load, retention and function, and that labour and the network line, not hardware, dominate a small
self-hosted service. Two prices I used had changed a day later.

*Grounded in:* the on-prem reference `services/local` (same engine, PostgreSQL adapter) and the cost
model's two views (Final §2: the fully amortised view is dominated by labour and the business line);
the M1 fibre and UPS prices that differed between 2026-10-16 and 2026-10-17 (`report/sources.md`
§2b, commit `c17454c`).

### 5. LIANG ZIHAN (user research and evaluation tooling), 45 words

Timing an expiry race at ±200 ms taught me that network delay is part of the experiment: an "early"
probe arrived late and was rightly rejected, so the harness calibrates send times. Preparing the
study, I learned to report the real sample, whatever its size.

*Grounded in:* the expiry-race run that failed one check because a probe meant to arrive 200 ms
before `expiresAt` arrived after it (Final §4.2, paragraph "The first series failed, and why."; commit `00faa52` "warm connection
and learn arrival error for timed expiry-race probes"); the Prelim §5 promise "we do not fabricate
participants" and the study package in `docs/user-study/`. Do not mention study results until the
study has run.

### 6. ZHANG TIANYI (organiser dashboard, QA and documentation), 44 words

SES production access was denied while our sender address was still unverified, so pilot participants
rely on in-app notifications; I learned to plan such approvals early. In QA I learned to report
failed experiments as failures and to give organisers a one-click invariant check.

*Grounded in:* the SES production-access denial on 2026-10-17 and the in-app fallback
(`docs/deployment-state.md`, `docs/ses-production-request.md`, commit `f3d1026`); the failed
concurrency and backfill checks reported as failures (Final §4.2) and the dashboard's `verify` button
(`GET …/verify`, Final §3.3).
