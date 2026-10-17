# expiry-race — Expiry race (plan §4, Table 3; tick-first, §1.2)

- Verdict: **FAIL** (32/33 checks passed)
- Pass criterion (plan §4): ACCEPT at expiresAt − 200 ms succeeds (a trial whose queue latency exceeds the margin is inconclusive under tick-first and repeated); ACCEPT at expiresAt + 200 ms is REJECTED(OFFER_EXPIRED) regardless of timer arrival; a late TICK has no effect on a newer offer
- Run id: `c00ba071-6d07-4e03-a0e6-fa8711bbdc02`, started 2026-10-17T15:07:23.892Z, finished 2026-10-17T15:10:35.399Z (192 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: 63eba1223a693bc2c01009bc4250036385c7f902 (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/expiry-race.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Early ACCEPT (reaching the API at expiresAt − 200 ms) applied: **2/3 runs**; attempts 6: 2 applied, 4 inconclusive, 0 failed
- Inconclusive early attempts (REJECTED(OFFER_EXPIRED) although accepted before expiresAt, because the worker processed them after it: queue latency > 200 ms margin, correct under tick-first; repeated with a fresh workshop): run 1 attempt 1 (pickup 51 ms), run 1 attempt 2 (pickup 39 ms), run 1 attempt 3 (pickup 50 ms), run 2 attempt 1 (pickup 38 ms)
- Worker pickup latency of the ACCEPTs (settledAt − acceptedAt): p50 41 ms, max 77 ms
- Late ACCEPT (expiresAt + 200 ms) rejected OFFER_EXPIRED: **3/3**
- Which reached the worker first in the late trials: timer tick processed before the ACCEPT arrived: 3
- Outcomes consistent with the server clock: 9/9
- Stale TICK injected: 3/3 without effect on the newer offer
- Send timing: server clock offset 27 ms (rtt 225 ms); |arrival − planned| p50 57 ms, max 460 ms

Expiry is decided by server time when the command is processed (tick-first): a command arriving before expiresAt
can still lose if it waits in the queue past expiresAt; `settledAt − expiresAt` shows that lag for every trial.

## Trials

| run | variant | attempt | arrival − expiresAt (ms) | settled − expiresAt (ms) | pickup (ms) | outcome | which first | consistent | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | early | 1 | 375 | 426 | 51 | REJECTED(OFFER_EXPIRED) | n/a | true | INCONCLUSIVE |
| 1 | early | 2 | 475 | 514 | 39 | REJECTED(OFFER_EXPIRED) | n/a | true | INCONCLUSIVE |
| 1 | early | 3 | 343 | 393 | 50 | REJECTED(OFFER_EXPIRED) | n/a | true | INCONCLUSIVE |
| 1 | late | 1 | 660 | 737 | 77 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |
| 2 | early | 1 | 257 | 295 | 38 | REJECTED(OFFER_EXPIRED) | n/a | true | INCONCLUSIVE |
| 2 | early | 2 | -197 | -166 | 31 | APPLIED | n/a | true | PASS |
| 2 | late | 1 | 208 | 249 | 41 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |
| 3 | early | 1 | -195 | -148 | 47 | APPLIED | n/a | true | PASS |
| 3 | late | 1 | 205 | 246 | 41 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |

## Stale TICK

| run | processed | version before → after | newer offer unchanged | backfills unchanged | newer offer ACCEPT | verdict |
|---|---|---|---|---|---|---|
| 1 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |
| 2 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |
| 3 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |

## Checks

1 of 33 checks failed:

| run | scenario | step | expected | actual | detail |
|---|---|---|---|---|---|
| 1 | early | ACCEPT at expiresAt − 200 ms succeeds (a conclusive trial within 3 attempts) | APPLIED in one of the attempts | all 3 attempts processed after expiresAt (worker pickup 51 / 39 / 50 ms > 200 ms margin) |  |
