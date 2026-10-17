# preference-order — Preference, order (plan §4, Table 3) — deployment replay of 20 fixed cases

- Verdict: **PASS** (204/204 checks passed)
- Pass criterion (plan §4): the allocated session is always the first acceptable session with a free seat; a non-acceptable session is never offered; verify ok
- Run id: `5d51b310-256c-4ca0-bf48-c6e3e9840d0f`, started 2026-10-17T13:25:36.174Z, finished 2026-10-17T13:26:16.711Z (41 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: ec54916a2dcb44302be594f6ff5da93bcdf7ef5e (dirty) on claude/serene-lovelace-7t14s9
- Script: `tools/experiments/src/preference-order.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Cases: **60/60** as predicted by the oracle (first acceptable session with a free seat)
- Offers of a non-acceptable session: **0** (target 0)
- Random-sequence half of this row: core property test (`packages/core`, ≥ 2,000 fast-check sequences; `checkInvariants` after every step).

## Cases

| run | case | preferences | full before | expected | actual | release | expected after | actual after | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | P01: all free → first preference | S1 S2 S3 S4 S5 | — | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 1 | P02: all free, preference order ≠ session order | S3 S1 | — | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 1 | P03: first preference full → second | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 1 | P04: two full → third | S1 S2 S3 | S1 S2 | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 1 | P05: four full → last preference | S1 S2 S3 S4 S5 | S1 S2 S3 S4 | OFFERED@S5 | OFFERED@S5 | — | — | — | PASS |
| 1 | P06: all full → queue; middle preference released | S1 S2 S3 S4 S5 | S1 S2 S3 S4 S5 | QUEUED#1 | QUEUED#1 | S3 | OFFERED@S3 | OFFERED@S3 | PASS |
| 1 | P07: single acceptable session full → queue; it is released | S2 | S2 | QUEUED#1 | QUEUED#1 | S2 | OFFERED@S2 | OFFERED@S2 | PASS |
| 1 | P08: non-acceptable session released → stays queued | S2 | S1 S2 | QUEUED#1 | QUEUED#1 | S1 | QUEUED#1 | QUEUED#1 | PASS |
| 1 | P09: capacity 2 with one seat taken → still free | S1 S2 | — | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 1 | P10: capacity 2 with both seats taken → next preference | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 1 | P11: reverse order, first preference full | S5 S4 S3 S2 S1 | S5 | OFFERED@S4 | OFFERED@S4 | — | — | — | PASS |
| 1 | P12: reverse order, three full | S5 S4 S3 S2 S1 | S3 S4 S5 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 1 | P13: free sessions exist but none acceptable → queue; acceptable one released | S2 S4 | S2 S4 | QUEUED#1 | QUEUED#1 | S4 | OFFERED@S4 | OFFERED@S4 | PASS |
| 1 | P14: only the single acceptable session is free | S4 | S1 S2 S3 S5 | OFFERED@S4 | OFFERED@S4 | — | — | — | PASS |
| 1 | P15: odd sessions acceptable and full, even free → queue; last preference released | S1 S3 S5 | S1 S3 S5 | QUEUED#1 | QUEUED#1 | S5 | OFFERED@S5 | OFFERED@S5 | PASS |
| 1 | P16: capacity 2 first preference half taken | S3 S2 | — | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 1 | P17: first preference full, second preference is S1 | S2 S1 | S2 | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 1 | P18: all full → queue; first preference released | S1 S2 S3 S4 S5 | S1 S2 S3 S4 S5 | QUEUED#1 | QUEUED#1 | S1 | OFFERED@S1 | OFFERED@S1 | PASS |
| 1 | P19: both acceptable full → queue; second preference released | S4 S2 | S2 S4 | QUEUED#1 | QUEUED#1 | S2 | OFFERED@S2 | OFFERED@S2 | PASS |
| 1 | P20: holding the second preference, first preference released → no second offer, no upgrade | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | S1 | OFFERED@S2 | OFFERED@S2 | PASS |
| 2 | P01: all free → first preference | S1 S2 S3 S4 S5 | — | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 2 | P02: all free, preference order ≠ session order | S3 S1 | — | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 2 | P03: first preference full → second | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 2 | P04: two full → third | S1 S2 S3 | S1 S2 | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 2 | P05: four full → last preference | S1 S2 S3 S4 S5 | S1 S2 S3 S4 | OFFERED@S5 | OFFERED@S5 | — | — | — | PASS |
| 2 | P06: all full → queue; middle preference released | S1 S2 S3 S4 S5 | S1 S2 S3 S4 S5 | QUEUED#1 | QUEUED#1 | S3 | OFFERED@S3 | OFFERED@S3 | PASS |
| 2 | P07: single acceptable session full → queue; it is released | S2 | S2 | QUEUED#1 | QUEUED#1 | S2 | OFFERED@S2 | OFFERED@S2 | PASS |
| 2 | P08: non-acceptable session released → stays queued | S2 | S1 S2 | QUEUED#1 | QUEUED#1 | S1 | QUEUED#1 | QUEUED#1 | PASS |
| 2 | P09: capacity 2 with one seat taken → still free | S1 S2 | — | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 2 | P10: capacity 2 with both seats taken → next preference | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 2 | P11: reverse order, first preference full | S5 S4 S3 S2 S1 | S5 | OFFERED@S4 | OFFERED@S4 | — | — | — | PASS |
| 2 | P12: reverse order, three full | S5 S4 S3 S2 S1 | S3 S4 S5 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 2 | P13: free sessions exist but none acceptable → queue; acceptable one released | S2 S4 | S2 S4 | QUEUED#1 | QUEUED#1 | S4 | OFFERED@S4 | OFFERED@S4 | PASS |
| 2 | P14: only the single acceptable session is free | S4 | S1 S2 S3 S5 | OFFERED@S4 | OFFERED@S4 | — | — | — | PASS |
| 2 | P15: odd sessions acceptable and full, even free → queue; last preference released | S1 S3 S5 | S1 S3 S5 | QUEUED#1 | QUEUED#1 | S5 | OFFERED@S5 | OFFERED@S5 | PASS |
| 2 | P16: capacity 2 first preference half taken | S3 S2 | — | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 2 | P17: first preference full, second preference is S1 | S2 S1 | S2 | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 2 | P18: all full → queue; first preference released | S1 S2 S3 S4 S5 | S1 S2 S3 S4 S5 | QUEUED#1 | QUEUED#1 | S1 | OFFERED@S1 | OFFERED@S1 | PASS |
| 2 | P19: both acceptable full → queue; second preference released | S4 S2 | S2 S4 | QUEUED#1 | QUEUED#1 | S2 | OFFERED@S2 | OFFERED@S2 | PASS |
| 2 | P20: holding the second preference, first preference released → no second offer, no upgrade | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | S1 | OFFERED@S2 | OFFERED@S2 | PASS |
| 3 | P01: all free → first preference | S1 S2 S3 S4 S5 | — | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 3 | P02: all free, preference order ≠ session order | S3 S1 | — | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 3 | P03: first preference full → second | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 3 | P04: two full → third | S1 S2 S3 | S1 S2 | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 3 | P05: four full → last preference | S1 S2 S3 S4 S5 | S1 S2 S3 S4 | OFFERED@S5 | OFFERED@S5 | — | — | — | PASS |
| 3 | P06: all full → queue; middle preference released | S1 S2 S3 S4 S5 | S1 S2 S3 S4 S5 | QUEUED#1 | QUEUED#1 | S3 | OFFERED@S3 | OFFERED@S3 | PASS |
| 3 | P07: single acceptable session full → queue; it is released | S2 | S2 | QUEUED#1 | QUEUED#1 | S2 | OFFERED@S2 | OFFERED@S2 | PASS |
| 3 | P08: non-acceptable session released → stays queued | S2 | S1 S2 | QUEUED#1 | QUEUED#1 | S1 | QUEUED#1 | QUEUED#1 | PASS |
| 3 | P09: capacity 2 with one seat taken → still free | S1 S2 | — | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 3 | P10: capacity 2 with both seats taken → next preference | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 3 | P11: reverse order, first preference full | S5 S4 S3 S2 S1 | S5 | OFFERED@S4 | OFFERED@S4 | — | — | — | PASS |
| 3 | P12: reverse order, three full | S5 S4 S3 S2 S1 | S3 S4 S5 | OFFERED@S2 | OFFERED@S2 | — | — | — | PASS |
| 3 | P13: free sessions exist but none acceptable → queue; acceptable one released | S2 S4 | S2 S4 | QUEUED#1 | QUEUED#1 | S4 | OFFERED@S4 | OFFERED@S4 | PASS |
| 3 | P14: only the single acceptable session is free | S4 | S1 S2 S3 S5 | OFFERED@S4 | OFFERED@S4 | — | — | — | PASS |
| 3 | P15: odd sessions acceptable and full, even free → queue; last preference released | S1 S3 S5 | S1 S3 S5 | QUEUED#1 | QUEUED#1 | S5 | OFFERED@S5 | OFFERED@S5 | PASS |
| 3 | P16: capacity 2 first preference half taken | S3 S2 | — | OFFERED@S3 | OFFERED@S3 | — | — | — | PASS |
| 3 | P17: first preference full, second preference is S1 | S2 S1 | S2 | OFFERED@S1 | OFFERED@S1 | — | — | — | PASS |
| 3 | P18: all full → queue; first preference released | S1 S2 S3 S4 S5 | S1 S2 S3 S4 S5 | QUEUED#1 | QUEUED#1 | S1 | OFFERED@S1 | OFFERED@S1 | PASS |
| 3 | P19: both acceptable full → queue; second preference released | S4 S2 | S2 S4 | QUEUED#1 | QUEUED#1 | S2 | OFFERED@S2 | OFFERED@S2 | PASS |
| 3 | P20: holding the second preference, first preference released → no second offer, no upgrade | S1 S2 | S1 | OFFERED@S2 | OFFERED@S2 | S1 | OFFERED@S2 | OFFERED@S2 | PASS |

## Command latencies

| sample | n | p50 ms | p95 ms | p99 ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| settle, client-observed | 84 | 795 | 849 | 1209 | 1209 | 805.4 |

## Checks

All 204 checks passed.
