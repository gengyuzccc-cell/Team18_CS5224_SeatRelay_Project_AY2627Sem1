# expiry-race — Expiry race (plan §4, Table 3; tick-first, §1.2)

- Verdict: **PASS** (27/27 checks passed)
- Pass criterion (plan §4): ACCEPT at expiresAt − 200 ms succeeds (a trial whose queue latency exceeds the margin is inconclusive under tick-first and repeated); ACCEPT at expiresAt + 200 ms is REJECTED(OFFER_EXPIRED) regardless of timer arrival; a late TICK has no effect on a newer offer
- Run id: `597e46dd-58fe-44d9-be35-af4bac764e98`, started 2026-10-17T18:38:13.141Z, finished 2026-10-17T18:39:45.072Z (92 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: e05c037d485dc9e64ca0e45552a530bba7ba43b0 (dirty)
- Script: `tools/experiments/src/expiry-race.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Early ACCEPT (reaching the API at expiresAt − 200 ms) applied: **3/3 runs**; attempts 3: 3 applied, 0 inconclusive, 0 failed
- Inconclusive early attempts (REJECTED(OFFER_EXPIRED) although accepted before expiresAt, because the worker processed them after it: queue latency > 200 ms margin, correct under tick-first; repeated with a fresh workshop): none
- Worker pickup latency of the ACCEPTs (settledAt − acceptedAt): p50 34 ms, max 70 ms
- Late ACCEPT (expiresAt + 200 ms) rejected OFFER_EXPIRED: **3/3**
- Which reached the worker first in the late trials: timer tick processed before the ACCEPT arrived: 3
- Outcomes consistent with the server clock: 6/6
- Stale TICK injected: 3/3 without effect on the newer offer
- Send timing: server clock offset 57 ms (rtt 233 ms); |arrival − planned| p50 8 ms, max 13 ms

Expiry is decided by server time when the command is processed (tick-first): a command arriving before expiresAt
can still lose if it waits in the queue past expiresAt; `settledAt − expiresAt` shows that lag for every trial.

## Trials

| run | variant | attempt | arrival − expiresAt (ms) | settled − expiresAt (ms) | pickup (ms) | outcome | which first | consistent | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | early | 1 | -188 | -146 | 42 | APPLIED | n/a | true | PASS |
| 1 | late | 1 | 209 | 253 | 44 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |
| 2 | early | 1 | -192 | -122 | 70 | APPLIED | n/a | true | PASS |
| 2 | late | 1 | 213 | 247 | 34 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |
| 3 | early | 1 | -192 | -161 | 31 | APPLIED | n/a | true | PASS |
| 3 | late | 1 | 208 | 242 | 34 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |

## Stale TICK

| run | processed | version before → after | newer offer unchanged | backfills unchanged | newer offer ACCEPT | verdict |
|---|---|---|---|---|---|---|
| 1 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |
| 2 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |
| 3 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |

## Checks

All 27 checks passed.
