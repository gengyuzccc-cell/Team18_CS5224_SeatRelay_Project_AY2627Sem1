# Interview record template and CSV specification

> 团队摘要：每次访谈后 24 小时内，复制 §1 的模板到 `results/interviews/I__.md`（只用编号，不写姓名、不写组织名称），把「Coded answers」里的数字按 §2 的列规范填到 `interviews.csv` 一行。§2 定义了每一列的类型、单位、取值；分析脚本只读这个 CSV，所以列名、单位和词表必须一字不差。

## 1. Record block (one file per interview: `results/interviews/I__.md`)

```markdown
# Interview I__

| Field | Value |
|---|---|
| id | I__ |
| date | 2026-10-__ |
| role | participant / organiser |
| org_type | student_club / department / cet_provider / other (participants: leave empty) |
| interviewer / note-taker | initials |
| mode | in person / call |
| duration_min | |
| consent | yes (verbal, script read in full) |
| scope note | e.g. "organiser only knows own events, not whole club" |

## Background (warm-up)
- Year/faculty or role and years of experience:
- Organisations mentioned (type only, no names):
- People involved in sign-ups (organisers):

## Notes by block
### A. (participant: multi-session sign-ups | organiser: volume)
-
### B. (participant: duplicate bookings | organiser: process and tools)
-
### C. (participant: waitlists | organiser: effort)
-
### D. (participant: notifications and hold | organiser: pain points)
-
### E. (participant: market-sizing questions | organiser: willingness to pay)
-
### F. (participant: willingness to pay | organiser: data and privacy)
-
### G. (closing, pilot interest)
-

## Coded answers (one per line, keep the keys exactly; empty = not asked / not known)
- events_per_year:
- multi_session_events:
- share_multi_session:
- held_multiple_slots:            # participant: 0 / 1 / 2 / 3+
- missed_due_full:                # participant: count
- hours_per_event:                # participant: minutes/60 spent getting a seat; organiser: person-hours of coordination
- tools:                          # vocabulary in README §4, e.g. google_forms;sheets;telegram
- notify_channel:                 # participant: ranked, e.g. telegram;email
- hold_window_ok_min:             # participant: minutes
- typical_sessions:               # organiser
- typical_capacity:               # organiser
- typical_signups:                # organiser
- oversubscribed_freq:            # organiser: never / sometimes / most
- wtp_too_cheap:
- wtp_bargain:
- wtp_expensive:
- wtp_too_expensive:
- anchor_10_reaction:             # organiser: yes / no / only_if (then explain in notes)
- pays_today_sgd_month:           # organiser
- privacy_constraints:            # organiser: pdpa;school_approval;sso;sg_residency;retention;none
- features_wanted:                # one_seat;waitlist_hold;backfill;notifications;attendance;csv;dashboard;team_accounts
- pilot_interest:                 # yes / no / maybe
- pilot_details:                  # organiser: topic, dates, sessions, capacity (if yes)

## Quotes (anonymised, at most 5, mark paraphrases with ~)
- "..."

## Interviewer observations
-

## Follow-ups / to-dos
-
```

## 2. `interviews.csv` column specification

One row per interview. Header (exact order, lower-case, comma-separated, no spaces):

```
id,date,role,org_type,events_per_year,share_multi_session,hours_per_event,tools,wtp_too_cheap,wtp_bargain,wtp_expensive,wtp_too_expensive,consent
```

| Column | Type | Unit / allowed values | Participant source | Organiser source |
|---|---|---|---|---|
| `id` | string | `I01`, `I02`, … in interview order; `EXAMPLE-*` rows are ignored by analysis | — | — |
| `date` | ISO date | `YYYY-MM-DD` (Singapore date) | — | — |
| `role` | enum | `participant` \| `organiser` | — | — |
| `org_type` | enum | `student_club` \| `department` \| `cet_provider` \| `other`; empty for participants | — | warm-up |
| `events_per_year` | integer | events with a sign-up form in the past 12 months | E1 (attended / signed up) | A1 (organised) |
| `share_multi_session` | decimal 0–1, 2 dp | events with ≥ 2 equivalent sessions ÷ `events_per_year` | E2 ÷ E1 | A2 ÷ A1 → **p** |
| `hours_per_event` | decimal, 1 dp | hours per typical event | A4 minutes ÷ 60 (time spent getting a seat) | C1 total person-hours of coordination |
| `tools` | list | `;`-separated slugs from README §4 vocabulary, alphabetical | A1 probe (what they used) | B1 |
| `wtp_too_cheap` | integer | S$; participant: **per event**; organiser: **per organisation per month** | F1 | E1 |
| `wtp_bargain` | integer | same unit as above | F2 | E2 |
| `wtp_expensive` | integer | same unit as above | F3 | E3 |
| `wtp_too_expensive` | integer | same unit as above | F4 | E4 |
| `consent` | enum | `yes` only; a row without `yes` must not exist | block 0 | block 0 |

Rules: a question not asked or not answered is an **empty** cell, never `0`, `NA` or `-`; a genuine zero (e.g. S$0) is `0`. Decimal point `.`, no thousands separators, no currency symbols, no `%`. If an answer is a range ("5–10"), write the midpoint and note the range in the record file. `share_multi_session` must be ≤ 1; if `events_per_year` is empty, leave the share empty too.

## 3. Example rows

```
EXAMPLE-P,2026-10-17,participant,,9,0.33,0.5,google_forms;telegram,0,1,3,5,yes
EXAMPLE-O,2026-10-18,organiser,student_club,12,0.25,6,google_forms;sheets;telegram,2,8,20,40,yes
```

Both example rows are present in `docs/interviews/interviews.csv` so the header and formats can be checked by script; `results/interviews/interviews.csv` (the real data) must not contain them.
