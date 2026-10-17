# concurrency — Concurrency (plan §4, Table 3)

- Verdict: **FAIL** (22/39 checks passed)
- Pass criterion (plan §4): final state satisfies every invariant (verify ok, 0 over-capacity, 0 double holds) after each concurrent phase; META conflict retries recorded (expected 0)
- Run id: `a6983ff8-cf1d-44c5-9b89-94751e701ca4`, started 2026-10-17T13:26:18.893Z, finished 2026-10-17T13:28:21.194Z (122 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: ec54916a2dcb44302be594f6ff5da93bcdf7ef5e (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/concurrency.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Setup: 50 concurrent accounts race for 3 sessions with 5 seats in total (capacities 2/2/1; 10.0 accounts per seat)
- Commands: 209 (76 transport errors / settle timeouts)
- Same-account races: 5/15 consistent; first effective command: CANCEL 7, ACCEPT 3, DECLINE 5
- META conflict retries in the window: **0** (expected 0: FIFO, one consumer per workshop)

## Per run

| run | offered after race | queued after race | relayed after same-account race | confirmed at end | backfill records |
|---|---|---|---|---|---|
| 1 | 5 | 24 | 4 | 5 | 4 |
| 2 | 5 | 27 | 5 | 5 | 5 |
| 3 | 5 | 32 | 5 | 5 | 6 |

## Settle latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| 1 register race: client-observed | 86 | 2023 | 7798 | 7839 | 7839 | 3414.0 |
| 1 register race: server-side | 86 | 975 | 6432 | 6593 | 6593 | 2364.1 |
| 2 same-account race: client-observed | 33 | 796 | 1432 | 1539 | 1539 | 885.1 |
| 2 same-account race: server-side | 33 | 241 | 499 | 566 | 566 | 258.7 |
| 3 accept storm: client-observed | 14 | 788 | 823 | 823 | 823 | 787.8 |
| 3 accept storm: server-side | 14 | 119 | 221 | 221 | 221 | 116.7 |
| all commands: client-observed | 133 | 1002 | 7788 | 7838 | 7839 | 2510.1 |
| all commands: server-side | 133 | 447 | 6349 | 6549 | 6593 | 1605.1 |

## Same-account races

| account | POST order | first effective | ACCEPT | DECLINE | CANCEL | verdict |
|---|---|---|---|---|---|---|
| 1 | CANCEL>DECLINE>ACCEPT | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | ERROR HTTP 503 HTTP_ERROR | APPLIED | FAIL |
| 13 | DECLINE>CANCEL>ACCEPT | CANCEL | ERROR HTTP 503 HTTP_ERROR | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | FAIL |
| 6 | ACCEPT>DECLINE>CANCEL | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | ERROR HTTP 503 HTTP_ERROR | FAIL |
| 15 | CANCEL>DECLINE>ACCEPT | CANCEL | ERROR HTTP 503 HTTP_ERROR | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | FAIL |
| 17 | DECLINE>CANCEL>ACCEPT | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | ERROR HTTP 503 HTTP_ERROR | APPLIED | FAIL |
| 3 | DECLINE>CANCEL>ACCEPT | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | ERROR HTTP 503 HTTP_ERROR | FAIL |
| 2 | ACCEPT>CANCEL>DECLINE | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 4 | DECLINE>ACCEPT>CANCEL | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 10 | ACCEPT>DECLINE>CANCEL | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | ERROR HTTP 503 HTTP_ERROR | APPLIED | FAIL |
| 15 | DECLINE>ACCEPT>CANCEL | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 15 | ACCEPT>CANCEL>DECLINE | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 2 | CANCEL>ACCEPT>DECLINE | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | ERROR HTTP 503 HTTP_ERROR | FAIL |
| 14 | CANCEL>ACCEPT>DECLINE | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | APPLIED | PASS |
| 8 | ACCEPT>CANCEL>DECLINE | DECLINE | ERROR HTTP 503 HTTP_ERROR | APPLIED | ERROR HTTP 503 HTTP_ERROR | FAIL |
| 5 | ACCEPT>DECLINE>CANCEL | DECLINE | ERROR HTTP 503 HTTP_ERROR | APPLIED | ERROR HTTP 503 HTTP_ERROR | FAIL |

## Metrics

Source: CloudWatch SeatRelay sums 2026-10-17T13:25:19.605Z → 2026-10-17T13:29:20.207Z (metrics may lag by ~1 min)

| metric | sum | samples | note |
|---|---|---|---|
| MetaConflictRetries | 0 | 0 | expected 0 |
| CommandSettledLatency | 0 | 0 | server-side settle ms (sum / samples) |
| OffersCreated | 0 | 0 |  |

## Checks

17 of 39 checks failed:

| run | scenario | step | expected | actual | detail |
|---|---|---|---|---|---|
| 1 | 1 register race | every REGISTER settled APPLIED | 50 | 27 | ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR |
| 1 | 1 register race | seq unique and gap-free (R2) | 1..27 | 29 seqs, 1..29 |  |
| 1 | 2 same-account race | account 1: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first CANCEL; ACCEPT REJECTED(OFFER_NOT_ACTIVE), DECLINE ERROR HTTP 503 HTTP_ERROR, CANCEL APPLIED; live none |  |
| 1 | 2 same-account race | account 13: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first CANCEL; ACCEPT ERROR HTTP 503 HTTP_ERROR, DECLINE REJECTED(OFFER_NOT_ACTIVE), CANCEL APPLIED; live none |  |
| 1 | 2 same-account race | account 6: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first ACCEPT; ACCEPT APPLIED, DECLINE REJECTED(OFFER_NOT_ACTIVE), CANCEL ERROR HTTP 503 HTTP_ERROR; live CONFIRMED |  |
| 1 | 2 same-account race | account 15: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first CANCEL; ACCEPT ERROR HTTP 503 HTTP_ERROR, DECLINE REJECTED(OFFER_NOT_ACTIVE), CANCEL APPLIED; live none |  |
| 1 | 2 same-account race | account 17: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first CANCEL; ACCEPT REJECTED(OFFER_NOT_ACTIVE), DECLINE ERROR HTTP 503 HTTP_ERROR, CANCEL APPLIED; live none |  |
| 1 | 3 accept storm | confirmed ≤ capacity in every session | confirmed = 4, ≤ capacity per session (2/2/1) | S1 2/2, S2 2/2, S3 1/1 |  |
| 2 | 1 register race | every REGISTER settled APPLIED | 50 | 26 | ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR |
| 2 | 1 register race | seq unique and gap-free (R2) | 1..26 | 32 seqs, 1..32 |  |
| 2 | 2 same-account race | account 3: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first DECLINE; ACCEPT REJECTED(OFFER_NOT_ACTIVE), DECLINE APPLIED, CANCEL ERROR HTTP 503 HTTP_ERROR; live OFFERED |  |
| 2 | 2 same-account race | account 10: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first CANCEL; ACCEPT REJECTED(OFFER_NOT_ACTIVE), DECLINE ERROR HTTP 503 HTTP_ERROR, CANCEL APPLIED; live none |  |
| 3 | 1 register race | every REGISTER settled APPLIED | 50 | 33 | ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR; ERROR HTTP 503 HTTP_ERROR |
| 3 | 1 register race | seq unique and gap-free (R2) | 1..33 | 37 seqs, 1..37 |  |
| 3 | 2 same-account race | account 2: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first DECLINE; ACCEPT REJECTED(OFFER_NOT_ACTIVE), DECLINE APPLIED, CANCEL ERROR HTTP 503 HTTP_ERROR; live OFFERED |  |
| 3 | 2 same-account race | account 8: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first DECLINE; ACCEPT ERROR HTTP 503 HTTP_ERROR, DECLINE APPLIED, CANCEL ERROR HTTP 503 HTTP_ERROR; live OFFERED |  |
| 3 | 2 same-account race | account 5: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left | never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration | first DECLINE; ACCEPT ERROR HTTP 503 HTTP_ERROR, DECLINE APPLIED, CANCEL ERROR HTTP 503 HTTP_ERROR; live OFFERED |  |
