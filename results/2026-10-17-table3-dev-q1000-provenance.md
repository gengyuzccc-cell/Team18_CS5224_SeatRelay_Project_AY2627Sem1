# Table 3 re-run on dev after the Lambda quota increase — provenance

What the quoted re-runs (`results/2026-10-17-*-2/`, `results/2026-10-17-expiry-race-5/`) ran against,
and why their `meta.json` says `commit.dirty = true`.

## Account

- Lambda account concurrency (`aws lambda get-account-settings`, `AccountLimit.ConcurrentExecutions`):
  **1000** (was 10 during the first series; see `results/2026-10-17-throttling-evidence/`).

## Deployed code

- Stack `seatrelay-app-dev`: last update started 2026-10-17T18:14:08Z (`LastUpdatedTime`) and completed
  18:14:18Z (`UPDATE_COMPLETE`), deployed from commit
  `e05c037`. No stack in the account was updated after that until the end of the series
  (`seatrelay-app-pilot` last changed 13:24:27Z, `seatrelay-auth` 07:08:43Z, web stacks earlier).
- The five functions' code (`LastModified` 13:17:54Z / 13:18:14Z: the 18:14 deploy changed the
  configuration, not the bundles) was downloaded with `aws lambda get-function` after the series and
  compared with `node services/aws/scripts/build.mjs` run on commit `d121145` (which does not change
  `services/` or `packages/` relative to `e05c037`): `diff -r` reports the deployed bundles and the
  local build **identical** for all five functions.

| function | deployed `index.mjs` sha256 |
|---|---|
| seatrelay-dev-api | `a69071b19698108e044891863639808a65ab7c5b52159281591ee79339de15f1` |
| seatrelay-dev-worker | `bcec233c5bb788cd20b89e62a6898953dd17164bc0179b1738dffc7dee0b4739` |
| seatrelay-dev-expiry-forwarder | `498417820231c8d92766540204f51aafb7dd9d8495398f497531377bb90cb098` |
| seatrelay-dev-sweep | `d4c7ecba9d00d567d8b0e038024d28cb20536526d637dbb73feb88ab2d804123` |
| seatrelay-dev-notifier | `a89a6fcc3b0d7e6e3930dd98c7593f75baa81e6d9ded7172a6108530b6e1f552` |

## Same code as the first series

`describe-stack-events` for `seatrelay-app-dev` lists three stack-level completions on 2026-10-17:
`CREATE_COMPLETE` 06:58:32Z, `UPDATE_COMPLETE` 13:18:27Z (the deploy whose bundles are still live,
`LastModified` 13:17:54Z / 13:18:14Z) and `UPDATE_COMPLETE` 18:14:18Z. The 18:14 update changed one
resource, `SweepFunctionEvery5Minutes` (`AWS::Scheduler::Schedule`), which gained the explicit name
`seatrelay-dev-sweep`; no function, queue, table or API changed. The first series
(13:21Z–15:04Z, `2026-10-17-table3-dev.status`) therefore ran the same Lambda code and the same
configuration as this re-run. The account's Lambda concurrency quota (10 → 1000) is the only
material difference between the two series.

## Harness

- All eight experiments and the smoke test ran from a separate clean git worktree checked out at
  `e05c037` (`tools/experiments/bin/run-table3.sh dev`, status log
  `2026-10-17-table3-dev-q1000.status`, full output `2026-10-17-table3-dev-q1000.log`).
- `commit.dirty = true` in eight of the nine `meta.json` files: at `e05c037` the dirty check still
  counted `results/`, and the runner appended to the tracked `results/2026-10-17-table3-dev.status`
  after the smoke test. `git status --porcelain` in the worktree after the series listed that file
  as the only modified tracked file (everything else was new, untracked result directories). Commit
  `d121145` excludes `results/` from the check and gives every invocation its own status file; the
  k6 matrix that followed ran at `d121145`.

## Series

| experiment | directory | verdict |
|---|---|---|
| smoke | `2026-10-17-smoke-2` | PASS 13/13 |
| correctness | `2026-10-17-correctness-2` | PASS 672/672 |
| preference-order | `2026-10-17-preference-order-2` | PASS 204/204 |
| concurrency | `2026-10-17-concurrency-2` | PASS 39/39 |
| repeat-execution | `2026-10-17-repeat-execution-2` | PASS 75/75 |
| expiry-race | `2026-10-17-expiry-race-5` | PASS 27/27 |
| failure-recovery | `2026-10-17-failure-recovery-2` | PASS 52/52 |
| access-control | `2026-10-17-access-control-2` | PASS 177/177 |
| backfill | `2026-10-17-backfill-2` | PASS 124/124 |

`SweepLateExpiries`: `aws cloudwatch list-metrics --namespace SeatRelay` lists no
`SweepLateExpiries` series in any dimension set. The worker emits it (0 or more) for every
sweep-originated TICK (`packages/service/src/worker/processCommand.ts`, `emitSweepMetrics`), and the
sweep sends a TICK only to a workshop whose `nextDueAt` has passed
(`packages/service/src/worker/sweep.ts`). Logs Insights on `/aws/lambda/seatrelay-dev-sweep`,
18:10Z–19:20Z: 15 `sweep completed` records (every 5 min from 18:14:54Z), `sum(ticked) = 0`,
`max(ticked) = 0`. So the sweep never found an overdue workshop: every expiry in the series was
relayed by its per-offer timer before a sweep came round, and `SweepLateExpiries = 0` holds
trivially (no sweep TICK was needed).

## After the series (docs/EXPERIMENTS.md section 6)

Checked at 19:29Z (k6 matrix running): `seatrelay-dev-commands-dlq.fifo`, `-expiry-delay-dlq` and
`-notify-dlq` hold 0 messages (visible and in flight); `get-function-concurrency` on
`seatrelay-dev-notifier` returns no reserved concurrency (the failure-recovery outage was undone);
no `seatrelay-dev-*` alarm is in ALARM.
