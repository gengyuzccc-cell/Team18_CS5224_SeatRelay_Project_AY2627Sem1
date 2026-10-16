# Control condition: one Google Form per session + one Google Sheet

Build once (≈ 2–3 h), reset between participants (§6). Everything lives in a study-only Google account; no real e-mail addresses other than the two study accounts appear anywhere.

## 1. Accounts and artefacts

| Item | Purpose | Notes |
|---|---|---|
| **Organiser Google account** (team-created, e.g. `seatrelay.study.organiser@gmail.com`) | Owns all forms, sheets, the announcement doc; is "Riley Tan, NUS Data Club"; sends the seat-held e-mails; receives cancellations | Enable Gmail Templates (Settings → See all settings → Advanced → Templates) and store the §4 texts as templates |
| **Persona Google account** (e.g. `seatrelay.study.jordan@gmail.com`) | "Jordan Lee": fills forms, receives the seat-held e-mail, replies, sends the cancellation | Signed in on the participant laptop in the control bookmark folder |
| Template form `Workshop sign-up TEMPLATE` | Copied by organiser-track participants in O1 | Title "Workshop sign-up TEMPLATE", description "<session day, time, seats>", questions: **Name** (short answer, required), **Email** (short answer, required, response validation → Text → Email address) |
| Dataset **A** participant set | 6 forms + sheet `CTRL-A participant` + doc `[A] NUS Data Club — workshop announcements` | §2, §5 |
| Dataset **B** participant set | 6 forms + sheet `CTRL-B participant` + doc `[B] …` | |
| Dataset **A** organiser set | 3 forms + sheet `CTRL-A organiser` | §3, §5 |
| Dataset **B** organiser set | 3 forms + sheet `CTRL-B organiser` | |

Real addresses go into `results/user-study/study-log.md`, never into this file.

## 2. Forms (18 in total: 6 + 6 + 3 + 3)

Make each by **File → Make a copy** of the template, then edit:

| Setting | Value |
|---|---|
| Title | `<Workshop> — <Day d Mon HH:MM>` e.g. `Data Visualisation Basics — Tue 17 Nov 14:00` (prefix `[A]`/`[B]` only in the Drive file name, not in the title shown to participants) |
| Description | Line 1: `Tue 17 Nov 2026, 14:00–15:30, COM1-02-01. 2 seats.` Line 2 (**static during the study**, mirrors an organiser who updates it by hand): either `STATUS: 1 seat left.` or `STATUS: FULL — submitting this form puts you on the waitlist for this session, in order of submission.` Line 3: `To cancel, e-mail <organiser address> with your name and session.` |
| Questions | Name (short answer, required) · Email (short answer, required, validation = email) — nothing else |
| Settings → Responses | *Collect email addresses*: **off** (we want the typed column C) · *Limit to 1 response*: **off** · *Allow response editing*: **off** · Accepting responses: **on** |
| Settings → Presentation | Confirmation message: `Thanks! Seats are given in order of submission. See the live status board: <status board link>. If a seat is held for you, we will e-mail you.` · *Show link to submit another response*: off |
| Responses → Link to Sheets | First form of a set: *Create a new spreadsheet* named `CTRL-A participant` (or `… organiser`). Every other form of the set: *Select existing spreadsheet* → that sheet. Rename the new tab immediately (§3). |

Status lines per form:

| Set | Form | STATUS line |
|---|---|---|
| A participant | Data Visualisation Basics Mon / Tue / Wed | FULL / **1 seat left** / FULL |
| A participant | Git Basics Thu / Fri / Sat | FULL / FULL / FULL |
| B participant | Resume Clinic Tue / Thu / Fri | FULL / FULL / **1 seat left** |
| B participant | Python for Data Analysis Mon / Wed / Thu | FULL / FULL / FULL |
| A organiser | Excel Power Tools Mon / Tue / Wed | FULL / FULL / FULL |
| B organiser | Public Speaking Lab Tue / Thu / Fri | FULL / FULL / FULL |

## 3. Sheets

Forms write columns **A Timestamp, B Name, C Email** and never touch other columns. Add **D Status** and **E Note** (header row 1) to every response tab of the *organiser* sheets. Participant sheets have no Status column (seat/waitlist is derived from submission order).

### 3.1 Tab names

| Sheet | Response tabs (rename `Form Responses n` to) | Extra tabs |
|---|---|---|
| `CTRL-A participant` | `W1-S1` (DV Mon), `W1-S2` (DV Tue), `W1-S3` (DV Wed), `W2-S1` (Git Thu), `W2-S2` (Git Fri), `W2-S3` (Git Sat) | `Status board` |
| `CTRL-B participant` | `W1-S1` (RC Tue), `W1-S2` (RC Thu), `W1-S3` (RC Fri), `W2-S1` (Py Mon), `W2-S2` (Py Wed), `W2-S3` (Py Thu) | `Status board` |
| `CTRL-A organiser` | `S1` (Mon), `S2` (Tue), `S3` (Wed) | `Summary` |
| `CTRL-B organiser` | `S1` (Tue), `S2` (Thu), `S3` (Fri) | `Summary` |

Formulas below use these names; a wrong tab name shows `#REF!`.

### 3.2 `Status board` tab (participant sheets) — what Jordan sees

Share the spreadsheet **Anyone with the link → Viewer**, hide the six response tabs (right-click → Hide sheet; viewers cannot unhide), and bookmark the sheet URL with `#gid=<Status board gid>` on the participant laptop. (Do not use *Publish to the web*: it refreshes with a delay of minutes.)

| | A | B | C | D | E |
|---|---|---|---|---|---|
| 1 | Session | Capacity | Seats left | Confirmed (in order of submission) | Waitlist (in order of submission) |
| 2 | Data Visualisation Basics — Mon 16 Nov 10:00 | 2 | `=MAX(0,B2-COUNTA('W1-S1'!C2:C))` | `=IFERROR(JOIN(", ",QUERY('W1-S1'!A2:C,"select B where C <> '' order by A limit "&B2,0)),"")` | `=IFERROR(JOIN(", ",QUERY('W1-S1'!A2:C,"select B where C <> '' order by A offset "&B2,0)),"")` |
| 3 | … — Tue 17 Nov 14:00 | 2 | same with `'W1-S2'` | | |
| 4 | … — Wed 18 Nov 16:00 | 2 | `'W1-S3'` | | |
| 5 | Git Basics — Thu 19 Nov 10:00 | 3 | `'W2-S1'` | | |
| 6 | … — Fri 20 Nov 14:00 | 3 | `'W2-S2'` | | |
| 7 | … — Sat 21 Nov 10:00 | 3 | `'W2-S3'` | | |
| 9 | *Note shown to viewers:* "Seats are given in order of submission. Position on a waitlist = your place in column E, counted from the left." | | | | |

Dataset B: same layout with the B session names/capacities.

### 3.3 `Summary` tab (organiser sheets)

Rows 1–5: per-session counts.

| | A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|---|
| 1 | Session | Capacity | Submissions | Confirmed | Offered | Waitlist | Cancelled | Seats free |
| 2 | S1 — Mon 16 Nov 10:00 | 3 | `=COUNTA(S1!C2:C)` | `=COUNTIF(S1!D2:D,"CONFIRMED")` | `=COUNTIF(S1!D2:D,"OFFERED")` | `=COUNTIF(S1!D2:D,"WAITLIST")` | `=COUNTIF(S1!D2:D,"CANCELLED")` | `=B2-D2-E2` |
| 3 | S2 — Tue 17 Nov 14:00 | 3 | `S2!` … | | | | | `=B3-D3-E3` |
| 4 | S3 — Wed 18 Nov 16:00 | 3 | `S3!` … | | | | | `=B4-D4-E4` |
| 5 | Total | `=SUM(B2:B4)` | `=SUM(C2:C4)` | `=SUM(D2:D4)` | `=SUM(E2:E4)` | `=SUM(F2:F4)` | `=SUM(G2:G4)` | `=SUM(H2:H4)` |

Rows 7–10: distinct counts (the numbers O4 asks for).

| Cell | Label (A) | Formula (B) |
|---|---|---|
| 7 | Distinct submitters (each e-mail once) | `=IFERROR(COUNTA(UNIQUE(ARRAYFORMULA(LOWER(TRIM(QUERY({S1!C2:C;S2!C2:C;S3!C2:C},"select Col1 where Col1 <> ''",0)))))),0)` |
| 8 | **Distinct confirmed people** (each e-mail once, Status = CONFIRMED) | `=IFERROR(COUNTA(UNIQUE(ARRAYFORMULA(LOWER(TRIM(QUERY({S1!C2:D;S2!C2:D;S3!C2:D},"select Col1 where Col2 = 'CONFIRMED'",0)))))),0)` |
| 9 | Confirmed rows (not people) | `=D5` |
| 10 | Distinct people waiting (Status = WAITLIST) | same as row 8 with `'WAITLIST'` |

Rows 12–20: duplicate detection.

| Cell | Label | Formula |
|---|---|---|
| A12 | Duplicate submitters (e-mail, number of forms) | |
| A13 | | `=IFERROR(QUERY(QUERY({S1!C2:C;S2!C2:C;S3!C2:C},"select lower(Col1), count(Col1) where Col1 <> '' group by lower(Col1) label lower(Col1) 'email', count(Col1) 'forms'",0),"select * where Col2 > 1",1),"none")` |
| D12 | People holding more than one CONFIRMED seat | |
| D13 | | `=IFERROR(QUERY(QUERY({S1!C2:D;S2!C2:D;S3!C2:D},"select lower(Col1), count(Col1) where Col2 = 'CONFIRMED' group by lower(Col1) label lower(Col1) 'email', count(Col1) 'seats'",0),"select * where Col2 > 1",1),"none")` |

Rows 22+: waitlists in order (one block per session, side by side).

| Cell | Formula |
|---|---|
| A22 | `S1 waitlist (next in line first)` |
| A23 | `=IFERROR(QUERY(S1!A2:E,"select A, B, C where D = 'WAITLIST' order by A",0),"empty")` |
| E22 / E23 | same for `S2` |
| I22 / I23 | same for `S3` |

Per-row duplicate flag in **each response tab**, column F (header `Also submitted` in F1, formula in F2 — Forms never writes column F):

| Tab | F2 |
|---|---|
| `S1` | `=ARRAYFORMULA(IF(C2:C="","",COUNTIF(S2!C:C,C2:C)+COUNTIF(S3!C:C,C2:C)))` |
| `S2` | `=ARRAYFORMULA(IF(C2:C="","",COUNTIF(S1!C:C,C2:C)+COUNTIF(S3!C:C,C2:C)))` |
| `S3` | `=ARRAYFORMULA(IF(C2:C="","",COUNTIF(S1!C:C,C2:C)+COUNTIF(S2!C:C,C2:C)))` |

Add a data-validation dropdown on D2:D (CONFIRMED, OFFERED, WAITLIST, CANCELLED) so the organiser's typing is consistent.

Fallback if a nested `QUERY … group by lower(Col1)` errors in your locale: replace B13 with `=IFERROR(FILTER(A24:B, B24:B>1),"none")` where A24 `=UNIQUE(ARRAYFORMULA(LOWER(TRIM(QUERY({S1!C2:C;S2!C2:C;S3!C2:C},"select Col1 where Col1 <> ''",0)))))` and B24 `=ARRAYFORMULA(IF(A24:A="","",COUNTIF(LOWER({S1!C2:C;S2!C2:C;S3!C2:C}),A24:A)))`.

### 3.4 Expected Summary values on the seeded data (dry-run check)

| Cell | A organiser | B organiser |
|---|---|---|
| C2:C4 Submissions | 5 / 5 / 4 | 5 / 5 / 5 |
| D2:D4 Confirmed | 3 / 3 / 3 | 3 / 3 / 3 |
| F2:F4 Waitlist | 2 / 2 / 1 | 2 / 2 / 2 |
| H2:H4 Seats free | 0 / 0 / 0 | 0 / 0 / 0 |
| B7 Distinct submitters | 12 | 13 |
| B8 Distinct confirmed people | **8** | **8** |
| B9 Confirmed rows | 9 | 9 |
| A13 Duplicate submitters | ravi.shankar 2, yusuf.ali 2 | gopal.krishnan 2, petra.novak 2 |
| D13 > 1 confirmed seat | ravi.shankar 2 | gopal.krishnan 2 |
| S3 waitlist block | Samuel Goh | Quentin Tay, Rania Said |

## 4. Announcement doc and e-mail texts

### 4.1 Announcement doc (one Google Doc per dataset, view-only link bookmarked as "Workshop announcement")

```
NUS Data Club — November workshops

Sign up with the form of the session you want (one form per session). Seats are given in
order of submission. If a session is FULL, submitting its form puts you on that session's
waitlist. If a seat is held for you, we will e-mail you — reply within the deadline or the
seat goes to the next person. To cancel, e-mail <organiser address> with your name and session.

Live status board (who has a seat, who is waiting): <sheet link>

Data Visualisation Basics (90 min, COM1-02-01)
 • Mon 16 Nov 10:00 — 2 seats — FULL (waitlist open) — <form link>
 • Tue 17 Nov 14:00 — 2 seats — 1 seat left — <form link>
 • Wed 18 Nov 16:00 — 2 seats — FULL (waitlist open) — <form link>

Git Basics (90 min, COM1-02-01)
 • Thu 19 Nov 10:00 — 3 seats — FULL (waitlist open) — <form link>
 • Fri 20 Nov 14:00 — 3 seats — FULL (waitlist open) — <form link>
 • Sat 21 Nov 10:00 — 3 seats — FULL (waitlist open) — <form link>

Questions: <organiser address>
```

Dataset B: Resume Clinic (Tue 17 Nov 11:00 FULL · Thu 19 Nov 15:00 FULL · Fri 20 Nov 10:00 **1 seat left**), Python for Data Analysis (Mon 16 Nov 09:00 · Wed 18 Nov 13:00 · Thu 19 Nov 17:00, all FULL).

### 4.2 "Seat held" e-mail — organiser → persona, sent by the facilitator right after T1 is recorded (Gmail template)

| | Dataset A | Dataset B |
|---|---|---|
| Subject | `[Data Visualisation Basics] Seat held for you — Tue 17 Nov 14:00 — reply by 18:00 today` | `[Resume Clinic] Seat held for you — Fri 20 Nov 10:00 — reply by 18:00 today` |
| Body | Hi Jordan, thanks for signing up. A seat in **Data Visualisation Basics, Tuesday 17 Nov, 14:00–15:30** is held for you. Please reply **CONFIRM** to this e-mail **by 18:00 today**; otherwise the seat goes to the next person on the list. — Riley, NUS Data Club | …**Resume Clinic, Friday 20 Nov, 10:00–11:30**… |

### 4.3 Cancellation e-mail — "other participant" → organiser, sent by the facilitator from the persona Gmail **before** reading the O2 card (control, organiser track)

| | Dataset A | Dataset B |
|---|---|---|
| Subject | `Excel Power Tools, Monday — can't attend (Mei Lin Chua)` | `Public Speaking Lab, Tuesday — can't attend (Farah Ismail)` |
| Body | Hi Riley, sorry, I can't make the Monday 16 Nov session of Excel Power Tools any more. Please give my seat to someone else. Mei Lin Chua (meilin.chua@example.com) | …Tuesday 17 Nov session of Public Speaking Lab… Farah Ismail (farah.ismail@example.com) |

## 5. Seed rows

Type them in (or paste from the blocks below); timestamps as `2026-10-20 09:01:00` so `order by A` works. E-mails are `first.last@example.com` in lower case. After seeding each sheet: **File → Version history → Name current version → `SEED`**.

### 5.1 `CTRL-A participant`

| Tab | Rows (Timestamp · Name · Email) |
|---|---|
| `W1-S1` | 2026-10-20 09:01 · Aiden Tan · aiden.tan@example.com · 09:04 · Priya Nair · priya.nair@example.com |
| `W1-S2` | 09:02 · Marcus Lim · marcus.lim@example.com |
| `W1-S3` | 09:03 · Chloe Wong · chloe.wong@example.com · 09:06 · Daniel Koh · daniel.koh@example.com |
| `W2-S1` | 10:01 Ethan Ng · 10:02 Grace Yeo · 10:03 Hafiz Rahman · 10:10 Wei Jie Ong · 10:12 Sara Ahmed |
| `W2-S2` | 10:04 Isabel Cruz · 10:05 Jun Hao Tan · 10:06 Kavya Menon · 10:11 Wei Jie Ong |
| `W2-S3` | 10:07 Leon Mueller · 10:08 Natalie Pang · 10:09 Omar Haddad · 10:13 Sara Ahmed |

Status board after seeding: DV Mon 0 left (Aiden, Priya) · DV Tue **1 left** (Marcus) · DV Wed 0 (Chloe, Daniel) · Git Thu 0, waitlist *Wei Jie Ong, Sara Ahmed* · Git Fri 0, waitlist *Wei Jie Ong* · Git Sat 0, waitlist *Sara Ahmed*.

### 5.2 `CTRL-B participant`

| Tab | Rows |
|---|---|
| `W1-S1` | 2026-10-21 09:01 Bella Chen · 09:02 Carl Ong |
| `W1-S2` | 09:03 Devi Pillai · 09:04 Elliot Low |
| `W1-S3` | 09:05 Fiona Goh |
| `W2-S1` | 10:01 Hannah Lim · 10:02 Ivan Petrov · 10:03 Jia Yi Wong · 10:10 Qi Ling Teo · 10:11 Rafael Santos · 10:12 Siti Nurul |
| `W2-S2` | 10:04 Karthik Raj · 10:05 Lucas Tan · 10:06 Maya Singh · 10:13 Qi Ling Teo |
| `W2-S3` | 10:07 Noah Koh · 10:08 Olivia Chan · 10:09 Pavel Novak · 10:14 Siti Nurul |

Status board: RC Fri **1 left** (Fiona); Py Mon waitlist *Qi Ling Teo, Rafael Santos, Siti Nurul*; Py Wed waitlist *Qi Ling Teo*; Py Thu waitlist *Siti Nurul*.

### 5.3 `CTRL-A organiser` (Timestamp · Name · Email · Status · Note)

| Tab | Rows |
|---|---|
| `S1` | 2026-10-20 09:01 Mei Lin Chua · CONFIRMED · 09:02 Ravi Shankar · CONFIRMED · 09:03 Tom Becker · CONFIRMED · 09:10 Hui Min Teo · WAITLIST · 09:12 Yusuf Ali · WAITLIST |
| `S2` | 09:04 Alicia Fernandez · CONFIRMED · 09:05 Ravi Shankar · CONFIRMED · 09:06 Ben Carter · CONFIRMED · 09:11 Zoe Lau · WAITLIST · 09:13 Yusuf Ali · WAITLIST |
| `S3` | 09:07 Nadia Rahman · CONFIRMED · 09:08 Kai Zhang · CONFIRMED · 09:09 Olivia Park · CONFIRMED · 09:14 Samuel Goh · WAITLIST |

### 5.4 `CTRL-B organiser`

| Tab | Rows |
|---|---|
| `S1` | 2026-10-21 09:01 Farah Ismail · CONFIRMED · 09:02 Gopal Krishnan · CONFIRMED · 09:03 Hana Sato · CONFIRMED · 09:10 Oscar Lee · WAITLIST · 09:11 Petra Novak · WAITLIST |
| `S2` | 09:04 Ivy Lim · CONFIRMED · 09:05 Gopal Krishnan · CONFIRMED · 09:06 Jonas Weber · CONFIRMED · 09:12 Kiran Desai · WAITLIST · 09:13 Petra Novak · WAITLIST |
| `S3` | 09:07 Lily Zhou · CONFIRMED · 09:08 Mateo Rossi · CONFIRMED · 09:09 Nur Aisyah · CONFIRMED · 09:14 Quentin Tay · WAITLIST · 09:15 Rania Said · WAITLIST |

Note column E is empty at seed time.

## 6. Reset checklist between participants (≈ 5 min)

### 6.1 Participant track (after T1–T5 in the control)

| # | Action | Done |
|---|---|---|
| 1 | Sheet `CTRL-x participant`: delete Jordan Lee's rows in every response tab (W1-S2 or W1-S3; W2-S1/S3 or W2-S1/S2; any extra tab she submitted). Right-click row → Delete row. | ☐ |
| 2 | Status board shows exactly §5.1/§5.2 again (seats left, waitlists). | ☐ |
| 3 | Form responses: not required (forms are not limited to one response); optional tidy-up Responses → individual → delete. | ☐ |
| 4 | Persona Gmail: delete the seat-held e-mail, the sent reply, the sent cancellation; empty Trash; Inbox must be empty. | ☐ |
| 5 | Organiser Gmail: delete the received reply and cancellation; sent seat-held e-mail may stay (or delete). Templates still present. | ☐ |
| 6 | Participant laptop: sign out of nothing, but close all tabs; reopen the bookmark folder for the next round/participant; clear the Downloads folder. | ☐ |

### 6.2 Organiser track (after O1–O4 in the control)

| # | Action | Done |
|---|---|---|
| 1 | Sheet `CTRL-x organiser`: File → Version history → See version history → **SEED** → Restore this version. Then check §3.4 values and that column E is empty. | ☐ |
| 2 | Drive: move to Trash the 3 forms and the spreadsheet the participant created in O1 (search by workshop name); keep the TEMPLATE. | ☐ |
| 3 | Organiser Gmail: delete the cancellation e-mail (will be re-sent for the next participant), the offer e-mail/draft the participant wrote; empty Drafts. | ☐ |
| 4 | Persona Gmail: delete the sent cancellation and any offer received. | ☐ |
| 5 | Downloads folder on the participant laptop emptied (CSV exports). | ☐ |
| 6 | Before the next organiser-track control round: send the §4.3 cancellation e-mail **before** reading the O2 card. | ☐ |

### 6.3 Before every control round (both tracks)

| # | Check |
|---|---|
| 1 | Correct dataset (A or B per `counterbalance.csv`) bookmarks folder open on the participant laptop: announcement doc, status board, Gmail inbox (participant track) / organiser sheet, Gmail, Drive (organiser track). |
| 2 | Announcement doc links point to the right dataset's forms. |
| 3 | Gmail inbox of the account the participant will use is empty (participant track) or holds exactly the cancellation e-mail (organiser track, before O2). |
| 4 | Stopwatch reset. |

## 7. Dry-run acceptance (10/28, before the pilot)

- Every formula cell shows a value, never `#REF!`/`#N/A`/`#ERROR!`; §3.4 values match.
- Submitting the Tue form as Jordan makes Status board row 3 show `0` seats left and "Marcus Lim, Jordan Lee" within ~5 s of refresh.
- Submitting a FULL session's form appends Jordan at the end of that waitlist (column E).
- Deleting Jordan's rows restores the seeded board.
- Restoring version `SEED` on the organiser sheet restores statuses and clears column E.
- Both e-mail templates send and arrive in Inbox (not Promotions/Spam) within 30 s.
- Each task of `tasks-participant.md` / `tasks-organiser.md` was walked once by a team member in the control; expected-answer cells written on the printed answer keys.
