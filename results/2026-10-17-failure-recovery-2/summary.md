# failure-recovery — Failure recovery (plan §4, Table 3)

- Verdict: **PASS** (52/52 checks passed)
- Pass criterion (plan §4): BEFORE_COMMIT / AFTER_COMMIT / TIMER_SEND: the command settles exactly once after the redelivery, traceable; notifier outage: backlog delivered < 5 min after the restore (seconds reported); dead letters empty
- Run id: `da47da60-1692-40f3-83eb-40dfcc2cd673`, started 2026-10-17T18:39:47.442Z, finished 2026-10-17T19:10:46.797Z (1859 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0 (dirty)
- Script: `tools/experiments/src/failure-recovery.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- `BEFORE_COMMIT`: 3/3 settled exactly once; server settle incl. redelivery p50 120142 ms, max 120163 ms
- `AFTER_COMMIT`: 3/3 settled exactly once; server settle incl. redelivery p50 65 ms, max 98 ms
- `TIMER_SEND`: 3/3 settled exactly once; server settle incl. redelivery p50 120127 ms, max 120136 ms
- Notifier outage recovery: **3/3** within 300 s; recovery seconds 53.9, 44.4, 38.4 (max 53.9 s)
- Notifier baseline (no outage): 3.9 s, 1.9 s, 2.5 s from the last settlement to the last notification processed
- Dead letters after the run: 0

Server settle latency of a BEFORE_COMMIT / TIMER_SEND command includes the redelivery delay
(local: retry backoff ≈ 1 s; AWS: the 120 s SQS visibility timeout); AFTER_COMMIT settles on the
first delivery and only the acknowledgement is redelivered.

## Fault cases

| run | fault | command | outcome | server settle ms | deliveries | effect | verdict |
|---|---|---|---|---|---|---|---|
| 1 | BEFORE_COMMIT | REGISTER | APPLIED | 120142 | 2 | seq +1, S2 held 1, OFFER notifications 1, A OFFERED@S2 | PASS |
| 1 | AFTER_COMMIT | ACCEPT_OFFER | APPLIED | 98 | 2 | S2 confirmed 1 held 0, CONFIRMED notifications 1, record unchanged after redelivery true | PASS |
| 1 | TIMER_SEND | REGISTER | APPLIED | 120127 | 2 | seq +2 (B + C), S1 held 1, B OFFER notifications 1; EXPIRED backfill relayed to C after 110 ms (timer path < 15 s; the sweep would take minutes) | PASS |
| 2 | BEFORE_COMMIT | REGISTER | APPLIED | 120099 | 2 | seq +1, S2 held 1, OFFER notifications 1, A OFFERED@S2 | PASS |
| 2 | AFTER_COMMIT | ACCEPT_OFFER | APPLIED | 57 | 2 | S2 confirmed 1 held 0, CONFIRMED notifications 1, record unchanged after redelivery true | PASS |
| 2 | TIMER_SEND | REGISTER | APPLIED | 120136 | 2 | seq +2 (B + C), S1 held 1, B OFFER notifications 1; EXPIRED backfill relayed to C after 144 ms (timer path < 15 s; the sweep would take minutes) | PASS |
| 3 | BEFORE_COMMIT | REGISTER | APPLIED | 120163 | 2 | seq +1, S2 held 1, OFFER notifications 1, A OFFERED@S2 | PASS |
| 3 | AFTER_COMMIT | ACCEPT_OFFER | APPLIED | 65 | 2 | S2 confirmed 1 held 0, CONFIRMED notifications 1, record unchanged after redelivery true | PASS |
| 3 | TIMER_SEND | REGISTER | APPLIED | 120120 | 2 | seq +2 (B + C), S1 held 1, B OFFER notifications 1; EXPIRED backfill relayed to C after 138 ms (timer path < 15 s; the sweep would take minutes) | PASS |

## Delivery traces

How each redelivery was observed (local: the `commands` row; AWS: worker log lines found by Logs Insights).

- run 1 `BEFORE_COMMIT` (47f35ff3-961f-4e4b-b1f4-84f0123d905f): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 18:39:51.839 injected fault; message will be redelivered (delivery 1) message=20046e41-1cc2-4199-87dc-5cdd94835c60
  - 2026-10-17 18:41:51.823 command settled status=APPLIED
  - 2026-10-17 18:41:51.823 message processed (delivery 2) outcome=APPLIED message=20046e41-1cc2-4199-87dc-5cdd94835c60
- run 1 `AFTER_COMMIT` (3dc1c329-c8f8-46e7-b3ad-896a80cbd725): 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 18:42:29.662 injected fault; message will be redelivered (delivery 1) message=5ef8f26c-d7af-4b19-b093-0a6658056046
  - 2026-10-17 18:44:29.637 command already settled; acknowledging redelivery
  - 2026-10-17 18:44:29.642 convergence pass after a settled redelivery outcome=NOOP
  - 2026-10-17 18:44:29.642 internal command had nothing to do
  - 2026-10-17 18:44:29.642 message processed (delivery 2) outcome=ALREADY_SETTLED message=5ef8f26c-d7af-4b19-b093-0a6658056046
- run 1 `TIMER_SEND` (cefe47d9-7d28-4a5b-81c4-780af9e68d6d): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 18:45:08.517 injected fault; message will be redelivered (delivery 1) message=b5e3edb9-5512-4122-842e-171f99d494a7
  - 2026-10-17 18:47:08.604 command settled status=APPLIED
  - 2026-10-17 18:47:08.604 message processed (delivery 2) outcome=APPLIED message=b5e3edb9-5512-4122-842e-171f99d494a7
- run 2 `BEFORE_COMMIT` (0cb52f95-dacd-4aaf-924a-78acda82e03f): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 18:50:19.213 injected fault; message will be redelivered (delivery 1) message=44a87555-ca2c-4c2c-8512-857b17158436
  - 2026-10-17 18:52:19.254 command settled status=APPLIED
  - 2026-10-17 18:52:19.254 message processed (delivery 2) outcome=APPLIED message=44a87555-ca2c-4c2c-8512-857b17158436
- run 2 `AFTER_COMMIT` (53b5a1f4-e86d-486c-9917-35879b37f689): 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 18:52:57.707 injected fault; message will be redelivered (delivery 1) message=0407c0f2-f721-428b-96d6-702b43f7a4ae
  - 2026-10-17 18:54:57.624 command already settled; acknowledging redelivery
  - 2026-10-17 18:54:57.629 convergence pass after a settled redelivery outcome=NOOP
  - 2026-10-17 18:54:57.629 internal command had nothing to do
  - 2026-10-17 18:54:57.629 message processed (delivery 2) outcome=ALREADY_SETTLED message=0407c0f2-f721-428b-96d6-702b43f7a4ae
- run 2 `TIMER_SEND` (f77fdd6b-d2e4-4673-a990-5ef73496abf6): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 18:55:36.851 injected fault; message will be redelivered (delivery 1) message=44e1446e-8934-487d-8545-8ed7a2aaa718
  - 2026-10-17 18:57:36.942 command settled status=APPLIED
  - 2026-10-17 18:57:36.943 message processed (delivery 2) outcome=APPLIED message=44e1446e-8934-487d-8545-8ed7a2aaa718
- run 3 `BEFORE_COMMIT` (6b25f1d8-68d7-4cb1-835c-10281a905e52): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 19:00:34.673 injected fault; message will be redelivered (delivery 1) message=d2f20d9f-6c68-4481-9d2e-fed4abd07a14
  - 2026-10-17 19:02:34.764 command settled status=APPLIED
  - 2026-10-17 19:02:34.764 message processed (delivery 2) outcome=APPLIED message=d2f20d9f-6c68-4481-9d2e-fed4abd07a14
- run 3 `AFTER_COMMIT` (1060c696-4b53-4094-9d6d-e5634cc1b86c): 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 19:03:12.614 injected fault; message will be redelivered (delivery 1) message=be7147df-939b-492e-ad07-e4510dda9517
  - 2026-10-17 19:05:12.597 command already settled; acknowledging redelivery
  - 2026-10-17 19:05:12.602 convergence pass after a settled redelivery outcome=NOOP
  - 2026-10-17 19:05:12.602 internal command had nothing to do
  - 2026-10-17 19:05:12.602 message processed (delivery 2) outcome=ALREADY_SETTLED message=be7147df-939b-492e-ad07-e4510dda9517
- run 3 `TIMER_SEND` (bfb4eeb8-ce3b-43cb-8923-b8a4303727e5): 2 deliveries (2 command + 3 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged)
  - 2026-10-17 19:05:51.687 injected fault; message will be redelivered (delivery 1) message=48293798-c613-4938-9764-6e2ce631f9a2
  - 2026-10-17 19:07:51.774 command settled status=APPLIED
  - 2026-10-17 19:07:51.774 message processed (delivery 2) outcome=APPLIED message=48293798-c613-4938-9764-6e2ce631f9a2

## Notifier

| run | phase | notifications | PENDING at restore | recovery s | SENT | SKIPPED | FAILED | still PENDING | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | baseline | 10 | — | 3.9 | 0 | 10 | 0 | 0 | PASS |
| 1 | outage | 10 | 10 | 53.9 | 0 | 10 | 0 | 0 | PASS |
| 2 | baseline | 10 | — | 1.9 | 0 | 10 | 0 | 0 | PASS |
| 2 | outage | 10 | 10 | 44.4 | 0 | 10 | 0 | 0 | PASS |
| 3 | baseline | 10 | — | 2.5 | 0 | 10 | 0 | 0 | PASS |
| 3 | outage | 10 | 10 | 38.4 | 0 | 10 | 0 | 0 | PASS |

## Checks

All 52 checks passed.
