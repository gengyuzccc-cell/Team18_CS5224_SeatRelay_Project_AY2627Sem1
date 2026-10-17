# smoke — Acceptance smoke test (RUNBOOK §3, plan §3 step 12; both deployments)

- Verdict: **PASS** (13/13 checks passed)
- Pass criterion (plan §4): every step asserts; cancellation backfill in the same settlement (0 ms); expiry relayed by the timer path within 15 s; late ACCEPT → OFFER_EXPIRED; verify ok; DLQ / FAILED rows empty
- Run id: `5a063ea6-f047-4597-844e-e15d958d3146`, started 2026-10-17T21:10:07.748Z, finished 2026-10-17T21:11:26.482Z (79 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 1; holdSeconds: 60; fault flags: on
- Commit: d34e0ac632e7b96126b1eb980192ea32ec24b8d9 on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/smoke.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Steps

| run | step | result | expected | actual | ms |
|---|---|---|---|---|---|
| 1 | 1 workshop created | PASS |  |  |  |
| 1 | 2 alice OFFERED S1 | PASS | OFFERED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 | REGISTER → APPLIED OFFERED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 [2257 ms] | 2257 |
| 1 | 3 alice CONFIRMED S1 | PASS | CONFIRMED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 | ACCEPT_OFFER → APPLIED CONFIRMED [890 ms] | 890 |
| 1 | 3 bob QUEUED position 1 | PASS | QUEUED#1 | REGISTER → APPLIED QUEUED#1 [883 ms] | 883 |
| 1 | 4 alice CANCEL relays one offer | PASS | APPLIED offersCreated=1 | CANCEL_REGISTRATION → APPLIED CANCELLED [910 ms] offersCreated=1 | 910 |
| 1 | 4 bob OFFERED S1 | PASS | OFFERED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 | OFFERED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 |  |
| 1 | 4 backfill CANCELLED_CONFIRMED latency 0 | PASS | 1 record, latencyMs 0, newUserId bob | [{"cause":"CANCELLED_CONFIRMED","latencyMs":0}] |  |
| 1 | 5 carol QUEUED | PASS | QUEUED | REGISTER → APPLIED QUEUED#1 [882 ms] | 882 |
| 1 | 5 carol OFFERED S1 after expiry | PASS | OFFERED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 | OFFERED@fae9e5f0-e0cd-4d73-9089-a1f9cacb0557 observed 2026-10-17T21:11:20.274Z | 702 |
| 1 | 5 backfill EXPIRED relayed within 15 s | PASS | 1 EXPIRED record, latencyMs < 15000 | [{"latencyMs":80,"reallocatedAt":"2026-10-17T21:11:19.652Z"}] | 80 |
| 1 | 6 bob late ACCEPT rejected OFFER_EXPIRED | PASS | REJECTED(OFFER_EXPIRED) | ACCEPT_OFFER → REJECTED(OFFER_EXPIRED) [805 ms] | 805 |
| 1 | 7 verify ok, no over-capacity, no double holds | PASS | ok=true overCapacity=0 doubleHolds=0 | ok=true overCapacity=0 doubleHolds=0 violations=[] |  |
| 1 | 7 dead letters empty | PASS | 0 | 0 |  |

## Latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| command settle, client-observed (POST → terminal poll) | 6 | 883 | 2257 | 2257 | 2257 | 1104.5 |
| command settle, server-side (settledAt − acceptedAt) | 6 | 47 | 1003 | 1003 | 1003 | 208.5 |
| expiry-driven backfill (reallocatedAt − expiresAt) | 1 | 80 | 80 | 80 | 80 | 80.0 |

Cancellation-driven backfills happen inside the cancelling command's own settlement (latencyMs 0 by construction; asserted in step 4).

## Checks

All 13 checks passed.
