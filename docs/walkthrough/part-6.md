# Part 6: user study and pilot, limitations, future work, AI use, division of work

- **Speaker:** LIANG ZIHAN (user research and evaluation tooling)
- **Clock:** 13:00–15:00 (2:00)
- **Slides:** 12 User study and pilot, 13 Limitations, future work, AI use and roles, 14 Questions
  (`report/Slides.tex`)
- **Hands over to:** Q&A (all members; see [../QA-prep.md](../QA-prep.md))

## What to say (about 300 spoken words, 2:00 at 150 words a minute; the Division-of-work line is not read out)

**Slide 12, user study and pilot.** Our evaluation with independent users has not run yet. The plan: First come four to six student interviews, two to three organiser interviews and a record
of what our own pilot organisers do today. Then twelve non-team university students, at least four with organising experience, will each
use SeatRelay and today's practice, one Google Form per session plus a spreadsheet with
duplicate-detection formulas. Half start with each tool. The targets
are 90 percent task completion, task times 25 percent shorter, and a usability score of at least 75.
Not run yet: the study is planned for 29 Oct to 5 Nov (on the day, give the results if
`results/user-study/summary.md` exists). The live pilot, two sessions of one real workshop, is also
still to come: planned for 3-4 Nov (on the day, give its status from `results/pilot/`).

Before the pilot we rehearsed it on the pilot stage with 20 synthetic accounts and scripted actions.
That is **staged**, not user evidence: all 43 commands were applied, 9 released seats were relayed, and
the invariants held throughout.

**Slide 13, limitations and future work.** One writer per workshop is the price of ordering: hot
workshops settle slower, though within target. A Lambda quota of ten throttled our first runs; the
re-runs passed. We run in one region. SES is out of the sandbox, but our sender is a gmail.com
address, so in-app notifications stay primary and sign-up codes still come from Cognito's default
mailer. The mechanism comparison is a simulation, and the cost is modelled. Next we would
batch commands per workshop, send from our own mail domain with DKIM, and try a cheaper Cognito tier, our largest
cost at scale.

**AI use.** An AI coding assistant generated our code, tests, scripts, documentation, desk research,
and the report, slide and poster text, and ran the deployments and experiments with our credentials.
The scope, rules and targets are ours, from the Preliminary report. The report's declaration gives the
details, with each member's statement of what they learned, drafted by the assistant from the project
record and approved by the team.

**Division of work.** Point at the slide instead of reading it out. The name-to-line mapping was
approved by the team on 2026-10-24 (`docs/ai-declaration-drafts.md`).

**Slide 14.** Thank you. We are happy to take questions.

## Key numbers

| Number | Value | Source |
|---|---|---|
| Participants run, by track (participant / organiser) | [PENDING] (plan: 12, of whom 4 organisers) | `results/user-study/summary.md` (`\StudyParticipants`, `\StudyParticipantTrack`, `\StudyOrganiserTrack`) |
| Key-task completion, SeatRelay vs control | [PENDING] (target ≥ 90 %) | same (`\StudyCompletionSRPct`, `\StudyCompletionCtrlPct`) |
| Median paired task time, improvement and Wilcoxon p | [PENDING] (target ≥ 25 %) | same (`\StudyTimeImprovementPct`, `\StudyTimeWilcoxonP`) |
| SUS, SeatRelay mean and 95 % CI | [PENDING] (target ≥ 75) | same (`\StudySusSRMean`, `\StudySusSRLo`, `\StudySusSRHi`) |
| Errors and help requests | [PENDING] | same (`\StudyErrorsSR`, `\StudyHelpSR`) |
| Pilot: workshops, registrations, confirmed, cancelled, backfills, attended, distinct participants | [PENDING] | `results/pilot/` (`\PilotWorkshops`, `\PilotRegistrations`, `\PilotBackfills`, `\PilotAttended`, `\PilotDistinctParticipants`) |
| Staged pilot rehearsal (synthetic accounts, scripted; not user evidence) | 20 participants; 43/43 commands applied; 9 seats relayed (expiry relays 72–74 ms; decline, cancellation and capacity relays 0 ms); 42 notifications SENT to the SES mailbox simulator; invariants held at all 8 phase checks; 85/85 checks | `results/2026-10-17-pilot-rehearsal-3/summary.md` (`\RehearsalParticipants`, `\RehearsalCommandsApplied`, `\RehearsalBackfills`, `\RehearsalNotificationsSent`, `\RehearsalInvariantReads`) |
| Roles (work lines of the Preliminary report, in title-block order) | as in the AI usage declaration; approved by the team 2026-10-24 | `docs/ai-declaration-drafts.md` |
| SES production access | granted 2026-10-24 (50,000 per 24 h, 14/s); denied 2026-10-17 while the sender was unverified | `results/2026-10-24-ses-production-check/`, `docs/deployment-state.md` |
| Cognito sign-up codes | default mailer, 50 per day | `results/2026-10-24-ses-production-check/summary.md` |
| Region and recovery | `ap-southeast-1`; DynamoDB point-in-time recovery enabled | `services/aws/templates/app.yaml` (`PointInTimeRecoveryEnabled: true`) |
| Cognito share of the 100k list price | US$500 of US$591.24 per month (the Lite-tier sensitivity is in `docs/COST.md` §7, not in a results file; do not quote its figure) | `results/cost/model-summary.md` §4 |

## Likely questions

**Q1. How many people took part, and is that enough?**
On 2026-10-17 the study had not run; on the day, give the real number per track: [PENDING: n per
track, or "not run yet"]. The report gives the real number even where it falls below the plan's 12. With n pairs, the smallest two-sided Wilcoxon p that can occur is 2^(1−n): with
4 organisers it is 0.125, so that track can never reach significance. We report that instead of
hiding it (`docs/user-study/README.md` §7). The completion rate and SUS are reported with their n and
confidence interval, and the pilot adds behaviour from people who were not in the lab.

**Q2. Why compare against Google Forms and a spreadsheet, and not Eventbrite?**
Because that is what organisers do today: [PENDING: tool frequencies from
results/interviews/summary.md]. Forms and a sheet are also the strongest free baseline for this
task. We gave the control its best case, with duplicate-detection formulas pre-built
(`docs/user-study/control-condition-setup.md`). A tool with per-date waitlists would still leave the
cross-session duplicate problem, which is the part SeatRelay changes.

**Q3. How did you use AI, and how did you check what it produced?**
Answer from the AI usage declaration in the Final report: where AI assistance was used, how it was
directed, and what each member learned. The checks did not depend on trusting the generated code:
- property tests and a 95 % coverage threshold on the engine;
- CI on every push;
- the Prelim. Table 3 experiments (Final Table 5) against the deployed system, with `verify` after
  every step;
- every measured number in the report generated from `results/`, never typed in.

The scope, the rules and the acceptance targets are the team's, from the Preliminary report; the
assistant ran the deployment and experiment scripts with the team's credentials. The members'
statements say what each learned; the assistant drafted them and the team approved them. The checks on
the generated work were automated: the engine's property tests and coverage threshold, CI, the
Table 3 experiments with `verify`, and the number trace (`check_numbers.py`). Do not claim a manual
review beyond that. The interviews, the user study and the pilot are run by the team (on 2026-10-24
none had run: study planned 29 Oct-5 Nov, pilot 3-4 Nov; give their status on the day).
