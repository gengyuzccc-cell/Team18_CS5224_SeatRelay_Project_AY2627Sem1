# pilot-rehearsal — Staged pilot rehearsal on the pilot stack (Prelim §5, logged separately from the live pilot)

**Staged rehearsal with synthetic accounts — operational evidence only, not user evidence (Prelim §5)**

- Verdict: **PASS** (84/84 checks passed)
- Pass criterion (plan §4): every scripted command settles with the expected outcome; verify ok, 0 over-capacity and 0 double holds after every phase; every released seat (decline, timer-driven expiry, capacity increase, cancellation) relayed while someone acceptable was queued; every notification leaves PENDING (SES simulator: SENT) and the in-app status matches the registration (C6); DLQs unchanged; no alarm entered ALARM
- Run id: `a633cb25-14c7-461d-b353-426b556fe671`, started 2026-10-17T16:37:51.206Z, finished 2026-10-17T16:43:15.843Z (325 s)
- Target: pilot (https://dx40kccif3.execute-api.ap-southeast-1.amazonaws.com); runs: 1; holdSeconds: 120; fault flags: off
- Commit: b8b8f3ae348036a08fd4b1b51c976bfd23b6719e (dirty) on claude/serene-lovelace-7t14s9
- Label: staged rehearsal run 1
- Script: `tools/experiments/src/pilot-rehearsal.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## What was staged

- Organisation **Staged rehearsal (synthetic accounts)**, workshop **Staged rehearsal — Intro to AWS (2 sessions)** (`a47de269-358d-4946-8e47-c95018d0734c`), mode UNIFIED, holdSeconds 120; sessions S1 "Intro to AWS — session 1 (staged)" starts 2026-10-19T16:38:31.132Z capacity 6; S2 "Intro to AWS — session 2 (staged)" starts 2026-10-20T16:38:31.132Z capacity 6.
- 20 synthetic participants (8 S1 only, 6 S2 only, 3 S2>S1, 3 S1>S2), registering in the order P01 … P20; every action sequential with a random 1000–3000 ms pause before it; organiser `rehearsal-organiser@example.com`.
- Participant addresses: `success+rehearsal-NN@simulator.amazonses.com` (SES mailbox simulator: the pilot's real SES path, delivery simulated, no real inbox). The identity provider (Cognito on AWS) accepted the address as username and the API saw it as the account e-mail: yes.
- Scripted behaviour: 3/3 declines, 2/2 offers left to expire, 3/3 cancellations after confirming, capacity +1 on S2, attendance marked for 5/5 confirmed participants, CSV export (`export.csv`).
- Every account and every action is synthetic and scripted. Nothing here is user evidence; the live pilot (independent participants) is logged separately.

## Timeline

| phase | started | finished | actions | invariants after | error |
|---|---|---|---|---|---|
| 1 register | 2026-10-17T16:38:31.452Z | 2026-10-17T16:39:28.473Z | 20 | ok |  |
| 2 respond | 2026-10-17T16:39:29.424Z | 2026-10-17T16:40:08.664Z | 15 | ok |  |
| 3 expiry | 2026-10-17T16:40:09.450Z | 2026-10-17T16:40:57.926Z | 3 | ok |  |
| 4 capacity | 2026-10-17T16:40:58.646Z | 2026-10-17T16:41:05.105Z | 2 | ok |  |
| 5 cancel | 2026-10-17T16:41:05.811Z | 2026-10-17T16:41:28.198Z | 6 | ok |  |
| 6 attendance | 2026-10-17T16:41:28.896Z | 2026-10-17T16:41:40.640Z | 5 | ok |  |
| 7 export | 2026-10-17T16:41:41.512Z | 2026-10-17T16:41:44.261Z | 1 | ok |  |
| 8 final | 2026-10-17T16:41:44.972Z | 2026-10-17T16:43:15.027Z | 0 | ok |  |

Waited 41 s in phase 3 for the unanswered holds to expire and be relayed.

## Command settle latency

43 commands settled (43 sent), every one sequential. Client-observed = POST → the poll that saw the terminal state (plan §1.3 backoff); server = `settledAt − acceptedAt`.

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| 202 response (POST) | 43 | 263 | 307 | 364 | 364 | 271.4 |
| settle, client-observed | 43 | 806 | 874 | 1673 | 1673 | 836.3 |
| settle, server-side | 43 | 54 | 94 | 975 | 975 | 76.2 |
| REGISTER client (n=20) | 20 | 808 | 911 | 1673 | 1673 | 864.8 |
| REGISTER server | 20 | 55 | 102 | 975 | 975 | 105.0 |
| ACCEPT_OFFER client (n=16) | 16 | 810 | 874 | 874 | 874 | 815.9 |
| ACCEPT_OFFER server | 16 | 54 | 73 | 73 | 73 | 52.8 |
| DECLINE_OFFER client (n=3) | 3 | 806 | 809 | 809 | 809 | 803.7 |
| DECLINE_OFFER server | 3 | 55 | 60 | 60 | 60 | 53.3 |
| SET_CAPACITY client (n=1) | 1 | 803 | 803 | 803 | 803 | 803.0 |
| SET_CAPACITY server | 1 | 48 | 48 | 48 | 48 | 48.0 |
| CANCEL_REGISTRATION client (n=3) | 3 | 801 | 803 | 803 | 803 | 799.0 |
| CANCEL_REGISTRATION server | 3 | 40 | 46 | 46 | 46 | 41.0 |

## Backfills

| cause | records | relayed | latency ms (each) | p50 ms | max ms |
|---|---|---|---|---|---|
| CANCELLED_CONFIRMED | 3 | 3 | 0, 0, 0 | 0 | 0 |
| CAPACITY_UP | 1 | 1 | 0 | 0 | 0 |
| DECLINED | 3 | 3 | 0, 0, 0 | 0 | 0 |
| EXPIRED | 2 | 2 | 105, 77 | 77 | 105 |

| released | cause | session | reallocated | latency ms | to |
|---|---|---|---|---|---|
| 2026-10-17T16:39:39.797Z | DECLINED | S2 | 2026-10-17T16:39:39.797Z | 0 | P14 |
| 2026-10-17T16:39:49.197Z | DECLINED | S2 | 2026-10-17T16:39:49.197Z | 0 | P16 |
| 2026-10-17T16:39:51.853Z | DECLINED | S1 | 2026-10-17T16:39:51.853Z | 0 | P05 |
| 2026-10-17T16:40:37.478Z | EXPIRED | S1 | 2026-10-17T16:40:37.583Z | 105 | P09 |
| 2026-10-17T16:40:47.459Z | EXPIRED | S1 | 2026-10-17T16:40:47.536Z | 77 | P12 |
| 2026-10-17T16:41:00.801Z | CAPACITY_UP | S2 | 2026-10-17T16:41:00.801Z | 0 | P10 |
| 2026-10-17T16:41:09.147Z | CANCELLED_CONFIRMED | S2 | 2026-10-17T16:41:09.147Z | 0 | P17 |
| 2026-10-17T16:41:17.070Z | CANCELLED_CONFIRMED | S2 | 2026-10-17T16:41:17.070Z | 0 | P18 |
| 2026-10-17T16:41:23.459Z | CANCELLED_CONFIRMED | S2 | 2026-10-17T16:41:23.459Z | 0 | P20 |

EXPIRED latency = `reallocatedAt − expiresAt` (timer-driven; Table 3 target ≤ 120 s). DECLINED / CANCELLED_CONFIRMED / CAPACITY_UP are relayed inside the same settlement (0 ms by construction).

## Invariants after each phase

| phase | verify | over-capacity | double holds | violations | S1 conf+held/cap | S2 conf+held/cap | queued | offered | confirmed | backfills | distinct served |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 register | ok | 0 | 0 | — | 0+6/6 q5 | 0+6/6 q5 | 8 | 12 | 0 | 0 | 0 |
| 2 respond | ok | 0 | 0 | — | 4+2/6 q5 | 6+0/6 q4 | 8 | 2 | 10 | 3 | 10 |
| 3 expiry | ok | 0 | 0 | — | 6+0/6 q3 | 6+0/6 q4 | 6 | 0 | 12 | 5 | 12 |
| 4 capacity | ok | 0 | 0 | — | 6+0/6 q3 | 7+0/7 q3 | 5 | 0 | 13 | 6 | 13 |
| 5 cancel | ok | 0 | 0 | — | 6+0/6 q2 | 7+0/7 q0 | 2 | 0 | 13 | 9 | 13 |
| 6 attendance | ok | 0 | 0 | — | 6+0/6 q2 | 7+0/7 q0 | 2 | 0 | 13 | 9 | 13 |
| 7 export | ok | 0 | 0 | — | 6+0/6 q2 | 7+0/7 q0 | 2 | 0 | 13 | 9 | 13 |
| 8 final | ok | 0 | 0 | — | 6+0/6 q2 | 7+0/7 q0 | 2 | 0 | 13 | 9 | 13 |

Invariant result over all phases: **held**.

## Final state (organiser dashboard)

| session | capacity | confirmed | held | free | queue (acceptable) |
|---|---|---|---|---|---|
| S1 | 6 | 6 | 0 | 0 | 2 |
| S2 | 7 | 7 | 0 | 0 | 0 |

- Counts: queued 2, offered 0, confirmed 13, backfills 9 (9 reallocated), attended 5.
- **Distinct participants served** (dashboard `distinctParticipantsServed`): 13 of 20 synthetic participants, for 13 seats.
- Export: `export.csv` (20 rows, the organiser download as served).

## Notifications

Source: Notification items in DynamoDB (`seatrelay-pilot`, status, attempts, last error) compared with every participant's in-app list (`GET /me/notifications`); waited up to 240 s for PENDING to clear.

| kind | PENDING | SENT | FAILED | SKIPPED | total |
|---|---|---|---|---|---|
| OFFER | 0 | 21 | 0 | 0 | 21 |
| CONFIRMED | 0 | 16 | 0 | 0 | 16 |
| EXPIRED | 0 | 2 | 0 | 0 | 2 |
| DECLINED | 0 | 3 | 0 | 0 | 3 |
| total | 0 | 42 | 0 | 0 | 42 |

No delivery error recorded.

In-app status (C6): 20/20 participants' "my registrations" status equals the organiser dashboard.

## Operations

- Dead-letter queues: before 0 {"commands-dlq":0,"expiry-delay-dlq":0,"notify-dlq":0}; after 0 {"commands-dlq":0,"expiry-delay-dlq":0,"notify-dlq":0}.
- Alarms (`seatrelay-pilot-*`): before 9 OK; after 9 OK; state changes during the run: none.

| alarm | before | after |
|---|---|---|
| seatrelay-pilot-api-5xx | OK | OK |
| seatrelay-pilot-api-errors | OK | OK |
| seatrelay-pilot-commands-dlq-not-empty | OK | OK |
| seatrelay-pilot-commands-oldest-message-age | OK | OK |
| seatrelay-pilot-expiry-dlq-not-empty | OK | OK |
| seatrelay-pilot-notifier-iterator-age | OK | OK |
| seatrelay-pilot-notify-dlq-not-empty | OK | OK |
| seatrelay-pilot-worker-errors | OK | OK |
| seatrelay-pilot-worker-record-failures | OK | OK |

CloudWatch, 2026-10-17T16:36:51.206Z → 2026-10-17T16:44:14.008Z (60 s periods):

- Account Lambda ConcurrentExecutions, max of 1-min maxima: **3** (account quota 10).
- dev stage activity in the same window (api + worker invocations): 0 — the SeatRelay custom metrics below are attributable to this rehearsal.

| function | invocations | errors | throttles | concurrent max |
|---|---|---|---|---|
| seatrelay-pilot-api | 196 | 0 | 0 | 2 |
| seatrelay-pilot-worker | 60 | 0 | 0 | 1 |
| seatrelay-pilot-expiry-forwarder | 16 | 0 | 0 | 1 |
| seatrelay-pilot-sweep | 2 | 0 | 0 | 1 |
| seatrelay-pilot-notifier | 41 | 0 | 0 | 2 |

| SeatRelay metric | sum | samples | max |
|---|---|---|---|
| CommandSettledLatency | 0 | 0 | 0 |
| BackfillLatency | 0 | 0 | 0 |
| OffersCreated | 0 | 0 | 0 |
| OffersExpired | 0 | 0 | 0 |
| SweepLateExpiries | 0 | 0 | 0 |
| NotificationFailures | 0 | 0 | 0 |

## Participants

| participant | preferences | what they did | in-app status at the end |
|---|---|---|---|
| P01 | S1 | registered S1; accepted S1; marked attended | CONFIRMED@S1 |
| P02 | S1 | registered S1; left S1 unanswered | ENDED(NO_ACCEPTABLE_SESSION) |
| P03 | S2 | registered S2; accepted S2; cancelled confirmed S2 | CANCELLED |
| P04 | S2 | registered S2; accepted S2 | CONFIRMED@S2 |
| P05 | S2>S1 | registered S2>S1; declined S2; accepted S1; marked attended | CONFIRMED@S1 |
| P06 | S1 | registered S1; left S1 unanswered | ENDED(NO_ACCEPTABLE_SESSION) |
| P07 | S1 | registered S1; accepted S1 | CONFIRMED@S1 |
| P08 | S1 | registered S1; accepted S1 | CONFIRMED@S1 |
| P09 | S2>S1 | registered S2>S1; declined S2; accepted S1 | CONFIRMED@S1 |
| P10 | S1>S2 | registered S1>S2; declined S1; accepted S2 | CONFIRMED@S2 |
| P11 | S2 | registered S2; accepted S2; marked attended | CONFIRMED@S2 |
| P12 | S1 | registered S1; accepted S1; marked attended | CONFIRMED@S1 |
| P13 | S2>S1 | registered S2>S1; accepted S2 | CONFIRMED@S2 |
| P14 | S2 | registered S2; accepted S2; cancelled confirmed S2 | CANCELLED |
| P15 | S1 | registered S1 | QUEUED#1 |
| P16 | S1>S2 | registered S1>S2; accepted S2; cancelled confirmed S2 | CANCELLED |
| P17 | S1>S2 | registered S1>S2; accepted S2 | CONFIRMED@S2 |
| P18 | S2 | registered S2; accepted S2 | CONFIRMED@S2 |
| P19 | S1 | registered S1 | QUEUED#2 |
| P20 | S2 | registered S2; accepted S2; marked attended | CONFIRMED@S2 |

## Caveats

- Staged: synthetic accounts, scripted decisions, human-like pacing. It exercises the deployed pilot stack end to end (API Gateway, Lambda, SQS FIFO and delay timers, DynamoDB, the notifier and SES) but says nothing about how real people use the system.
- Attendance was marked before the sessions start: it rehearses the organiser feature, not a real check-in.
- The workshop stays OPEN with its final state for inspection. Participants still queued at a session's cut-off (start − 30 min) will be ended by the sweep then (ENDED notifications to simulator addresses, outside this run's window).

## Checks

All 84 checks passed.
