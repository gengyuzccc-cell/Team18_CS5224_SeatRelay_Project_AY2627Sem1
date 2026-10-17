# Part 6: user study and pilot, limitations, future work, AI use, division of work

- **Speaker:** (team member)
- **Clock:** 13:00–15:00 (2:00)
- **Slides:** 12 User study and pilot, 13 Limitations, future work, AI use, division of work
- **Hands over to:** Q&A (all members; see [../QA-prep.md](../QA-prep.md))

## What to say (about 340 words)

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

**Slide 13, limitations and future work.**
- **Serialised writes per workshop.** One workshop's writes are processed one at a time. That is the
  price of the ordering guarantee, and it shows in the hot-spot test.
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

**AI use.** [Summarise the AI usage declaration of the Final report in two or three sentences: where
AI assistance was used, how it was directed and reviewed, and what the team did itself.]

**Division of work.** [PENDING: one line per member: name and responsibilities, as in the Final
report.]

Thank you. We are happy to take questions.

## Key numbers

| Number | Value | Source |
|---|---|---|
| Participants run, by track (participant / organiser) | [PENDING] (plan: 12, of whom 4 organisers) | `results/user-study/summary.md` (`\StudyParticipants`, `\StudyParticipantTrack`, `\StudyOrganiserTrack`) |
| Key-task completion, SeatRelay vs control | [PENDING] (target ≥ 90 %) | same (`\StudyCompletionSRPct`, `\StudyCompletionCtrlPct`) |
| Median paired task time, improvement and Wilcoxon p | [PENDING] (target ≥ 25 %) | same (`\StudyTimeImprovementPct`, `\StudyTimeWilcoxonP`) |
| SUS, SeatRelay mean and 95 % CI | [PENDING] (target ≥ 75) | same (`\StudySusSRMean`, `\StudySusSRLo`, `\StudySusSRHi`) |
| Errors and help requests | [PENDING] | same (`\StudyErrorsSR`, `\StudyHelpSR`) |
| Pilot: workshops, registrations, confirmed, cancelled, backfills, attended, distinct participants | [PENDING] | `results/pilot/` (`\PilotWorkshops`, `\PilotRegistrations`, `\PilotBackfills`, `\PilotAttended`, `\PilotDistinctParticipants`) |
| SES production access | denied on 2026-10-17 (sender identity not yet verified) | `docs/deployment-state.md` |
| SES sandbox limits | verified recipients only, 200 mails per 24 h, 1 mail/s | `docs/deployment-state.md` |
| Region and recovery | `ap-southeast-1`; DynamoDB point-in-time recovery enabled | `services/aws/templates/app.yaml` (`PointInTimeRecoveryEnabled: true`) |
| Cognito share of the 100k list price | US$500 of US$591.04 per month (the Lite-tier sensitivity is in `docs/COST.md` §7, not in a results file; do not quote its figure) | `results/cost/model-summary.md` §4 |

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

The team made the design decisions, reviewed the changes, deployed the stacks, and ran the
experiments, the user study and the pilot.
