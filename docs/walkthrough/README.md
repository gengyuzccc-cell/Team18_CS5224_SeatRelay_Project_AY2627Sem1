# Presentation walkthrough (15 min talk + 10 min Q&A)

Speaker notes for the 13 November presentation (plan §7.2). Every member speaks. One file per part:

| Part | File | Speaker | Clock | Length | Slides |
|---|---|---|---|---|---|
| 1 | [part-1.md](part-1.md) | Speaker 1 | 0:00–2:00 | 2:00 | 1 Title, 2 Problem and market, 3 Business model |
| 2 | [part-2.md](part-2.md) | Speaker 2 | 2:00–4:00 | 2:00 | 4 Mechanism and rules |
| 3 | [part-3.md](part-3.md) | Speaker 3 | 4:00–6:00 | 2:00 | 5 Architecture (Figure A), 6 Request path and transaction (Figure B), 7 Timers and sweep (Figure C) |
| 4 | [part-4.md](part-4.md) | Speaker 4 narrates D1–D3; Speaker 5 operates, then narrates D5b–D4 | 6:00–11:00 | 5:00 | 8 Live demo (backup slides B1–B7) |
| 5 | [part-5.md](part-5.md) | Speaker 5 | 11:00–13:00 | 2:00 | 9 System results (Table 3), 10 Latency and mechanism comparison, 11 Cloud vs on-prem cost |
| 6 | [part-6.md](part-6.md) | Speaker 6 | 13:00–15:00 | 2:00 | 12 User study and pilot, 13 Limitations, future work, AI use, division of work |

Q&A preparation for the whole project: [../QA-prep.md](../QA-prep.md).

## Timing

- The plan gives each speaker about 2.5 minutes. The demo needs about 5 minutes (docs/DEMO.md), so
  it is shared by speakers 4 and 5, and the five slide parts get 2:00 each:
  5 × 2:00 + 5:00 = 15:00.
- Each set of notes is about 300–350 words, which is about 2:00–2:20 at 150 words per minute. A
  sentence marked *(optional)* is the first thing to cut when a rehearsal runs long.
- If the demo runs on the local stack (Plan B), the crash-recovery beat takes seconds instead of two
  minutes. Give the time saved to Part 5.
- Hand-overs are written into the notes ("Next, [Speaker 2] …"). Replace the bracket with the name.

## Numbers: rules for every speaker

1. **Quote only the numbers in your part's "Key numbers" table.** Each row names the file under
   `results/` (or the cited source) it comes from. The macro name in the table is the same number in
   `report/generated/numbers.tex`, which is generated from those files by `report/tools/numbers.py`.
2. A value written **[PENDING: …]** does not exist yet. Before the first timed rehearsal, replace it
   with the value from the named file. If it still does not exist on the day, say "not measured yet".
   Never estimate, round up, or quote a number from memory or chat.
3. Status on 2026-10-17:
   - The Table 3 dev run (`results/2026-10-17-table3-dev.status`) is still in progress.
   - The k6 matrix, cost snapshots, interviews, user study and pilot have no results yet.
   - Final: the dev smoke run (`results/2026-10-17-smoke/`), the mechanism comparison
     (`results/replay/`) and the cost model (`results/cost/model-summary.md`).
4. Values seen during the demo are demo values. The rehearsal values in the DEMO.md appendix are not
   report measurements.
5. A missed target is reported as missed, with the measured value and the explanation.

## Slide ownership and backup slides

| Slide | Owner | Content | Source |
|---|---|---|---|
| 1 | Speaker 1 | title, team, repository URL | README §1 |
| 2 | Speaker 1 | problem, market-size table | `docs/market-sizing.md` §6 |
| 3 | Speaker 1 | pricing, value argument, competitor table | `docs/market-sizing.md` §3, §5 |
| 4 | Speaker 2 | Figure 1 flow, R1–R7 one line each, C1/C2/C3/C5/C7 | `docs/ARCHITECTURE.md` §9–10 |
| 5 | Speaker 3 | Figure A architecture | `docs/ARCHITECTURE.md` §1.2, `report/figures/fig-architecture.tex` |
| 6 | Speaker 3 | Figure B 202 → poll → settled | `docs/ARCHITECTURE.md` §3.2, `report/figures/fig-sequence.tex` |
| 7 | Speaker 3 | Figure C offer → timer → tick → backfill | `docs/ARCHITECTURE.md` §5.3 |
| 8 | Speakers 4, 5 | "Live demo" title, the five beats, URL of the dev stage | `docs/DEMO.md` §5 |
| 9 | Speaker 5 | Table 3: target, measured, runs, source | `results/<date>-*/summary.md` |
| 10 | Speaker 5 | backfill latency CDF, performance p95 by VU, mechanism comparison | `results/<date>-backfill/plots/`, `results/loadtest/<date>/`, `results/replay/*.svg` |
| 11 | Speaker 5 | cost table (3 tiers × layers) and crossover chart | `results/cost/model-summary.md`, `results/cost/crossover.png` |
| 12 | Speaker 6 | completion, task time, SUS, pilot facts | `results/user-study/summary.md`, `results/pilot/` |
| 13 | Speaker 6 | limitations, future work, AI use, roles | Final report: conclusion and AI usage declaration |
| B1 | Speaker 4 | demo recording (Plan C), with chapter marks | `docs/DEMO.md` §6 |
| B2–B7 | Speakers 4, 5 | one screenshot per expected demo state (D1, D2, D5a, D3, D5b, D4) | `docs/DEMO.md` §6 Plan D |
| B8 | Q&A | failure-mode table | `docs/ARCHITECTURE.md` §12 |
| B9 | Q&A | DynamoDB key table and the transaction | `docs/ARCHITECTURE.md` §8, §4 |

## Rehearsal checklist

- [ ] Every `[PENDING: …]` in parts 1–6 replaced from its file, or explicitly kept as "not measured
      yet".
- [ ] Two timed run-throughs, each at most 15:00 (plan §3 step 28). Note the clock at each hand-over.
- [ ] Each speaker can answer the three questions at the end of their part without notes, and has
      read [../QA-prep.md](../QA-prep.md).
- [ ] Operator and narrator have done the demo setup in docs/DEMO.md §3 at least once on their own.
