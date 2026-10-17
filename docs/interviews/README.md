# SeatRelay Phase 0 interviews — package

> 团队摘要：10/16–10/24 访谈 4–6 位学生（`guide-participant.md`，20 分钟）和 2–3 位组织者（`guide-organiser.md`，25 分钟），全部非组员。目的是给 Final §1 的市场规模（p、每场人工小时）、§2 的定价（WTP）和问题证据提供**真实**数据。口头同意、只记笔记、只用编号。原始记录放 `results/interviews/`，数字只从那里进报告；不许编造、不许凑数。

Plan reference: `docs/plan/execution-plan.md` §1.1 (p, hours, TAM/SAM/SOM), §3 step 6, §7.1 (Final §1–§2), §8 (10/16–10/24), §10 (every number traceable to `results/`).

## 1. Why and what we need

| Number for the report | From | Column / key | Used in |
|---|---|---|---|
| **p** — share of organisers' events with ≥ 2 equivalent sessions | organiser A1, A2 | `share_multi_session` (role = organiser) | `docs/market-sizing.md` TAM |
| Person-hours of coordination per multi-session event | organiser C1 | `hours_per_event` (organiser) | value per event → S$10/month justification |
| Acceptable price range and reaction to S$10/month | organiser E1–E5 | `wtp_*`, `anchor_10_reaction` | Final §2 business model |
| Tools in use today | organiser B1, participant A1 | `tools` | Final §1 competitor table |
| How often students meet multi-session events and hold several slots | participant E1–E3 | `share_multi_session` (participant), `held_multiple_slots` | Final §1 problem evidence, mechanism comparison framing |
| Preferred channel, acceptable hold window | participant D1, D2 | `notify_channel`, `hold_window_ok_min` | `holdSeconds` default, notification design |
| Data/privacy constraints | organiser F1–F3 | `privacy_constraints` | assumptions, SAM filter |
| Pilot candidates | organiser G1 | `pilot_interest` | plan §8 (decide pilot by 10/22) |

Target: 4–6 participants + 2–3 organisers (at least one student club and one department if possible). Report the number actually interviewed; a smaller n is reported as a smaller n.

## 2. Files

| File | Purpose |
|---|---|
| `guide-participant.md` | 20-min semi-structured guide for students (consent script, probes, exact market-sizing and WTP questions) |
| `guide-organiser.md` | 25-min guide for club / department / CET organisers (volume → p, tools, hours, pain points, van Westendorp + S$10 anchor, privacy, pilot) |
| `record-template.md` | Per-interview Markdown block and the column specification of the CSV |
| `interviews.csv` | Header + two `EXAMPLE-*` rows; the spec for the real file |
| `results/interviews/I01.md … ` | Filled records (created during the interviews; not in `docs/`) |
| `results/interviews/interviews.csv` | The real coded data, without EXAMPLE rows |

## 3. Consent

- Consent is **verbal**: the interviewer reads the script in block 0 of the guide in full and writes `consent: yes` in the record. No signature is needed because no personal data is kept. If the person declines, no record is created.
- No audio or video recording. Notes only.
- The person may skip questions, stop at any time, and ask for their notes to be deleted until **2026-11-10** by quoting their code. Deletion = remove `results/interviews/I__.md` and the CSV row, and note the withdrawal (code and date only) in `results/interviews/log.md`.
- Interviewees are not paid and are not team members.

## 4. Anonymisation and coding rules

- Codes `I01, I02, …` in interview order, shared between roles. The mapping code → name lives only in the interviewer's private note (phone/paper), never in the repository, chat, Telegram or Google Drive, and is deleted after the course grade is released.
- Records contain no names, e-mails, student numbers, organisation names or event names that identify a person. Write "a faculty student club", "a library workshop series". Quotes are anonymised and paraphrases are marked `~`.
- Never copy data from an organiser's form or spreadsheet (their participants did not consent). Look, count, describe.
- `tools` vocabulary (alphabetical, `;`-separated, add a new slug only if nothing fits and mention it in the record): `eventbrite`, `excel`, `google_forms`, `luma`, `microsoft_forms`, `nusync`, `other_university_system`, `paper`, `sheets`, `telegram`, `whatsapp`, `email`, `none`.
- Units: `hours_per_event` in hours (1 dp); `wtp_*` integers in S$, **per event** for participants and **per organisation per month** for organisers; shares as decimals 0–1 (2 dp). Empty cell = not asked / unknown; `0` = a real zero. Full column table in `record-template.md` §2.
- Rows whose `id` starts with `EXAMPLE` are ignored by any analysis script.

## 5. Where the numbers go

1. After each interview: `results/interviews/I__.md` + one row in `results/interviews/interviews.csv` (copy the header from `docs/interviews/interviews.csv`).
2. After the last interview: compute and write `results/interviews/summary.md` with, per role, `n`, and:
   - organisers: `p` = Σ multi-session events ÷ Σ events (event-weighted, from `share_multi_session × events_per_year`) and the simple mean; median and range of `hours_per_event`; the four `wtp_*` medians and the range between median `wtp_bargain` and median `wtp_expensive` (with n ≤ 3 do not fit van Westendorp curves — report the raw answers); count of `anchor_10_reaction` yes / no / only_if; tools frequency; privacy constraints frequency; pilot candidates.
   - participants: mean and median `share_multi_session`; distribution of `held_multiple_slots` and `missed_due_full`; `notify_channel` first choices; median `hold_window_ok_min`; `wtp_*` medians; mean `hours_per_event`.
3. `docs/market-sizing.md` takes `p` and hours from `summary.md`; Final §1 and §2 cite `results/interviews/summary.md`. **Every interview-derived number in the report comes only from these files**; nothing is quoted from memory or from a chat message.

## 6. Honesty rules (plan §0, §9)

- No invented, merged or "cleaned" rows. If an answer was not given, the cell is empty and the n for that column is smaller.
- The report states the real n per role and that interviewees were recruited by convenience from the team's network (a limitation).
- Team members, their flatmates/partners, and user-study participants (`docs/user-study/`) are not interviewed here; a person is either an interviewee or a study participant, not both.
