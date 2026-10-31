# Part 6: simulated research package, pilot status, limitations, AI use, close

- **Speaker:** LIANG ZIHAN (user research and evaluation tooling)
- **Clock:** 13:00–15:00 (2:00)
- **Slides:** 12 Research: simulated interviews and usability study; 13 Limitations, future work, AI use and roles; 14 Questions (`report/Slides.tex`)
- **Hands over to:** Q&A (all members; see [../QA-prep.md](../QA-prep.md))

## What to say (about 340 spoken words, 2:15 at 150 words a minute; cut to 2:00 in rehearsal)

**Slides 12–14.** Read the [generated speaking notes](../../results/research/presentation-notes.en.md)
(about 270 words: slide 12, slide 13, close). They are regenerated with the dataset, so the spoken
figures equal the report's and the slides' (`report/generated/research.tex`). Their first sentence
says what the study is: simulated, authored scenarios, generated responses, nobody recruited or
observed. Never drop that sentence; the audience hears nothing else that says it.

**After the slide-12 notes, add (pilot status, about 30 words):** "The live pilot has not run
either: its 3–4 November slot lapsed and is to be rebooked; our 17 October rehearsal used synthetic
accounts, so it is staged, not user evidence."

**With the slide-13 notes, add (AI use and roles, about 25 words):** "Two assistants generated the
work: Claude Code the code, tests and report text, Codex the simulated research package; scope, rules
and targets are ours."
Point at the work lines on the slide instead of reading them; the name-to-line mapping was approved
by the team on 2026-10-24 (`docs/ai-declaration-drafts.md`).

**Slide 14.** Thank you. We are happy to take questions.

Read the full [research report](../../results/research/summary.md) and the
[research guide](../research/README.md) before presenting.

## Key numbers

Every research value below is an output of the simulated scenario (seed 20261031), not a measurement
of people; say "simulated" or "generated" whenever you quote one.

| Number | Value | Source |
|---|---|---|
| Interview profiles (students / organisers), authored | 6 / 3 | `results/research/interviews.csv`; `results/research/summary.json` (`\SimInterviewStudents`, `\SimInterviewOrganisers`) |
| Generated study profiles (participant / organiser track); task attempts; SUS forms | 12 (8 / 4); 112; 24 | `results/research/summary.json` (`\SimStudyN`, `\SimTaskAttempts`, `\SimSusForms`) |
| Unassisted completion, SeatRelay vs control | 89.3 % vs 78.6 % (reference line ≥ 90 %: not met) | `results/research/summary.json` (`\SimCompletionSR`, `\SimCompletionCtrl`) |
| SUS mean, SeatRelay vs control | 69.4 vs 53.3 (reference ≥ 75: not met) | `results/research/sus-sheet.csv`; `summary.json` (`\SimSusSR`, `\SimSusCtrl`) |
| Median paired time reduction; profiles faster with SeatRelay | 38.7 %; 9 of 12 (reference ≥ 25 %: met) | `results/research/paired-subjects.csv`; `summary.json` (`\SimPairedReduction`, `\SimFasterProfiles`) |
| Organiser manual actions, median over four tasks | 13.5 vs 28.0 | `summary.json` (`\SimStepsSR`, `\SimStepsCtrl`) |
| Errors / help requests, SeatRelay vs control | 15 / 8 vs 24 / 14 | `summary.json` (`\SimErrorsSR`, `\SimHelpSR`, `\SimErrorsCtrl`, `\SimHelpCtrl`) |
| Scenario market inputs | p = 37.0 % (20 of 54 events of the 3 organiser profiles), h = 4.0 h, bargain S$8 / expensive S$15 a month | `summary.json` (`\SimMultiSessionPct`, `\SimCoordinationHours`, `\SimBargainSgd`, `\SimExpensiveSgd`) |
| Live pilot | not run (3–4 Nov slot lapsed; to be rebooked); `results/pilot/` absent | Final §4.5, Table 5 (`\PilotWorkshops` pending) |
| Staged pilot rehearsal (synthetic accounts, scripted; not user evidence) | 20 participants; 43/43 commands applied; 9 seats relayed (expiry relays 72–74 ms; decline, cancellation and capacity relays 0 ms); 42 notifications to the SES mailbox simulator; 85/85 checks; invariants held at all 8 checkpoints | `results/2026-10-17-pilot-rehearsal-3/summary.md` (`\Rehearsal*`) |
| Roles (work lines of the Preliminary report) | as in the AI usage declaration; approved by the team 2026-10-24 | `docs/ai-declaration-drafts.md` |
| SES production access | granted 2026-10-24 (50,000 per 24 h, 14/s); denied 2026-10-17 while the sender was unverified | `results/2026-10-24-ses-production-check/`, `docs/deployment-state.md` |
| Cognito sign-up codes | default mailer, 50 per day | `results/2026-10-24-ses-production-check/summary.md` |
| Region and recovery | `ap-southeast-1`; DynamoDB point-in-time recovery enabled | `services/aws/templates/app.yaml` (`PointInTimeRecoveryEnabled: true`) |

## Likely questions

**Q1. How many people took part?**
None. The research is simulated: nine authored interview profiles and twelve generated participant
profiles (seed 20261031, `results/research/manifest.json`). It demonstrates the evaluation workflow
and the trade-offs the scenarios encode; it is not evidence about users. The real interviews, the
12-student study and the live pilot promised in the Preliminary report were not held; the report says
so in §4.4, Table 5, §4.5 and the declaration. If asked why: no participants were recruited before
the deadline, and we chose a labelled simulation over a padded sample.

**Q2. Why compare against Google Forms and a spreadsheet, and not Eventbrite?**
Because that is the strongest free baseline for this task and what small organisers commonly use
(organisers' actual tool use was not surveyed). The control got its best case, with duplicate-detection
formulas pre-built (`docs/user-study/control-condition-setup.md`). A tool with per-date waitlists would
still leave the cross-session duplicate problem, which is the part SeatRelay changes; in the engine
simulation per-session forms left 3.87 duplicate confirmed seats per workshop (`results/replay/summary.md`).

**Q3. How did you use AI, and how did you check what it produced?**
Answer from the declaration: Claude Code generated the code, infrastructure, tests, experiment scripts,
documentation and the report, slide and poster text and ran the deployments and measurements with our
credentials; Codex authored the interview scenarios, generated the task and SUS responses and wrote
§4.4 and the companion report. The checks did not depend on trusting the generated work: property tests
and a coverage threshold on the engine; CI on every push; the Table 3 experiments against the deployed
system with `verify` after every step; every measured number generated from `results/` by
`report/tools/report_numbers.py` and traced by `check_numbers.py`; and the research package reproduced
from its sources by `tools/research/simulate.py --check --check-figures` on every build. The scope,
rules and acceptance targets are ours, from the Preliminary report; the members' statements were drafted
by the assistant and approved by the team.
