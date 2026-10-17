# backfill — Backfill latency (plan §4, Table 3)

- Verdict: **PASS** (124/124 checks passed)
- Pass criterion (plan §4): expiry-driven backfill p95 ≤ 120 s (reallocatedAt − releasedAt; single-digit seconds expected), every expiry relayed, outliers listed; cancellation-driven backfills reported separately (≈ 0 ms); SweepLateExpiries = 0
- Run id: `983158fd-059e-4c78-a5be-acd0e94b46d0`, started 2026-10-17T19:11:42.100Z, finished 2026-10-17T19:16:36.604Z (295 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0 (dirty)
- Script: `tools/experiments/src/backfill.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Expiry-driven backfill latency (reallocatedAt − releasedAt, releasedAt = expiresAt): **p50 0.05 s, p95 0.10 s, max 0.33 s** over 300 samples (target p95 ≤ 120 s)
- Expired offers relayed: 300/300 expected (0 EXPIRED records without reallocation: nobody left in the queue)
- Cancellation-driven backfills (same settlement): 60 samples, p50 0 ms, max 0 ms
- Outliers above max(10000 ms, p95): 0
- SweepLateExpiries in the window: **0** (expected 0)
- Layout: 10 workshops × 2 sessions × capacity 5, 1 round(s), 22 registrations per workshop, holdSeconds 60

## Latency distribution

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| EXPIRED (timer path) | 300 | 49 | 100 | 136 | 328 | 46.7 |
| CANCELLED_* (same settlement) | 60 | 0 | 0 | 0 | 0 | 0.0 |

## Outliers

None above max(10000 ms, p95 = 100 ms).

## Workshops

| run | workshop | registered | expiries expected | relayed | cancellations | waited s | verify | error |
|---|---|---|---|---|---|---|---|---|
| 1 | c16849d1-0d52-4f7a-b16c-1504ac07f7aa | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | 76ed6939-a84f-4875-a20f-b5a8477c10a1 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | 9e2a0d52-59e8-4c6c-acb6-6cfa86261ed6 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | 9a36ed58-96c7-4ab2-81ac-5d1ea9a16314 | 22 | 10 | 10 | 2 | 60 | ok |  |
| 1 | 5b72d470-1302-481b-90b6-79f587489357 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | b0c90b01-4be0-4beb-b7d5-c73c65e7c653 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | e9148ba4-17fe-4c7e-8bfa-629b9dec7de1 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | d547827c-bc71-43b3-8948-9522eadd559a | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | 94ea5301-a28c-418e-b01c-68d3446cf7d6 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 1 | 30cc8c6c-f5c7-46d6-998b-5c0b1d492edb | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | c0a991f2-67e2-463a-bb08-503937622851 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 5ae37bf6-c44a-4268-8435-1a43ceba9850 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 919c5042-d340-4180-946a-a0ea6e2f05bf | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 4f38c560-b5a7-4e87-8e48-cb40d92d33d3 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 57a085b7-5c0b-4507-adbc-3425c16eb01f | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 72cc6c48-0973-4fa7-83e8-6c4a56154722 | 22 | 10 | 10 | 2 | 60 | ok |  |
| 2 | c5fee2a4-2ddf-4d09-95c2-60b77ebfa900 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | f68f9f9a-5c54-4d19-9c47-9007cb14a2bf | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 5a260140-6c2c-43c1-af34-28706a59453a | 22 | 10 | 10 | 2 | 59 | ok |  |
| 2 | 0018936d-c03d-4d4c-8d96-8e4b728e8040 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 05004709-8364-4f64-aa69-750b1cc85ff7 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 2b125bae-1ce2-4287-8b02-f38eccbac325 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 39c8727d-6b62-4eb8-8ab5-58d12daa09a7 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | c60a1cb0-a46d-4e8d-a5b8-24b64d8cf6e1 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 25663fc2-ac0e-43c4-89ad-1d0b8b90036f | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 64ecacf3-72de-42c2-a75c-3f0d7878acc0 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 866d064e-d8b1-447a-947c-700deeb8f0b3 | 22 | 10 | 10 | 2 | 60 | ok |  |
| 3 | 2e157f42-d0e7-4696-bfe2-6245f8cbcc1f | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | a9403a0b-a0c1-4e17-8b0b-93ab3e533252 | 22 | 10 | 10 | 2 | 59 | ok |  |
| 3 | 3a3b4fcd-7e63-4396-ac05-c40fce98561f | 22 | 10 | 10 | 2 | 59 | ok |  |

## Metrics

Source: CloudWatch SeatRelay sums 2026-10-17T19:10:42.845Z → 2026-10-17T19:17:35.570Z (metrics may lag by ~1 min)

| metric | sum | samples | note |
|---|---|---|---|
| SweepLateExpiries | 0 | 0 | expected 0 |
| BackfillLatency | 14023 | 360 | worker-side ms (sum / samples) |
| OffersExpired | 321 | 1044 | offers expired by tick-first |

`raw.csv` holds one row per backfill record (cause, releasedAt, reallocatedAt, latencyMs); plot with
`python3 tools/experiments/analysis/plot_results.py <this dir> --value latencyMs --group cause`.

## Checks

All 124 checks passed.
