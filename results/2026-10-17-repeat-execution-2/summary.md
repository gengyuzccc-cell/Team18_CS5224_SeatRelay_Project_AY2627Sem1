# repeat-execution — Repeat execution (plan §4, Table 3; C3)

- Verdict: **PASS** (75/75 checks passed)
- Pass criterion (plan §4): no double booking or double release: one command record, settled once (APPLIED once), identical on every read; AFTER_COMMIT redelivery applies nothing twice
- Run id: `668e39b5-6b98-45b3-89d9-d8872e900f13`, started 2026-10-17T18:23:18.537Z, finished 2026-10-17T18:38:10.396Z (892 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0 (dirty)
- Script: `tools/experiments/src/repeat-execution.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Probes: 18/18 with one settled record, identical reads and the effect exactly once
- Fault flags: on (AFTER_COMMIT cases ran)

## Probes

| run | case | POSTs → 202 | 202 statuses | final | identical reads | re-POST identical | deliveries | effect | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | REGISTER ×N | 5 → 5 | ACCEPTED/APPLIED/APPLIED/APPLIED/APPLIED | APPLIED | true | true | — | seq +1, A OFFERED@S1, S1 held 1, OFFER notifications 1 | PASS |
| 1 | ACCEPT ×N | 5 → 5 | APPLIED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 1 held 0, CONFIRMED notifications 1 | PASS |
| 1 | CANCEL ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 0 held 1, CANCELLED_CONFIRMED records 1, B OFFERED@S1 (1 OFFER notifications), A none | PASS |
| 1 | DECLINE ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 held 0, DECLINED records 1, B none | PASS |
| 1 | REGISTER (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 1 | ACCEPT (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 2 | REGISTER ×N | 5 → 5 | ACCEPTED/ACCEPTED/APPLIED/APPLIED/APPLIED | APPLIED | true | true | — | seq +1, A OFFERED@S1, S1 held 1, OFFER notifications 1 | PASS |
| 2 | ACCEPT ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 1 held 0, CONFIRMED notifications 1 | PASS |
| 2 | CANCEL ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 0 held 1, CANCELLED_CONFIRMED records 1, B OFFERED@S1 (1 OFFER notifications), A none | PASS |
| 2 | DECLINE ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 held 0, DECLINED records 1, B none | PASS |
| 2 | REGISTER (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 2 | ACCEPT (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 3 | REGISTER ×N | 5 → 5 | APPLIED/ACCEPTED/APPLIED/APPLIED/APPLIED | APPLIED | true | true | — | seq +1, A OFFERED@S1, S1 held 1, OFFER notifications 1 | PASS |
| 3 | ACCEPT ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 1 held 0, CONFIRMED notifications 1 | PASS |
| 3 | CANCEL ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 0 held 1, CANCELLED_CONFIRMED records 1, B OFFERED@S1 (1 OFFER notifications), A none | PASS |
| 3 | DECLINE ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 held 0, DECLINED records 1, B none | PASS |
| 3 | REGISTER (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 3 | ACCEPT (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |

## AFTER_COMMIT delivery traces

- run 1: REGISTER: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 18:23:34.790 injected fault; message will be redelivered (delivery 1) message=4d0bcd37-121f-46f4-9c20-d60962f93735 | 2026-10-17 18:25:34.759 command already settled; acknowledging redelivery | 2026-10-17 18:25:34.763 internal command had nothing to do | 2026-10-17 18:25:34.764 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 18:25:34.764 message processed (delivery 2) outcome=ALREADY_SETTLED message=4d0bcd37-121f-46f4-9c20-d60962f93735 || ACCEPT: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 18:25:34.823 injected fault; message will be redelivered (delivery 1) message=0fc45833-9c23-45b2-b277-d88a4a83134a | 2026-10-17 18:27:34.852 command already settled; acknowledging redelivery | 2026-10-17 18:27:34.858 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 18:27:34.858 internal command had nothing to do | 2026-10-17 18:27:34.858 message processed (delivery 2) outcome=ALREADY_SETTLED message=0fc45833-9c23-45b2-b277-d88a4a83134a
- run 2: REGISTER: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 18:28:31.250 injected fault; message will be redelivered (delivery 1) message=4eeb90a7-44e9-49ea-80e8-f100b32d5598 | 2026-10-17 18:30:31.273 command already settled; acknowledging redelivery | 2026-10-17 18:30:31.278 internal command had nothing to do | 2026-10-17 18:30:31.279 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 18:30:31.279 message processed (delivery 2) outcome=ALREADY_SETTLED message=4eeb90a7-44e9-49ea-80e8-f100b32d5598 || ACCEPT: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 18:30:31.333 injected fault; message will be redelivered (delivery 1) message=39d3a3b7-ae07-41a2-b0e3-22c25cc44f51 | 2026-10-17 18:32:31.326 command already settled; acknowledging redelivery | 2026-10-17 18:32:31.330 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 18:32:31.330 internal command had nothing to do | 2026-10-17 18:32:31.330 message processed (delivery 2) outcome=ALREADY_SETTLED message=39d3a3b7-ae07-41a2-b0e3-22c25cc44f51
- run 3: REGISTER: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 18:33:27.511 injected fault; message will be redelivered (delivery 1) message=6d380520-751b-420f-ad9d-d6edbca63ae0 | 2026-10-17 18:35:27.526 command already settled; acknowledging redelivery | 2026-10-17 18:35:27.530 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 18:35:27.530 internal command had nothing to do | 2026-10-17 18:35:27.530 message processed (delivery 2) outcome=ALREADY_SETTLED message=6d380520-751b-420f-ad9d-d6edbca63ae0 || ACCEPT: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 18:35:27.580 injected fault; message will be redelivered (delivery 1) message=1559652d-5bc1-4ade-8e6f-fcbd551433b3 | 2026-10-17 18:37:27.570 command already settled; acknowledging redelivery | 2026-10-17 18:37:27.573 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 18:37:27.573 internal command had nothing to do | 2026-10-17 18:37:27.573 message processed (delivery 2) outcome=ALREADY_SETTLED message=1559652d-5bc1-4ade-8e6f-fcbd551433b3

## Checks

All 75 checks passed.
