# smoke — Acceptance smoke test (RUNBOOK §3, plan §3 step 12; both deployments)

- Verdict: **PASS** (13/13 checks passed)
- Pass criterion (plan §4): every step asserts; cancellation backfill in the same settlement (0 ms); expiry relayed by the timer path within 15 s; late ACCEPT → OFFER_EXPIRED; verify ok; DLQ / FAILED rows empty
- Run id: `adcdb34d-7f32-45c5-9fce-6e3bff6d8aa2`, started 2026-10-31T05:29:22.686Z, finished 2026-10-31T05:30:39.892Z (77 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 1; holdSeconds: 60; fault flags: on
- Commit: 7970cfffa556df636076fa0a5c18b28d5a6d7d5b on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/smoke.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Steps

| run | step | result | expected | actual | ms |
|---|---|---|---|---|---|
| 1 | 1 workshop created | PASS |  |  |  |
| 1 | 2 alice OFFERED S1 | PASS | OFFERED@c9a912b9-b36e-40e2-8701-363adc58bcac | REGISTER → APPLIED OFFERED@c9a912b9-b36e-40e2-8701-363adc58bcac [1331 ms] | 1331 |
| 1 | 3 alice CONFIRMED S1 | PASS | CONFIRMED@c9a912b9-b36e-40e2-8701-363adc58bcac | ACCEPT_OFFER → APPLIED CONFIRMED [882 ms] | 882 |
| 1 | 3 bob QUEUED position 1 | PASS | QUEUED#1 | REGISTER → APPLIED QUEUED#1 [803 ms] | 803 |
| 1 | 4 alice CANCEL relays one offer | PASS | APPLIED offersCreated=1 | CANCEL_REGISTRATION → APPLIED CANCELLED [837 ms] offersCreated=1 | 837 |
| 1 | 4 bob OFFERED S1 | PASS | OFFERED@c9a912b9-b36e-40e2-8701-363adc58bcac | OFFERED@c9a912b9-b36e-40e2-8701-363adc58bcac |  |
| 1 | 4 backfill CANCELLED_CONFIRMED latency 0 | PASS | 1 record, latencyMs 0, newUserId bob | [{"cause":"CANCELLED_CONFIRMED","latencyMs":0}] |  |
| 1 | 5 carol QUEUED | PASS | QUEUED | REGISTER → APPLIED QUEUED#1 [815 ms] | 815 |
| 1 | 5 carol OFFERED S1 after expiry | PASS | OFFERED@c9a912b9-b36e-40e2-8701-363adc58bcac | OFFERED@c9a912b9-b36e-40e2-8701-363adc58bcac observed 2026-10-31T05:30:33.905Z | 273 |
| 1 | 5 backfill EXPIRED relayed within 15 s | PASS | 1 EXPIRED record, latencyMs < 15000 | [{"latencyMs":85,"reallocatedAt":"2026-10-31T05:30:33.717Z"}] | 85 |
| 1 | 6 bob late ACCEPT rejected OFFER_EXPIRED | PASS | REJECTED(OFFER_EXPIRED) | ACCEPT_OFFER → REJECTED(OFFER_EXPIRED) [793 ms] | 793 |
| 1 | 7 verify ok, no over-capacity, no double holds | PASS | ok=true overCapacity=0 doubleHolds=0 | ok=true overCapacity=0 doubleHolds=0 violations=[] |  |
| 1 | 7 dead letters empty | PASS | 0 | 0 |  |

## Latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| command settle, client-observed (POST → terminal poll) | 6 | 815 | 1331 | 1331 | 1331 | 910.2 |
| command settle, server-side (settledAt − acceptedAt) | 6 | 41 | 162 | 162 | 162 | 72.5 |
| expiry-driven backfill (reallocatedAt − expiresAt) | 1 | 85 | 85 | 85 | 85 | 85.0 |

Cancellation-driven backfills happen inside the cancelling command's own settlement (latencyMs 0 by construction; asserted in step 4).

## Checks

All 13 checks passed.
