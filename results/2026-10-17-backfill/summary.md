# backfill — Backfill latency (plan §4, Table 3)

- Verdict: **FAIL** (0/1 checks passed)
- Pass criterion (plan §4): expiry-driven backfill p95 ≤ 120 s (reallocatedAt − releasedAt; single-digit seconds expected), every expiry relayed, outliers listed; cancellation-driven backfills reported separately (≈ 0 ms); SweepLateExpiries = 0
- Run id: `3393de39-7f0b-4404-994e-cc912749aec4`, started 2026-10-17T14:16:25.938Z, finished 2026-10-17T14:16:29.695Z (4 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: c1d066056b2c9d36cc33869629f99f390451c101 (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/backfill.ts`; raw samples: `raw.csv`; parameters: `meta.json`

**The run aborted with an error:** POST /orgs/3e3fad61-2cc6-4403-b62d-c8fb2d023ce1/workshops → 503

## Checks

1 of 1 checks failed:

| run | scenario | step | expected | actual | detail |
|---|---|---|---|---|---|
| 1 | harness | run |  |  | POST /orgs/3e3fad61-2cc6-4403-b62d-c8fb2d023ce1/workshops → 503 |
