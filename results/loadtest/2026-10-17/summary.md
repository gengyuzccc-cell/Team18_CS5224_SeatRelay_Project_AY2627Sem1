# Load test 2026-10-17

- Each VU iteration: `GET /workshops/{id}` → `POST …/commands` REGISTER (202) → poll `GET /commands/{id}` every 200 ms until APPLIED/REJECTED → CANCEL_REGISTRATION the same way. `cross-workshop` spreads the VUs over 10 workshops, `hotspot` puts all of them on one.
- Targets (plan §4 Performance): reads p95 < 1000 ms, 202 p95 < 1000 ms, client-observed settle p95 < 5000 ms, HTTP error rate < 1.00 %. Server-side settle = `settledAt − acceptedAt` of the CommandResult (plan §1.3 distinguishes the two); the client figure includes up to 200 ms of polling quantisation.
- Custom metrics (reads, 202s, polls, settle) cover the measured phase only; `HTTP errors` is k6 `http_req_failed` over the whole run including warm-up. Raw rows: `raw.csv`; k6 summaries: `k6/<target>/<runId>/`; k6 output: `logs/<target>/<runId>/`.
- CloudWatch columns (dev/pilot): pulled after the matrix (ingestion delay) over the whole minutes of each measured phase (`cwWindowStart`–`cwWindowEnd` in raw.csv; the runs are started so that the measured phase begins on a minute boundary). SQS depth / oldest-message age = maximum of the commands FIFO in the window; CW settle p95 = p95 of the worker's `CommandSettledLatency` over the window as one period (server-side, every command of the stage). It is reported next to, never instead of, the client-observed k6 settle p95.
- A cell run more than once keeps every attempt: the tables use the latest attempt (column `attempts`), the earlier ones are listed under "Superseded runs" and stay in `raw.csv` / `runs.json` with their k6 files.

## Target `dev`

- API: `https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com`
- Runs: 18 (scenarios `cross-workshop`, `hotspot` × VUs 10/25/50 × rounds 1/2/3); warm-up `30s`, measured `60s` per run; commit `c1d0660-dirty`.

### dev · cross-workshop

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 1 | 277 / 290 | 290 / 308 | 291 | 770 / 793 | 55 | 0.00 % | 0 | 0 | pass | 0 | 0 | – / – |
| 10 | 2 | 1 | 277 / 292 | 291 / 315 | 294 | 770 / 803 | 72 | 0.00 % | 0 | 0 | pass | 0 | 0 | – / – |
| 10 | 3 | 1 | 278 / 288 | 290 / 318 | 295 | 771 / 811 | 65 | 0.00 % | 0 | 0 | pass | 0 | 0 | – / – |
| 25 | 1 | 1 | 276 / 293 | 290 / 320 | 296 | 789 / 6554 | 6054 | 1.57 % | 9 | 0 | FAIL (settle_ms p(95)<5000; http_req_failed rate<0.01) | 0 | 0 | – / – |
| 25 | 2 | 1 | 275 / 288 | 287 / 306 | 289 | 774 / 6912 | 6302 | 1.33 % | 20 | 0 | FAIL (settle_ms p(95)<5000; http_req_failed rate<0.01) | 0 | 0 | – / – |
| 25 | 3 | 1 | 275 / 286 | 287 / 304 | 288 | 786 / 7059 | 6507 | 0.84 % | 11 | 0 | FAIL (settle_ms p(95)<5000) | 13 | 3 | – / – |
| 50 | 1 | 1 | 272 / 284 | 284 / 300 | 289 | 15537 / 29127 | 28460 | 9.68 % | 21 | 38 | FAIL (settle_ms p(95)<5000; http_req_failed rate<0.01) | 34 | 15 | – / – |
| 50 | 2 | 1 | 273 / 293 | 285 / 300 | 289 | 14930 / 28625 | 28180 | 9.81 % | 15 | 26 | FAIL (settle_ms p(95)<5000; http_req_failed rate<0.01) | 38 | 17 | – / – |
| 50 | 3 | 1 | 273 / 284 | 284 / 306 | 290 | 11650 / 29370 | 28888 | 9.40 % | 27 | 35 | FAIL (http_req_failed rate<0.01; settle_ms p(95)<5000) | 36 | 17 | – / – |

Per level (median of the rounds; errors = worst round):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | HTTP errors | targets |
|---|---|---|---|---|---|---|---|
| 10 | 3 | 290 | 315 | 803 | 65 | 0.00 % | met |
| 25 | 3 | 288 | 306 | 6912 | 6302 | 1.57 % | NOT met |
| 50 | 3 | 284 | 300 | 29127 | 28460 | 9.81 % | NOT met |

### dev · hotspot

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 1 | 273 / 284 | 283 / 296 | 287 | 757 / 780 | 116 | 0.00 % | 0 | 0 | pass | 0 | 0 | – / – |
| 10 | 2 | 1 | 271 / 281 | 281 / 300 | 283 | 754 / 780 | 120 | 0.00 % | 0 | 0 | pass | 0 | 0 | – / – |
| 10 | 3 | 1 | 274 / 284 | 285 / 303 | 289 | 762 / 792 | 127 | 0.00 % | 0 | 0 | pass | 0 | 0 | – / – |
| 25 | 1 | 1 | 271 / 289 | 282 / 305 | 286 | 1246 / 7245 | 6650 | 0.22 % | 3 | 0 | FAIL (settle_ms p(95)<5000) | 11 | 0 | – / – |
| 25 | 2 | 1 | 274 / 292 | 284 / 306 | 288 | 1234 / 7405 | 6791 | 0.47 % | 9 | 0 | FAIL (settle_ms p(95)<5000) | 24 | 3 | – / – |
| 25 | 3 | 1 | 275 / 294 | 285 / 306 | 292 | 1237 / 7398 | 6852 | 0.47 % | 8 | 0 | FAIL (settle_ms p(95)<5000) | 12 | 0 | – / – |
| 50 | 1 | 1 | 276 / 314 | 284 / 305 | 285 | 0 / 0 | – | 7.61 % | 0 | 63 | FAIL (http_req_failed rate<0.01) | 73 | 25 | – / – |
| 50 | 2 | 1 | 275 / 307 | 283 / 298 | 285 | 25989 / 29943 | 29335 | 8.01 % | 8 | 60 | FAIL (http_req_failed rate<0.01; settle_ms p(95)<5000) | 49 | 12 | – / – |
| 50 | 3 | 1 | 276 / 287 | 286 / 310 | 285 | 20061 / 28644 | 28242 | 7.08 % | 2 | 76 | FAIL (settle_ms p(95)<5000; http_req_failed rate<0.01) | 48 | 17 | – / – |

Per level (median of the rounds; errors = worst round):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | HTTP errors | targets |
|---|---|---|---|---|---|---|---|
| 10 | 3 | 284 | 300 | 780 | 120 | 0.00 % | met |
| 25 | 3 | 292 | 306 | 7398 | 6791 | 0.47 % | NOT met |
| 50 | 3 | 307 | 305 | 28644 | 28788 | 8.01 % | NOT met |

## Target `local`

- API: `http://localhost:3000`
- Runs: 13 (scenarios `cross-workshop`, `hotspot` × VUs 10/25/50 × rounds 1/2/3); warm-up `30s`, measured `60s` per run; commit `410622a-dirty`.
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

Per level (median of the rounds; errors = worst round):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | HTTP errors | targets |
|---|---|---|---|---|---|---|---|
| 10 | 3 | 11 | 10 | 414 | 250 | 0.00 % | met |
| 25 | 3 | 17 | 14 | 426 | 365 | 0.00 % | met |
| 50 | 3 | 13 | 10 | 2875 | 2807 | 0.00 % | met |

### local · hotspot

| VUs | round | attempts | reads p50 / p95 (ms) | 202 p50 / p95 (ms) | poll p95 (ms) | settle p50 / p95 client (ms) | settle p95 server (ms) | HTTP errors | rejected | timeouts | k6 thresholds | SQS depth max | oldest msg max (s) | CW settle p95 / samples (window) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1 | 1 | 5 / 12 | 4 / 9 | 5 | 208 / 411 | 226 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 10 | 2 | 1 | 5 / 11 | 5 / 9 | 5 | 209 / 414 | 238 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 10 | 3 | 1 | 5 / 11 | 5 / 9 | 5 | 209 / 413 | 236 | 0.00 % | 0 | 0 | pass | – | – | – / – |
| 25 | 1 | 1 | 6 / 16 | 5 / 13 | 6 | 217 / 424 | 368 | 0.00 % | 0 | 0 | pass | – | – | – / – |

Per level (median of the rounds; errors = worst round):

| VUs | rounds | reads p95 | 202 p95 | settle p95 client | settle p95 server | HTTP errors | targets |
|---|---|---|---|---|---|---|---|
| 10 | 3 | 11 | 9 | 413 | 236 | 0.00 % | met |
| 25 | 1 | 16 | 13 | 424 | 368 | 0.00 % | met |
