# Organiser-track tasks (O1–O4)

Four participants with organiser experience (counterbalance track `organiser`: P03, P06, P09, P12). Each does O1–O4 once in SeatRelay (SR) and once in the control (CTRL), dataset A in one round and B in the other. Cards are tool-neutral; success criteria and the manual-step counts are per tool. Print 8 cards.

Persona: **Riley Tan**, organiser of **NUS Data Club** (`study.riley@example.com` in SeatRelay; the organiser Gmail in the control). The facilitator plays the "other participant" of O2 (Mei Lin Chua in A, Farah Ismail in B) on the facilitator laptop.

Every task: **cap 300 s**. If the pilot shows O1 in the control routinely exceeds the cap, raise O1's cap to 480 s **in both conditions** for all 12 participants and log it.

## 1. Seeded state (reset before every round)

`holdSeconds = 1800`. Sessions in the week of 16 Nov 2026 (cut-off never reached during the study).

### Dataset A — W3-A "Excel Power Tools"

| Session | Capacity | Confirmed (SR) | Control tab rows in timestamp order (Status) |
|---|---|---|---|
| S1 Mon 16 Nov 10:00–11:30 | 3 | Mei Lin Chua, Ravi Shankar, Tom Becker | Mei Lin Chua (CONFIRMED), Ravi Shankar (CONFIRMED), Tom Becker (CONFIRMED), Hui Min Teo (WAITLIST), Yusuf Ali (WAITLIST) |
| S2 Tue 17 Nov 14:00–15:30 | 3 | Alicia Fernandez, Ben Carter, Zoe Lau | Alicia Fernandez (CONFIRMED), **Ravi Shankar (CONFIRMED — duplicate, also holds S1)**, Ben Carter (CONFIRMED), Zoe Lau (WAITLIST), Yusuf Ali (WAITLIST) |
| S3 Wed 18 Nov 16:00–17:30 | 3 | Nadia Rahman, Kai Zhang, Olivia Park | Nadia Rahman (CONFIRMED), Kai Zhang (CONFIRMED), Olivia Park (CONFIRMED), Samuel Goh (WAITLIST) |
| Queue (SR, seq order) | | 1. Hui Min Teo — S1 · 2. Yusuf Ali — S1, S2 · 3. Samuel Goh — S3 | |

Control A totals: 14 rows, 12 distinct e-mails, 9 CONFIRMED rows = **8 distinct confirmed people** (Ravi twice). SR A: 9 confirmed distinct, 3 queued.

O1-A spec (new workshop): **Intro to Figma** — S1 Mon 23 Nov 14:00–15:30, 10 seats · S2 Wed 25 Nov 14:00–15:30, 10 seats · S3 Fri 27 Nov 10:00–11:30, 8 seats · hold 15 min.

### Dataset B — W3-B "Public Speaking Lab"

| Session | Capacity | Confirmed (SR) | Control tab rows in timestamp order (Status) |
|---|---|---|---|
| S1 Tue 17 Nov 09:00–10:30 | 3 | Farah Ismail, Gopal Krishnan, Hana Sato | Farah Ismail (CONFIRMED), Gopal Krishnan (CONFIRMED), Hana Sato (CONFIRMED), Oscar Lee (WAITLIST), Petra Novak (WAITLIST) |
| S2 Thu 19 Nov 13:00–14:30 | 3 | Ivy Lim, Jonas Weber, Kiran Desai | Ivy Lim (CONFIRMED), **Gopal Krishnan (CONFIRMED — duplicate)**, Jonas Weber (CONFIRMED), Kiran Desai (WAITLIST), Petra Novak (WAITLIST) |
| S3 Fri 20 Nov 15:00–16:30 | 3 | Lily Zhou, Mateo Rossi, Nur Aisyah | Lily Zhou (CONFIRMED), Mateo Rossi (CONFIRMED), Nur Aisyah (CONFIRMED), Quentin Tay (WAITLIST), Rania Said (WAITLIST) |
| Queue (SR, seq order) | | 1. Oscar Lee — S1 · 2. Petra Novak — S1, S2 · 3. Quentin Tay — S3 · 4. Rania Said — S3 | |

Control B totals: 15 rows, 13 distinct e-mails, 9 CONFIRMED rows = **8 distinct confirmed** (Gopal twice). SR B: 9 confirmed distinct, 4 queued.

O1-B spec: **LaTeX for Theses** — S1 Tue 24 Nov 10:00–11:30, 12 seats · S2 Thu 26 Nov 16:00–17:30, 12 seats · S3 Sat 28 Nov 10:00–11:30, 6 seats · hold 15 min.

### Reset

- SeatRelay: `pnpm --filter @seatrelay/scripts seed-study -- --track organiser --dataset A|B --stage dev` (plan step 14): recreate W3 exactly as above, delete any workshop created by the previous participant in NUS Data Club, re-register the cancelled participant (Mei Lin / Farah).
- Control: `control-condition-setup.md` §6 (restore the named version "SEED", trash the forms/sheet created in O1, delete e-mails and drafts).

## 2. Task cards

### O1 — Create a 3-session workshop

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario (read aloud)** | "You are Riley Tan from NUS Data Club. Set up sign-ups for a new workshop, **Intro to Figma**, with three sessions: Monday 23 November 14:00–15:30 with 10 seats, Wednesday 25 November 14:00–15:30 with 10 seats, and Friday 27 November 10:00–11:30 with 8 seats. People should be able to sign up for any of the three. Say 'done' when sign-ups could be opened." *(hand over the card; the dates are printed on it)* | "…**LaTeX for Theses**, three sessions: Tuesday 24 November 10:00–11:30 with 12 seats, Thursday 26 November 16:00–17:30 with 12 seats, and Saturday 28 November 10:00–11:30 with 6 seats…" |
| **Success — SR** | A workshop with the exact title exists under NUS Data Club with 3 sessions whose day, start time and capacity match the card; status OPEN. Hold time left at the default is fine. One wrong capacity/time → `0`. | same |
| **Success — CTRL** | Three Google Forms exist (copies of the template) whose title or description names the workshop, the session day/time and the seat count; each has the Name and Email fields; all three are linked to **one** spreadsheet (3 response tabs). Forms not linked, or linked to three separate sheets → `0` (the organiser could not run the sheet). | same |
| **Expected minimal manual steps** | SR: open organiser area → New workshop → title → add session ×3 (day, time, capacity) → create = **≈ 6–8** | CTRL: copy template ×3 (3) → rename/edit each (3) → link responses: create sheet (1) + select existing (2) → check tabs (1) = **≈ 10–12** |
| **Max time** | 300 s (see cap note above) | same |
| **Observe** | SR: is "add session" obvious; date/time picker trouble; do they look for a hold-time setting. CTRL: do they build forms from scratch instead of copying; do they forget to link responses; do they create three sheets. | same |

### O2 — Process a cancellation and see the backfill

Facilitator script, both tools: read the card; the moment the stopwatch starts, nothing else. **SR:** when the participant says what Mei Lin / Farah must do (or asks whether she can cancel herself, or after 60 s of searching for a "remove" button), the facilitator says "Mei Lin has just cancelled in SeatRelay" and clicks *Cancel registration* on the facilitator laptop (logged in as her). The participant then reads the dashboard. **CTRL:** the facilitator has already sent the cancellation e-mail to the organiser inbox before reading the card (`control-condition-setup.md` §4.3).

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "**Mei Lin Chua** has a seat in the Monday session of **Excel Power Tools**. She has just told you she cannot attend. Make sure her seat is freed and given to the right next person in line, and tell me who gets it. If the person herself has to do something in the system, tell me what and I will do it as Mei Lin. Say 'done' when the seat has been passed on." | "**Farah Ismail** has a seat in the Tuesday session of **Public Speaking Lab**. She has just told you she cannot attend. …as Farah…" |
| **Success — SR** | Participant states **Hui Min Teo** got the Monday seat (dashboard: S1 shows 1 held/offered, backfill log shows EXPIRED/CANCELLED → re-offered to Hui Min with latency; queue shrinks to Yusuf, Samuel). Naming Yusuf → `0`. | **Oscar Lee** gets Tuesday; queue → Petra, Quentin, Rania. |
| **Success — CTRL** | All of: Mei Lin's S1 row marked CANCELLED (or deleted); **Hui Min Teo** identified as next (first WAITLIST row of S1 by timestamp) and offered: an e-mail **sent** (or saved as draft — accept both, note which) to her address naming the Monday session and a deadline; her row marked OFFERED (or CONFIRMED — note which). Offering Yusuf → `0`. Offering Hui Min without checking the S2 tab is still `1` (she is not confirmed elsewhere) — note whether the duplicate check happened. | Farah → CANCELLED; **Oscar Lee** offered Tuesday; Petra → `0`. |
| **Expected minimal manual steps** | SR: tell Mei Lin to cancel (1) → open dashboard / refresh (1) → read = **≈ 2** | CTRL: open S1 tab (1) → mark Mei Lin CANCELLED (1) → find first WAITLIST (read) → check Summary duplicates / other tabs (1–2) → open Gmail, compose offer with deadline (2) → mark Hui Min OFFERED + note (1) = **≈ 6–7** |
| **Max time** | 300 s | same |
| **Observe** | SR: do they look for a "remove participant" button first (log the seconds spent); do they find the backfill log; do they understand "held" vs "confirmed" for Hui Min; do they notice the latency figure. CTRL: do they pick the next person by timestamp or by row order after sorting; do they check the duplicate flag; do they set a deadline; do they update the Status board. | same |

### O3 — Read backfill results / queue

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "Two questions about **Excel Power Tools**: (a) how many people are waiting for a seat in the **Wednesday** session right now? (b) who is first in line for Wednesday? Say both answers out loud." | "…**Public Speaking Lab**: (a) …**Friday** session… (b) who is first in line for Friday?" |
| **Expected — SR** | (a) **1** (Samuel Goh is the only queued registration accepting S3; Hui Min is OFFERED on S1, Yusuf accepts S1/S2 only). (b) **Samuel Goh**. | (a) **2** (Quentin, Rania). (b) **Quentin Tay**. |
| **Expected — CTRL** | (a) **1** (S3 tab: Samuel Goh WAITLIST). (b) **Samuel Goh**. | (a) **2**. (b) **Quentin Tay** (earlier timestamp than Rania). |
| **Success** | Both correct in the final answer. | same |
| **Expected minimal manual steps** | SR: open dashboard (1) → read session row / queue list = **1** | CTRL: open S3 tab or Summary (1) → read/sort (0–1) = **1–2** |
| **Max time** | 300 s (expected SR ≈ 20–45 s, CTRL ≈ 30–90 s) | same |
| **Observe** | SR: do they use the per-session queue count or count the queue list by hand; do they also read the backfill latency (ask in I3). CTRL: do they count only WAITLIST rows or all rows beyond capacity; do they use the Summary tab. | same |

### O4 — Distinct participant count and CSV export

| | Dataset A | Dataset B |
|---|---|---|
| **Scenario** | "For **Excel Power Tools**: (a) how many **different people** currently have a confirmed seat, counting each person once even if they appear in more than one session? Say the number. (b) Then export the full registration list — all sessions — as a CSV file. Say 'done' when the file is on the laptop." | same with **Public Speaking Lab** |
| **Expected — SR** | (a) **8** (dashboard "distinct participants"; after O2: Ravi, Tom, Alicia, Ben, Zoe, Nadia, Kai, Olivia confirmed; Hui Min only held) — **dry run must confirm whether the dashboard counts held seats; if it shows 9, the key is 9**. (b) Export CSV button → one file downloaded. | (a) **8** (Gopal, Hana, Ivy, Jonas, Kiran, Lily, Mateo, Nur; Oscar held), or 9 if held counted. (b) one CSV. |
| **Expected — CTRL** | (a) The value shown in Summary cell "Distinct confirmed people" **at that moment** (seeded value 8; 7 if the participant marked Mei Lin CANCELLED and Hui Min OFFERED in O2; 8 if Hui Min CONFIRMED). Facilitator reads the cell and writes both the cell value and the answer into `notes`. Reading the row count (9 or 14) → `0`. (b) CSV files containing all three tabs' rows: either three downloads (File → Download → CSV, per tab) or one combined tab downloaded. | same (seeded 8; 7/8 after O2). |
| **Success** | (a) and (b) both. | same |
| **Expected minimal manual steps** | SR: read dashboard (0) → Export CSV (1) = **1** | CTRL: open Summary (1) → read; Download per tab (3 × 2 clicks = 3 steps) or build combined tab (≥ 3) = **≈ 4–6** |
| **Max time** | 300 s (expected SR ≈ 15–40 s, CTRL ≈ 60–180 s) | same |
| **Observe** | SR: do they trust the number or recount; is Export discoverable. CTRL: do they find/trust the Summary formula or count by eye (and miscount Ravi/Gopal); do they realise CSV export is per tab. | same |

## 3. Answer key summary (facilitator copy)

| Task | SR-A | SR-B | CTRL-A | CTRL-B |
|---|---|---|---|---|
| O1 | Intro to Figma, 3 sessions (10/10/8) | LaTeX for Theses (12/12/6) | 3 forms + 1 sheet, 3 tabs | same |
| O2 | Hui Min Teo gets Mon | Oscar Lee gets Tue | Mei Lin CANCELLED; Hui Min offered Mon | Farah CANCELLED; Oscar offered Tue |
| O3 | (a) 1 (b) Samuel Goh | (a) 2 (b) Quentin Tay | (a) 1 (b) Samuel Goh | (a) 2 (b) Quentin Tay |
| O4 | (a) 8 (or 9 if held counted — dry run) (b) 1 CSV | same | (a) Summary cell value (b) 3 CSVs or 1 combined | same |

## 4. Control: the exact manual procedure the organiser is expected to discover

This is what "process a cancellation" means in the Forms + Sheet world, and what `manual_steps` counts against. It is **not** shown to the participant.

| Step | Action in the control Sheet / Gmail |
|---|---|
| 1 | Open the tab of the cancelled session (`S1`). Find the person's row (Ctrl-F on the name). |
| 2 | Set `Status` = `CANCELLED` (column D). Do not delete the row — the published Status board uses row order. |
| 3 | Identify the next person: the first row with `Status` = `WAITLIST` in timestamp order (column A). |
| 4 | Check the `Summary` tab block "Duplicate submitters": if the next person already has `CONFIRMED` in another tab, skip to the following WAITLIST row. |
| 5 | In Gmail, compose to that person: session day/time, "reply CONFIRM by <deadline>", send (or save draft). |
| 6 | Set that person's `Status` = `OFFERED`, write the deadline in `Note` (column E). |
| 7 | (If asked for the count) `Summary` → "Distinct confirmed people" = `COUNTA(UNIQUE(...))` over CONFIRMED rows of all tabs (`control-condition-setup.md` §3). |
| 8 | (Export) File → Download → Comma-separated values, once per tab, or paste the tabs into one "All" tab first. |
