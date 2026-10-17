# Generated result charts

Written by `report/tools/make_figures.py` from `results/`; do not edit. Re-run with
`python3 -I report/tools/make_figures.py` after new results arrive.

| Chart | What | Source |
|---|---|---|
| `replay-comparison.pdf` | UNIFIED vs PER_SESSION per seed (box p25-p75, median line, whiskers p5-p95, diamond = mean) | `results/replay/raw.csv: dup_hold_events, fill_rate, seat_refill_min_mean by mode` |
| `replay-paired.pdf` | per-seed pairs, UNIFIED on x, PER_SESSION on y, dashed y = x | `results/replay/raw.csv: distinct_served, seat_refill_min_mean pivoted by seed` |
| `cost-crossover.pdf` | monthly cost by registrations (log-log), on-prem at the model's amortisation period; after-credits layer is 0 and not drawn | `results/cost/crossover-curve.csv: cloud_list, cloud_after_free, onprem_full, onprem_increment`<br>`results/cost/model-summary.md: section 3 crossover points` |
| `cost-unit.pdf` | cost per 1,000 registrations (log-log) | `results/cost/crossover-curve.csv: cloud_list, cloud_after_free, onprem_full, onprem_increment` |
| `settle-latency.pdf` | command settle latency ECDFs per functional experiment (log x) | `results/2026-10-17-smoke/raw.csv: serverSettleMs, settleMs (runId c527cac7-5cf1-4e4a-a6e7-6cfa5ce16ad9, target dev, started 2026-10-17T13:19:10.386Z, commit 227de3d12b0f)`<br>`results/2026-10-17-correctness/latency.csv: serverSettleMs, settleMs (runId fe64a545-028a-44dd-8988-073b8bd2dfd0, target dev, started 2026-10-17T13:21:12.236Z, commit 227de3d12b0f (dirty))`<br>`results/2026-10-17-preference-order/latency.csv: serverSettleMs, settleMs (runId 5d51b310-256c-4ca0-bf48-c6e3e9840d0f, target dev, started 2026-10-17T13:25:36.174Z, commit ec54916a2dcb (dirty))`<br>`results/2026-10-17-concurrency/raw.csv: serverSettleMs, settleMs (runId a6983ff8-cf1d-44c5-9b89-94751e701ca4, target dev, started 2026-10-17T13:26:18.893Z, commit ec54916a2dcb (dirty))` |

## Not drawn (input missing)

- `backfill-latency.pdf`: no complete results/<date>-backfill run for target dev
- `loadtest-p95.pdf`: no results/loadtest/<date>/raw.csv
- `study-completion.pdf`: no participant rows in results/user-study/session-sheet.csv
- `study-time.pdf`: no participant rows in results/user-study/session-sheet.csv
- `study-sus.pdf`: no valid SUS rows in results/user-study/sus-sheet.csv
