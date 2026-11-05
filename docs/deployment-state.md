# Deployment state (live identifiers)

Account `379549361891`, region `ap-southeast-1`, deployer IAM user `seatrelay-deployer`.
Updated whenever a stack is (re)deployed. No secrets are stored here. The team's sender and alarm
e-mail addresses are passed at deploy time (`SenderEmail`, `AlarmEmail` / `ALARM_EMAIL`) and are
masked below as placeholders; the git history before `faea23b` still names the sender address, and
that address, a personal gmail.com mailbox, is the live SES identity (DKIM not set up) and the
`From:` of every participant e-mail. A team alias or a DKIM-signed team domain is future work
(the report's future-work list says so).

## seatrelay-auth (deployed 2026-10-16, last updated 2026-10-31, UPDATE_COMPLETE)

| Output | Value |
|---|---|
| UserPoolId | `ap-southeast-1_ZZ7UsL6Ib` |
| Issuer | `https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ZZ7UsL6Ib` |
| WebClientId (`web`, code + PKCE) | `6f926dm22ulrv8gfjro2db1ac` |
| ToolingClientId (`tooling`, USER_PASSWORD_AUTH) | `203uigcnditpcmp54ir0gnsieq` |
| HostedUiDomain | `https://seatrelay-379549361891.auth.ap-southeast-1.amazoncognito.com` |
| SenderEmail (SES identity) | `<team sender address>` — verified (2026-10-17) |
| Budgets | `seatrelay-monthly` US$20 (IncludeCredit=false), `seatrelay-annual` US$60 |
| Cost allocation tag | `Project` active since 2026-10-16 (checked 2026-11-05) |

Validation performed: hosted UI login page HTTP 200; OIDC discovery OK (note: Cognito now publishes
`end_session_endpoint`, so RP-initiated logout also works besides the classic `/logout` endpoint);
test user `smoke1@example.com` (created with `MessageAction=SUPPRESS`) minted an ID token through the
tooling client with `email` and `name` claims.

SES: out of the sandbox since 2026-10-24 (see below). History: the account was in the sandbox (200
mails/24 h, 1 mail/s, verified recipients only); production access request: **submitted 2026-10-17 00:5x UTC via `sesv2 put-account-details`** (status PENDING; mail type
TRANSACTIONAL, website URL = CloudFront URL, use case = `docs/ses-production-request.md` §3). Account-level
suppression list enabled for BOUNCE and COMPLAINT. Feedback notifications (Bounce/Complaint, with headers)
published to SNS topic `seatrelay-ses-feedback`; the e-mail subscription for the team sender mailbox is
confirmed (checked 2026-10-30 with `sns list-subscriptions-by-topic`: a real subscription ARN, not
`PendingConfirmation`).

**2026-10-24: SES production access GRANTED** (same case, after the team's reply): out of the sandbox in
ap-southeast-1, 50,000 messages per 24 h, 14 per second; `sesv2 get-account` shows `ProductionAccessEnabled: true`,
`EnforcementStatus: HEALTHY`. The notifier now skips reserved test domains (commit `bcd7bd1`), `dev` was redeployed
with `EmailEnabled=true` and `pilot` keeps it; end-to-end check with the SES mailbox simulator in
`results/2026-10-24-ses-production-check/`. Cognito's sign-up codes still use its default mailer (50/day) because the
only SES identity is a gmail.com address (see that summary).

History: **2026-10-17 07:0x UTC: SES production access DENIED** (support case `179219791000451`). At review time the
sender identity was still *unverified*, which is the usual cause. Next steps for the team at the time (all done by 24 Oct): (1) click the SES
verification e-mail sent to the team sender mailbox; (2) confirm the SNS subscription e-mail; (3) reply to the case
in the AWS Support Center console (Basic support cannot reply via CLI) with the use-case text of
`docs/ses-production-request.md` §3 and the CloudFront URL. Until approved the plan §9 fallback applied:
participants relied on in-app notifications (`/me/notifications`), e-mail went only to verified team addresses,
and the dev stack ran with `EmailEnabled=false` (until 24 Oct).

## seatrelay-web-dev (deployed 2026-10-16, last updated 2026-10-31, UPDATE_COMPLETE)

Parameters: `Stage=dev ApiOrigin=https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com` (`ApiOrigin` since 2026-10-31, for the Content-Security-Policy).

| Output | Value |
|---|---|
| WebUrl | `https://d2ni5e1z674t04.cloudfront.net` |
| DistributionId | `E26U29AH9791XC` |
| BucketName | `seatrelay-web-dev-379549361891` |

Callback/logout URLs registered in Cognito: localhost:5173, the dev CloudFront URL and the pilot CloudFront URL
(`/callback` for sign-in, `/` for sign-out).

## seatrelay-app-dev (deployed 2026-10-17, last updated 2026-10-31, UPDATE_COMPLETE)

Parameters: `Stage=dev AllowFaultFlags=true EmailEnabled=true AllowLocalOrigin=true WorkerMaxConcurrency=5 LogRetentionDays=14 AuthStackName=seatrelay-auth WebOrigin=https://d2ni5e1z674t04.cloudfront.net AlarmEmail=<team alarm address> SenderEmail=<team sender address>` (`EmailEnabled=false` until 2026-10-24; `AllowLocalOrigin` since 2026-10-31).

| Output | Value |
|---|---|
| ApiUrl | `https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com` |
| TableName | `seatrelay-dev` |
| CommandsQueueUrl | `https://sqs.ap-southeast-1.amazonaws.com/379549361891/seatrelay-dev-commands.fifo` |
| ExpiryDelayQueueUrl | `https://sqs.ap-southeast-1.amazonaws.com/379549361891/seatrelay-dev-expiry-delay` |
| DLQs | `seatrelay-dev-commands-dlq.fifo`, `seatrelay-dev-expiry-delay-dlq`, `seatrelay-dev-notify-dlq` |
| Functions | `seatrelay-dev-{api,worker,expiry-forwarder,sweep,notifier}` (nodejs22.x, arm64) |
| Dashboard | CloudWatch dashboard `seatrelay-dev` |
| Alarm topic | `seatrelay-dev-alarms` (e-mail subscription confirmed, checked 2026-10-30) |

Smoke test (plan §3 step 12) passed against the live stack twice; evidence in `results/2026-10-17-smoke-dev/`
(`run.log`, `meta.json`, `smoke-dev.mjs`). After the runs: all DLQs empty, no alarm in ALARM state, 0 Lambda
errors, custom metrics `CommandSettledLatency`, `BackfillLatency`, `OffersCreated`, `OffersExpired` present with
only the `service` dimension. CORS pre-flight answered by API Gateway for the CloudFront and localhost origins
only. Smoke test users (Cognito, e-mail suppressed): `smoke-{organiser,alice,bob,carol}@example.com`.

The SPA is published to `https://d2ni5e1z674t04.cloudfront.net` with `env.js` pointing at the Cognito pool and
the dev API (`STAGE=dev tools/scripts/bin/deploy-web.sh`).

**2026-10-17 17:15 UTC: dev SPA republished** (same script, bundle `index-Dx1ogDmM.js` / `index-DW27saFr.css`) with
the front-end fixes found by the first real-browser walkthrough: buttons no longer stretched across column
containers, wizard step 1 top-aligned, *My registrations → Past* shows the human end-reason copy. The **pilot SPA
was not republished** then and kept the previous bundle; both stages now serve the same bundle
(section "2026-10-31 afternoon" below). Walkthrough accounts (Cognito, e-mail suppressed,
display names "… (staged)"): `walkthrough-{organiser,alice,bob,carol}@example.com`, created by
`tools/e2e/bin/ensure-users.sh` (recreated once on 2026-10-17, so the published screenshots start from empty
histories). The walkthrough leaves its staged organisations and workshops ("Staged walkthrough …", "Cloud Computing
Workshop (staged demo)") open on dev. Evidence: `results/2026-10-17-web-walkthrough-dev/`.

## seatrelay-web-pilot (deployed 2026-10-17, last updated 2026-10-31, UPDATE_COMPLETE)

Parameters: `Stage=pilot ApiOrigin=https://dx40kccif3.execute-api.ap-southeast-1.amazonaws.com` (`ApiOrigin` since 2026-10-31).

| Output | Value |
|---|---|
| WebUrl | `https://diiztwl34x7s1.cloudfront.net` |
| DistributionId | `E8IW9Y948A3CG` |
| BucketName | `seatrelay-web-pilot-379549361891` |

Registered in Cognito as callback (`/callback`) and logout (`/`) URL together with dev and localhost.

## seatrelay-app-pilot (deployed 2026-10-17, last updated 2026-10-31, UPDATE_COMPLETE)

Parameters: `Stage=pilot AllowFaultFlags=false EmailEnabled=true AllowLocalOrigin=false WorkerMaxConcurrency=5 LogRetentionDays=14 AuthStackName=seatrelay-auth WebOrigin=https://diiztwl34x7s1.cloudfront.net AlarmEmail=<team alarm address> SenderEmail=<team sender address>`.

| Item | Value |
|---|---|
| ApiUrl | `https://dx40kccif3.execute-api.ap-southeast-1.amazonaws.com` |
| TableName | `seatrelay-pilot` (deletion protection ON, PITR ON, on-demand, stream NEW_AND_OLD_IMAGES) |
| Throttling | 50 rps / burst 100 (dev: 300 / 500) |
| Fault flags | `ALLOW_FAULT_FLAGS=false` (the API strips `_fault`) |
| E-mail | `EMAIL_ENABLED=true`, sender `<team sender address>` (verified). Since 2026-10-24 SES is out of the sandbox, so every participant receives e-mail; addresses on reserved test domains are skipped (in-app only) |
| Sweep schedule | `seatrelay-pilot-sweep` (EventBridge Scheduler, rate 5 min) |
| Alarm topic | `seatrelay-pilot-alarms` (e-mail subscription confirmed, checked 2026-10-30) |

Checks after deployment: `/health` 200 `{"ok":true,"stage":"pilot"}`, `/me` without token 401, pilot SPA `env.js`
points at the pilot API.

First attempt failed CloudFormation early validation: SAM names a `ScheduleV2` event after its logical id when
`Name` is omitted, so the dev and pilot sweep schedules collided (`SweepFunctionEvery5Minutes`). Fixed by
`Name: !Sub seatrelay-${Stage}-sweep`; dev kept the old name until its 18:14 UTC update on 2026-10-17 (after
the first Table 3 series; see below).

## Lambda concurrency quota (before the increase; superseded, see "2026-10-17 evening")

`aws lambda get-account-settings` on 2026-10-17 (before the increase) returned `ConcurrentExecutions: 10`,
`UnreservedConcurrentExecutions: 10`, `FunctionCount: 10` (the five functions of `dev` and the five of
`pilot` shared these 10 slots). An increase to 1,000 (quota `L-B99A9384`, "Concurrent executions") was
requested through Service Quotas (support case `179224956500721`) and was approved; the account limit is
now 1000 (see below). While the limit was 10, no concurrent load was generated against AWS. The HTTP 503
responses of the first concurrency, backfill and k6 runs were Lambda throttles
(`results/2026-10-17-throttling-evidence/`, Final §4.2); the series was re-run at 1000.

## 2026-10-17 evening: quota, re-run, redeploy, test-account passwords

- **Lambda account concurrency quota: 1000** (was 10, the new-account default; increase approved,
  `aws lambda get-account-settings` → `AccountLimit.ConcurrentExecutions = 1000`). The first Table 3 series
  failed under the old quota (`results/2026-10-17-throttling-evidence/`); the whole series was re-run at 1000
  from commit `e05c037` (`results/2026-10-17-table3-dev-q1000-provenance.md`), then the k6 matrix
  (`results/loadtest/2026-10-17/`, run `20261017T192002Z`).
- **18:14 UTC** `seatrelay-app-dev` update: only the sweep schedule gained the name `seatrelay-dev-sweep`
  (no function, queue, table or API changed).
- **21:08 UTC** `seatrelay-app-dev` redeployed from commit `d34e0ac` (ended-registration card, notification
  wording, backfill holder names, refresh while confirmed), same parameters as above; dev SPA republished
  (`index-C61U0ZZ4.js` / `index-DW27saFr.css`). **21:19 UTC** `seatrelay-app-pilot` and the pilot SPA
  redeployed from the same commit (`Stage=pilot AllowFaultFlags=false EmailEnabled=true
  WebOrigin=https://diiztwl34x7s1.cloudfront.net AlarmEmail=<team alarm address>`). The ten deployed Lambda
  bundles were downloaded afterwards and are byte-identical to `node services/aws/scripts/build.mjs` at
  `d34e0ac`. Both `/health` endpoints answer `ok`; both `env.js` files point at their own API. Regression on
  dev after the deploy: smoke, correctness and access-control passed (`results/2026-10-17-*-3/`).
- **Test-account passwords (21:02–21:07 UTC).** The repository is public and its documented local default was
  also the password of every synthetic account in the pool. All 93 synthetic accounts (`@example.com`, SES
  simulator) now have a private password that is not stored anywhere in the repository, and were signed out
  everywhere (`tools/scripts/bin/reset-test-passwords.sh`); the tools read it from `SEATRELAY_TEST_PASSWORD`
  and refuse the public default on AWS stages. To use the accounts (demo, user study), a team member picks a
  password, exports it and runs the reset script with the deployer credentials.
- **Leaked ID tokens.** The k6 summaries committed at 15:07 UTC (`63eba12`) contained the ID tokens of the 62
  load-test accounts (k6 copies `setup()`'s return value into the summary). They were redacted in `9fc93fc`
  and the k6 script now keeps only e-mail and user id; the copies in git history stay valid until they expire
  at the latest 2026-10-18 02:15 UTC (12 h ID tokens; API Gateway's JWT authorizer cannot revoke them), for
  synthetic accounts in synthetic organisations only. The passwords above were rotated so that no new token
  can be minted from public information. Status 2026-10-30: a known, closed exposure. The tokens expired on
  2026-10-18 (the audit decoded one: `exp` 01:18:50 UTC); nothing is left to rotate and the history is not
  rewritten.
- **SES (status on 17 Oct):** the sender identity (the team sender address) is verified; production access showed
  **DENIED** for case `179219791000451` (the team replied to the case). Granted on 24 Oct, see the next section.

## 2026-10-24: SES production access, notifier and web redeploys

- **2026-10-24** `seatrelay-app-dev` and `seatrelay-app-pilot` redeployed from `bcd7bd1` (only
  `NotifierFunction` changed: reserved test domains are skipped; dev now `EmailEnabled=true`). About
  08:24 UTC the dev and pilot SPAs were republished from `cb160d2` (redesigned web app;
  `index-_vrUTyTT.js` / `index-DnGuptRW.css`; supersedes the `d34e0ac` bundle named above). Checks:
  `results/2026-10-24-ses-production-check/`, `results/2026-10-24-web-walkthrough-dev/` (45/45). Smoke,
  correctness and access-control were not re-run after these redeploys (last regression: 17 Oct, `d34e0ac`).

## 2026-10-31: audit fixes, security headers, verification-before-update; app stacks redeployed

- **Repository:** the six-lens audit of 30 Oct (plan, engine, backend, web, tooling, security; 49
  findings, 25 confirmed after adversarial verification) was fixed in `8ace25c`. CI is green on that
  commit (run 64); every earlier run had failed in the lint step since 21 Oct (browser globals in
  `docs/poster/render.mjs`).
- **`seatrelay-auth`** UPDATE_COMPLETE 2026-10-31T00:09:55Z: the user pool now requires a changed
  e-mail address to be verified before it replaces the old one
  (`UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate = [email]`); new parameter
  `CognitoEmailSourceArn` (empty: sign-up codes still go through Cognito's default mailer, 50/day).
- **`seatrelay-web-dev`** UPDATE_COMPLETE 2026-10-31T00:07:32Z and **`seatrelay-web-pilot`** (same
  change, shortly after): a per-stage CloudFront response-headers policy with a Content-Security-Policy
  (`default-src 'self'`, `connect-src` = the stage's API, the Cognito issuer and the hosted UI,
  `frame-ancestors 'none'`) replaces the managed SecurityHeadersPolicy. The 31 Oct browser walkthrough
  ran under it on the unchanged 24 Oct SPA: 45/45 (`results/2026-10-31-web-walkthrough-dev/`).
- **dev SPA** republished at 00:30 UTC from `8ace25c` (`index-QXj8a_uu.js` / `index-DnGuptRW.css`;
  supersedes the `cb160d2` bundle): capacity validation before sending, stale "done" labels fixed,
  renewal refetch, "What we keep" notice, favicon files, no stale not-found prefix. Browser walkthrough
  against it at 00:31 UTC: 45/45 (`results/2026-10-31-web-walkthrough-dev-2/`; run with `--no-publish`,
  so `docs/demo/` keeps the 24 Oct assets). The pilot SPA was then republished from the same build
  (same bundle names).
- **`seatrelay-app-dev`** UPDATE_COMPLETE 2026-10-31T05:26:01Z and **`seatrelay-app-pilot`**
  UPDATE_COMPLETE 2026-10-31T05:31:17Z from the `8ace25c` bundles (the change sets reviewed at 00:08
  and 05:30 UTC: `Modify` only, no replacement; executed with the team's authorisation). Checked live
  afterwards: `USER_POOL_ID` set, api and worker roles carry only the listed DynamoDB actions (api also
  `cognito-idp:ListUsers`), `AWS_NODEJS_CONNECTION_REUSE_ENABLED` gone, pilot `ALLOW_FAULT_FLAGS=false`,
  `EMAIL_ENABLED=true` on both, no alarm, all DLQs empty. Functional checks on dev
  (scratch log, not a results run): member added by e-mail (200; unknown address 404), `SET_CAPACITY`
  20,000 → 400 `VALIDATION_ERROR`, 10,000 → APPLIED, 0 and −5 → REJECTED `INVALID_CAPACITY`,
  `/me/registrations` and `/me/notifications` of a synthetic account capped at 500, a temporary user
  with `email_verified=false` gets 401 on `/me` (user deleted afterwards).
- **CORS rendering fix, second redeploy** (`app-pilot` 05:37:35Z, `app-dev` 05:40:35Z, only `HttpApi`
  changed): SAM copies the items of `CorsConfiguration.AllowOrigins` into the OpenAPI body but emits a
  conditional *list* (`!If` around the whole list) in place of the CORS object, so the first `8ace25c`
  deploy left the previous CORS settings in force on both stages (pilot still admitted localhost). The
  template now uses a per-item `!If` with `AWS::NoValue`; live after the fix: pilot
  `AllowOrigins = [https://diiztwl34x7s1.cloudfront.net]` (a pre-flight from `http://localhost:5173`
  gets no allow-origin header), dev keeps both origins.
- **Regression on dev after the redeploy** (`report/series.json` "regression", RUNS.md): smoke 13/13
  (`results/2026-10-31-smoke/`), correctness 672/672 in 3 runs (`results/2026-10-31-correctness/`),
  access-control 177/177 in 3 runs (`results/2026-10-31-access-control/`), browser walkthrough 45/45
  (`results/2026-10-31-web-walkthrough-dev-3/`). Three audit-check workshops created by these checks
  on dev are cancelled ("Audit fix check 2026-10-30 …", "Audit regression check 2026-10-31 …");
  `loaduser-10@example.com` was added as a member of the staged walkthrough organisation.
- **Core tests** re-recorded on the audited engine: `results/2026-10-31-core-tests/` (156/156 in 16
  files, branches 99.66 %, `8ace25c`); `report/generated/numbers.tex` quotes this run.
- **Not changed:** SES (production, 50,000/day), Cognito mailer (default), budgets, alarms, pilot data
  (still only the three 17 Oct staged-rehearsal workshops; no real pilot workshop exists yet).

## 2026-10-31 afternoon: staged rehearsal on the submitted build; web app from `82b7298`

- **Staged pilot rehearsal, run 4** on `pilot` (13:04:13–13:09:41 UTC; app stack unchanged since the
  05:37 CORS redeploy, i.e. the `8ace25c` bundles, whose backend code is identical to `82b7298`):
  PASS 85/85 (`results/2026-10-31-pilot-rehearsal/`, run `d29814ed`). 20 synthetic accounts on the
  SES mailbox simulator (tokens minted for the 17 Oct accounts), 43/43 commands applied, 9 seats relayed
  (expiries 86 and 113 ms through the timer path), 42 notifications SENT, invariants held after all 8
  phases, DLQs 0 before and after, no alarm transition, no Lambda error or throttle. Its workshop
  (`248ad987-…`, sessions 2 and 3 Nov) stays OPEN for inspection, like the three of 17 Oct; the sweep
  ends the two still-queued synthetic registrations at the cut-off. Final §4.5 quotes this run.
- **Web app** built from `82b7298` (`index-kaiHpPN-.js`, CSS unchanged `index-DnGuptRW.css`; adds the
  abort checks in `commandRunner`/`pollCommand` that came with the research merge) published to dev at
  13:09 UTC and, after the browser walkthrough on dev passed (45/45,
  `results/2026-10-31-web-walkthrough-dev-4/`, `--no-publish`), to pilot at 13:20 UTC. Both stages
  serve the same bundle; `env.js` names each stage's API.
- **Checked after:** `/health` 200 and `/me` 401 on both APIs, both CloudFront URLs 200 with the
  Content-Security-Policy header, every alarm OK, all six DLQs empty, all five stacks
  UPDATE_COMPLETE.
- **Pilot data now:** four staged-rehearsal workshops (17 Oct ×3, 31 Oct ×1), all synthetic; no
  real pilot workshop exists. The live pilot was not run before submission (Final §4.5, Table 5).
