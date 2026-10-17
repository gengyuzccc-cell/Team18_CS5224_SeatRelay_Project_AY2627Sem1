# Root cause of the HTTP 503s in the first dev Table 3 run (2026-10-17, quota 10)

- Verdict: **Lambda account concurrency quota (10) exhausted → API Gateway returned 503 "Service Unavailable"**.
- Collected 2026-10-17 ~18:30 UTC with read-only CloudWatch / CloudWatch Logs queries (AWS CLI); account
  379549361891, ap-southeast-1, stack `seatrelay-app-dev`, HTTP API `3s8s2lavzi`.
- Files: `lambda-metrics.csv` (per function: `Throttles` sum, `Invocations` sum, `ConcurrentExecutions` max; plus
  the account-wide `ConcurrentExecutions` max), `api-503.csv` (503 entries in the API access log
  `/seatrelay/dev/api-access`, API Gateway `Count` and `5xx` metrics, api-Lambda throttles).

## Evidence

| window (affected experiment) | api-Lambda throttles | API 5xx (metric) | 503 in access log | account concurrent max |
|---|---|---|---|---|
| 13:26–13:29 (concurrency) | 76 | 76 | 76 | 10 |
| 14:16–14:18 (backfill setup) | 63 | 63 | 63 | 10 |
| 14:17–15:04 (k6 matrix) | 5,580 | 5,580 | 5,580 | 10 |

1. In every window the number of API 503s equals the number of api-Lambda throttles exactly, and the account-wide
   `ConcurrentExecutions` maximum equals the account quota at that time (`AccountLimit.ConcurrentExecutions = 10`,
   the default for new accounts; all ten functions of the dev and pilot stacks share it).
2. The 503 responses have `integrationLatency` of 6–11 ms and `errorMessage` "Service Unavailable" in the access
   log: API Gateway answered without the function running, which is how a throttled Lambda integration surfaces
   (the application's own `QUEUE_UNAVAILABLE` 503 carries a JSON body and needs a failed SQS send).
3. During the k6 matrix the worker (416), the expiry forwarder (213) and the notifier (103) were throttled too.
   Throttled SQS/stream pollers back off and retry, which is the settle-time backlog of 6–29 s observed at 25 and
   50 VUs (results/loadtest/2026-10-17/summary.md, dev section, first attempts).
4. The system stayed correct under throttling: in the concurrency run the worker assigned more queue numbers than
   the client saw APPLIED because some throttled requests were the client's *polls*, not the commands
   (results/2026-10-17-concurrency/checks.csv: e.g. 27 APPLIED observed, seq 1..29 assigned); verify reported no
   invariant violation.

## Remedy and re-run

Service Quotas request `48a20acceaef4f3881808f88d7b6ba06C086x7So` (support case 179224956500721) raised
`Concurrent executions` to 1,000 (confirmed by `aws lambda get-account-settings` at 2026-10-17 18:11 UTC). The
whole Table 3 suite was then re-run on dev from a clean checkout of commit `e05c037` (the directories pinned in
`report/series.json`), and the k6 matrix from clean commit `d121145` (run `20261017T192002Z`; `d121145` changes
only the harness's provenance check, not `services/` or `packages/`). The throttled first run is kept as
documented evidence of the failure mode; the re-run is the measurement of record.
