# concurrency — Concurrency (plan §4, Table 3)

- Verdict: **PASS** (39/39 checks passed)
- Pass criterion (plan §4): final state satisfies every invariant (verify ok, 0 over-capacity, 0 double holds) after each concurrent phase; META conflict retries recorded (expected 0)
- Run id: `08262972-5e6e-4436-af51-36893adf38c3`, started 2026-10-17T18:21:17.132Z, finished 2026-10-17T18:23:15.662Z (119 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0 (dirty)
- Script: `tools/experiments/src/concurrency.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Setup: 50 concurrent accounts race for 3 sessions with 5 seats in total (capacities 2/2/1; 10.0 accounts per seat)
- Commands: 210 (0 transport errors / settle timeouts)
- Same-account races: 15/15 consistent; first effective command: ACCEPT 7, DECLINE 6, CANCEL 2
- META conflict retries in the window: **0** (expected 0: FIFO, one consumer per workshop)

## Per run

| run | offered after race | queued after race | relayed after same-account race | confirmed at end | backfill records |
|---|---|---|---|---|---|
| 1 | 5 | 45 | 5 | 5 | 6 |
| 2 | 5 | 45 | 5 | 5 | 6 |
| 3 | 5 | 45 | 5 | 5 | 7 |

## Settle latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| 1 register race: client-observed | 150 | 2024 | 3430 | 3649 | 3725 | 1997.7 |
| 1 register race: server-side | 150 | 890 | 1589 | 1700 | 1732 | 870.8 |
| 2 same-account race: client-observed | 45 | 802 | 1637 | 1731 | 1731 | 1028.1 |
| 2 same-account race: server-side | 45 | 410 | 715 | 801 | 801 | 400.8 |
| 3 accept storm: client-observed | 15 | 795 | 841 | 841 | 841 | 799.1 |
| 3 accept storm: server-side | 15 | 126 | 236 | 236 | 236 | 129.1 |
| all commands: client-observed | 210 | 1599 | 3384 | 3642 | 3725 | 1704.3 |
| all commands: server-side | 210 | 656 | 1525 | 1683 | 1732 | 717.1 |

## Same-account races

| account | POST order | first effective | ACCEPT | DECLINE | CANCEL | verdict |
|---|---|---|---|---|---|---|
| 1 | CANCEL>DECLINE>ACCEPT | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 5 | DECLINE>CANCEL>ACCEPT | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | APPLIED | PASS |
| 45 | ACCEPT>DECLINE>CANCEL | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 41 | CANCEL>DECLINE>ACCEPT | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 30 | DECLINE>CANCEL>ACCEPT | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | REJECTED(NOT_REGISTERED) | PASS |
| 4 | DECLINE>CANCEL>ACCEPT | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 2 | ACCEPT>CANCEL>DECLINE | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | APPLIED | PASS |
| 1 | DECLINE>ACCEPT>CANCEL | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 3 | ACCEPT>DECLINE>CANCEL | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 12 | DECLINE>ACCEPT>CANCEL | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | APPLIED | PASS |
| 12 | ACCEPT>CANCEL>DECLINE | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 9 | CANCEL>ACCEPT>DECLINE | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | APPLIED | PASS |
| 14 | CANCEL>ACCEPT>DECLINE | ACCEPT | APPLIED | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |
| 1 | ACCEPT>CANCEL>DECLINE | DECLINE | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | APPLIED | PASS |
| 10 | ACCEPT>DECLINE>CANCEL | CANCEL | REJECTED(OFFER_NOT_ACTIVE) | REJECTED(OFFER_NOT_ACTIVE) | APPLIED | PASS |

## Metrics

Source: CloudWatch SeatRelay sums 2026-10-17T18:20:17.454Z → 2026-10-17T18:24:14.639Z (metrics may lag by ~1 min)

| metric | sum | samples | note |
|---|---|---|---|
| MetaConflictRetries | 0 | 0 | expected 0 |
| CommandSettledLatency | 167619 | 443 | server-side settle ms (sum / samples) |
| OffersCreated | 222 | 443 |  |

## Checks

All 39 checks passed.
