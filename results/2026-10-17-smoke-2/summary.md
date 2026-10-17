# smoke — Acceptance smoke test (RUNBOOK §3, plan §3 step 12; both deployments)

- Verdict: **PASS** (13/13 checks passed)
- Pass criterion (plan §4): every step asserts; cancellation backfill in the same settlement (0 ms); expiry relayed by the timer path within 15 s; late ACCEPT → OFFER_EXPIRED; verify ok; DLQ / FAILED rows empty
- Run id: `3aabe3fe-c5be-49d8-aa99-46b12dd28242`, started 2026-10-17T18:14:45.190Z, finished 2026-10-17T18:15:57.834Z (73 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 1; holdSeconds: 60; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0
- Script: `tools/experiments/src/smoke.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Steps

| run | step | result | expected | actual | ms |
|---|---|---|---|---|---|
| 1 | 1 workshop created | PASS |  |  |  |
| 1 | 2 alice OFFERED S1 | PASS | OFFERED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 | REGISTER → APPLIED OFFERED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 [1765 ms] | 1765 |
| 1 | 3 alice CONFIRMED S1 | PASS | CONFIRMED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 | ACCEPT_OFFER → APPLIED CONFIRMED [849 ms] | 849 |
| 1 | 3 bob QUEUED position 1 | PASS | QUEUED#1 | REGISTER → APPLIED QUEUED#1 [876 ms] | 876 |
| 1 | 4 alice CANCEL relays one offer | PASS | APPLIED offersCreated=1 | CANCEL_REGISTRATION → APPLIED CANCELLED [906 ms] offersCreated=1 | 906 |
| 1 | 4 bob OFFERED S1 | PASS | OFFERED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 | OFFERED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 |  |
| 1 | 4 backfill CANCELLED_CONFIRMED latency 0 | PASS | 1 record, latencyMs 0, newUserId bob | [{"cause":"CANCELLED_CONFIRMED","latencyMs":0}] |  |
| 1 | 5 carol QUEUED | PASS | QUEUED | REGISTER → APPLIED QUEUED#1 [858 ms] | 858 |
| 1 | 5 carol OFFERED S1 after expiry | PASS | OFFERED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 | OFFERED@a1bfbc5b-cf1e-4f0d-ab45-64f476acf5a7 observed 2026-10-17T18:15:52.387Z | 585 |
| 1 | 5 backfill EXPIRED relayed within 15 s | PASS | 1 EXPIRED record, latencyMs < 15000 | [{"latencyMs":108,"reallocatedAt":"2026-10-17T18:15:51.910Z"}] | 108 |
| 1 | 6 bob late ACCEPT rejected OFFER_EXPIRED | PASS | REJECTED(OFFER_EXPIRED) | ACCEPT_OFFER → REJECTED(OFFER_EXPIRED) [832 ms] | 832 |
| 1 | 7 verify ok, no over-capacity, no double holds | PASS | ok=true overCapacity=0 doubleHolds=0 | ok=true overCapacity=0 doubleHolds=0 violations=[] |  |
| 1 | 7 dead letters empty | PASS | 0 | 0 |  |

## Latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| command settle, client-observed (POST → terminal poll) | 6 | 858 | 1765 | 1765 | 1765 | 1014.3 |
| command settle, server-side (settledAt − acceptedAt) | 6 | 57 | 767 | 767 | 767 | 173.2 |
| expiry-driven backfill (reallocatedAt − expiresAt) | 1 | 108 | 108 | 108 | 108 | 108.0 |

Cancellation-driven backfills happen inside the cancelling command's own settlement (latencyMs 0 by construction; asserted in step 4).

## Checks

All 13 checks passed.
