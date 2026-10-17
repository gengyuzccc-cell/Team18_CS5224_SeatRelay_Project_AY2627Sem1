# SeatRelay live demo script

The script for the live demo inside the 15-minute presentation on 11/13 (plan §7.2: every member
speaks; the live demo takes about 5½ minutes). It covers:

- the preset data;
- the two browsers and their accounts;
- the exact click path for the five beats the plan requires:
  1. register → offer → accept;
  2. a second person's cancellation, instantly back-filled;
  3. an offer with `holdSeconds = 60` expiring and being back-filled automatically;
  4. `verify` on the dashboard;
  5. one fault injection (`AFTER_COMMIT`) that shows exactly-once settlement;
- the fallback plan and the reset procedure.

**Targets.**

- **Plan A**: the dev stack on AWS. It is the only cloud stage with fault flags
  (`AllowFaultFlags=true`); pilot strips them.
- **Plan B**: the local Docker Compose stack, with identical steps.
- **Plan C**: the recorded video.

**Rehearsal record.** The flow below was rehearsed against the local stack through the API on
2026-10-17. The outputs are in the appendix; they are rehearsal values, not report measurements.

---

## 1. Cast, screens and accounts

| Who / what | Plan A (dev, `https://d2ni5e1z674t04.cloudfront.net`) | Plan B (local, `http://localhost:8081`) | Where on screen |
|---|---|---|---|
| **O**: organiser | `demo.organiser@example.com` / `Passw0rd!` (created by `seed-demo`) | `organiser@example.com` / `Passw0rd!` | Browser 1 (Chrome, normal window), left half |
| **A**: participant "Demo 1" | `demo-1@example.com` / `Passw0rd!` | same | Browser 2 (Firefox, normal window), top right |
| **B**: participant "Demo 2" | `demo-2@example.com` / `Passw0rd!` | same | Browser 2, **private window** (separate storage), bottom right |
| **C**: participant "Demo 3" | `demo-3@example.com`, terminal only (fault injection) | same | Terminal, large font, on a second desktop |
| Background participants (preset) | `demo.p1`, `demo.p2`, `demo.p3@example.com` | `alice@`, `bob@`, `carol@example.com` | only visible on the dashboard |

Why two browsers: the SPA keeps the signed-in user in `localStorage`, so one browser profile is one
account. A private window has its own storage and its own identity-provider cookies, so it counts as
a third profile.

Roles in the team: one **operator** drives all windows and the terminal and never talks. One
**narrator** speaks the "Say" lines. Swap roles between rehearsals so that two people can do each
job.

---

## 2. Preset data

`pnpm --filter @seatrelay/scripts seed-demo` (source `tools/scripts/src/lib/seedDemo.ts`) creates
organisation **SeatRelay Demo** and workshop **Demo workshop** (UNIFIED). It has three sessions, the
first starting in 3 days:

| Session | Capacity |
|---|---|
| Session 1 | 2 |
| Session 2 | 2 |
| Session 3 | 1 |

It then registers three background participants with fixed preference lists:

| Participant | Preference list | Result after seeding |
|---|---|---|
| p1 | [S1, S2, S3] | OFFERED Session 1 |
| p2 | [S2, S3] | OFFERED Session 2 |
| p3 | [S3, S1] | OFFERED Session 3 |

The script cancels any earlier "Demo workshop", so re-running it is the reset.

We seed with **`--hold 3600`**. The preset offers then stay held for an hour, and the dashboard does
not change by itself during the talk. Starting state:

| Session | Capacity | Held | Free | Queue |
|---|---|---|---|---|
| Session 1 | 2 | 1 | 1 | 0 |
| Session 2 | 2 | 1 | 1 | 0 |
| Session 3 | 1 | 1 | 0 | 0 |

The expiry beat needs a 60-second hold. `holdSeconds` is fixed per workshop when it is created, so
the organiser creates a second workshop, **Expiry demo**, during setup: hold 60 s, Session A and
Session B with capacity 1 each.

---

## 3. Setup checklist

### T−1 day (once)

1. `git pull`. The dev stack is deployed from the demo commit (`docs/deployment-state.md`).
   Run `pnpm --filter @seatrelay/experiments smoke -- --target dev`; it must PASS.
2. Create the demo accounts and tokens:
   ```bash
   # Plan A (needs AWS credentials; no e-mail is sent)
   pnpm --filter @seatrelay/scripts create-test-users -- --count 3 --prefix demo --password 'Passw0rd!' --stage dev
   # Plan B
   pnpm --filter @seatrelay/scripts get-tokens-keycloak -- --count 3 --prefix demo
   ```
3. Sign in once with A and B in their browsers (hosted UI, e-mail + password) and accept any
   browser prompts. Set browser zoom to 125 %. Turn off OS notifications. Use a dark terminal theme
   with an 18 pt font.
4. Record the fallback video (section 6) during the second rehearsal.

### T−30 min

```bash
API=$(aws cloudformation describe-stacks --stack-name seatrelay-app-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)   # dev today: https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com
curl -s "$API/health"                                                             # {"ok":true,...,"stage":"dev"}
aws cloudformation describe-stacks --stack-name seatrelay-app-dev \
  --query 'Stacks[0].Parameters[?ParameterKey==`AllowFaultFlags`].ParameterValue' --output text   # true
for q in commands-dlq.fifo expiry-delay-dlq notify-dlq; do
  aws sqs get-queue-attributes --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text \
    --queue-url "$(aws sqs get-queue-url --queue-name seatrelay-dev-$q --query QueueUrl --output text)"
done                                                                              # 0 0 0
# Refresh C's token (dev ID tokens last 12 h, local ones 60 min)
pnpm --filter @seatrelay/scripts create-test-users -- --count 3 --prefix demo --password 'Passw0rd!' --stage dev
```

Plan B: `pnpm local:up`, wait until `docker compose -f services/local/docker-compose.yml ps` shows
`server` healthy, then `curl -s http://localhost:3000/health`. Re-run `get-tokens-keycloak`
(previous step 2) within the hour before the demo.

### T−20 min: seed and prepare the windows

```bash
mkdir -p ~/seatrelay-demo
pnpm --silent --filter @seatrelay/scripts seed-demo -- --target dev --hold 3600 > ~/seatrelay-demo/seed.json
#   Plan B: ... seed-demo -- --target local --hold 3600 > ~/seatrelay-demo/seed.json
jq -c '{verify, sessions: [.sessions[] | {key, free, held}], participants: [.participants[] | {email, status, session}]}' ~/seatrelay-demo/seed.json
# expect verify true; S1 free 1 held 1, S2 free 1 held 1, S3 free 0 held 1; p1..p3 OFFERED S1/S2/S3
WEB=https://d2ni5e1z674t04.cloudfront.net        # Plan B: http://localhost:8081
ORG=$(jq -r .orgId ~/seatrelay-demo/seed.json); WS=$(jq -r .workshopId ~/seatrelay-demo/seed.json)
echo "organiser: $WEB/org/$ORG/workshops/$WS"; echo "participants: $WEB/workshops/$WS"
```

Seed no earlier than 45 minutes before the slot. The preset offers expire 60 minutes after seeding.
If the slot slips, re-seed: it takes 15 seconds, and the URLs change.

1. **Window O (organiser).** Open the organiser URL: the dashboard of *Demo workshop*. Then create
   the expiry workshop:
   1. Click **Organiser** → *SeatRelay Demo* → **Create a workshop**.
   2. Step 1: title `Expiry demo`, mode *Unified*, hold seconds `60` → **Next**.
   3. Step 2: *Session A* tomorrow 10:00, capacity 1; *Session B* tomorrow 14:00, capacity 1
      → **Next**.
   4. Step 3: **Create workshop**.
   5. Open its dashboard in a second tab and copy its **Share link (public page)**.
2. **Window A** (Firefox, signed in as Demo 1). Tab 1: the participant URL (*Demo workshop*).
   Tab 2: the *Expiry demo* public page.
3. **Window B** (Firefox private window, signed in as Demo 2). The same two tabs.
4. **Terminal** (Plan A; for Plan B set `API=http://localhost:3000` and use the `.token-cache.local.json` cache):
   ```bash
   # same shell as the previous steps, working directory = the repository root
   export API WS
   export S2=$(jq -r '.sessions[] | select(.key=="S2") | .id' ~/seatrelay-demo/seed.json)
   export TOKEN_C=$(jq -r '.users[] | select(.email=="demo-3@example.com") | .idToken' tools/loadtest/.token-cache.dev.json)
   export CMD=$(python3 -c 'import uuid; print(uuid.uuid4())')
   export BODY=$(jq -nc --arg c "$CMD" --arg s "$S2" '{type:"REGISTER", commandId:$c, acceptable:[$s], _fault:"AFTER_COMMIT"}')
   echo "$BODY" | jq .                                     # visible to the audience: note the _fault field
   ```
5. Optional (Plan A): open CloudWatch → Logs Insights on `/aws/lambda/seatrelay-dev-worker` in a
   tab of Window O. This is the backup for the log command in D5b.

### T−5 min

On both dashboards, click **Verify invariants**: *All invariants hold*. Check that the *Demo
workshop* still shows held 1/1/1 and an empty queue. Leave the tabs on the dashboard (O) and on the
*Demo workshop* page (A, B).

---

## 4. Run of show (15:00)

| Time | Block | Slides / screen |
|---|---|---|
| 0:00–1:00 | Problem and market size | slides |
| 1:00–2:00 | Business model and pricing | slides |
| 2:00–3:00 | Mechanism and rules R1–R7 | slides |
| 3:00–4:00 | Architecture (Figure A) | slides |
| 4:00–5:30 | Request path, timers, transaction (Figures B, C) | slides |
| **5:30–11:00** | **Live demo**: D1 → D2 → D5a → D3 → D5b → D4 (section 5) | browsers + terminal |
| 11:00–12:45 | System evaluation results (Table 3) | slides |
| 12:45–13:30 | Cloud vs on-prem cost | slides |
| 13:30–14:15 | User study and pilot | slides |
| 14:15–15:00 | Limitations, future work, AI use, roles | slides |

The order D5a before D3 is deliberate. On dev the crashed message comes back after the 120 s SQS
visibility timeout, and the expiry beat fills exactly that wait. The beat also shows that a stuck
message pauses only *its own* workshop: the expiry runs on another workshop's queue meanwhile.

---

## 5. Live demo click path

Notation: **Do** = operator action, **Expect** = what appears (exact UI text where it matters),
**Say** = narrator line. Times are relative to the start of the demo block.

### D1 (0:00–1:00): register → offer → accept (Window A, *Demo workshop*)

- **Say:** "Three sessions of the same workshop. Session 3 is already taken; sessions 1 and 2 have
  one seat each. Demo 1 can attend Session 3 or Session 1, and prefers Session 3."
- **Do:** In **Register**, tick *Session 3*, then *Session 1*. The tick order sets the rank; show the
  ▲/▼ buttons once. Click **Register (2 sessions)**.
- **Expect:** *Request received, waiting for the outcome…*, then the toast *Registration applied*.
  The status card shows *A seat in Session 1 is held for you — confirm within 59:5x.*
- **Say:** "Two distinct moments: the request was accepted immediately, a 202, and the browser polled
  until the seat was decided. Session 3 was full, so the engine went straight to her second choice.
  One registration, one queue, never two seats."
- **Do:** **Accept seat**.
- **Expect:** *Accept applied — Your seat in Session 1 is confirmed.*
- **Do (Window O):** **Refresh**. *Session 1* now shows confirmed 1, held 1, free 0, and Demo 1 is
  in *Confirmed (1)*.

### D2 (1:00–2:00): second person cancels → instant backfill (Windows B, A, O)

- **Do (Window B):** Tick only *Session 1* → **Register (1 session)**.
- **Expect:** *You are queued at position 1.* In the sessions table, Session 1 shows 0 free and 1
  in the queue.
- **Say:** "Session 1 is full; Demo 2 waits first in line. Now Demo 1's plans change."
- **Do (Window A):** **Cancel my seat** → *Release your seat?* **Yes, cancel**.
- **Expect (A):** *Cancellation applied — Your registration is cancelled.* The page shows the
  registration form again.
- **Expect (B):** Within 10 s (the status page refreshes while you are queued; or press F5): *A seat
  in Session 1 is held for you — confirm within 59:5x.*
- **Do (Window B):** **Accept seat** → *Your seat in Session 1 is confirmed.*
- **Do (Window O):** **Refresh**. The **Backfill log** shows *Session 1 · confirmed seat cancelled ·
  latency 0 ms*. The header reads *1/1 reallocated*.
- **Say:** "The cancellation and the hand-over to the next person are one transaction: zero
  milliseconds, nobody had to email anyone."

### D5a (2:00–2:45): fault injection, crash after commit (terminal)

- **Say:** "Now we crash the worker on purpose, right **after** it has committed but **before** it
  could acknowledge the message, the worst moment for double booking. This flag only works on the
  dev stage."
- **Do:**
  ```bash
  curl -s -X POST "$API/workshops/$WS/commands" -H "authorization: Bearer $TOKEN_C" \
    -H 'content-type: application/json' -d "$BODY" | jq '{commandId, status, acceptedAt}'
  sleep 2
  curl -s "$API/commands/$CMD" -H "authorization: Bearer $TOKEN_C" \
    | jq '{status, settledAt, registration: .result.registration.status}'
  curl -s -X POST "$API/workshops/$WS/commands" -H "authorization: Bearer $TOKEN_C" \
    -H 'content-type: application/json' -d "$BODY" | jq '{status, settledAt}'
  ```
- **Expect:** in this order:
  1. `"status": "ACCEPTED"`;
  2. `"status": "APPLIED"` with a `settledAt` and `"registration": "OFFERED"`;
  3. for the re-POST of the same `commandId`, `"status": "APPLIED"` with the **same** `settledAt`.
     Nothing is applied twice.
- **Say:** "Committed, then crashed. SQS will hand the same message to the worker again in about two
  minutes. Until then this workshop's queue is paused: that is the ordering guarantee. We look at
  the result after the next beat, which runs on a different workshop and is not slowed down."
- **Rule:** send **no command to *Demo workshop*** until D5b. Its FIFO group waits for the
  redelivery. Dashboard reads are fine.

### D3 (2:45–4:30): 60 s hold expires → automatic backfill (*Expiry demo*)

- **Do (Window A, tab 2):** Tick *Session A* → **Register (1 session)**.
- **Expect:** *A seat in Session A is held for you — confirm within 00:59.*
- **Do (Window B, tab 2):** Tick *Session A* → **Register (1 session)** → *You are queued at position 1.*
- **Do (Window O, tab 2):** **Refresh**. *Offered (1)* lists Demo 1 with a live countdown; *Queue
  (1)* lists Demo 2.
- **Say during the wait** (about 50 s; Figure C on the slide if the projector can switch):
  - "When the offer was created, the worker put a one-minute timer on an SQS delay queue, before it
    committed.
  - When the timer fires, a small Lambda forwards a 'tick' into this workshop's ordered queue. The
    worker always expires whatever is due by server time first, then gives the seat to the next
    person.
  - A late or duplicate tick finds nothing to do. The five-minute sweep is only a safety net; it is
    not what makes this fast."
- **Do (Window A), optional, at 00:00 while the Accept button is still visible:** **Accept seat**.
- **Expect:** *Accept rejected — The offer expired before your answer arrived.* At the next refresh,
  A's page shows the registration form again. Her registration has ended; *My registrations* lists
  it under *Past* as *Your registration ended: none of your acceptable sessions could still be
  joined.*
  - If A's click arrives before the timer, A's own command performs the expiry (tick-first). The
    outcome is the same.
- **Expect (Window B):** within a few seconds after 00:00 (refresh if the 10 s auto-refresh has not
  fired yet): *A seat in Session A is held for you — confirm within 00:5x.* **Accept seat** →
  confirmed.
- **Do (Window O, tab 2):** **Refresh**. The **Backfill log** shows *Session A · offer expired ·
  latency ≈ 1–3 s* (released at `expiresAt`, re-allocated when the tick was processed).
- **Say:** "Nobody pressed anything: the seat moved on by itself, in about a second or two."

### D5b (4:30–5:00): exactly-once, proven (terminal + Window O)

At least 120 s must have passed since D5a. If not, do D4 first and come back.

- **Do (Plan A):**
  ```bash
  aws logs filter-log-events --log-group-name /aws/lambda/seatrelay-dev-worker \
    --start-time $(( ($(date +%s) - 900) * 1000 )) --filter-pattern "\"$CMD\"" \
    --query 'events[].message' --output json \
    | jq -r '.[] | (fromjson? // .) | if type == "object" then [.timestamp, .message, (.deliveryAttempt // "" | tostring), (.outcome // "")] | @tsv else . end'
  curl -s "$API/commands/$CMD" -H "authorization: Bearer $TOKEN_C" | jq '{status, settledAt}'
  ```
  The backup is the Logs Insights tab:
  `fields @timestamp, message, deliveryAttempt, outcome | filter @message like "<commandId>" | sort @timestamp asc`.
- **Do (Plan B):**
  ```bash
  docker compose -f services/local/docker-compose.yml logs server --since 10m | grep "$CMD"
  docker exec seatrelay-local-postgres-1 psql -U seatrelay -d seatrelay -c \
    "select id, status, attempts from commands where dedup_id = '$CMD'"
  ```
- **Expect:**
  1. *injected fault; message will be redelivered* (`deliveryAttempt 1`). On local the message
     reads *injected fault after commit; message left for redelivery*.
  2. About 120 s later (local: about 1 s), *command already settled; acknowledging redelivery*.
  3. *convergence pass after a settled redelivery* with outcome `NOOP`.
  4. Local only: the `commands` row has `status DONE` and `attempts 2`.
  5. The command record still shows **APPLIED with the same `settledAt`**.
- **Do (Window O, tab 1):** **Refresh**. Demo 3 appears **once** under *Offered*. *Session 2* shows
  held 2, free 0.
- **Say:** "Delivered twice, applied once. The result and the seat change are one transaction, and
  that transaction only succeeds while the command is still 'accepted'. The second delivery found it
  settled and simply acknowledged it."

### D4 (5:00–5:30): verify invariants (Window O)

- **Do:** On *Demo workshop*, click **Verify invariants**; then on *Expiry demo*.
- **Expect:** *All invariants hold — checked … — C1 no over-capacity, C2 no double holds, and the
  other engine invariants.* *Demo workshop* stats: Queued 0, Offered 4, Confirmed 1, Distinct served
  1, Backfills 1/1. Sessions:

  | Session | Confirmed | Held | Free |
  |---|---|---|---|
  | Session 1 | 1 | 1 | 0 |
  | Session 2 | 0 | 2 | 0 |
  | Session 3 | 0 | 1 | 0 |

- **Say:** "The organiser can check at any time that no session is over capacity and nobody holds two
  seats. Our experiments call the same check after every step. Results next." (Hand over to the
  results speaker.)

---

## 6. Fallback plan

| Level | When | What |
|---|---|---|
| **Plan B: local stack** | Before the slot: AWS health check fails or campus Wi-Fi blocks AWS, but the laptop runs Docker. | Same script against `http://localhost:8081` / `http://localhost:3000`. Seed with `--target local`. The D5 redelivery takes about 1 s, so D5b can follow D5a directly. Mention "this is our on-prem reference deployment, same code". |
| **Plan C: recorded video** | Before the slot: neither A nor B is ready. During the demo: a step has not settled after 15 s, or an error banner appears, or sign-in breaks. | Say "let me show you this step from our recording" and jump to the chapter of the failing beat. Do not debug live. Afterwards, return to the slides. |
| **Plan D: screenshots** | Video playback fails. | Backup slides with one screenshot per expected state (D1–D5 "Expect" lines). |

Recording the video (second rehearsal, 11/12):

- Capture the full screen (1920×1080, 30 fps) with OBS, including narration. Run the whole demo
  block once, without cuts, on dev.
- Export MP4 (H.264, ≤ 200 MB).
- Write down the chapter timestamps: D1, D2, D5a, D3, D5b, D4. Keep the list next to the
  presenter's notes.
- Store three copies: the presenting laptop's desktop, the team drive, a USB stick. Keep the video
  out of git: it is large, and the repository holds the scripts that reproduce it.
- Link it from a hidden backup slide right after the demo slide.

Network fallback: test a phone hotspot during setup. Cognito's hosted UI and the API both work
over it.

---

## 7. Reset (between rehearsals and after the demo)

1. **Expiry demo.** In Window O, on its dashboard: **Cancel workshop** → **Yes, cancel it**. This
   releases A's and B's registrations there.
2. **Re-seed** the main workshop. This cancels the previous *Demo workshop* (the registrations of A,
   B, C and p1–p3 end with `WORKSHOP_CANCELLED`) and creates a fresh one:
   `pnpm --silent --filter @seatrelay/scripts seed-demo -- --target dev --hold 3600 > ~/seatrelay-demo/seed.json`
   (the output lists the old one under `cancelledWorkshops`).
3. Create a new *Expiry demo* with the wizard (section 3, T−20 step 1).
4. In the terminal, re-export `WS`, `S2`, `TOKEN_C` and a **new** `CMD`/`BODY` (section 3, T−20
   step 4). Reusing the old `commandId` would only return the old result; that is C3 at work.
5. Point the browser tabs at the new URLs. Old registrations show under *Past* in *My
   registrations*, which is fine. Mark old notifications read if the badge distracts.
6. Check that the DLQs are empty and that no alarm is in ALARM (section 3, T−30).
7. Plan B full reset: `pnpm local:down && pnpm local:up` (drops the database and re-imports the
   realm). Then redo T−1 day step 2 and section 3 from T−20.

---

## 8. Troubleshooting during the demo

| Symptom | Likely cause | Action (≤ 10 s, otherwise Plan C) |
|---|---|---|
| A status card does not change after the other window acted | auto-refresh runs every 10 s and only while the tab is visible | press F5 in that window |
| "Still processing — the server has your request; we keep checking every 5 s." | worker backlog, or the workshop's group is waiting for the D5 redelivery | if it is *Demo workshop* between D5a and D5b: expected; say so. Otherwise switch to the video |
| Sign-in page appears | token or session expired | sign in again (password manager); if it fails, Plan C |
| `"status": "ACCEPTED"` stays on the D5a poll | queue slow | poll again after 2 s; the redelivery is unaffected |
| D5a returns `"_fault"` silently ignored (settles without a crash, no `deliveryAttempt 1` log line) | stack deployed with `AllowFaultFlags=false` | show the idempotent re-POST only; explain the flag; play the D5 chapter of the video |
| Verify shows a violation | should not happen; possibly `NO_STARVATION` while a continuation is queued | wait 5 s and verify again; if it persists, say so honestly and take a screenshot for the bug report |

---

## Appendix: rehearsal record (local stack, 2026-10-17, API-driven)

The click path was rehearsed against an isolated local server (same code, PostgreSQL, Keycloak). The
browser clicks were replaced by the equivalent API calls, and D5 used the exact commands above.
Observed:

```
D1  REGISTER [S3,S1]  → APPLIED, OFFERED Session 1;  ACCEPT → APPLIED, CONFIRMED
D2  B REGISTER [S1]   → APPLIED, QUEUED position 1;  A CANCEL → APPLIED;  B → OFFERED Session 1
    backfill {"cause":"CANCELLED_CONFIRMED","latencyMs":0};  B ACCEPT → CONFIRMED
D5a {"status":"ACCEPTED"} → {"status":"APPLIED","settledAt":"…38.891Z","registration":"OFFERED"} → re-POST {"status":"APPLIED","settledAt":"…38.891Z"}
D3  A REGISTER [A] → OFFERED;  B REGISTER [A] → QUEUED 1;  A ACCEPT at expiresAt + 0.3 s → REJECTED OFFER_EXPIRED
    B → OFFERED Session A;  backfill {"cause":"EXPIRED","latencyMs":843};  B ACCEPT → CONFIRMED
D5b log: "injected fault after commit; message left for redelivery" (deliveryAttempt 1)
         "command already settled; acknowledging redelivery"
         "convergence pass after a settled redelivery" (outcome NOOP)
    commands row: status DONE, attempts 2;  command record unchanged (APPLIED, same settledAt)
D4  counts {queued 0, offered 4, confirmed 1, backfills 1/1}, distinct served 1;
    Session 1 1/1/0, Session 2 0/2/0, Session 3 0/1/0 (confirmed/held/free);  verify ok on both workshops
```
