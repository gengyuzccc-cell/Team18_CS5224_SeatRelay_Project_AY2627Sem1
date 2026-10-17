# Run register

Every run directory under `results/` with its `meta.json` fields (docs/EXPERIMENTS.md section 6).
Generated from the run directories; the notes column is written by hand. Failed and aborted runs stay listed.

| start (UTC) | experiment | target | commit (dirty?) | run id | runs | verdict (checks) | results dir | notes |
|---|---|---|---|---|---|---|---|---|
| 2026-10-17T07:04:41Z | smoke-dev | dev | f3d1026 |  |  | see the directory | 2026-10-17-smoke-dev | first smoke after the initial dev deploy (older meta format; see the directory) |
| 2026-10-17T13:19:10.386Z | smoke | dev | 227de3d | c527cac7 | 1 | PASS 13/13 | 2026-10-17-smoke | first series (account Lambda quota 10) |
| 2026-10-17T13:21:12.236Z | correctness | dev | 227de3d (dirty) | fe64a545 | 3 | PASS 672/672 | 2026-10-17-correctness | first series (quota 10) |
| 2026-10-17T13:25:36.174Z | preference-order | dev | ec54916 (dirty) | 5d51b310 | 3 | PASS 204/204 | 2026-10-17-preference-order | first series (quota 10) |
| 2026-10-17T13:26:18.893Z | concurrency | dev | ec54916 (dirty) | a6983ff8 | 3 | FAIL 22/39 | 2026-10-17-concurrency | first series (quota 10): 76 HTTP 503 = API Lambda throttles (results/2026-10-17-throttling-evidence/); verify ok after every phase |
| 2026-10-17T13:28:23.895Z | repeat-execution | dev | c1d0660 (dirty) | 3a636ec3 | 3 | PASS 75/75 | 2026-10-17-repeat-execution | first series (quota 10) |
| 2026-10-17T13:43:06.037Z | expiry-race | dev | c1d0660 (dirty) | 1b862065 | 3 | FAIL 26/27 | 2026-10-17-expiry-race | first series (quota 10): one early probe arrived after expiresAt (client send jitter), rejected as the server clock requires |
| 2026-10-17T13:44:40.315Z | failure-recovery | dev | c1d0660 (dirty) | 3a7ac99e | 3 | PASS 52/52 | 2026-10-17-failure-recovery | first series (quota 10) |
| 2026-10-17T14:15:28.545Z | access-control | dev | c1d0660 (dirty) | 361341fa | 3 | PASS 177/177 | 2026-10-17-access-control | first series (quota 10) |
| 2026-10-17T14:16:25.938Z | backfill | dev | c1d0660 (dirty) | 3393de39 | 3 | FAIL 0/1 | 2026-10-17-backfill | first series (quota 10): aborted at its first request with HTTP 503 (63 API throttles in the window) |
| 2026-10-17T15:07:23.892Z | expiry-race | dev | 63eba12 (dirty) | c00ba071 | 3 | FAIL 32/33 | 2026-10-17-expiry-race-2 | send-time calibration in progress; one early probe late again |
| 2026-10-17T15:44:31.558Z | expiry-race | dev | 775b488 (dirty) | 871f00c7 | 3 | PASS 27/27 | 2026-10-17-expiry-race-3 | calibrated send time |
| 2026-10-17T15:46:25.018Z | expiry-race | dev | 00faa52 | e1be2b0b | 3 | PASS 27/27 | 2026-10-17-expiry-race-4 | calibrated send time, clean commit |
| 2026-10-17T16:37:51.206Z | pilot-rehearsal | pilot | b8b8f3a (dirty) | a633cb25 | 1 | PASS 84/84 | 2026-10-17-pilot-rehearsal | staged rehearsal on pilot, synthetic accounts (not user evidence) |
| 2026-10-17T16:46:21.309Z | pilot-rehearsal | pilot | b8b8f3a (dirty) | 12f30c90 | 1 | PASS 85/85 | 2026-10-17-pilot-rehearsal-2 | staged rehearsal on pilot, synthetic accounts (not user evidence) |
| 2026-10-17T16:51:30.226Z | pilot-rehearsal | pilot | b8b8f3a (dirty) | 60453144 | 1 | PASS 85/85 | 2026-10-17-pilot-rehearsal-3 | staged rehearsal on pilot, synthetic accounts (not user evidence); quoted in the report |
| 2026-10-17T17:27:04.217Z | web-walkthrough-dev | dev | b8b8f3a (dirty) |  |  | PASS | 2026-10-17-web-walkthrough-dev | real-browser walkthrough with test accounts (Playwright), UI before d34e0ac; not user evidence |
| 2026-10-17T18:14:45.190Z | smoke | dev | e05c037 | 3aabe3fe | 1 | PASS 13/13 | 2026-10-17-smoke-2 | re-run series at quota 1000; deployed bundles = build of e05c037 (results/2026-10-17-table3-dev-q1000-provenance.md) |
| 2026-10-17T18:16:07.202Z | correctness | dev | e05c037 (dirty) | d179d40d | 3 | PASS 672/672 | 2026-10-17-correctness-2 | re-run series at quota 1000; quoted in the report; dirty = runner status log under results/ only |
| 2026-10-17T18:20:35.647Z | preference-order | dev | e05c037 (dirty) | 4b65ed89 | 3 | PASS 204/204 | 2026-10-17-preference-order-2 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T18:21:17.132Z | concurrency | dev | e05c037 (dirty) | 08262972 | 3 | PASS 39/39 | 2026-10-17-concurrency-2 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T18:23:18.537Z | repeat-execution | dev | e05c037 (dirty) | 668e39b5 | 3 | PASS 75/75 | 2026-10-17-repeat-execution-2 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T18:38:13.141Z | expiry-race | dev | e05c037 (dirty) | 597e46dd | 3 | PASS 27/27 | 2026-10-17-expiry-race-5 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T18:39:47.442Z | failure-recovery | dev | e05c037 (dirty) | da47da60 | 3 | PASS 52/52 | 2026-10-17-failure-recovery-2 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T19:10:49.064Z | access-control | dev | e05c037 (dirty) | 6dacbc7a | 3 | PASS 177/177 | 2026-10-17-access-control-2 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T19:11:42.100Z | backfill | dev | e05c037 (dirty) | 983158fd | 3 | PASS 124/124 | 2026-10-17-backfill-2 | re-run series at quota 1000; quoted; dirty = status log only |
| 2026-10-17T21:10:07.748Z | smoke | dev | d34e0ac | 5a063ea6 | 1 | PASS 13/13 | 2026-10-17-smoke-3 | regression after deploying d34e0ac to dev (report/series.json regression) |
| 2026-10-17T21:11:33.047Z | correctness | dev | d34e0ac | 211a1a57 | 3 | PASS 672/672 | 2026-10-17-correctness-3 | regression after deploying d34e0ac to dev |
| 2026-10-17T21:16:19.960Z | access-control | dev | d34e0ac | d65305fd | 3 | PASS 177/177 | 2026-10-17-access-control-3 | regression after deploying d34e0ac to dev |
| 2026-10-17T21:21:17.227Z | web-walkthrough-dev | dev | a563d92 (dirty) |  |  | PASS | 2026-10-17-web-walkthrough-dev-2 | real-browser walkthrough after deploying d34e0ac (ended card, named holders); screenshots and backup video in docs/demo/; not user evidence |

Not harness runs (no `meta.json`), listed for completeness:

- `results/2026-10-17-throttling-evidence/`: CloudWatch evidence that the first series' HTTP 503s were Lambda
  concurrency throttling under the account quota of 10.
- `results/2026-10-17-table3-dev.status` / `.log`: status and output of the first series;
  `results/2026-10-17-table3-dev-q1000.status` / `.log` / `-provenance.md`: the re-run at quota 1000.
- `results/loadtest/<date>/`: k6 matrices (`runs.json` lists every invocation; a superseded round carries `supersededBy` in `raw.csv`).
- `results/replay/`, `results/cost/`, `results/market/`: simulation, cost model and market counts.
