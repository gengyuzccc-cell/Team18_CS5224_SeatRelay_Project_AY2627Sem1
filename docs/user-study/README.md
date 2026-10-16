# SeatRelay user evaluation — study package

Plan reference: `docs/plan/execution-plan.md` §3 step 18 (package), step 20 (pilot), step 22 (12 sessions), §5 (design and metrics), §10 (verification: raw CSV + `analysis.py` output, honest n).

## 1. Study in one paragraph

Within-subject comparison of **SeatRelay** (SR) against a **control** (CTRL) that mirrors current practice: *one Google Form per session plus one Google Sheet*. 12 non-team participants (≥ 4 with event-organising experience) each use **both** tools; order is counterbalanced (6 SR-first, 6 CTRL-first) and the second round uses an equivalent-but-different dataset (A/B) so nothing is a repeat. Eight participants do the 5 **participant tasks** (choose sessions in preference order, join the waitlist, read the status page, confirm a held seat, cancel); four participants with organiser experience do the 4 **organiser tasks** (create a 3-session workshop, process a cancellation and see the backfill, read backfill/queue, read the distinct-participant count and export CSV). After each tool the participant fills in the original 10-item SUS. A session takes ~40 min.

| Metric (plan §5) | Target | Source |
|---|---|---|
| Key-task completion rate (SR) | ≥ 90 % | `session-sheet.csv` → `success` |
| Paired median task-time improvement, SR vs CTRL | ≥ 25 % (Wilcoxon signed-rank p reported as uncertainty) | `session-sheet.csv` → `time_s` |
| SUS (SR) | ≥ 75, reported as mean ± 95 % CI | `sus-sheet.csv` |
| Errors, help requests, organiser manual steps | reported, no target | `session-sheet.csv` |
| Short interview | qualitative | `results/user-study/interview-notes.md` |

The control is deliberately a *well-prepared* spreadsheet (duplicate-detection formulas pre-built), so any SeatRelay advantage is a conservative estimate.

## 2. File map

| File | Purpose | Used by |
|---|---|---|
| `README.md` | This overview, timeline, roles, outputs | everyone |
| `protocol.md` | Minute-by-minute session script, timing and scoring rules, facilitator do/don't, recording | facilitator, note-taker |
| `consent.md` | Plain-language consent form (print 1 per participant) | facilitator |
| `recruitment.md` | Message template, inclusion criteria, screener, scheduling table | recruiter |
| `tasks-participant.md` | 5 participant tasks × 2 conditions × datasets A/B, answer keys | facilitator (print task cards) |
| `tasks-organiser.md` | 4 organiser tasks × 2 conditions × datasets A/B, control manual steps, answer keys | facilitator |
| `control-condition-setup.md` | How to build the Forms + Sheet control, exact formulas, seed rows, reset checklist | whoever builds the control (once) + facilitator (reset) |
| `sus.md` | SUS items (Brooke 1996), scoring, printable answer sheet | facilitator, note-taker |
| `session-sheet.csv` | Task-level data template (one row per participant × condition × task) | note-taker |
| `sus-sheet.csv` | SUS answers template (one row per participant × condition) | note-taker |
| `counterbalance.csv` | P01–P12 → track, order, dataset order | recruiter, facilitator |
| `analysis.py` | Produces `results/user-study/summary.md` + PNG charts from the two CSVs | analyst |

## 3. Timeline

| Date | What | Who |
|---|---|---|
| by 10/27 | Control condition built (`control-condition-setup.md`), SeatRelay study accounts + seed script ready (`tasks-*.md` state tables), task cards printed, 2 pilot people and 12 participants booked | team |
| 10/28 | Dry run by the team: walk every task in both conditions, fill in the "expected value" column of the answer keys from what the UI actually shows (UI freeze is 10/28, tag `v0.9-study`) | facilitator |
| **10/29 (Thu)** | **Pilot, 2 people** (not counted). Fix task wording, time caps, reset checklist; record the changes in `results/user-study/study-log.md` | facilitator + note-taker |
| **10/30 (Fri) – 11/05 (Thu)** | **12 sessions**, ~40 min each, 2 per day (suggested: 10/30 P01–P02, 10/31 P03–P04, 11/02 P05–P06, 11/03 P07–P08, 11/04 P09–P10, 11/05 P11–P12; 11/01 and evenings as buffer) | facilitator + note-taker |
| after each session | Rows typed into `session-sheet.csv` / `sus-sheet.csv`; interview + background notes into `interview-notes.md`; both systems reset | note-taker |
| 11/05 evening | `python3 docs/user-study/analysis.py` → `results/user-study/` | analyst |
| 11/06–11/10 | Numbers and charts into Final §4; sample size and limitations stated as-is | report author |

Book sessions 50 min apart (40 min session + 10 min reset). Two sessions back-to-back need two laptops already reset, or the 10-min gap.

## 4. Roles

| Role | Responsibilities |
|---|---|
| **Facilitator** (1 team member, same person for all 12 sessions if possible) | Runs `protocol.md` verbatim; reads task cards; keeps the stopwatch; gives hints only by the hint ladder; plays the "other participant" (e.g. Mei Lin Chua) on the second laptop during organiser task O2; sends the control-condition e-mails; resets both systems after the session. |
| **Note-taker** (1 team member) | Writes one `session-sheet.csv` row per task *immediately* after the task (success, time, errors, help requests, manual steps, notes); transcribes SUS sheets; types background + interview answers into `interview-notes.md`; never talks to the participant during tasks. |
| **Recruiter** (any team member) | Sends `recruitment.md` messages, runs the screener, fills the scheduling table and `counterbalance.csv` dates. |
| **Analyst** (any team member) | Runs `analysis.py`, checks warnings, copies numbers into the report. |

Team members are **never** participants (plan §5). Pilot people are not counted and cannot return as participants.

## 5. Equipment per session

- Participant laptop (Chrome, two bookmarks folders "A" and "B" with: SeatRelay login as the study persona; the control announcement doc; the persona Gmail inbox). Logged out of everything else.
- Facilitator laptop: SeatRelay organiser dashboard, SeatRelay logged in as the "other participant" of the current dataset (for O2), the organiser Gmail with the pre-written drafts, the control Sheet.
- Note-taker laptop with `session-sheet.csv` open (or a Google Sheet copy with the same columns, exported to CSV daily).
- Stopwatch (phone), printed task cards (one task per card, both conditions, both datasets), 2 printed consent forms, 2 printed SUS sheets per participant, pens.
- `counterbalance.csv` printed, with the day's assignments highlighted.

## 6. What goes into `results/user-study/`

`results/` is the single source of truth for every number in the Final report (plan §10). After the last session the folder must contain:

| File | Content |
|---|---|
| `session-sheet.csv` | Final task-level data (copy of `docs/user-study/session-sheet.csv` with EXAMPLE rows removed; `analysis.py` copies it automatically) |
| `sus-sheet.csv` | Final SUS data (same) |
| `counterbalance.csv` | The assignment actually used, with dates |
| `interview-notes.md` | Per participant: background answers, interview answers, facilitator observations (no names, IDs only) |
| `study-log.md` | Pilot changes, deviations from protocol (e.g. a reset that failed, a task skipped), no-shows and replacements, the SeatRelay commit/tag and stack used |
| `summary.md` | Output of `analysis.py` (tables, p-values, warnings, n) |
| `task-time-paired.png`, `sus-boxplot.png`, `completion-bars.png` | Charts from `analysis.py` |

Nothing in `results/user-study/` is ever edited by hand except `interview-notes.md` and `study-log.md`. If a participant withdraws, their rows are deleted from the CSVs and the withdrawal is noted in `study-log.md`.

## 7. Running the analysis

```bash
pip install --user pandas scipy matplotlib      # once
python3 docs/user-study/analysis.py             # reads docs/user-study/*.csv, writes results/user-study/
python3 docs/user-study/analysis.py path/to/session.csv path/to/sus.csv --out results/user-study
```

Rows whose `participant_id` or `notes` contain `EXAMPLE` are dropped. The script never raises on small or missing data: it prints `WARNING:` lines and writes `n/a` in the tables. Read every warning before quoting a number. Minimum attainable two-sided Wilcoxon p with *n* non-tied pairs is 2^(1−n) (n = 4 → 0.125, n = 8 → 0.0078), so organiser-task p-values (n ≤ 4) can never be "significant"; the report states this instead of hiding it.

## 8. Honesty rules (plan §0, §9)

- Report the number of participants actually run, per track. If fewer than 12 show up, say so.
- No row is ever invented, moved or "cleaned" to hit a target. A failed task is a failed task.
- The pilot's two people are excluded even if their data look good.
- Every change to tasks or rules after the pilot is dated in `study-log.md` and applied identically to all 12 participants.
