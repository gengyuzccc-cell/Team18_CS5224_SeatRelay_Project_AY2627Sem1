# correctness — Core correctness (plan §4, Table 3)

- Verdict: **PASS** (672/672 checks passed)
- Pass criterion (plan §4): every scripted step as expected; verify ok after every step; 0 over-capacity; 0 double holds
- Run id: `d179d40d-6148-41b2-8a5d-1a4df8ae0ac5`, started 2026-10-17T18:16:07.202Z, finished 2026-10-17T18:20:33.416Z (266 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0 (dirty)
- Script: `tools/experiments/src/correctness.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Scenarios: 27/27 passed
- Over-capacity observations: **0** (target 0) over 234 post-step reads
- Double holds: **0** (target 0)
- verify failures: 0

## Scenarios

| run | scenario | what it exercises | checks | failed | over-capacity | double holds | verdict |
|---|---|---|---|---|---|---|---|
| 1 | register-confirm | REGISTER → OFFERED on the first preference with a free seat → ACCEPT → CONFIRMED; R1 duplicate rejected; queueing when full | 19 | 0 | 0 | 0 | PASS |
| 1 | rejections | deterministic rejections leave no trace: duplicate/unknown preferences, unknown offer, cancel without registration | 15 | 0 | 0 | 0 | PASS |
| 1 | decline | DECLINE drops the session (R5): next preference offered and the declined seat relayed, both in the same settlement; last preference declined → ENDED | 22 | 0 | 0 | 0 | PASS |
| 1 | cancel | CANCEL from CONFIRMED / OFFERED / QUEUED (R6): released seats relayed in the same settlement; re-registration gets a new seq at the tail | 37 | 0 | 0 | 0 | PASS |
| 1 | capacity-up | SET_CAPACITY up relays the new seats to the queue in the same settlement (CAPACITY_UP backfills) | 26 | 0 | 0 | 0 | PASS |
| 1 | capacity-down | SET_CAPACITY below confirmed + held is rejected (R7), to exactly the usage is applied; invalid values rejected | 23 | 0 | 0 | 0 | PASS |
| 1 | cancel-session | CANCEL_SESSION revokes held seats, releases confirmed ones and drops the session from every preference list; owners queue for their other sessions | 38 | 0 | 0 | 0 | PASS |
| 1 | cancel-workshop | CANCEL_WORKSHOP ends every registration (WORKSHOP_CANCELLED), releases every seat and rejects later commands | 26 | 0 | 0 | 0 | PASS |
| 1 | close-open | CLOSE_REGISTRATION blocks new registrations but keeps offers acceptable; OPEN_REGISTRATION reopens | 18 | 0 | 0 | 0 | PASS |
| 2 | register-confirm | REGISTER → OFFERED on the first preference with a free seat → ACCEPT → CONFIRMED; R1 duplicate rejected; queueing when full | 19 | 0 | 0 | 0 | PASS |
| 2 | rejections | deterministic rejections leave no trace: duplicate/unknown preferences, unknown offer, cancel without registration | 15 | 0 | 0 | 0 | PASS |
| 2 | decline | DECLINE drops the session (R5): next preference offered and the declined seat relayed, both in the same settlement; last preference declined → ENDED | 22 | 0 | 0 | 0 | PASS |
| 2 | cancel | CANCEL from CONFIRMED / OFFERED / QUEUED (R6): released seats relayed in the same settlement; re-registration gets a new seq at the tail | 37 | 0 | 0 | 0 | PASS |
| 2 | capacity-up | SET_CAPACITY up relays the new seats to the queue in the same settlement (CAPACITY_UP backfills) | 26 | 0 | 0 | 0 | PASS |
| 2 | capacity-down | SET_CAPACITY below confirmed + held is rejected (R7), to exactly the usage is applied; invalid values rejected | 23 | 0 | 0 | 0 | PASS |
| 2 | cancel-session | CANCEL_SESSION revokes held seats, releases confirmed ones and drops the session from every preference list; owners queue for their other sessions | 38 | 0 | 0 | 0 | PASS |
| 2 | cancel-workshop | CANCEL_WORKSHOP ends every registration (WORKSHOP_CANCELLED), releases every seat and rejects later commands | 26 | 0 | 0 | 0 | PASS |
| 2 | close-open | CLOSE_REGISTRATION blocks new registrations but keeps offers acceptable; OPEN_REGISTRATION reopens | 18 | 0 | 0 | 0 | PASS |
| 3 | register-confirm | REGISTER → OFFERED on the first preference with a free seat → ACCEPT → CONFIRMED; R1 duplicate rejected; queueing when full | 19 | 0 | 0 | 0 | PASS |
| 3 | rejections | deterministic rejections leave no trace: duplicate/unknown preferences, unknown offer, cancel without registration | 15 | 0 | 0 | 0 | PASS |
| 3 | decline | DECLINE drops the session (R5): next preference offered and the declined seat relayed, both in the same settlement; last preference declined → ENDED | 22 | 0 | 0 | 0 | PASS |
| 3 | cancel | CANCEL from CONFIRMED / OFFERED / QUEUED (R6): released seats relayed in the same settlement; re-registration gets a new seq at the tail | 37 | 0 | 0 | 0 | PASS |
| 3 | capacity-up | SET_CAPACITY up relays the new seats to the queue in the same settlement (CAPACITY_UP backfills) | 26 | 0 | 0 | 0 | PASS |
| 3 | capacity-down | SET_CAPACITY below confirmed + held is rejected (R7), to exactly the usage is applied; invalid values rejected | 23 | 0 | 0 | 0 | PASS |
| 3 | cancel-session | CANCEL_SESSION revokes held seats, releases confirmed ones and drops the session from every preference list; owners queue for their other sessions | 38 | 0 | 0 | 0 | PASS |
| 3 | cancel-workshop | CANCEL_WORKSHOP ends every registration (WORKSHOP_CANCELLED), releases every seat and rejects later commands | 26 | 0 | 0 | 0 | PASS |
| 3 | close-open | CLOSE_REGISTRATION blocks new registrations but keeps offers acceptable; OPEN_REGISTRATION reopens | 18 | 0 | 0 | 0 | PASS |

## Command latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| settle, client-observed (POST → terminal poll) | 207 | 793 | 852 | 915 | 1024 | 799.4 |
| settle, server-side (settledAt − acceptedAt) | 207 | 38 | 54 | 78 | 215 | 39.9 |

`raw.csv` lists every step (expected vs actual, settle ms); `latency.csv` every command.

## Checks

All 672 checks passed.
