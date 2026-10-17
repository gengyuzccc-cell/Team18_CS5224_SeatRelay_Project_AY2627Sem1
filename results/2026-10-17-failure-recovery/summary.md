# failure-recovery — Failure recovery (plan §4, Table 3)

- Verdict: **PASS** (52/52 checks passed)
- Pass criterion (plan §4): BEFORE_COMMIT / AFTER_COMMIT / TIMER_SEND: the command settles exactly once after the redelivery, traceable; notifier outage: backlog delivered < 5 min after the restore (seconds reported); dead letters empty
- Run id: `3a7ac99e-663f-4bb0-99d7-bec8de3a7b84`, started 2026-10-17T13:44:40.315Z, finished 2026-10-17T14:15:26.033Z (1846 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: c1d066056b2c9d36cc33869629f99f390451c101 (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/failure-recovery.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- `BEFORE_COMMIT`: 3/3 settled exactly once; server settle incl. redelivery p50 120112 ms, max 120128 ms
- `AFTER_COMMIT`: 3/3 settled exactly once; server settle incl. redelivery p50 68 ms, max 90 ms
- `TIMER_SEND`: 3/3 settled exactly once; server settle incl. redelivery p50 120095 ms, max 120125 ms
- Notifier outage recovery: **3/3** within 300 s; recovery seconds 44.2, 52.3, 38.1 (max 52.3 s)
- Notifier baseline (no outage): 2.7 s, 2.4 s, 0.8 s from the last settlement to the last notification processed
- Dead letters after the run: 0

Server settle latency of a BEFORE_COMMIT / TIMER_SEND command includes the redelivery delay
(local: retry backoff ≈ 1 s; AWS: the 120 s SQS visibility timeout); AFTER_COMMIT settles on the
first delivery and only the acknowledgement is redelivered.

## Fault cases

| run | fault | command | outcome | server settle ms | deliveries | effect | verdict |
|---|---|---|---|---|---|---|---|
| 1 | BEFORE_COMMIT | REGISTER | APPLIED | 120112 | 2 | seq +1, S2 held 1, OFFER notifications 1, A OFFERED@S2 | PASS |
| 1 | AFTER_COMMIT | ACCEPT_OFFER | APPLIED | 49 | 2 | S2 confirmed 1 held 0, CONFIRMED notifications 1, record unchanged after redelivery true | PASS |
| 1 | TIMER_SEND | REGISTER | APPLIED | 120081 | 2 | seq +2 (B + C), S1 held 1, B OFFER notifications 1; EXPIRED backfill relayed to C after 119 ms (timer path < 15 s; the sweep would take minutes) | PASS |
| 2 | BEFORE_COMMIT | REGISTER | APPLIED | 120094 | 2 | seq +1, S2 held 1, OFFER notifications 1, A OFFERED@S2 | PASS |
| 2 | AFTER_COMMIT | ACCEPT_OFFER | APPLIED | 90 | 2 | S2 confirmed 1 held 0, CONFIRMED notifications 1, record unchanged after redelivery true | PASS |
| 2 | TIMER_SEND | REGISTER | APPLIED | 120125 | 2 | seq +2 (B + C), S1 held 1, B OFFER notifications 1; EXPIRED backfill relayed to C after 982 ms (timer path < 15 s; the sweep would take minutes) | PASS |
| 3 | BEFORE_COMMIT | REGISTER | APPLIED | 120128 | 2 | seq +1, S2 held 1, OFFER notifications 1, A OFFERED@S2 | PASS |
| 3 | AFTER_COMMIT | ACCEPT_OFFER | APPLIED | 68 | 2 | S2 confirmed 1 held 0, CONFIRMED notifications 1, record unchanged after redelivery true | PASS |
| 3 | TIMER_SEND | REGISTER | APPLIED | 120095 | 2 | seq +2 (B + C), S1 held 1, B OFFER notifications 1; EXPIRED backfill relayed to C after 131 ms (timer path < 15 s; the sweep would take minutes) | PASS |

## Delivery traces

How each redelivery was observed (local: the `commands` row; AWS: worker log lines found by Logs Insights).

- run 1 `BEFORE_COMMIT` (7b61fd0e-cdd9-4dc7-97c2-b88f7d8be5f8): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 13:44:45.296 injected fault; message will be redelivered (delivery 1) message=996d5c7a-3b09-4e98-83fe-58ed3a631629
  - 2026-10-17 13:46:45.294 command settled status=APPLIED
  - 2026-10-17 13:46:45.294 message processed (delivery 2) outcome=APPLIED message=996d5c7a-3b09-4e98-83fe-58ed3a631629
- run 1 `AFTER_COMMIT` (c0e10154-ca75-44c4-a664-754b5e5026ed): 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 13:47:22.057 injected fault; message will be redelivered (delivery 1) message=7d304ea2-88e7-4236-b313-63f9fd9e2c84
  - 2026-10-17 13:49:22.040 command already settled; acknowledging redelivery
  - 2026-10-17 13:49:22.044 convergence pass after a settled redelivery outcome=NOOP
  - 2026-10-17 13:49:22.044 internal command had nothing to do
  - 2026-10-17 13:49:22.044 message processed (delivery 2) outcome=ALREADY_SETTLED message=7d304ea2-88e7-4236-b313-63f9fd9e2c84
- run 1 `TIMER_SEND` (d5d8946d-2f40-4f0b-9866-b7733d965f4f): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 13:50:00.099 injected fault; message will be redelivered (delivery 1) message=bf2dff75-64b3-4d01-a485-eee7b6b9c47e
  - 2026-10-17 13:52:00.144 command settled status=APPLIED
  - 2026-10-17 13:52:00.144 message processed (delivery 2) outcome=APPLIED message=bf2dff75-64b3-4d01-a485-eee7b6b9c47e
- run 2 `BEFORE_COMMIT` (ded9adc9-4703-469d-b453-7310c1bbdde2): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 13:54:57.519 injected fault; message will be redelivered (delivery 1) message=8bc53536-7677-4f36-8b5b-9940abf6f0e5
  - 2026-10-17 13:56:57.570 command settled status=APPLIED
  - 2026-10-17 13:56:57.570 message processed (delivery 2) outcome=APPLIED message=8bc53536-7677-4f36-8b5b-9940abf6f0e5
- run 2 `AFTER_COMMIT` (d12c2523-68ea-43c7-82e2-9cc4977372ad): 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 13:57:34.862 injected fault; message will be redelivered (delivery 1) message=343c31e1-ae34-47b4-bc28-bed0452225be
  - 2026-10-17 13:59:34.747 command already settled; acknowledging redelivery
  - 2026-10-17 13:59:34.754 convergence pass after a settled redelivery outcome=NOOP
  - 2026-10-17 13:59:34.754 internal command had nothing to do
  - 2026-10-17 13:59:34.754 message processed (delivery 2) outcome=ALREADY_SETTLED message=343c31e1-ae34-47b4-bc28-bed0452225be
- run 2 `TIMER_SEND` (307b24ed-9042-4a89-8709-f04becffcadf): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 14:00:13.136 injected fault; message will be redelivered (delivery 1) message=98f5cb64-243d-4ac0-9b0a-cf9d79bc56f0
  - 2026-10-17 14:02:13.219 command settled status=APPLIED
  - 2026-10-17 14:02:13.219 message processed (delivery 2) outcome=APPLIED message=98f5cb64-243d-4ac0-9b0a-cf9d79bc56f0
- run 3 `BEFORE_COMMIT` (8dc7e65a-10da-4c0f-b8b1-289e6026ab7a): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 14:05:19.470 injected fault; message will be redelivered (delivery 1) message=9ef85bb1-6714-4698-a7d4-2445d2fd1576
  - 2026-10-17 14:07:19.524 command settled status=APPLIED
  - 2026-10-17 14:07:19.524 message processed (delivery 2) outcome=APPLIED message=9ef85bb1-6714-4698-a7d4-2445d2fd1576
- run 3 `AFTER_COMMIT` (c1e6acf9-3a07-4d2d-bdbc-4d61ff76da4c): 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 14:07:56.568 injected fault; message will be redelivered (delivery 1) message=14a01b5a-5962-4d5d-98a8-addaa4042fee
  - 2026-10-17 14:09:56.568 command already settled; acknowledging redelivery
  - 2026-10-17 14:09:56.572 internal command had nothing to do
  - 2026-10-17 14:09:56.573 convergence pass after a settled redelivery outcome=NOOP
  - 2026-10-17 14:09:56.573 message processed (delivery 2) outcome=ALREADY_SETTLED message=14a01b5a-5962-4d5d-98a8-addaa4042fee
- run 3 `TIMER_SEND` (4d2ae8cc-d2c4-48c5-b27c-fb4d733e86dd): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 14:10:34.529 injected fault; message will be redelivered (delivery 1) message=93de125a-317b-4988-8006-2a369c9c9b88
  - 2026-10-17 14:12:34.582 command settled status=APPLIED
  - 2026-10-17 14:12:34.582 message processed (delivery 2) outcome=APPLIED message=93de125a-317b-4988-8006-2a369c9c9b88

## Notifier

| run | phase | notifications | PENDING at restore | recovery s | SENT | SKIPPED | FAILED | still PENDING | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | baseline | 10 | — | 2.7 | 0 | 10 | 0 | 0 | PASS |
| 1 | outage | 10 | 10 | 44.2 | 0 | 10 | 0 | 0 | PASS |
| 2 | baseline | 10 | — | 2.4 | 0 | 10 | 0 | 0 | PASS |
| 2 | outage | 10 | 10 | 52.3 | 0 | 10 | 0 | 0 | PASS |
| 3 | baseline | 10 | — | 0.8 | 0 | 10 | 0 | 0 | PASS |
| 3 | outage | 10 | 10 | 38.1 | 0 | 10 | 0 | 0 | PASS |

## Checks

All 52 checks passed.
