# repeat-execution — Repeat execution (plan §4, Table 3; C3)

- Verdict: **PASS** (75/75 checks passed)
- Pass criterion (plan §4): no double booking or double release: one command record, settled once (APPLIED once), identical on every read; AFTER_COMMIT redelivery applies nothing twice
- Run id: `3a636ec3-6a43-46f2-88ce-dd04a3288809`, started 2026-10-17T13:28:23.895Z, finished 2026-10-17T13:43:03.555Z (880 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: c1d066056b2c9d36cc33869629f99f390451c101 (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/repeat-execution.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Probes: 18/18 with one settled record, identical reads and the effect exactly once
- Fault flags: on (AFTER_COMMIT cases ran)

## Probes

| run | case | POSTs → 202 | 202 statuses | final | identical reads | re-POST identical | deliveries | effect | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | REGISTER ×N | 5 → 5 | ACCEPTED/APPLIED/APPLIED/APPLIED/APPLIED | APPLIED | true | true | — | seq +1, A OFFERED@S1, S1 held 1, OFFER notifications 1 | PASS |
| 1 | ACCEPT ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 1 held 0, CONFIRMED notifications 1 | PASS |
| 1 | CANCEL ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 0 held 1, CANCELLED_CONFIRMED records 1, B OFFERED@S1 (1 OFFER notifications), A none | PASS |
| 1 | DECLINE ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 held 0, DECLINED records 1, B none | PASS |
| 1 | REGISTER (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 1 | ACCEPT (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 2 | REGISTER ×N | 5 → 5 | ACCEPTED/APPLIED/APPLIED/APPLIED/ACCEPTED | APPLIED | true | true | — | seq +1, A OFFERED@S1, S1 held 1, OFFER notifications 1 | PASS |
| 2 | ACCEPT ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/APPLIED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 1 held 0, CONFIRMED notifications 1 | PASS |
| 2 | CANCEL ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/APPLIED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 0 held 1, CANCELLED_CONFIRMED records 1, B OFFERED@S1 (1 OFFER notifications), A none | PASS |
| 2 | DECLINE ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 held 0, DECLINED records 1, B none | PASS |
| 2 | REGISTER (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 2 | ACCEPT (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 3 | REGISTER ×N | 5 → 5 | ACCEPTED/ACCEPTED/APPLIED/APPLIED/APPLIED | APPLIED | true | true | — | seq +1, A OFFERED@S1, S1 held 1, OFFER notifications 1 | PASS |
| 3 | ACCEPT ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 1 held 0, CONFIRMED notifications 1 | PASS |
| 3 | CANCEL ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 confirmed 0 held 1, CANCELLED_CONFIRMED records 1, B OFFERED@S1 (1 OFFER notifications), A none | PASS |
| 3 | DECLINE ×N | 5 → 5 | ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED/ACCEPTED | APPLIED | true | true | — | S1 held 0, DECLINED records 1, B none | PASS |
| 3 | REGISTER (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |
| 3 | ACCEPT (AFTER_COMMIT) | 1 → 1 |  | APPLIED | true | true | REGISTER: 2, ACCEPT: 2 | seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, notifications OFFER 1 CONFIRMED 1, records unchanged after redelivery: true/true | PASS |

## AFTER_COMMIT delivery traces

- run 1: REGISTER: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 13:28:37.206 injected fault; message will be redelivered (delivery 1) message=4b6f38bd-c592-4e7a-9b11-d321fbc4afa9 | 2026-10-17 13:30:37.113 command already settled; acknowledging redelivery | 2026-10-17 13:30:37.117 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 13:30:37.117 internal command had nothing to do | 2026-10-17 13:30:37.117 message processed (delivery 2) outcome=ALREADY_SETTLED message=4b6f38bd-c592-4e7a-9b11-d321fbc4afa9 || ACCEPT: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 13:30:37.197 injected fault; message will be redelivered (delivery 1) message=31c80dcf-a86c-436b-a6ee-e29c8adca244 | 2026-10-17 13:32:37.199 command already settled; acknowledging redelivery | 2026-10-17 13:32:37.204 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 13:32:37.204 internal command had nothing to do | 2026-10-17 13:32:37.204 message processed (delivery 2) outcome=ALREADY_SETTLED message=31c80dcf-a86c-436b-a6ee-e29c8adca244
- run 2: REGISTER: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 13:33:29.580 injected fault; message will be redelivered (delivery 1) message=b76e2305-e795-45b7-8939-faa8244f6723 | 2026-10-17 13:35:29.585 command already settled; acknowledging redelivery | 2026-10-17 13:35:29.591 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 13:35:29.591 internal command had nothing to do | 2026-10-17 13:35:29.591 message processed (delivery 2) outcome=ALREADY_SETTLED message=b76e2305-e795-45b7-8939-faa8244f6723 || ACCEPT: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 13:35:29.654 injected fault; message will be redelivered (delivery 1) message=46582932-8af4-41b4-a62b-7a62d9b34c67 | 2026-10-17 13:37:29.655 command already settled; acknowledging redelivery | 2026-10-17 13:37:29.660 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 13:37:29.660 internal command had nothing to do | 2026-10-17 13:37:29.660 message processed (delivery 2) outcome=ALREADY_SETTLED message=46582932-8af4-41b4-a62b-7a62d9b34c67
- run 3: REGISTER: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 13:38:22.444 injected fault; message will be redelivered (delivery 1) message=1ae3b22f-2850-48a1-8b32-50754085b864 | 2026-10-17 13:40:22.455 command already settled; acknowledging redelivery | 2026-10-17 13:40:22.461 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 13:40:22.461 internal command had nothing to do | 2026-10-17 13:40:22.461 message processed (delivery 2) outcome=ALREADY_SETTLED message=1ae3b22f-2850-48a1-8b32-50754085b864 || ACCEPT: 2 deliveries (3 command + 5 message log lines in /aws/lambda/seatrelay-dev-worker; injected fault logged) — 2026-10-17 13:40:22.507 injected fault; message will be redelivered (delivery 1) message=43eb9ceb-e52d-4594-afd8-1cb95060c53c | 2026-10-17 13:42:22.540 command already settled; acknowledging redelivery | 2026-10-17 13:42:22.544 convergence pass after a settled redelivery outcome=NOOP | 2026-10-17 13:42:22.544 internal command had nothing to do | 2026-10-17 13:42:22.544 message processed (delivery 2) outcome=ALREADY_SETTLED message=43eb9ceb-e52d-4594-afd8-1cb95060c53c

## Checks

All 75 checks passed.
