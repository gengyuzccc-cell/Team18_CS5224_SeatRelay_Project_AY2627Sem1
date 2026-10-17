# Load test 2026-10-17

- Each VU iteration: `GET /workshops/{id}` → `POST …/commands` REGISTER (202) → poll `GET /commands/{id}` every 200 ms until APPLIED/REJECTED → CANCEL_REGISTRATION the same way. `cross-workshop` spreads the VUs over 10 workshops, `hotspot` puts all of them on one.
- Targets (plan §4 Performance): reads p95 < 1000 ms, 202 p95 < 1000 ms, client-observed settle p95 < 5000 ms, HTTP error rate < 1.00 %. Server-side settle = `settledAt − acceptedAt` of the CommandResult (plan §1.3 distinguishes the two); the client figure includes up to 200 ms of polling quantisation.
- Custom metrics (reads, 202s, polls, settle) cover the measured phase only; `HTTP errors` is k6 `http_req_failed` over the whole run including warm-up. Raw rows: `raw.csv`; k6 summaries: `k6/<target>/<runId>/`; k6 output: `logs/<target>/<runId>/`.
- CloudWatch columns (dev/pilot): pulled after the matrix (ingestion delay) over the whole minutes of each measured phase (`cwWindowStart`–`cwWindowEnd` in raw.csv; the runs are started so that the measured phase begins on a minute boundary). SQS depth / oldest-message age = maximum of the commands FIFO in the window; CW settle p95 = p95 of the worker's `CommandSettledLatency` over the window as one period (server-side, every command of the stage). It is reported next to, never instead of, the client-observed k6 settle p95.
- A cell run more than once keeps every attempt: the tables use the latest attempt (column `attempts`), the earlier ones are listed under "Superseded runs" and stay in `raw.csv` / `runs.json` with their k6 files.

## Target `dev`

- API: `https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com`
- Runs: 18 (scenarios `cross-workshop`, `hotspot` × VUs 10/25/50 × rounds 1/2/3); warm-up `30s`, measured `60s` per run; commit `d121145`.

### dev · cross-workshop

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 2 | 276 / 319 | 290 / 336 | 321 | 769 / 861 | 62 | 0.00 % | 0 | 0 | pass | 0 | 0 | 61 / 640 |
| 10 | 2 | 2 | 276 / 293 | 288 / 315 | 289 | 766 / 799 | 62 | 0.00 % | 0 | 0 | pass | 0 | 0 | 60 / 643 |
| 10 | 3 | 2 | 277 / 294 | 289 / 312 | 292 | 769 / 800 | 65 | 0.00 % | 0 | 0 | pass | 0 | 0 | 64 / 649 |
| 25 | 1 | 2 | 275 / 291 | 287 / 314 | 291 | 764 / 799 | 83 | 0.00 % | 0 | 0 | pass | 0 | 0 | 85 / 1639 |
| 25 | 2 | 2 | 275 / 293 | 286 / 310 | 291 | 763 / 796 | 88 | 0.00 % | 0 | 0 | pass | 0 | 0 | 89 / 1642 |
| 25 | 3 | 2 | 275 / 292 | 287 / 310 | 289 | 764 / 793 | 91 | 0.00 % | 0 | 0 | pass | 0 | 0 | 91 / 1643 |
| 50 | 1 | 2 | 275 / 292 | 286 / 310 | 292 | 762 / 795 | 193 | 0.00 % | 0 | 0 | pass | 0 | 0 | 192 / 3282 |
| 50 | 2 | 2 | 275 / 286 | 286 / 302 | 286 | 762 / 786 | 193 | 0.00 % | 0 | 0 | pass | 0 | 0 | 184 / 3297 |
| 50 | 3 | 2 | 273 / 289 | 284 / 301 | 285 | 759 / 784 | 163 | 0.00 % | 0 | 0 | pass | 1 | 0 | 160 / 3308 |

Per level (median of the rounds; errors = worst round; a round in which no command settled within the client budget counts as +∞ in the settle medians, not as 0):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | rounds with nothing settled | HTTP errors | targets |
|---|---|---|---|---|---|---|---|---|
| 10 | 3 | 294 | 315 | 800 | 62 | 0 | 0.00 % | met |
| 25 | 3 | 292 | 310 | 796 | 88 | 0 | 0.00 % | met |
| 50 | 3 | 289 | 302 | 786 | 193 | 0 | 0.00 % | met |

### dev · hotspot

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 2 | 275 / 297 | 286 / 310 | 302 | 763 / 816 | 104 | 0.00 % | 0 | 0 | pass | 0 | 0 | 107 / 657 |
| 10 | 2 | 2 | 276 / 294 | 287 / 311 | 296 | 765 / 797 | 115 | 0.00 % | 0 | 0 | pass | 1 | 0 | 117 / 660 |
| 10 | 3 | 2 | 274 / 286 | 285 / 299 | 287 | 761 / 785 | 162 | 0.00 % | 0 | 0 | pass | 0 | 0 | 162 / 663 |
| 25 | 1 | 2 | 277 / 291 | 287 / 308 | 291 | 1236 / 1296 | 909 | 0.00 % | 0 | 0 | pass | 12 | 0 | 888 / 1157 |
| 25 | 2 | 2 | 277 / 294 | 287 / 307 | 292 | 1236 / 1360 | 940 | 0.00 % | 0 | 0 | pass | 10 | 0 | 922 / 1160 |
| 25 | 3 | 2 | 277 / 294 | 287 / 306 | 292 | 1238 / 1686 | 950 | 0.00 % | 0 | 0 | pass | 6 | 0 | 950 / 1151 |
| 50 | 1 | 2 | 278 / 298 | 287 / 307 | 289 | 2661 / 3169 | 2604 | 0.00 % | 0 | 0 | pass | 35 | 1 | 2613 / 1084 |
| 50 | 2 | 2 | 277 / 294 | 285 / 306 | 288 | 2659 / 3166 | 2531 | 0.00 % | 0 | 0 | pass | 35 | 1 | 2567 / 1076 |
| 50 | 3 | 2 | 278 / 297 | 286 / 311 | 290 | 2659 / 3175 | 2601 | 0.00 % | 0 | 0 | pass | 34 | 1 | 2652 / 1087 |

Per level (median of the rounds; errors = worst round; a round in which no command settled within the client budget counts as +∞ in the settle medians, not as 0):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | rounds with nothing settled | HTTP errors | targets |
|---|---|---|---|---|---|---|---|---|
| 10 | 3 | 294 | 310 | 797 | 115 | 0 | 0.00 % | met |
| 25 | 3 | 294 | 307 | 1360 | 940 | 0 | 0.00 % | met |
| 50 | 3 | 297 | 307 | 3169 | 2601 | 0 | 0.00 % | met |

## Target `local`

- API: `http://localhost:3000`
- Runs: 18 (scenarios `cross-workshop`, `hotspot` × VUs 10/25/50 × rounds 1/2/3); warm-up `30s`, measured `60s` per run; commit `410622a-dirty`.
- Note: docker-stats.csv: `docker stats` of the seatrelay-local-* containers every 2 s while the matrix runs (join on startedAt/endedAt of each run).

### local · cross-workshop

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 1 | 5 / 11 | 4 / 10 | 5 | 208 / 411 | 222 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 10 | 2 | 1 | 6 / 12 | 5 / 11 | 5 | 210 / 414 | 250 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 10 | 3 | 1 | 5 / 11 | 5 / 9 | 5 | 210 / 415 | 280 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 1 | 1 | 6 / 17 | 5 / 14 | 7 | 214 / 426 | 346 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 2 | 1 | 5 / 13 | 5 / 11 | 5 | 212 / 423 | 365 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 3 | 1 | 6 / 18 | 5 / 15 | 7 | 215 / 433 | 387 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 50 | 1 | 1 | 5 / 13 | 5 / 10 | 5 | 2230 / 6296 | 6213 | 0.00 % | 0 | 0 | FAIL (settle_ms p(95)<5000) | – | – | – / – |
| 50 | 2 | 1 | 5 / 14 | 5 / 11 | 5 | 2035 / 2840 | 2663 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 50 | 3 | 1 | 5 / 11 | 4 / 10 | 5 | 2028 / 2875 | 2807 | 0.00 % | 0 | 0 | pass | – | – | – / – |

Per level (median of the rounds; errors = worst round; a round in which no command settled within the client budget counts as +∞ in the settle medians, not as 0):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | rounds with nothing settled | HTTP errors | targets |
|---|---|---|---|---|---|---|---|---|
| 10 | 3 | 11 | 10 | 414 | 250 | 0 | 0.00 % | met |
| 25 | 3 | 17 | 14 | 426 | 365 | 0 | 0.00 % | met |
| 50 | 3 | 13 | 10 | 2875 | 2807 | 0 | 0.00 % | met |

### local · hotspot

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 1 | 5 / 12 | 4 / 9 | 5 | 208 / 411 | 226 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 10 | 2 | 1 | 5 / 11 | 5 / 9 | 5 | 209 / 414 | 238 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 10 | 3 | 1 | 5 / 11 | 5 / 9 | 5 | 209 / 413 | 236 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 1 | 1 | 6 / 16 | 5 / 13 | 6 | 217 / 424 | 368 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 2 | 1 | 6 / 16 | 5 / 12 | 6 | 408 / 428 | 379 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 3 | 1 | 6 / 14 | 5 / 11 | 6 | 213 / 421 | 368 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 50 | 1 | 1 | 7 / 18 | 5 / 14 | 6 | 817 / 1047 | 991 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 50 | 2 | 1 | 5 / 12 | 4 / 10 | 6 | 2460 / 2879 | 2784 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 50 | 3 | 1 | 5 / 11 | 4 / 10 | 5 | 3852 / 5947 | 5868 | 0.00 % | 0 | 0 | FAIL (settle_ms p(95)<5000) | – | – | – / – |

Per level (median of the rounds; errors = worst round; a round in which no command settled within the client budget counts as +∞ in the settle medians, not as 0):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | rounds with nothing settled | HTTP errors | targets |
|---|---|---|---|---|---|---|---|---|
| 10 | 3 | 11 | 9 | 413 | 236 | 0 | 0.00 % | met |
| 25 | 3 | 16 | 12 | 424 | 368 | 0 | 0.00 % | met |
| 50 | 3 | 12 | 10 | 2879 | 2784 | 0 | 0.00 % | met |

## Superseded runs

Earlier attempts of a cell that was run again; kept for traceability, not used in the tables above.

| target | scenario | VUs | round | run id | started | exit | k6 thresholds | settle p95 client (ms) | superseded by | k6 summary | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev | cross-workshop | 10 | 1 | 20261017T141749Z | 2026-10-17T14:18:30.028Z | 0 | pass | 793 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-10-1.json` |  |
| dev | cross-workshop | 10 | 2 | 20261017T141749Z | 2026-10-17T14:20:30.007Z | 0 | pass | 803 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-10-2.json` |  |
| dev | cross-workshop | 10 | 3 | 20261017T141749Z | 2026-10-17T14:22:30.007Z | 0 | pass | 811 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-10-3.json` |  |
| dev | cross-workshop | 25 | 1 | 20261017T141749Z | 2026-10-17T14:24:30.010Z | 99 | FAIL | 6554 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-25-1.json` |  |
| dev | cross-workshop | 25 | 2 | 20261017T141749Z | 2026-10-17T14:26:30.001Z | 99 | FAIL | 6912 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-25-2.json` |  |
| dev | cross-workshop | 25 | 3 | 20261017T141749Z | 2026-10-17T14:29:30.006Z | 99 | FAIL | 7059 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-25-3.json` |  |
| dev | cross-workshop | 50 | 1 | 20261017T141749Z | 2026-10-17T14:32:30.055Z | 99 | FAIL | 29127 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-50-1.json` |  |
| dev | cross-workshop | 50 | 2 | 20261017T141749Z | 2026-10-17T14:35:30.041Z | 99 | FAIL | 28625 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-50-2.json` |  |
| dev | cross-workshop | 50 | 3 | 20261017T141749Z | 2026-10-17T14:38:30.047Z | 99 | FAIL | 29370 | 20261017T192002Z | `k6/dev/20261017T141749Z/cross-workshop-50-3.json` |  |
| dev | hotspot | 10 | 1 | 20261017T141749Z | 2026-10-17T14:41:30.042Z | 0 | pass | 780 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-10-1.json` |  |
| dev | hotspot | 10 | 2 | 20261017T141749Z | 2026-10-17T14:43:30.003Z | 0 | pass | 780 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-10-2.json` |  |
| dev | hotspot | 10 | 3 | 20261017T141749Z | 2026-10-17T14:45:30.011Z | 0 | pass | 792 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-10-3.json` |  |
| dev | hotspot | 25 | 1 | 20261017T141749Z | 2026-10-17T14:47:30.012Z | 99 | FAIL | 7245 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-25-1.json` |  |
| dev | hotspot | 25 | 2 | 20261017T141749Z | 2026-10-17T14:49:30.001Z | 99 | FAIL | 7405 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-25-2.json` |  |
| dev | hotspot | 25 | 3 | 20261017T141749Z | 2026-10-17T14:51:30.002Z | 99 | FAIL | 7398 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-25-3.json` |  |
| dev | hotspot | 50 | 1 | 20261017T141749Z | 2026-10-17T14:53:30.000Z | 99 | FAIL | 0 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-50-1.json` |  |
| dev | hotspot | 50 | 2 | 20261017T141749Z | 2026-10-17T14:56:30.032Z | 99 | FAIL | 29943 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-50-2.json` |  |
| dev | hotspot | 50 | 3 | 20261017T141749Z | 2026-10-17T14:59:30.028Z | 99 | FAIL | 28644 | 20261017T192002Z | `k6/dev/20261017T141749Z/hotspot-50-3.json` |  |
