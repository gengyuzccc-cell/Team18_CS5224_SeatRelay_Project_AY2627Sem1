# Participant-track tasks (T1–T5)

Eight participants (counterbalance track `participant`). Each does T1–T5 once in SeatRelay (SR) and once in the control (CTRL, one Google Form per session + Sheet), with dataset A in one round and dataset B in the other (`counterbalance.csv`). **Task cards are tool-neutral**: the same card is read in both conditions for a given dataset; only the success criterion depends on the tool. Print one card per task per dataset (10 cards).

Persona in both tools: **Jordan Lee** (`study.jordan@example.com` in SeatRelay; the persona Gmail in the control — write the real address in the study log, not here).

Every task: **cap 300 s** (`protocol.md` §6.1). "Expected" columns are what the dry run on 10/28 must confirm; correct them on the printed answer key if the UI shows something else, and log it.

## 1. Seeded state (reset to this before every round)

Hold time for every study workshop: `holdSeconds = 1800` (30 min), so a held seat survives the 12-minute round even with time caps. All sessions are 90 min; cut-off is 30 min before start, far outside the study week.

### Dataset A

| Workshop | Session | Capacity | Confirmed | Free |
|---|---|---|---|---|
| **W1-A — Data Visualisation Basics** | S1 Mon 16 Nov 2026 10:00–11:30 | 2 | Aiden Tan, Priya Nair | 0 |
| | S2 Tue 17 Nov 14:00–15:30 | 2 | Marcus Lim | **1** |
| | S3 Wed 18 Nov 16:00–17:30 | 2 | Chloe Wong, Daniel Koh | 0 |
| Queue W1-A | — | | (empty) | |
| **W2-A — Git Basics** | S1 Thu 19 Nov 10:00–11:30 | 3 | Ethan Ng, Grace Yeo, Hafiz Rahman | 0 |
| | S2 Fri 20 Nov 14:00–15:30 | 3 | Isabel Cruz, Jun Hao Tan, Kavya Menon | 0 |
| | S3 Sat 21 Nov 10:00–11:30 | 3 | Leon Mueller, Natalie Pang, Omar Haddad | 0 |
| Queue W2-A (seq order) | 1. Wei Jie Ong — acceptable Thu, Fri · 2. Sara Ahmed — acceptable Thu, Sat | | | |

Control A: the same people are rows in the response tabs; the Thursday waitlist of Git Basics is Wei Jie Ong, Sara Ahmed (in that order); Friday waitlist Wei Jie Ong; Saturday waitlist Sara Ahmed. Form descriptions show "FULL — submitting puts you on the waitlist" for every full session and "1 seat left" for Tuesday of Data Visualisation Basics. Exact rows: `control-condition-setup.md` §5.

### Dataset B

| Workshop | Session | Capacity | Confirmed | Free |
|---|---|---|---|---|
| **W1-B — Resume Clinic** | S1 Tue 17 Nov 2026 11:00–12:30 | 2 | Bella Chen, Carl Ong | 0 |
| | S2 Thu 19 Nov 15:00–16:30 | 2 | Devi Pillai, Elliot Low | 0 |
| | S3 Fri 20 Nov 10:00–11:30 | 2 | Fiona Goh | **1** |
| Queue W1-B | — | | (empty) | |
| **W2-B — Python for Data Analysis** | S1 Mon 16 Nov 09:00–10:30 | 3 | Hannah Lim, Ivan Petrov, Jia Yi Wong | 0 |
| | S2 Wed 18 Nov 13:00–14:30 | 3 | Karthik Raj, Lucas Tan, Maya Singh | 0 |
| | S3 Thu 19 Nov 17:00–18:30 | 3 | Noah Koh, Olivia Chan, Pavel Novak | 0 |
| Queue W2-B (seq order) | 1. Qi Ling Teo — Mon, Wed · 2. Rafael Santos — Mon · 3. Siti Nurul — Mon, Thu | | | |

Control B: Monday waitlist of Python for Data Analysis = Qi Ling Teo, Rafael Santos, Siti Nurul; Wednesday waitlist = Qi Ling Teo; Thursday waitlist = Siti Nurul. "1 seat left" on Friday of Resume Clinic.

Jordan Lee has **no** registration, no form submission, no e-mail at reset.

### Reset

- SeatRelay: `pnpm --filter @seatrelay/scripts seed-study -- --track participant --dataset A|B --stage dev` (deliverable of plan step 14; it must delete the two workshops and recreate exactly the tables above, and remove any registration of the persona). Until the script exists: cancel Jordan's registrations, then re-create the state by hand and tick it against the table.
- Control: `control-condition-setup.md` §6.

## 2. Task cards

Read the scenario verbatim. Then start the stopwatch.

### T1 — Choose acceptable sessions in preference order

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario (read aloud)** | "You are Jordan Lee. You want to attend the workshop **Data Visualisation Basics**. You can make the **Tuesday** session or the **Wednesday** session, but **not Monday**. You would prefer **Wednesday**. Sign up so that you get a seat in a session you can attend, with Wednesday as your first choice if possible. Say 'done' when you have signed up." | "You are Jordan Lee. You want to attend the workshop **Resume Clinic**. You can make the **Thursday** session or the **Friday** session, but **not Tuesday**. You would prefer **Thursday**. Sign up so that you get a seat in a session you can attend, with Thursday as your first choice if possible. Say 'done' when you have signed up." |
| **Success — SR** | Registration for W1-A exists with acceptable sessions = {Wed, Tue}, **Wed ranked first**; status card shows a held seat (OFFERED) for **Tue 17 Nov 14:00** with a countdown. Wrong order, Monday ticked, or only one session ticked → `0`. | Same with W1-B: acceptable = {Thu, Fri}, Thu first; OFFERED **Fri 20 Nov 10:00**. |
| **Success — CTRL** | A submission by Jordan Lee exists in the **Tuesday** form (the only acceptable session with a seat) and **none** in the Monday form. A submission in the Wednesday form (waitlist) is allowed — record `duplicate` in `notes`, not an error. | Submission in the **Friday** form, none in Tuesday; Thursday waitlist submission allowed (`duplicate` in notes). |
| **Max time** | 300 s (expected SR ≈ 60–90 s, CTRL ≈ 90–180 s) | same |
| **Observe** | SR: do they find the preference-ordering control; do they read the result ("held for you… confirm within…") or just see "submitted"? CTRL: do they open the Monday form (error); do they notice "FULL"/"1 seat left" in the description; do they submit two or three forms; do they look for a way to express preference. | same |

### T2 — Join the waitlist

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "You also want to attend **Git Basics**. You can make **Thursday** or **Saturday**, but **not Friday**; Thursday is your first choice. All sessions are currently full. Make sure you are in line for a seat in Thursday or Saturday if one frees up. Say 'done' when you are in line." | "You also want to attend **Python for Data Analysis**. You can make **Monday** or **Wednesday**, but **not Thursday**; Monday is your first choice. All sessions are currently full. Make sure you are in line for a seat in Monday or Wednesday if one frees up. Say 'done' when you are in line." |
| **Success — SR** | Registration for W2-A with acceptable = {Thu, Sat}, Thu first; status **QUEUED, position 3**. Friday ticked → `0`. Only one session ticked → `0` (not in line for both). | W2-B: acceptable = {Mon, Wed}, Mon first; **QUEUED, position 4**. |
| **Success — CTRL** | Submissions by Jordan Lee in **both** the Thursday and the Saturday form of Git Basics; none in Friday. Only one of the two → `0`, note which. | Both Monday and Wednesday forms; none in Thursday. |
| **Max time** | 300 s (expected SR ≈ 45–75 s, CTRL ≈ 90–180 s) | same |
| **Observe** | SR: do they realise they are queued, not seated; do they look for the position? CTRL: do they hesitate to submit a form marked FULL; do they submit the third form "to be safe" (error, `duplicate`); do they ask how they will be told. | same |

### T3 — Interpret the status page

Control only: the "seat held" e-mail (`control-condition-setup.md` §4.2) must be in the persona inbox before this card is read (sent after T1).

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "Without changing anything, find out and tell me: (a) for **Git Basics**, what is your position in the line? (b) for **Data Visualisation Basics**, which session has been held for you, and how long do you have to confirm it? Say both answers out loud." | "Without changing anything, find out and tell me: (a) for **Python for Data Analysis**, what is your position in the line? (b) for **Resume Clinic**, which session has been held for you, and how long do you have to confirm it? Say both answers out loud." |
| **Expected — SR** | (a) **3** (My registrations → Git Basics card "Queued, position 3"). (b) **Tue 17 Nov 14:00**, "about N minutes" where N = the countdown shown (accept ± 2 min; 30 min minus time since T1). | (a) **4**. (b) **Fri 20 Nov 10:00**, countdown ± 2 min. |
| **Expected — CTRL** | (a) **3rd on the Thursday waitlist** (status board; "3rd for Thursday, 2nd for Saturday" also correct). (b) **Tue 17 Nov 14:00; reply by 18:00 today** (from the e-mail). | (a) **4th on the Monday waitlist** ("2nd for Wednesday" additionally fine). (b) **Fri 20 Nov 10:00; reply by 18:00 today**. |
| **Success** | Both (a) and (b) correct in the final answer. One wrong → `0`. A wrong answer corrected before "done" → error, still `1`. | same |
| **Max time** | 300 s (expected SR ≈ 30–60 s, CTRL ≈ 60–150 s) | same |
| **Observe** | SR: where do they look first (My registrations, notifications, workshop page); do they misread "held" as "confirmed"; do they understand the countdown unit. CTRL: do they find the status board link (announcement, form confirmation text); do they count the waitlist correctly; do they find the e-mail. | same |

### T4 — Confirm a held seat

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "Confirm that you will take the seat that is held for you in **Data Visualisation Basics**. Say 'done' when you are sure the seat is yours." | "Confirm that you will take the seat that is held for you in **Resume Clinic**. Say 'done' when you are sure the seat is yours." |
| **Success — SR** | W1-A registration status **CONFIRMED, Tue 17 Nov 14:00** (Accept clicked, settlement shown). Declined, or "done" while still OFFERED → `0`. | W1-B CONFIRMED, Fri 20 Nov 10:00. |
| **Success — CTRL** | A reply to the "seat held" e-mail **sent** to the organiser address whose text confirms the seat (e.g. "CONFIRM"). Facilitator checks the organiser inbox. A reply saved as draft but not sent → `0`. | same |
| **Max time** | 300 s (expected SR ≈ 10–30 s, CTRL ≈ 30–90 s) | same |
| **Observe** | SR: Accept vs Decline confusion; do they wait for the "confirmed" state before saying done? CTRL: do they reply or try to submit a form again (error)? | same |

### T5 — Cancel

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "Your plans have changed: you can no longer attend **Data Visualisation Basics** at all. Give up your seat so that someone else can have it. Say 'done'." | "Your plans have changed: you can no longer attend **Resume Clinic** at all. Give up your seat so that someone else can have it. Say 'done'." |
| **Success — SR** | W1-A registration status **CANCELLED** (Cancel + confirmation dialog). The W1-A page then keeps a **Cancelled** status card: *You gave up your confirmed seat in ‹Tuesday session› at ‹time›; it is free again for the next person waiting, if there is one.* (true here: the W1 queue is empty, so nobody receives it) with *You can register again; you will join the end of the queue.* and a **Register again** button (the empty registration form does not come back by itself). Cancelling Git Basics instead → `0` (wrong action). Clicking **Register again** and re-registering → `0` (the seat is no longer given up). | W1-B CANCELLED; the card names the Friday session. |
| **Success — CTRL** | An e-mail **sent** to the organiser address that identifies Jordan Lee and the Tuesday session (or the workshop) and asks to cancel. Submitting any form → error. Saying "done" without sending anything → `0`. | Friday session / Resume Clinic. |
| **Max time** | 300 s (expected SR ≈ 15–40 s, CTRL ≈ 45–120 s) | same |
| **Observe** | SR: is Cancel discoverable; do they read the *Cancelled* card ("free again for the next person waiting, if there is one") and take it as confirmation, or look elsewhere (My registrations → Past reads *cancelled: you gave up your seat in ‹session›*); any fear of cancelling the wrong workshop. CTRL: do they know whom to e-mail (address is in the announcement and in the form description); do they try to delete their form response. | same |

## 3. Answer key summary (facilitator copy)

| Task | SR-A | SR-B | CTRL-A | CTRL-B |
|---|---|---|---|---|
| T1 | acceptable Wed > Tue; OFFERED Tue 17 Nov 14:00 | acceptable Thu > Fri; OFFERED Fri 20 Nov 10:00 | Tue form submitted; no Mon | Fri form submitted; no Tue |
| T2 | acceptable Thu > Sat; QUEUED #3 | acceptable Mon > Wed; QUEUED #4 | Thu + Sat forms | Mon + Wed forms |
| T3 | (a) 3 (b) Tue 14:00, countdown | (a) 4 (b) Fri 10:00, countdown | (a) 3rd Thu (b) Tue 14:00 by 18:00 | (a) 4th Mon (b) Fri 10:00 by 18:00 |
| T4 | CONFIRMED Tue | CONFIRMED Fri | reply sent | reply sent |
| T5 | CANCELLED (W1) | CANCELLED (W1) | cancel e-mail sent | cancel e-mail sent |

After T5 in SR the freed seat has no queue behind it (W1 queue is empty), so nothing else changes — this keeps the reset simple.

## 4. Known fragilities

| Risk | Handling |
|---|---|
| Hold expires before T4 (T1–T3 took > 30 min) | Cannot normally happen (12-min round); if it does: T4 `success = 0`, `time_s` empty, `notes = "offer expired before T4"`; T5 is then run on the Git Basics / Python queue entry instead and noted. What the participant sees: the W1 card goes back to **Queued** for the first-choice session (Wed / Thu), and the notification reads *Your hold on a seat in "‹Tuesday / Friday session›" (starts ‹Tue 17 Nov 2026, 14:00 SGT› / ‹Fri 20 Nov 2026, 10:00 SGT›) … expired at ‹… SGT› because it was not accepted in time, … You keep your place in the queue for the other sessions you chose.* (notification and e-mail times are Singapore time). |
| Participant submits the SR registration without ordering (default order) and the default happens to be right | Still `1` — the UI's default is part of the tool. Note "default order" in `notes`. |
| Control status board shows a stale value (Sheets recalculation lag) | Refresh the tab; if still wrong, stop the stopwatch, note "tool lag", resume. |
| Persona Gmail shows the e-mail in "Promotions" or spam | Dry-run check; whitelist the organiser address beforehand. |
