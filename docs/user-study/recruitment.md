# Recruitment

> 团队摘要：从 10/20 起招募 12 位非组员的在读大学生（Prelim §5：twelve university students who are not team members；不招教职员，其中 ≥ 4 位有活动组织经验），另约 2 位预试（10/29，不计入）。
> 用下面的消息模板发 Telegram/WhatsApp/邮件；用筛选问题确认资格与组织经验，然后按 `counterbalance.csv` 的顺序分配 ID 和场次。
> 每场 40 分钟，间隔 50 分钟；排期表在 §5，排好后把日期写回 `counterbalance.csv`。

## 1. Who we need

| Criterion | Rule |
|---|---|
| Affiliation | Current NUS student, any faculty and year (the Preliminary report commits to "twelve university students who are not team members"; staff are not eligible) |
| Not a team member | Not in Team 18, not a flatmate/partner of a team member, not someone who has already seen SeatRelay |
| Count | 12 participants + 2 pilot people (pilot not counted) |
| Organiser experience | **At least 4** of the 12 have organised ≥ 1 event with sign-ups in the last 2 years → organiser track (`counterbalance.csv` rows P03, P06, P09, P12). The other 8 → participant track (organiser experience allowed but not required). |
| Tools | Has filled in a Google Form at least once (screener S4); comfortable using a laptop with Chrome |
| Language | Comfortable reading English task cards |
| Availability | One 40-minute slot between 10/30 and 11/05 (pilot: 10/29), on campus or over screen-share if unavoidable (log it) |

Aim for a mix of faculties and years. Do not recruit only CS students — the control (Forms + Sheets) is what most people use today, and heavy spreadsheet users are not the typical workshop participant.

## 2. Message template (Telegram / WhatsApp / e-mail)

Subject (e-mail): *40-min usability session: workshop sign-up tools (NUS CS5224 project)*

> Hi! I'm part of a 6-person NUS CS5224 team building **SeatRelay**, a sign-up tool for workshops that run several identical sessions (e.g. "same talk, Mon / Tue / Wed").
>
> We're looking for **NUS students** for a **40-minute** session between **30 Oct and 5 Nov** (on campus, [building/room]). You'll try two sign-up tools with made-up data, do a few small tasks (sign up, check your waitlist spot, confirm a seat…) and fill in a short questionnaire. No preparation needed, nothing is recorded except anonymous task results.
>
> **If you've ever organised an event with sign-ups**, we especially want to hear from you — we have a short organiser version.
>
> No payment, but coffee/tea and our sincere thanks. Interested? Reply here or e-mail [facilitator e-mail] with a few time slots that work for you, and I'll send a 4-question screener.
>
> — [Name], Team 18

Follow-up reminder (day before): *"Reminder: your session is tomorrow at [time] in [room]. It takes ~40 min. Bring nothing; reply if you need to reschedule. Thanks!"*

## 3. Screener (ask before booking; record answers in the scheduling table, not in the repo)

| # | Question | Qualifies if |
|---|---|---|
| S1 | Are you currently an NUS student? | yes |
| S2 | Are you a member of, or closely related to, CS5224 Team 18? Have you seen SeatRelay before? | no / no |
| S3 | In the last 2 years, have you organised an event, workshop or class that needed sign-ups? If yes: roughly how many, and which tools did you use? | any answer; **yes with ≥ 1 event** → eligible for the organiser track |
| S4 | Have you signed up for something via Google Forms before? | yes |
| S5 | Which of these slots work for you? (list open slots) | at least one |

Assign the **next free ID in the matching track** of `counterbalance.csv` (participant track: P01, P02, P04, P05, P07, P08, P10, P11; organiser track: P03, P06, P09, P12). IDs are assigned in booking order, never by preference. If an organiser-track person cancels, the ID stays reserved for an organiser-track replacement, so the counterbalance stays balanced. If, by 11/05, fewer than 4 organisers were found, run the organiser track with the people available and state the number in the report — never move a participant-track person into the organiser track after their session.

## 4. Scheduling rules

- 40 min per session, **50 min between start times** (10 min reset).
- Max 4 sessions per day for one facilitator/note-taker pair.
- Book the pilot (2 people, 10/29) first; they can be friends of team members who have *not* seen SeatRelay, since their data are not used.
- Confirm by message the day before (template above). No-shows: re-book into a buffer slot; log in `study-log.md`.
- Write the booked date/time into `counterbalance.csv` (`date`, `time` columns) so the facilitator sees the whole plan in one file.

## 5. Scheduling table

Fill as bookings come in (keep the same table in a private team sheet with names and contacts; the repo copy has IDs only).

| Slot | Date | Time | ID | Track | Order | Dataset 1 → 2 | Screener S3 (organised?) | Confirmed | Reminder sent | Done |
|---|---|---|---|---|---|---|---|---|---|---|
| Pilot 1 | 10/29 Thu | | PILOT-1 | participant | SR_first | A → B | | ☐ | ☐ | ☐ |
| Pilot 2 | 10/29 Thu | | PILOT-2 | organiser | CTRL_first | B → A | | ☐ | ☐ | ☐ |
| 1 | 10/30 Fri | | P01 | participant | SR_first | A → B | | ☐ | ☐ | ☐ |
| 2 | 10/30 Fri | | P02 | participant | CTRL_first | B → A | | ☐ | ☐ | ☐ |
| 3 | 10/31 Sat | | P03 | organiser | SR_first | A → B | yes | ☐ | ☐ | ☐ |
| 4 | 10/31 Sat | | P04 | participant | CTRL_first | A → B | | ☐ | ☐ | ☐ |
| 5 | 11/02 Mon | | P05 | participant | SR_first | B → A | | ☐ | ☐ | ☐ |
| 6 | 11/02 Mon | | P06 | organiser | CTRL_first | B → A | yes | ☐ | ☐ | ☐ |
| 7 | 11/03 Tue | | P07 | participant | SR_first | B → A | | ☐ | ☐ | ☐ |
| 8 | 11/03 Tue | | P08 | participant | CTRL_first | A → B | | ☐ | ☐ | ☐ |
| 9 | 11/04 Wed | | P09 | organiser | CTRL_first | A → B | yes | ☐ | ☐ | ☐ |
| 10 | 11/04 Wed | | P10 | participant | CTRL_first | B → A | | ☐ | ☐ | ☐ |
| 11 | 11/05 Thu | | P11 | participant | SR_first | A → B | | ☐ | ☐ | ☐ |
| 12 | 11/05 Thu | | P12 | organiser | SR_first | B → A | yes | ☐ | ☐ | ☐ |
| Buffer | 11/01 Sun, evenings | | | | | | | | | |

Dates are suggestions; the ID → order/dataset/track mapping in `counterbalance.csv` is fixed.
