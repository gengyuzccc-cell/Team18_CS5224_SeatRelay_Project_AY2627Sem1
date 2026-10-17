# Part 4: live demo

- **Speaker:** (team member), narrator for beats D1, D2, D5a and D3
- **Operator:** the Part 5 speaker drives every window and the terminal. They also narrate D5b and
  D4, then continue straight into Part 5.
- **Clock:** 6:00–11:00 (5:00)
- **Slide:** 8 "Live demo" (dev stage URL `https://d2ni5e1z674t04.cloudfront.net`). Backup: B1
  recording with chapter marks, B2–B7 one screenshot per beat.
- **Script:** `docs/DEMO.md` is the authority for setup (§3), click path (§5), fallback (§6), reset
  (§7) and troubleshooting (§8). This file compresses its §5 to 5:00 and assigns the lines.

## Before the slot

- Plan A is the dev stage. Run the T−30 and T−20 steps of `docs/DEMO.md` §3: health, `AllowFaultFlags`,
  empty DLQs, `seed-demo --hold 3600`, the *Expiry demo* workshop with a 60 s hold, and `$BODY` with
  `_fault: AFTER_COMMIT` in the terminal.
- At T−5, click *Verify invariants* on both dashboards. *Demo workshop* shows held 1/1/1 and an empty
  queue.
- Decide Plan A, B (local stack) or C (recording) before the talk starts, and say which one is
  running.

## Beat timing

| Talk clock | Beat | Operator does | Narrator |
|---|---|---|---|
| 6:00–6:50 | D1 register → offer → accept | Window A: tick Session 3, then Session 1 → Register; then Accept seat; Window O: Refresh | Speaker 4 |
| 6:50–7:40 | D2 cancellation → instant backfill | Window B: Session 1 → Register (queued #1); Window A: Cancel my seat → Yes; Window B: Accept seat; Window O: Refresh, point at the backfill log | Speaker 4 |
| 7:40–8:20 | D5a crash after commit | Terminal: the three `curl` commands of DEMO.md D5a (POST at about 7:45) | Speaker 4 |
| 8:20–10:00 | D3 60 s hold expires → automatic backfill | *Expiry demo* tab: A registers (offer), B registers (queued); Window O: Refresh; wait; B refreshes and accepts; Window O: Refresh, point at the backfill log | Speaker 4 |
| 10:00–10:30 | D5b exactly once, proven | Terminal: the log query and the `GET /commands/$CMD` of DEMO.md D5b (at least 135 s after the D5a POST); Window O: Refresh | Speaker 5 |
| 10:30–11:00 | D4 verify invariants | Window O: Verify invariants on both workshops | Speaker 5 |

D5a comes before D3 on purpose. On dev the crashed message returns after the 120 s visibility
timeout, and the expiry beat fills that wait. It also shows that a stuck message pauses only its own
workshop. Do not send any command to *Demo workshop* between D5a and D5b.

## What to say

### Speaker 4 (about 340 words, spread over 4 minutes of clicking and waiting)

**D1.** On the left is the organiser's dashboard; on the right are two participants. All of this is
running live on our dev stage on AWS. The workshop has three sessions. Session 3 is already held,
and Sessions 1 and 2 have one seat each. Demo 1 can do Session 3 or Session 1, and prefers 3.
*(after Register)* Two separate moments: the request was accepted at once, that was the 202, and the
browser polled until the seat was decided. Session 3 was full, so she got her second choice. One
registration, one queue, never two seats. *(after Accept)* Confirmed, and the dashboard shows it.

**D2.** Demo 2 wants Session 1 only. It is full, so she is first in the queue. Now Demo 1's plans
change, and she cancels. *(B's card changes)* Demo 2 already has the offer. The cancellation and the
hand-over to the next person were one transaction. The backfill log says zero milliseconds, and
nobody had to e-mail anyone.

**D5a.** Now we crash our own worker on purpose, right after it has committed but before it
acknowledges the message. That is the worst moment for double booking. This flag only works on the
dev stage. *(outputs)* Accepted, then applied. Sending the same command id again returns the same
result with the same timestamp. SQS will give the crashed message to the worker again in about two
minutes. Until then this workshop's queue waits; that is the ordering guarantee. A different
workshop is not slowed down, as you'll see now.

**D3.** This workshop has a one-minute hold. Demo 1 gets the offer, and Demo 2 queues behind her.
Demo 1 will not answer. *(during the wait)* When the offer was created, the worker put a one-minute
timer on an SQS delay queue, before committing. When the timer fires, a small Lambda forwards a tick
into this workshop's queue. The worker first expires whatever is due by the server clock, then
offers the seat to the next person. A late or duplicate tick finds nothing to do, and the
five-minute sweep is only a safety net. *(after B's offer)* Nobody pressed anything: the seat moved
on by itself, and the log records how long the hand-over took.
Let's go back to the command we crashed.

### Speaker 5 (about 110 words)

**D5b.** This is the worker's log for that command. Delivery one: the injected fault after the
commit. About two minutes later, delivery two: command already settled, acknowledged. The record
still says APPLIED with the same timestamp, and Demo 3 appears once on the dashboard. Delivered
twice, applied once, because the result and the seat change are one transaction that only succeeds
while the command is unsettled.

**D4.** Finally, Verify invariants on both workshops: no session over capacity, nobody holding two
seats. Our experiments run this same check after every step. Here is what they found.
*(continue with Part 5, slide 9)*

## Fallback cues (docs/DEMO.md §6, §8)

| Situation | Who acts | What to say and do |
|---|---|---|
| A step has not settled after 15 s, an error banner appears, or sign-in breaks | Speaker 4 | "Let me show this step from our recording." Operator jumps to the beat's chapter in B1. Do not debug live. |
| The *Demo workshop* card shows "Still processing" between D5a and D5b | Speaker 4 | "Expected: this workshop's queue is waiting for the crashed message." |
| D5b would start less than 120 s after the D5a POST | Operator | Do D4 first, then D5b. |
| Plan B (local stack) | Speaker 4 | Say once: "This is our on-premise reference deployment, same code." D5b can follow D5a directly (redelivery after about 1 s). |
| A card does not update after the other window acted | Operator | Press F5 (the page refreshes every 10 s only while visible). |

## Key numbers

Do not quote numbers from the screen as results. The backfill latency on the dashboard and the
redelivery time are demo values. If you are asked, these are the measured ones:

| Number | Value | Source |
|---|---|---|
| Smoke on dev, 2026-10-17 (same flow, scripted) | PASS, 13/13 checks | `results/2026-10-17-smoke/summary.md` |
| Cancellation-driven backfill | 0 ms (relayed in the same transaction; asserted) | same file, step 4 |
| Expiry-driven backfill in that smoke run | 117 ms (n = 1, a single sample) | same file (`\SmokeExpiryBackfillMaxMs`) |
| Expiry-driven backfill distribution | [PENDING: p50 / p95 / max] | `results/<date>-backfill/summary.md` (`\BackfillExpiredPNinetyFiveS`) |
| Redelivery delay after a crash | the SQS visibility timeout, 120 s (configuration) | `services/aws/templates/app.yaml` |
| Repeat execution with crash after commit | [PENDING: probes passed] | `results/<date>-repeat-execution/summary.md` (`\RepeatAfterCommitPassed`) |

## Likely questions

**Q1. Was that really live on AWS?**
Plan A runs live on the dev stage at the URL on the slide, the same stack our experiments use. If we
had to switch to Plan B (the Docker Compose stack, same code) or Plan C (the recording), we said so
when we switched. The scripted version of the same flow passed 13/13 checks on dev on 2026-10-17
(`results/2026-10-17-smoke/summary.md`).

**Q2. What if Demo 1 had clicked Accept one second after the countdown reached zero?**
It would be rejected with `OFFER_EXPIRED`, whether or not the timer tick had already been processed.
Every decision first expires everything due by the server clock (`tickFirst()` in
`packages/core/src/tick.ts`). If her click reaches the worker before the tick, her own command
performs the expiry and the seat still goes to Demo 2 in the same transaction. The expiry-race
experiment sends ACCEPTs 200 ms before and after `expiresAt` to check exactly this: [PENDING:
results/<date>-expiry-race/summary.md].

**Q3. Why did the crash pause only that one workshop?**
The FIFO message group is the workshop. SQS delivers the next message of a group only after the one
in flight is deleted or its visibility timeout ends, and other groups keep flowing
(`aws-sqs-fifo-terms` in `report/references.bib`). That is the cost of the per-workshop ordering
guarantee. A real crash is rare. A message that fails three times goes to the dead-letter queue,
which unblocks the group and raises an alarm (`commands-dlq-not-empty`, `docs/RUNBOOK.md` §5).
