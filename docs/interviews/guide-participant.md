# Interview guide — participants (students), 20 minutes

> 团队摘要：对 4–6 位非组员学生做 20 分钟半结构化访谈（10/16–10/24，plan §8）。目的：(1) 多场次活动报名的真实经历与痛点；(2) 重复占位、候补、通知偏好；(3) 市场规模需要的两个精确数字（过去一年参加过多少个「≥ 2 个等价场次」的活动；其中多少次同时占了多个名额）；(4) 支付意愿。
> 开场读一遍同意句并在 CSV 的 `consent` 列记 `yes`；只记笔记、不录音；用 `I01…` 编号，不记姓名。结束后 24 小时内按 `record-template.md` 整理并把数字填进 `interviews.csv`。
> 粗体问题是必须问的；缩进的「Probe」是追问，时间不够可跳过。

Plan reference: `docs/plan/execution-plan.md` §1.1 (market sizing, p), §3 step 6, §8 (10/16–10/24: 4–6 students). Record with `record-template.md`; coded numbers go to `interviews.csv`; rules in `README.md`.

**Who:** NUS students (any faculty, any year) who are not in Team 18 and have signed up for at least one event with sign-ups in the past year. A mix of faculties; not only CS.
**Where:** in person on campus or a 20-minute call. One interviewer, one note-taker if available.
**Bring:** this guide, a printed `record-template.md` block or a laptop, a phone timer.

| Block | Minutes | What it gives the report |
|---|---|---|
| 0. Consent + warm-up | 2 | eligibility, context |
| A. Multi-session sign-ups | 5 | problem evidence (Final §1) |
| B. Duplicate bookings | 3 | motivation for R1–R3, mechanism comparison framing |
| C. Waitlists and backfill | 3 | motivation for hold + backfill, H1/H3 |
| D. Notifications and hold window | 2 | `holdSeconds` default, channel choice |
| E. Market-sizing questions | 3 | participant-side frequency; `events_per_year`, `share_multi_session` |
| F. Willingness to pay | 1.5 | business model (Final §2); `wtp_*` |
| G. Closing | 0.5 | — |

## 0. Consent and warm-up (2 min)

Read aloud, then tick `consent = yes` in the record:

> "Thanks for your time. We are four NUS students doing a CS5224 course project called SeatRelay, a sign-up tool for workshops that run several identical sessions. This is a 20-minute conversation about your experience signing up for events. We take written notes only, no recording. Your name is not written anywhere; you get a code like I03. Anonymised quotes and the numbers we collect may appear in our course report. You can skip any question or stop at any time, and you can ask us to delete your notes until 10 November. Is that okay?"

If no: thank them and stop; do not create a record.

Warm-up (write answers in the record header):
- **Year and faculty?** (e.g. Y2, Business)
- **Roughly how many events, talks or workshops with a sign-up form did you register for this semester?**
- **Which clubs or departments run the ones you go to most?** (names of organisations only, no people)

## A. Experiences with multi-session workshop sign-ups (5 min)

Define it once: "By *equivalent sessions* I mean the same workshop or talk offered more than once, for example Monday 2 pm, Tuesday 6 pm and Thursday 2 pm, and you only need to attend one."

- **A1. Tell me about the last time you signed up for something that had 2 or more equivalent sessions.** What was it, who ran it, how many sessions, how did you sign up?
  - Probe: one form per session, one form with a session choice, Telegram message, Eventbrite/Luma ticket, a school system?
  - Probe: did you get to the session you wanted? If not, what happened?
- **A2. What was confusing or annoying about that sign-up?**
  - Probe: unclear whether you had a seat; no confirmation; had to message the organiser; session full with no waitlist.
- **A3. How did you find out whether you had a seat?** (immediate confirmation / e-mail days later / only on the day / never)
- **A4. How long, in total, did you spend on getting a seat for that event?** (filling forms, refreshing, messaging, checking) — write minutes; feeds `hours_per_event` for participants.

## B. Duplicate bookings (3 min)

- **B1. Have you ever signed up for more than one session of the same event at the same time?** Why? (keep options open; not sure of timetable; afraid of missing out; organiser asked for backups)
  - Probe: did you release the extra one? When? How? Did anyone tell you to?
- **B2. Have you seen others do it, or an organiser complain about it?** What did the organiser do about it (nothing / manual messages / first-come rule)?
- **B3. If the system guaranteed you one seat in one of your acceptable sessions, would you still want to hold two?** Why?

## C. Waitlists and backfill (3 min)

- **C1. Have you been on a waitlist for a full session? What happened?**
  - Probe: did you know your position? Were you told when a seat opened? How long after it opened? Was it still useful by then?
- **C2. When a seat opens, how quickly do you need to respond before it is fair to pass it to the next person?** (minutes / an hour / a day) — write their number.
- **C3. Has a seat ever gone unused because you (or someone) forgot to cancel?** What would have made cancelling easier?

## D. Notifications and hold window (2 min)

- **D1. Where do you want to be told that a seat is held for you: e-mail, Telegram, SMS, WhatsApp, inside the sign-up site, something else?** Rank the top two. Code as `notify_channel`.
- **D2. A held seat expires if you do not confirm. Is 15 minutes enough? What is the longest hold you would find acceptable before it is unfair to people waiting?** Code minutes as `hold_window_ok_min`.
  - Probe: when would 15 minutes be too short (in class, asleep, no data)?
- **D3. How often do you want reminders before the session?** (none / day before / hour before)

## E. Market-sizing questions (3 min) — ask exactly as written

Say: "Three counting questions. Rough numbers are fine; take a moment."

- **E1. In the past year, how many events did you attend (or sign up for) that had sign-up forms at all?** → `events_per_year`
- **E2. In the past year, how many events did you attend that had 2 or more equivalent sessions?** → `multi_session_events_attended`; `share_multi_session = E2 / E1`
  - Probe if stuck: workshops, library or career-centre sessions, orientation, lab safety briefings, CCA trials, training courses.
- **E3. Of those (E2), how often did you hold more than one slot at the same time, even briefly?** Count of events → `held_multiple_slots` (0 / 1 / 2 / 3+)
- **E4. In the past year, how many times did you miss a session you wanted because it was full while another equivalent session had empty seats or no-shows?** → `missed_due_full`

## F. Willingness to pay (1.5 min)

Frame it: "Imagine the organiser used a tool that guarantees you at most one seat, shows your waitlist position, and tells you within a minute when a seat frees up. Suppose there were a small per-event booking fee to the participant, refunded if you attend. Four quick prices, in Singapore dollars per event."

- **F1. At what price would it be so cheap that you would doubt it works?** → `wtp_too_cheap`
- **F2. At what price would it be a bargain?** → `wtp_bargain`
- **F3. At what price would it start to feel expensive, but you might still pay?** → `wtp_expensive`
- **F4. At what price would it be too expensive and you would not sign up?** → `wtp_too_expensive`
- **F5. Would such a tool change whether you sign up at all, or which organisers you trust?** (yes / no / depends; one sentence)

S$0 answers are valid; write 0, not blank. Participants are not the paying customer (organisers are); these answers show the perceived value and whether a fee hurts sign-ups.

## G. Closing (30 s)

- **Anything we did not ask that matters to you about event sign-ups?**
- "Thank you. Your code is I__. If you want your notes deleted, message [interviewer] with that code before 10 November."
- Offer to send the pilot workshop link (late October) if they want to try the real thing; note `pilot_interest: yes/no`.

## After the interview (within 24 h)

1. Fill one `record-template.md` block as `results/interviews/I__.md` (ID only, no name).
2. Add one row to `interviews.csv` with the coded numbers (units in `README.md` §4).
3. Keep the name-to-ID note outside the repository; delete it after the course grade is released.
