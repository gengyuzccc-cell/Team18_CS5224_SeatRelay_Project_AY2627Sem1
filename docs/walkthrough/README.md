# Presentation walkthrough (15 min talk + 10 min Q&A)

Speaker notes for the 13 November presentation (plan §7.2). Every member speaks. One file per part.
The slides are `report/Slides.tex` (build: `cd report && latexmk -pdf Slides.tex`, or
`./report/build.sh -t Slides -m 30` for the same build plus its checks; add `-s` for the copy with
student numbers on the title slide, `report/Slides-submission.pdf`, git-ignored). Every slide shows
its speaker in the footer tag. Main slides are numbered 1–14; backup slides are B1–B8 (PDF pages
15–22).

| Part | File | Speaker | Clock | Length | Slides |
|---|---|---|---|---|---|
| 1 | [part-1.md](part-1.md) | LI ZONGZE | 0:00–2:00 | 2:00 | 1 Title, 2 Problem and market, 3 Business model |
| 2 | [part-2.md](part-2.md) | CHEN YANG | 2:00–4:00 | 2:00 | 4 Mechanism and rules |
| 3 | [part-3.md](part-3.md) | LIN JIE | 4:00–6:00 | 2:00 | 5 Architecture, 6 Request path (202 → poll → settled), 7 Timers and sweep |
| 4 | [part-4.md](part-4.md) | ZHU GENGYU narrates D1, D2, D5a, D3; LIANG ZIHAN operates, then narrates D5b and D4 | 6:00–11:00 | 5:00 | 8 Live demo (backup B1–B6) |
| 5 | [part-5.md](part-5.md) | LIANG ZIHAN | 11:00–13:00 | 2:00 | 9 System results (Prelim. Table 3 = Final Table 5), 10 Latency, backfill and mechanism comparison, 11 Cloud vs on-prem cost |
| 6 | [part-6.md](part-6.md) | ZHANG TIANYI | 13:00–15:00 | 2:00 | 12 User study and pilot, 13 Limitations, future work, AI use and roles, 14 Questions |

Q&A preparation for the whole project: [../QA-prep.md](../QA-prep.md).

**Who speaks which part.** Parts 1–6 go to the six members in the order of the title block (the
same order the Final report's AI declaration uses for the work lines, `docs/ai-declaration-drafts.md`).
That mapping has not been confirmed by the team yet. If the team splits the talk differently, change
the names here, in the six part files, and in the `\speaker{...}` lines of `report/Slides.tex`.
Two overlaps to decide before the rehearsal, because Q&A tends to probe them: slide 11 (cost and the
on-prem reference) is presented by LIANG ZIHAN, while the on-prem reference is ZHU GENGYU's work line;
slide 12 (user study) is presented by ZHANG TIANYI, while user research is LIANG ZIHAN's work line. One
fix is to let ZHU GENGYU present slide 11 right after LIANG ZIHAN's slide 10, and to let the owner of
user research take the user-study questions in Q&A.

## Timing

- The plan gives each speaker about 2.5 minutes. The demo has a 5:00 slot (6:00–11:00; `docs/DEMO.md`
  §4 follows this table), so it is shared by Parts 4 and 5, and the five slide parts get 2:00 each:
  5 × 2:00 + 5:00 = 15:00.
- The spoken text of Parts 1, 2, 3 and 5 is at most 280 words and Part 6 about 300 (counted without
  slide labels, stage directions and [PENDING] markers): about 1:52 and 2:00 at 150 words per minute,
  about 1,410 words or 9:25 for the five slide parts. That leaves about 30 s for hand-overs and the switch to
  the demo. A spoken [PENDING] value adds a few words; keep it to the number.
- Re-time every part with a stopwatch in the first rehearsal (checklist below); if a part runs over
  2:00, cut it, do not speak faster.
- If the demo runs on the local stack (Plan B), the crash-recovery beat takes seconds instead of two
  minutes. Give the time saved to Part 5.
- Hand-overs are written into the notes ("Next, CHEN YANG …").

## Numbers: rules for every speaker

1. **Quote only the numbers in your part's "Key numbers" table.** Each row names the file under
   `results/` (or the cited source) it comes from. The macro name in the table is the same number in
   `report/generated/numbers.tex`, which is generated from those files by `report/tools/report_numbers.py`.
   The slides and the Final report both print these macros, so a slide always shows the report's digits.
2. A value written **[PENDING: …]** does not exist yet, and the slide shows the same red marker.
   Before the first timed rehearsal, re-run `report/tools/report_numbers.py`, rebuild the slides and
   replace the marker here with the value from the named file. If it still does not exist on the
   day, say "not measured yet". Never estimate, round up, or quote a number from memory or chat.
3. Status on 2026-10-17 (evening):
   - Prelim. Table 3 (Final Table 5) on dev: all eight scripted experiments ran, three runs each. Six pass. Concurrency and backfill
     fail: requests got HTTP 503 responses, and the backfill run aborted at its first request. The
     cause is still open, and the re-runs wait for the Lambda concurrency quota increase (the account
     quota is 10).
   - k6 matrix on dev: complete. All targets were met only at 10 virtual users. The on-prem matrix
     on the local stack is complete: on the median of three rounds it met the targets up to 50 VUs,
     but two single rounds at 50 VUs exceeded 5 s, and it has no network hop.
   - Staged pilot rehearsal on the pilot stage (`results/2026-10-17-pilot-rehearsal-3/`): synthetic
     accounts and scripted actions. It is operational evidence, not user evidence; say "staged" every
     time you mention it.
   - No results yet: the interviews, the user study, the live pilot, the core property-test record
     and the measured-usage cost snapshot.
   - Final: the dev smoke run (`results/2026-10-17-smoke/`), the mechanism comparison
     (`results/replay/`) and the cost model (`results/cost/model-summary.md`).
4. Values seen during the demo are demo values. The rehearsal values in the DEMO.md appendix are not
   report measurements.
5. A missed target is reported as missed, with the measured value and the explanation.

## Slide ownership and backup slides

| Slide | Owner | Content | Source |
|---|---|---|---|
| 1 | LI ZONGZE | title, team, repository URL | README §1 |
| 2 | LI ZONGZE | problem, SeatRelay in one line, market figures (≥ 693 organisations, 11 of 37 repeats, campus market × p) | Final report §1, Table 1; `results/market/` |
| 3 | LI ZONGZE | pricing, value test, interview figures (pending), simulated duplicate clean-up, competitors | Final report §2, Table 2; `results/replay/summary.md` |
| 4 | CHEN YANG | Fig. 1 flow, R1–R7 and C1–C7 one line each (abridged; full wording in Final report Table 4) | Final report Fig. 1, Table 4; `docs/ARCHITECTURE.md` §9–10 |
| 5 | LIN JIE | architecture (Final report Fig. 2) | `docs/ARCHITECTURE.md` §1.2, `report/figures/fig-architecture.tex` |
| 6 | LIN JIE | 202 → poll → settled (Fig. 3a) and the transaction | `docs/ARCHITECTURE.md` §3.2, `report/figures/fig-sequence.tex` |
| 7 | LIN JIE | offer → timer → tick → backfill (Fig. 3b) and the sweep | `docs/ARCHITECTURE.md` §5.3, §6 |
| 8 | ZHU GENGYU, LIANG ZIHAN | "Live demo": the beats D1, D2, D5a, D3, D5b, D4, the dev URL, the backup note | `docs/DEMO.md` §5–6 |
| 9 | LIANG ZIHAN | Prelim. Table 3 verdicts, one tile per aspect with its key value | Final report Table 5; `results/2026-10-17-*/summary.md` |
| 10 | LIANG ZIHAN | k6 settle and read p95 by virtual users; duplicate holds per simulated workshop (slide-size charts `slide-loadtest.pdf`, `slide-replay.pdf`); backfill line | Final report §4.2–4.3 (Figs. 4 and the replay figure); `results/loadtest/2026-10-17/`, `results/replay/` |
| 11 | LIANG ZIHAN | cost table (3 loads × cloud and on-prem views) and crossover chart | Final report §2 (cost, its Table 3); `results/cost/model-summary.md` |
| 12 | ZHANG TIANYI | student interviews, user study, live pilot (planned, not yet run); staged rehearsal, labelled as staged | Final report §4.4–4.5; `results/user-study/`, `results/pilot/`, `results/2026-10-17-pilot-rehearsal-3/` |
| 13 | ZHANG TIANYI | limitations, future work, AI use, roles | Final report §5 and AI usage declaration |
| 14 | ZHANG TIANYI | thank you, questions, repository URL | — |
| B1 | ZHU GENGYU | demo recording (Plan C), chapter marks | `docs/demo/backup-demo-chapters.txt`, `docs/DEMO.md` §6 |
| B2–B5 | ZHU GENGYU, LIANG ZIHAN | screenshots of D1–D4 from the staged walkthrough (Plan D): other accounts and data than the live click path, so narrate them with the fallback script in part-4.md | `docs/demo/screenshots/`, `docs/DEMO.md` §6, §9 |
| B6 | LIANG ZIHAN | D5 has no screenshot: what the repeat-execution and failure-recovery runs recorded | `results/2026-10-17-repeat-execution/`, `results/2026-10-17-failure-recovery/` |
| B7 | LIN JIE (Q&A) | failure modes and what happens | `docs/ARCHITECTURE.md` §12 |
| B8 | LIN JIE (Q&A) | DynamoDB keys and the one transaction per decision | `docs/ARCHITECTURE.md` §8, §4 |

## Rehearsal checklist

- [ ] Every `[PENDING: …]` in parts 1–6 replaced from its file, or explicitly kept as "not measured
      yet".
- [ ] The speaker mapping above confirmed by the team (or changed in the three places named above).
- [ ] Two timed run-throughs, each at most 15:00 (plan §3 step 28). Note the clock at each hand-over.
- [ ] Each speaker can answer the three questions at the end of their part without notes, and has
      read [../QA-prep.md](../QA-prep.md).
- [ ] Operator and narrator have done the demo setup in docs/DEMO.md §3 at least once on their own.
