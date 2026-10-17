# expiry-race — Expiry race (plan §4, Table 3; tick-first, §1.2)

- Verdict: **FAIL** (26/27 checks passed)
- Pass criterion (plan §4): ACCEPT at expiresAt − 200 ms succeeds (a trial whose queue latency exceeds the margin is inconclusive under tick-first and repeated); ACCEPT at expiresAt + 200 ms is REJECTED(OFFER_EXPIRED) regardless of timer arrival; a late TICK has no effect on a newer offer
- Run id: `1b862065-3e76-4168-9f19-5d7c440d0ce5`, started 2026-10-17T13:43:06.037Z, finished 2026-10-17T13:44:37.992Z (92 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 60; fault flags: on
- Commit: c1d066056b2c9d36cc33869629f99f390451c101 (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/expiry-race.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Early ACCEPT (reaching the API at expiresAt − 200 ms) applied: **2/3 runs**; attempts 3: 2 applied, 0 inconclusive, 1 failed
- Inconclusive early attempts (REJECTED(OFFER_EXPIRED) although accepted before expiresAt, because the worker processed them after it: queue latency > 200 ms margin, correct under tick-first; repeated with a fresh workshop): none
- Worker pickup latency of the ACCEPTs (settledAt − acceptedAt): p50 36 ms, max 62 ms
- Late ACCEPT (expiresAt + 200 ms) rejected OFFER_EXPIRED: **3/3**
- Which reached the worker first in the late trials: timer tick processed before the ACCEPT arrived: 3
- Outcomes consistent with the server clock: 6/6
- Stale TICK injected: 3/3 without effect on the newer offer
- Send timing: server clock offset 20 ms (rtt 234 ms); |arrival − planned| p50 8 ms, max 625 ms

Expiry is decided by server time when the command is processed (tick-first): a command arriving before expiresAt
can still lose if it waits in the queue past expiresAt; `settledAt − expiresAt` shows that lag for every trial.

## Trials

| run | variant | attempt | arrival − expiresAt (ms) | settled − expiresAt (ms) | pickup (ms) | outcome | which first | consistent | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | early | 1 | 362 | 411 | 49 | REJECTED(OFFER_EXPIRED) | n/a | true | FAIL |
| 1 | late | 1 | 825 | 887 | 62 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |
| 2 | early | 1 | -188 | -157 | 31 | APPLIED | n/a | true | PASS |
| 2 | late | 1 | 206 | 245 | 39 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |
| 3 | early | 1 | -192 | -156 | 36 | APPLIED | n/a | true | PASS |
| 3 | late | 1 | 205 | 239 | 34 | REJECTED(OFFER_EXPIRED) | timer tick processed before the ACCEPT arrived | true | PASS |

## Stale TICK

| run | processed | version before → after | newer offer unchanged | backfills unchanged | newer offer ACCEPT | verdict |
|---|---|---|---|---|---|---|
| 1 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |
| 2 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |
| 3 | waited 20 s | 3 → 3 | true | true | APPLIED | PASS |

## Checks

1 of 27 checks failed:

| run | scenario | step | expected | actual | detail |
|---|---|---|---|---|---|
| 1 | early | ACCEPT at expiresAt − 200 ms succeeds | APPLIED | REJECTED(OFFER_EXPIRED); arrived 362 ms, settled 411 ms relative to expiresAt (worker pickup 49 ms) |  |
