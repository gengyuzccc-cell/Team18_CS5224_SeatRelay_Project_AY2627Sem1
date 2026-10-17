# Interview guide — organisers (clubs, departments, training providers), 25 minutes

> 团队摘要：对 2–3 位组织者（学生社团干事、常办 workshop 的部门职员、或 CET 培训机构人员）做 25 分钟访谈（10/16–10/24，plan §8）。必须拿到的数字：每年办几场有报名的活动、其中多少场有「≥ 2 个等价场次」（→ 问题发生率 p）、每场人工协调几小时、用什么工具、van Westendorp 四个价格 + 对 S$10/月的反应、数据/隐私限制。
> 顺带问能否在 11/3–11/4 用 SeatRelay 办一次真实试点（plan §8 10/22 截止）。
> 粗体问题必须问；「Probe」是追问。结束后 24 小时内整理记录并填 `interviews.csv`。

Plan reference: `docs/plan/execution-plan.md` §1.1 (p, hours per event, S$120/year pricing), §3 step 6, §5, §8 (2–3 organiser interviews; pilot workshop decided by 10/22). Record with `record-template.md`; numbers to `interviews.csv`; rules in `README.md`.

**Who:** someone who has personally run sign-ups for at least one event in the past year: a student-club exco member (events / secretary), a department staff member who runs workshops (library, career centre, IT, teaching support, faculty office), or a trainer at a SkillsFuture/CET provider. Not a team member.
**Where:** in person or a 25-minute call. Bring a laptop: organisers often want to show their form or sheet; ask before looking, and never copy participant data.

| Block | Minutes | What it gives the report |
|---|---|---|
| 0. Consent + warm-up | 2 | `org_type`, context |
| A. Volume and multi-session share | 4 | `events_per_year`, `share_multi_session` → **p** |
| B. Current process and tools | 5 | `tools`, competitor framing (Final §1) |
| C. Effort | 3 | `hours_per_event` → value per event |
| D. Pain points | 3 | problem evidence, feature priorities |
| E. Willingness to pay | 4 | `wtp_*`, reaction to S$10/month (Final §2) |
| F. Data and privacy constraints | 2 | assumptions, SAM filter |
| G. Pilot interest + closing | 2 | real pilot (plan §8) |

## 0. Consent and warm-up (2 min)

Read aloud, then tick `consent = yes`:

> "Thanks for your time. We are four NUS students doing a CS5224 course project called SeatRelay, a sign-up tool for workshops that run several identical sessions. This is a 25-minute conversation about how you run sign-ups today. We take written notes only, no recording. Neither your name nor your organisation's name is written in our records; you get a code like I07 and an organisation type like 'student club'. Anonymised quotes and the numbers we collect may appear in our course report. Skip anything, stop any time, and you can ask us to delete your notes until 10 November. Is that okay?"

Warm-up:
- **What is your role, and what kind of organisation is it?** Code `org_type`: `student_club` / `department` / `cet_provider` / `other` (describe).
- **How long have you been running sign-ups?** (years)
- **Who else is involved in sign-ups for an event?** (number of people)

## A. Volume and multi-session share (4 min) — ask exactly as written

Define: "By *equivalent sessions* I mean the same workshop run more than once, e.g. Monday and Thursday, and each participant attends only one."

- **A1. In the past 12 months, how many events with a sign-up form did your organisation run?** → `events_per_year` (if they only know their own share, write that and note `scope: own events`)
- **A2. Of those, how many had 2 or more equivalent sessions?** → `multi_session_events`; `share_multi_session = A2 / A1`
  - Probe: training workshops, briefings, lab sessions, recruitment talks, orientation, repeated tours.
- **A3. For a typical multi-session event: how many sessions, capacity per session, and roughly how many people signed up in total?** → `typical_sessions`, `typical_capacity`, `typical_signups`
- **A4. How often were sessions oversubscribed while another equivalent session had free seats?** (never / sometimes / most times)

## B. Current process and tools (5 min)

- **B1. Walk me through how sign-ups work for a multi-session event, from announcement to the day.**
  - Probe: one Google Form per session or one form with a dropdown? Luma? Eventbrite? Telegram poll or message? A university system (which one)? A spreadsheet? Code `tools` with the vocabulary in `README.md` §4 (e.g. `google_forms;sheets;telegram`).
- **B2. How do you handle a full session?** (first-come cut-off / waitlist in a sheet / tell people to try another session / nothing)
- **B3. How do you handle people who sign up for several sessions?** Do you detect it? How? What do you do?
- **B4. What happens when someone cancels or does not turn up?** Does the seat get reused? Who contacts the next person, and how long does that take?
- **B5. How do you confirm seats and send reminders?** (manual e-mail / mail merge / Telegram / the tool does it)
- **B6. Do you track attendance? How? Do you need a list or export afterwards (for whom)?**

## C. Effort (3 min)

- **C1. For one typical multi-session event, how many person-hours go into sign-up coordination in total?** → `hours_per_event`. Build it up if needed:

| Activity | Hours (their estimate) |
|---|---|
| Building the form(s) and announcement | |
| Answering "do I have a seat?" / change requests | |
| Finding duplicates and oversubscription, moving people | |
| Chasing the waitlist when seats free up | |
| Confirmations and reminders | |
| Attendance list, export, follow-up | |
| **Total** | |

- **C2. Who does that work (paid staff, volunteers), and what would they otherwise do with that time?**
- **C3. What is the worst that has happened because of a sign-up mix-up?** (one story)

## D. Pain points (3 min)

- **D1. What are the three most annoying things about sign-ups for multi-session events today?** Rank them.
- **D2. What have you tried to fix them?** Did it work?
- **D3. If a tool solved only one of those, which one would make you switch?**
- **D4. Which of these would matter to your organisation:** at most one seat per person, automatic waitlist with a short hold, instant backfill on cancellation, e-mail/in-app notifications, attendance tick-list, CSV export, a dashboard of free seats per session, organiser accounts for a team. (tick what resonates; note anything they add)

## E. Willingness to pay (4 min)

Show or read a one-line description: "One sign-up form for all sessions; each participant ranks acceptable sessions and gets at most one seat; waitlist with a short hold and automatic backfill; e-mail and in-app notifications; dashboard, attendance and CSV export; team accounts. Priced per organisation per month, unlimited events."

Van Westendorp, in Singapore dollars **per organisation per month**. Ask in this order; accept 0.

- **E1. At what monthly price would it be so cheap that you would doubt its quality?** → `wtp_too_cheap`
- **E2. At what monthly price would it be a bargain?** → `wtp_bargain`
- **E3. At what monthly price would it start to feel expensive, but you would still consider it?** → `wtp_expensive`
- **E4. At what monthly price would it be too expensive to consider?** → `wtp_too_expensive`

Anchor (ask after E1–E4, never before):

- **E5. We are thinking of S$10 per organisation per month, with a free tier for one small event at a time. Would your organisation pay that?** (yes / no / only if …) → `anchor_10_reaction`
  - Probe: who approves spending like that, and from which budget (club funds, department, faculty, school IT)? How long does approval take?
  - Probe: would you rather pay per event (how much?) or per year?
- **E6. What do you pay today for any sign-up or event tool?** (S$0 is common; note Eventbrite fees, Luma Plus, etc.)

## F. Data and privacy constraints (2 min)

- **F1. What participant data do you collect for a sign-up?** (name, e-mail, student number, phone, faculty, dietary…) Where is it stored, and for how long?
- **F2. Are there rules you must follow before using a new tool?** (PDPA, university data-protection policy, must use school-approved tools, must use school login/SSO, data must stay in Singapore, retention limits, approval by a staff advisor or IT)
- **F3. Who would have to approve adopting a new sign-up tool, and what would they ask?** → feeds the SAM filter (organisers covered by closed institutional systems).
- **F4. Would participants in your events accept signing in with an e-mail account to confirm a seat?**

## G. Pilot interest and closing (2 min)

- **G1. Do you have a multi-session event between 3 and 7 November where we could run sign-ups on SeatRelay, with your usual process as a backup?** Topic, dates, sessions, capacity, expected demand → `pilot_interest`, details in the record.
- **G2. Anything we did not ask?**
- "Thank you. Your code is I__. Message [interviewer] with that code before 10 November if you want your notes deleted."

## After the interview (within 24 h)

1. Fill one `record-template.md` block as `results/interviews/I__.md` (code only; no names, no organisation names, no participant data).
2. Add one row to `interviews.csv` (units in `README.md` §4). `share_multi_session = multi_session_events / events_per_year` rounded to 2 decimals.
3. If `pilot_interest = yes`, tell the team the same day (plan §8: pilot workshop fixed by 10/22).
