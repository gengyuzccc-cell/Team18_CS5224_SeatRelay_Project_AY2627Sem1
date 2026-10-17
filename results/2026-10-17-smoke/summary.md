# smoke — Acceptance smoke test (RUNBOOK §3, plan §3 step 12; both deployments)

- Verdict: **PASS** (13/13 checks passed)
- Pass criterion (plan §4): every step asserts; cancellation backfill in the same settlement (0 ms); expiry relayed by the timer path within 15 s; late ACCEPT → OFFER_EXPIRED; verify ok; DLQ / FAILED rows empty
- Run id: `c527cac7-5cf1-4e4a-a6e7-6cfa5ce16ad9`, started 2026-10-17T13:19:10.386Z, finished 2026-10-17T13:20:26.548Z (76 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 1; holdSeconds: 60; fault flags: on
- Commit: 227de3d12b0f6f87b7f614ee785f57d62bc28189 on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/smoke.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Steps

| run | step | result | expected | actual | ms |
|---|---|---|---|---|---|
| 1 | 1 workshop created | PASS |  |  |  |
| 1 | 2 alice OFFERED S1 | PASS | OFFERED@5ec4054d-3b5e-4675-869c-5ffb1aff54af | REGISTER → APPLIED OFFERED@5ec4054d-3b5e-4675-869c-5ffb1aff54af [1815 ms] | 1815 |
| 1 | 3 alice CONFIRMED S1 | PASS | CONFIRMED@5ec4054d-3b5e-4675-869c-5ffb1aff54af | ACCEPT_OFFER → APPLIED CONFIRMED [884 ms] | 884 |
| 1 | 3 bob QUEUED position 1 | PASS | QUEUED#1 | REGISTER → APPLIED QUEUED#1 [854 ms] | 854 |
| 1 | 4 alice CANCEL relays one offer | PASS | APPLIED offersCreated=1 | CANCEL_REGISTRATION → APPLIED CANCELLED [841 ms] offersCreated=1 | 841 |
| 1 | 4 bob OFFERED S1 | PASS | OFFERED@5ec4054d-3b5e-4675-869c-5ffb1aff54af | OFFERED@5ec4054d-3b5e-4675-869c-5ffb1aff54af |  |
| 1 | 4 backfill CANCELLED_CONFIRMED latency 0 | PASS | 1 record, latencyMs 0, newUserId bob | [{"cause":"CANCELLED_CONFIRMED","latencyMs":0}] |  |
| 1 | 5 carol QUEUED | PASS | QUEUED | REGISTER → APPLIED QUEUED#1 [848 ms] | 848 |
| 1 | 5 carol OFFERED S1 after expiry | PASS | OFFERED@5ec4054d-3b5e-4675-869c-5ffb1aff54af | OFFERED@5ec4054d-3b5e-4675-869c-5ffb1aff54af observed 2026-10-17T13:20:20.383Z | 914 |
| 1 | 5 backfill EXPIRED relayed within 15 s | PASS | 1 EXPIRED record, latencyMs < 15000 | [{"latencyMs":117,"reallocatedAt":"2026-10-17T13:20:19.586Z"}] | 117 |
| 1 | 6 bob late ACCEPT rejected OFFER_EXPIRED | PASS | REJECTED(OFFER_EXPIRED) | ACCEPT_OFFER → REJECTED(OFFER_EXPIRED) [782 ms] | 782 |
| 1 | 7 verify ok, no over-capacity, no double holds | PASS | ok=true overCapacity=0 doubleHolds=0 | ok=true overCapacity=0 doubleHolds=0 violations=[] |  |
| 1 | 7 dead letters empty | PASS | 0 | 0 |  |

## Latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| command settle, client-observed (POST → terminal poll) | 6 | 848 | 1815 | 1815 | 1815 | 1004.0 |
| command settle, server-side (settledAt − acceptedAt) | 6 | 45 | 904 | 904 | 904 | 195.5 |
| expiry-driven backfill (reallocatedAt − expiresAt) | 1 | 117 | 117 | 117 | 117 | 117.0 |

Cancellation-driven backfills happen inside the cancelling command's own settlement (latencyMs 0 by construction; asserted in step 4).

## Checks

All 13 checks passed.
