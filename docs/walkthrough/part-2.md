# Part 2: mechanism and rules

- **Speaker:** CHEN YANG (allocation logic and API)
- **Clock:** 2:00–4:00 (2:00)
- **Slide:** 4 Mechanism and rules (`report/Slides.tex`): the Fig. 1 flow at the top; below it R1–R7 and
  C1–C7, one line each, abridged from the Preliminary report (full wording: Final report Table 4)
- **Hands over to:** Part 3 (architecture)

## What to say (about 280 spoken words, 1:50 at 150 words a minute)

Let me follow one participant, Mei, through the flow at the top of the slide.

Mei ticks the sessions she can attend, in order: Session 3 first, then Session 1. She can have only
one live registration per workshop, **R1**. Her place in line is the order her request reached the
workshop's queue, **R2**.

Whenever a seat may be free, the engine scans the queue in that order and offers each person the first
session on their own list that still has a seat, **R3**, so Mei never gets a session she did not list.

An offer is a timed hold: 15 minutes by default, and never past the cut-off half an hour before the
session, **R4**. If Mei declines or lets it expire, only that session
leaves her list and she keeps her number; with no session left, her registration ends, **R5**. If she
cancels, she leaves the whole workshop, and her seat goes to the next person in the same step, **R6**.
A confirmed seat is never taken away automatically, and organisers cannot cut capacity below the seats
in use; added seats are offered at once, **R7**.

Below the rules are the seven constraints. A session is never over capacity, **C1**; nobody holds two
seats in one workshop, **C2**; a repeated request never applies twice, **C3**; each decision is one
transaction, **C4**; expiry follows the server clock, so a stale timer does nothing, **C5**; a failed
e-mail never undoes a seat, **C6**; and only the owning organisation can manage a workshop, **C7**.
Organisers can check them with *Verify invariants*; our experiments run that check after every step.

Next, LIN JIE shows how this runs on AWS.

## Key numbers

| Number | Value | Source |
|---|---|---|
| Hold time per workshop | default 900 s, minimum 30 s, maximum 86,400 s | `packages/contracts/src/constants.ts` (configuration) |
| Registration cut-off | 30 min before the session starts | `CUTOFF_BEFORE_START_SECONDS`, same file |
| Sessions per workshop | 2–5 | same file |
| Offers per decision | at most 12, then a REALLOCATE continuation | `packages/core/src/state.ts` (`DEFAULT_DECISION_LIMITS`) |
| Engine property test | 2,000 random command sequences (84,983 steps), every invariant held after every step; 127/127 core tests pass, branch coverage 99.8 % | `results/2026-10-17-core-tests/` (`\CorePropertySequences`, `\CorePropertySteps`, `\CoreTestsPassed`, `\CoreBranchCoveragePct`) |
| Preference order on AWS | 20 fixed cases × 3 runs: 60 of 60 as predicted, 0 offers of an unacceptable session (PASS) | `results/2026-10-17-preference-order-2/summary.md` (`\PrefOrderCasesPassed`, `\PrefOrderNonAcceptable`) |
| Duplicate-hold events per workshop (simulation, 1,000 seeds) | 0.00 with one queue, 34.57 with per-session forms | `results/replay/summary.md` |

The configuration values above are design parameters, not measurements. Say so if you are asked.

## Likely questions

**Q1. Is it fair that someone behind me in the queue can get a seat before me?**
Only for a session you did not list. A free seat goes to the earliest person in the queue who
accepts that session (R3, `allocate()` in `packages/core/src/allocate.ts`). You are never passed
over for a session on your own list, and the preference-order experiment checks exactly that. The
order is the order in which the workshop's queue received the requests, not click time. Two requests
a few milliseconds apart are ordered by the SQS FIFO queue.

**Q2. Why remove a declined session instead of keeping me queued for it?**
Otherwise the same seat could come back to the same person who just said no. You keep your number
for your other sessions, so declining one never costs you your place (R5,
`dropSessionFromRegistration()` in `packages/core/src/state.ts`). An expiry is treated like a decline
because no answer means the person could not take it. The notification says what happened and
whether you are still queued.

**Q3. Why 15 minutes by default, and why 60 seconds in your experiments?**
The hold is set per workshop, from 30 s to 24 h. The 900 s default is also the SQS message-timer
maximum, so a default offer needs one timer hop. Longer holds hop through the forwarder in steps of
at most 15 minutes. The experiments use 60 s so that each expiry sample takes one minute instead of
fifteen; the relay path is the same whatever the hold length. How long students find acceptable:
[PENDING: `hold_window_ok_min` median from results/interviews/summary.md].
