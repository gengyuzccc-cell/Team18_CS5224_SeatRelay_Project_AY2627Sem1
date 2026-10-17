# Generated result charts

Written by `report/tools/make_figures.py` from `results/`; do not edit. Re-run with
`python3 -I report/tools/make_figures.py` after new results arrive.

| Chart | What | Source |
|---|---|---|
| `replay-comparison.pdf` | UNIFIED vs PER_SESSION per seed (box p25-p75, median line, whiskers p5-p95, diamond = mean) | `results/replay/raw.csv: dup_hold_events, fill_rate, seat_refill_min_mean by mode` |
| `slide-replay.pdf` | slide 10: duplicate-hold events per simulated workshop by mode (box p25-p75, median, whiskers p5-p95, diamond = mean) | `results/replay/raw.csv: dup_hold_events by mode` |
| `replay-paired.pdf` | per-seed pairs, UNIFIED on x, PER_SESSION on y, dashed y = x | `results/replay/raw.csv: distinct_served, seat_refill_min_mean pivoted by seed` |
| `cost-crossover.pdf` | monthly cost by registrations (log-log), on-prem at the model's amortisation period; after-credits layer is 0 and not drawn | `results/cost/crossover-curve.csv: cloud_list, cloud_after_free, onprem_full, onprem_increment`<br>`results/cost/model-summary.md: section 3 crossover points` |
| `cost-unit.pdf` | cost per 1,000 registrations (log-log) | `results/cost/crossover-curve.csv: cloud_list, cloud_after_free, onprem_full, onprem_increment` |
| `backfill-latency.pdf` | expiry-driven backfill latency, runId 983158fd-059e-4c78-a5be-acd0e94b46d0, target dev, started 2026-10-17T19:11:42.100Z, commit e05c037d485d (dirty) | `results/2026-10-17-backfill-2/raw.csv: latencyMs where cause = EXPIRED and reallocatedAt set (pooled over runs)` |
| `settle-latency.pdf` | command settle latency ECDFs per functional experiment (log x) | `results/2026-10-17-smoke-2/raw.csv: serverSettleMs, settleMs (runId 3aabe3fe-c5be-49d8-aa99-46b12dd28242, target dev, started 2026-10-17T18:14:45.190Z, commit e05c037d485d)`<br>`results/2026-10-17-correctness-2/latency.csv: serverSettleMs, settleMs (runId d179d40d-6148-41b2-8a5d-1a4df8ae0ac5, target dev, started 2026-10-17T18:16:07.202Z, commit e05c037d485d (dirty))`<br>`results/2026-10-17-preference-order-2/latency.csv: serverSettleMs, settleMs (runId 4b65ed89-d047-4946-9188-deaefb827df1, target dev, started 2026-10-17T18:20:35.647Z, commit e05c037d485d (dirty))`<br>`results/2026-10-17-concurrency-2/raw.csv: serverSettleMs, settleMs (runId 08262972-5e6e-4436-af51-36893adf38c3, target dev, started 2026-10-17T18:21:17.132Z, commit e05c037d485d (dirty))` |
| `loadtest-p95.pdf` | k6 matrix, median over rounds of each run's p95, dashed lines = 1 s and 5 s targets | `results/loadtest/2026-10-17/raw.csv: readP95, commandP95, settleP95, serverSettleP95 (active rounds, median per VU level)` |
| `slide-loadtest.pdf` | slide 10: k6 client-observed settle p95 (both scenarios) and read p95 by virtual users, median of rounds | `results/loadtest/2026-10-17/raw.csv: settleP95, readP95 (target dev; same +inf rule)` |

## Not drawn (input missing)

- `study-completion.pdf`: no participant rows in results/user-study/session-sheet.csv
- `study-time.pdf`: no participant rows in results/user-study/session-sheet.csv
- `study-sus.pdf`: no valid SUS rows in results/user-study/sus-sheet.csv
