# Preliminary report (15 Sep 2026): commitments the Final must honour

Source: `PreliminaryReport_Group18.pdf` (5 pages, submitted 28 Sep 2026; kept by the team, not in this
public repository because it carries student numbers). Quoted wording below is verbatim; the right-hand
columns record where the Final report and the code answer each item. Student numbers live only in the
git-ignored `report/team-ids.tex`, printed only by the submission build `./report/build.sh -t Final -m 10 -s`
(git-ignored `report/Final-submission.pdf`; see `docs/SUBMISSION-CHECKLIST.md`).

Team (Group 18): LI ZONGZE, CHEN YANG, LIN JIE, ZHU GENGYU, LIANG ZIHAN, ZHANG TIANYI.
Work lines (Prelim §4): product and front end; allocation logic and API; AWS and monitoring; data and the local
reference; user research and evaluation tooling; organiser dashboard plus cross-cutting QA and documentation.

## Hypotheses (Prelim §1) — "stated as hypotheses, not findings"

| ID | Wording | Evidence planned for the Final |
|---|---|---|
| H1 | unified registration reduces the participant effort needed to register and track a waitlist | user study: participant task times, completion, errors, help requests (SeatRelay vs per-session forms + spreadsheet) |
| H2 | the cross-session constraint removes the capacity waste caused by one account holding seats in several sessions at once | mechanism comparison (`tools/replay`, 1,000 seeds): duplicate holds, distinct participants served |
| H3 | automatic backfill reduces the organiser's manual handling of cancellations and offers | backfill latency (Table 3), replay duplicate-confirmation clean-up proxy, organiser manual steps in the user study |

"We make no claim about attendance rates, satisfaction or paying customers."

## Allocation rules (Prelim §2)

| ID | Prelim wording (abridged) | Final |
|---|---|---|
| R1 | One verified account holds at most one pending hold or confirmed seat per workshop. No claim to detect one person with several accounts. | unchanged |
| R2 | Queue order is the order in which the server successfully accepts the request. | refined (plan §1.4): queue order = FIFO enqueue order = `seq` assigned by the single-writer worker |
| R3 | Queue scanned in order; most-preferred acceptable session with capacity. | unchanged |
| R4 | Hold 15 min, never past the cut-off (30 min before start); no allocation after cut-off. | hold configurable per workshop, default 900 s, min 30 s (experiments use 60 s) |
| R5 | Decline/expiry removes only that session; none left → registration ends. | unchanged |
| R6 | Cancel leaves the whole workshop; changing the acceptable set = cancel + re-register (back of queue). | unchanged |
| R7 | A confirmed seat is never reassigned automatically; capacity not below confirmed + unreleased holds. | unchanged (an organiser's CANCEL_SESSION re-queues its confirmed people: organiser action, not automatic) |

## Constraints (Prelim §3)

| ID | Prelim wording | Final |
|---|---|---|
| C1 | Confirmed seats plus unreleased holds never exceed a session's capacity. | unchanged |
| C2 | One account never holds seats in several sessions of one workshop at the same time. | unchanged |
| C3 | Every operation carries an idempotency key, so a repeat submission or retry returns the existing result instead of applying the change twice. | client-generated `commandId` |
| C4 | Seat state, capacity and the notification record are updated in one transaction, so a partial update cannot occur. | one `TransactWriteItems` per decision (notification rows included); one SQL transaction on-prem |
| C5 | An expiry task must match a specific offer and version, so a stale task cannot cancel a newer allocation. | **strengthened** to tick semantics (plan §1.2, TA feedback 2): expiry is decided by server time when the worker processes any command; a late/duplicate tick is a no-op; a stale tick can never expire a newer, unexpired offer |
| C6 | A notification failure never rolls back a successful registration; failures are retried and logged, and in-app status stays readable. | notifier runs after commit from the stream; permanent errors → FAILED, transient → retried, DLQ + alarm |
| C7 | The server checks organisation ownership on every resource, rejecting cross-organisation access. | unchanged |

"Expiry is judged by server time. A scheduled task performs the release" → replaced by per-offer SQS delay timers
with the 5-minute sweep as a safety net (TA feedback 2).

## Table 3 targets (Prelim §4) — acceptance targets, verbatim

| Aspect | Scenario and method | Target |
|---|---|---|
| Core correctness | Register, confirm, decline, cancel, capacity change, event cancellation | Zero over-capacity; zero double holds |
| Preference, order | Fixed cases plus randomly generated arrival sequences | Never allocates an unacceptable session |
| Concurrency | 50 requests contending for few seats; one account acting on several sessions | Final state satisfies every invariant |
| Repeat execution | Duplicate submits, message redelivery, response lost after submit | No double decrement or release |
| Expiry race | Confirmation concurrent with expiry; a delayed stale expiry task | Stale offers rejected; newer state intact |
| Failure recovery | Worker killed before and after the transaction; notifier down; task retried | Recoverable and traceable; recovery within 5 min |
| Access control | Confirming another account's offer; cross-organisation dashboard access | All unauthorised operations rejected |
| Performance | 10 / 25 / 50 concurrent users; cross-workshop and single-workshop hot spot separately | Read/accept p95 < 1 s; settled p95 < 5 s |
| Backfill latency | Time from hold expiry to reallocation under normal operation | p95 ≤ 120 s; outliers reported |
| Cost | Cloud bill, resource usage, and the local reference under the same load model | Unit cost and its trend with scale |

Prelim method notes: warm-up, three runs per level, p50, p95, error rate, queue depth; "we measure the time until
the asynchronous operation actually completes, and never use the 202 response time as the service's performance".
Mechanism comparison: one fixed sequence replayed through per-session waitlists vs the unified queue; duplicate
holds, distinct participants served, backfill time; "not a performance measurement of Luma, Eventbrite or Humanitix".

## User evaluation (Prelim §5)

- 4–6 student interviews first, plus a record of what the team's pilot organisers do today.
- 12 non-team university students (≥ 4 with organising experience); a pilot run precedes and is excluded.
- **"If recruitment falls short we report the real sample and its limitations; we do not fabricate participants,
  and we do not mix team members into the independent sample."**
- Control = one form per session + spreadsheet; counterbalanced order; equivalent different data in round 2.
- Targets: critical-task completion ≥ 90 %; median paired task time improved by ≥ 25 %; SUS ≥ 75 (original
  10 items, standard scoring); also errors, help requests, organiser manual steps, short interviews.
- Live pilot: two small sessions of identical content; naturally occurring cancellations and **rehearsed events
  staged to exercise the flow are logged separately**; team-organiser observations = internal operational evidence;
  independent participants' feedback = user evidence.

## Cost (Prelim §3)

Three layers (metered, after free tier, paid after credits). Budget US$15/month × 3 + US$15 reruns, ceiling US$60
against US$120 credits; Budgets alerts are delayed, so throttling, log retention and teardown bound spend.
On-prem: hardware amortisation + electricity + network + backup and e-mail + labour; hardware-only increment vs
fully amortised; sensitivity at low/medium/high load; availability difference stated plainly.

## AI declaration (Prelim §6)

"No AI-generated code appears here; **if code is generated with AI during implementation, the Final report
declares that specifically.** Each member records their own learning from this work."

## Prelim references to keep

[1] Luma help (Waitlist; Multi-Session / Recurring Events) · [2] Eventbrite help (event waitlist; multiple date or
recurring events) · [3] Humanitix help (waitlist) · [4] AWS SQS FIFO · [5] DynamoDB transactions · [6] DynamoDB TTL ·
[7] SES sandbox and sending limits · [8] AWS Budgets · [9] Pricing: API Gateway, Lambda, DynamoDB (Singapore) ·
[10] Brooke 1996, SUS.
