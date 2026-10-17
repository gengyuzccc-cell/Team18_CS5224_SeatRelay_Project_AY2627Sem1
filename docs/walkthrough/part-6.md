# Part 6: user study and pilot, limitations, future work, AI use, division of work

- **Speaker:** ZHANG TIANYI
- **Clock:** 13:00–15:00 (2:00)
- **Slides:** 12 User study and pilot, 13 Limitations, future work, AI use and roles, 14 Questions
  (`report/Slides.tex`)
- **Hands over to:** Q&A (all members; see [../QA-prep.md](../QA-prep.md))

## What to say (about 360 words; the Division-of-work line is not read out)

**Slide 12, user study and pilot.** We compared SeatRelay with what organisers use today: one Google
Form per session plus a shared spreadsheet. We set that up carefully, including duplicate-detection
formulas, so any advantage we find is a conservative one.

[PENDING: n] people outside the team used both tools, half starting with each, with different data
in the second round.
- Key-task completion with SeatRelay was [PENDING], against our target of 90 percent.
- The median paired task time changed by [PENDING] (target: 25 percent faster), with a Wilcoxon p of
  [PENDING].
- SeatRelay's SUS score was [PENDING], with its confidence interval, against a target of 75.

*(If a target was missed, say so here, plainly.)*

In the pilot, [PENDING: number of workshops, registrations, cancellations that were relayed,
attendance, from results/pilot/].

Before the pilot we rehearsed it on the pilot stage with 20 synthetic accounts and scripted
actions. That is **staged**, not user evidence: all 43 commands were applied, 9 released seats were
relayed, and the invariants held throughout. *(optional)* 42 e-mails went to the SES mailbox
simulator.

**Slide 13, limitations and future work.**
- **One writer per workshop, and an open problem under load.** One workshop's writes are processed
  one at a time; that is the price of the ordering guarantee. Under load, settling fell behind above
  10 virtual users, across workshops too, and some requests got HTTP 503. We have not found the
  cause yet.
- **One region.** The managed services are multi-AZ and the table has point-in-time recovery, but a
  regional outage would stop the service.
- **E-mail.** SES production access was denied while our sender address was still unverified, so
  e-mail reaches only verified addresses. Everyone else relies on in-app notifications.
- **Simulation and model.** The mechanism comparison is a simulation, and the cost drivers are
  modelled until our usage snapshots replace them.
- **Small samples.** The interview and study samples are small convenience samples.

Next we would batch commands per workshop to raise hot-spot throughput, obtain SES production
access, and evaluate a cheaper Cognito tier, because Cognito is our largest cost item at scale. *(optional)*
Push updates would only be worth adding if polling ever became the bottleneck.

**AI use.** An AI coding assistant generated our code, tests, scripts, documentation and first
drafts, and ran the deployment and experiment scripts with our credentials. We set the scope, rules
and targets, reviewed what it produced and approved every deployment; no measured number was typed
by hand. *(optional)* The report's AI declaration gives the details and what each of us learned.

**Division of work.** Point at the slide instead of reading it out. It shows: LI ZONGZE, product
and front end; CHEN YANG, allocation logic and API; LIN JIE, AWS and monitoring; ZHU GENGYU, data and
the on-prem reference; LIANG ZIHAN, user research and evaluation tooling; ZHANG TIANYI, organiser
dashboard, QA and documentation. [PENDING: each member confirms their line,
`docs/ai-declaration-drafts.md`.]

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
| Roles (work lines of the Preliminary report, in title-block order) | as in the AI usage declaration; [PENDING: each member to confirm] | `docs/ai-declaration-drafts.md` |
| SES production access | denied on 2026-10-17 (sender identity not yet verified) | `docs/deployment-state.md` |
| SES sandbox limits | verified recipients only, 200 mails per 24 h, 1 mail/s | `docs/deployment-state.md` |
| Region and recovery | `ap-southeast-1`; DynamoDB point-in-time recovery enabled | `services/aws/templates/app.yaml` (`PointInTimeRecoveryEnabled: true`) |
| Cognito share of the 100k list price | US$500 of US$591.24 per month (the Lite-tier sensitivity is in `docs/COST.md` §7, not in a results file; do not quote its figure) | `results/cost/model-summary.md` §4 |

## Likely questions

**Q1. How many people took part, and is that enough?**
We ran [PENDING: n per track] sessions, and the report gives the real number even where it falls
below the plan's 12. With n pairs, the smallest two-sided Wilcoxon p that can occur is 2^(1−n): with
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
- the Table 3 experiments against the deployed system, with `verify` after every step;
- every number in the report generated from `results/`, never typed in.

The team set the scope, the rules and the acceptance targets, reviewed the changes and approved
each deployment; the assistant ran the deployment and experiment scripts with the team's
credentials. The interviews, the user study and the pilot are run by the team.
