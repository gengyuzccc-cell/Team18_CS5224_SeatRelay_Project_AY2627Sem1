# Submission checklist (deadline: 13 Nov 2026)

Every action that remains before `Final.pdf` and `Slides.pdf` are submitted, with the owner role and the
file each action changes. Owners are the Preliminary report's work lines; the names in brackets follow
the assignment in `docs/ai-declaration-drafts.md`, which the team must confirm or correct.

Rules that apply to every row:

- **No invented data.** Interview, study and pilot numbers come only from the files named below, and only
  after the event really happened. A short or small sample is reported as it is (Prelim §5).
- **Staged is labelled staged.** Rehearsed or scripted activity (for example
  `results/<date>-pilot-rehearsal/`) is logged and reported separately from natural pilot events, everywhere
  it appears.
- **Student numbers** stay in the git-ignored `report/team-ids.tex`; only the submission build
  (`./report/build.sh -t Final -m 10 -s`) prints them, into the git-ignored `report/Final-submission.pdf`.
- A step is done when its `\pending{...}` marker is gone from the report and `./report/build.sh -t Final -m 10`
  still prints `pages<=10 overfull=0 undefined=0`.

## 1. Team-only evidence (people, not scripts)

| # | Action | When | Owner (role) | Files it changes | Report marker it clears |
|---|---|---|---|---|---|
| 1.1 | Interview 4–6 students and 2–3 organisers with `docs/interviews/guide-*.md` (verbal consent, codes only, non-team) | 16–24 Oct | user research and evaluation tooling (LIANG ZIHAN) + any member | `results/interviews/I__.md`; `results/interviews/interviews.csv` (header copied from the template `docs/interviews/interviews.csv`, no `EXAMPLE` rows); `results/interviews/summary.md` | the 9 `interviews not yet done` markers (p, hours per event, WTP; §1, §2, Table 1) |
| 1.2 | Decide the serviceable share `s` (from the organiser interviews) and the team's assumed adoption share `a`; write both with their basis | after 1.1 | product and front end (LI ZONGZE) | `docs/market-sizing.md` §3–4; `report/sections/01-motivation.tex` (Market size paragraph) | `$s$ from the organiser interviews; the team's assumed adoption share $a$` |
| 1.3 | Open the NUS (`nus-osa-getstarted`), SMU (`smu-osl-2022`) and SIT (`sit-find-your-tribe`) pages in a browser and save dated screenshots; if a figure changed, update the count | before 10 Nov | data and the local reference (ZHU GENGYU) | `results/market/screenshots/<key>-<date>.png` (new); `report/sources.md` (verification column); `docs/market-sizing.md` §8; then `report/sections/07-declaration.tex` (Assumptions) | `dated browser screenshots of these three pages` |
| 1.4 | Book the pilot workshop (two sessions of identical content, registration open ≥ 5 days), run it on the `pilot` stage, export the organiser CSVs and the dashboard's backfill log; log natural cancellations separately from rehearsed (staged) events | dates by 22 Oct; run ~3–4 Nov | organiser dashboard, QA and documentation (ZHANG TIANYI) with product (LI ZONGZE) | `results/pilot/*.csv` (or `results/<date>-pilot/`); observation notes in `results/pilot/notes.md`; `report/sections/04-evaluation.tex` §4.5 | `pilot not yet run`; `pilot workshop, dates and observations …` |
| 1.5 | User study: 2-person pilot run (excluded), then 12 non-team university students (Prelim §5; ≥ 4 with organising experience; no staff), counterbalanced, per `docs/user-study/protocol.md` | 29 Oct – 5 Nov | user research and evaluation tooling (LIANG ZIHAN) + facilitator/note-taker | `docs/user-study/session-sheet.csv`, `docs/user-study/sus-sheet.csv` (delete the `EXAMPLE` rows), then `python3 docs/user-study/analysis.py` → `results/user-study/` (`summary.md`, charts); `results/user-study/study-log.md`, `interview-notes.md` by hand | `user study not yet run`; `user-study results …`; `user-study charts …` |
| 1.6 | Write the H1 verdict and the organiser side of H3 from the study results (only what the data support) | after 1.5 | user research (LIANG ZIHAN) | `report/sections/04-evaluation.tex` §4.6; `report/sections/05-conclusion.tex` | the `H1 verdict …` / `H3: compare the organiser's manual steps …` markers that appear automatically once the study data exist |
| 1.7 | Each member confirms or rewrites their own "what I learned" paragraph (≤ 45 words, first person), says how they reviewed the generated work and whether they approved deployments, and confirms the member-to-line mapping (the report prints none of this until then; slide 13 marks the mapping provisional) | 6–10 Nov | every member | `docs/ai-declaration-drafts.md` (tick the box); `report/sections/07-declaration.tex` | `confirmation by each member, docs/ai-declaration-drafts.md` |
| 1.8 | One named member checks every number in the PDF against `results/` (macro → file map in `report/generated/README.md`) and enters their name | after the last regeneration (3.1) | organiser dashboard, QA and documentation (ZHANG TIANYI) | `report/sections/07-declaration.tex` | `name of the member who did the check` |
| 1.9 | Done 24 Oct: SES production access granted (case `179219791000451`; 50,000/day, 14/s), e-mail on in `dev` and `pilot`, check in `results/2026-10-24-ses-production-check/`. Still open: confirm the SNS e-mail subscriptions (`seatrelay-ses-feedback`, `seatrelay-dev-alarms`); tell pilot participants to check their spam folder (sender is a gmail.com address) | done | AWS and monitoring (LIN JIE) | `docs/deployment-state.md` (SES section) | none (affects whether pilot participants get e-mail) |

## 2. Technical re-runs (anyone with the AWS credentials)

History: the account's Lambda concurrency quota was raised from 10 to 1000 on 2026-10-17 (case
`179224956500721`; `docs/deployment-state.md`). The first series' HTTP 503s were throttling under the
old quota (`results/2026-10-17-throttling-evidence/`). Rows 2.1–2.5 are done; they stay listed with
their evidence.

| # | Action | Owner (role) | Files it changes | Report marker it clears |
|---|---|---|---|---|
| 2.1 | Done: cause in `results/2026-10-17-throttling-evidence/summary.md`; re-runs `results/2026-10-17-concurrency-2/` (39/39) and `results/2026-10-17-backfill-2/` (124/124); Final §4.2 and Fig. 5 | AWS and monitoring (LIN JIE) | `results/2026-10-17-concurrency-2/`, `results/2026-10-17-backfill-2/`; `report/sections/04-evaluation.tex` ("The first series failed, and why") | resolved |
| 2.2 | Done: `results/loadtest/2026-10-17/summary.md`, run `20261017T192002Z` at `d121145`, 6/6 levels met, 0.00 % errors; Final §4.2 Latency | AWS and monitoring (LIN JIE) | `results/loadtest/2026-10-17/`; `report/sections/04-evaluation.tex` ("Latency") | resolved |
| 2.3 | Done: `results/2026-10-17-table3-dev-q1000-provenance.md` (series from a clean worktree at `e05c037`, deployed bundles identical); Final §4.1 | AWS and monitoring (LIN JIE) | `results/2026-10-17-table3-dev-q1000-provenance.md`; `report/sections/04-evaluation.tex` (Method) | resolved |
| 2.4 | Done: `results/2026-10-17-core-tests/` (`run.log`, `coverage-summary.json`, `commit.txt`; `docs/EXPERIMENTS.md` §3.2) | allocation logic and API (CHEN YANG) | `results/2026-10-17-core-tests/` | resolved |
| 2.5 | Price measured usage: done for 17 Oct from CloudWatch (`python3 tools/experiments/cost/cloudwatch_usage.py --date 2026-10-17 --price`, window 00:00–20:20 UTC); optionally re-run after the day ends for the full day, and cross-check with `tools/scripts/bin/cost-snapshot.sh` + `model.py --from-snapshot` once Cost Explorer has billed the day | data and the local reference (ZHU GENGYU) | `results/cost/usage-2026-10-17-cloudwatch.{json,md}`, `results/cost/usage-priced.md` | resolved in §2 (US$3.25 list, US$1.19 after free tier); the measured unit cost stays open because CloudWatch has no registration count |

## 3. Build and submit

| # | Action | When | Owner (role) | Files it changes |
|---|---|---|---|---|
| 3.1 | Regenerate numbers and charts, then build: `python3 -I report/tools/report_numbers.py && python3 -I report/tools/make_figures.py && ./report/build.sh -t Final -m 10` must print `placeholders=0` and `pages<=10`. The user-study figure is printed only once its chart exists; it needs about 5 cm, so shorten the text named in the comments of `report/sections/04-evaluation.tex` when it arrives | after every new result; final run 12 Nov | organiser dashboard, QA and documentation (ZHANG TIANYI) | `report/generated/{numbers.tex,README.md,pending.tex}`, `report/figures/generated/*.pdf`, `report/Final.pdf` |
| 3.2 | Submission build with student numbers: make sure `report/team-ids.tex` exists (recreate from the Preliminary report if missing), then `./report/build.sh -t Final -m 10 -s` | 12–13 Nov | same | `report/Final-submission.pdf` (git-ignored) |
| 3.3 | Build the slides after step 3.1 (same `numbers.tex`, so the slides show the report's numbers): `./report/build.sh -t Slides -m 30 -s` must print `placeholders=0`; it writes `report/Slides-submission.pdf` with the student numbers on the title slide (git-ignored; without `-s`, `report/Slides.pdf` shows names only). Look at every page (`pdftoppm -r 50`), then rehearse twice (every member speaks; `docs/walkthrough/`, `docs/DEMO.md`, backup recording) | 11–12 Nov | product and front end (LI ZONGZE) + every member | `report/Slides.tex` (only if a slide must change), `docs/walkthrough/*.md` |
| 3.4 | Upload to Canvas: `report/Final-submission.pdf` renamed to **`Final.pdf`**, and `report/Slides-submission.pdf` renamed to **`Slides.pdf`**; a second member downloads both and checks pages, names and student numbers | 13 Nov | one member submits, another verifies | none in the repository |
| 3.5 | Every member completes the peer assessment (missing = 0 marks) | 13 Nov | every member | none |
| 3.6 | Keep the public repository URL reachable until grades are out; after the presentation tear down the `dev` stage (app and web stacks; auth and pilot stay) with `STAGE=dev tools/scripts/bin/teardown.sh` | after 13 Nov | AWS and monitoring (LIN JIE) | `docs/deployment-state.md` |
