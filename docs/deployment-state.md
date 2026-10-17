# Deployment state (live identifiers)

Account `379549361891`, region `ap-southeast-1`, deployer IAM user `seatrelay-deployer`.
Updated whenever a stack is (re)deployed. No secrets are stored here.

## seatrelay-auth (deployed 2026-10-16, CREATE_COMPLETE)

| Output | Value |
|---|---|
| UserPoolId | `ap-southeast-1_ZZ7UsL6Ib` |
| Issuer | `https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ZZ7UsL6Ib` |
| WebClientId (`web`, code + PKCE) | `6f926dm22ulrv8gfjro2db1ac` |
| ToolingClientId (`tooling`, USER_PASSWORD_AUTH) | `203uigcnditpcmp54ir0gnsieq` |
| HostedUiDomain | `https://seatrelay-379549361891.auth.ap-southeast-1.amazoncognito.com` |
| SenderEmail (SES identity) | `gengyuzccc@gmail.com` — verification pending (click the SES e-mail) |
| Budgets | `seatrelay-monthly` US$20 (IncludeCredit=false), `seatrelay-annual` US$60 |
| Cost allocation tag | `Project` activation requested 2026-10-16 (visible in Cost Explorer after ≤ 24 h) |

Validation performed: hosted UI login page HTTP 200; OIDC discovery OK (note: Cognito now publishes
`end_session_endpoint`, so RP-initiated logout also works besides the classic `/logout` endpoint);
test user `smoke1@example.com` (created with `MessageAction=SUPPRESS`) minted an ID token through the
tooling client with `email` and `name` claims.

SES: account is in the **sandbox** (200 mails/24 h, 1 mail/s, verified recipients only). Production
access request: **submitted 2026-10-17 00:5x UTC via `sesv2 put-account-details`** (status PENDING; mail type
TRANSACTIONAL, website URL = CloudFront URL, use case = `docs/ses-production-request.md` §3). Account-level
suppression list enabled for BOUNCE and COMPLAINT. Feedback notifications (Bounce/Complaint, with headers)
published to SNS topic `seatrelay-ses-feedback`; the e-mail subscription for gengyuzccc@gmail.com is pending
confirmation (click the SNS confirmation e-mail).

**2026-10-17 07:0x UTC: SES production access DENIED** (support case `179219791000451`). At review time the
sender identity was still *unverified*, which is the usual cause. Next steps for the team: (1) click the SES
verification e-mail sent to gengyuzccc@gmail.com; (2) confirm the SNS subscription e-mail; (3) reply to the case
in the AWS Support Center console (Basic support cannot reply via CLI) with the use-case text of
`docs/ses-production-request.md` §3 and the CloudFront URL. Until approved the plan §9 fallback applies:
participants rely on in-app notifications (`/me/notifications`), e-mail goes only to verified team addresses,
and the dev stack runs with `EmailEnabled=false`.

## seatrelay-web-dev (deployed 2026-10-16, CREATE_COMPLETE)

| Output | Value |
|---|---|
| WebUrl | `https://d2ni5e1z674t04.cloudfront.net` |
| DistributionId | `E26U29AH9791XC` |
| BucketName | `seatrelay-web-dev-379549361891` |

Callback/logout URLs registered in Cognito: localhost:5173, the dev CloudFront URL and the pilot CloudFront URL
(`/callback` for sign-in, `/` for sign-out).

## seatrelay-app-dev (deployed 2026-10-17, CREATE_COMPLETE)

Parameters: `Stage=dev AllowFaultFlags=true EmailEnabled=false WebOrigin=https://d2ni5e1z674t04.cloudfront.net AlarmEmail=gengyuzccc@gmail.com`.

| Output | Value |
|---|---|
| ApiUrl | `https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com` |
| TableName | `seatrelay-dev` |
| CommandsQueueUrl | `https://sqs.ap-southeast-1.amazonaws.com/379549361891/seatrelay-dev-commands.fifo` |
| ExpiryDelayQueueUrl | `https://sqs.ap-southeast-1.amazonaws.com/379549361891/seatrelay-dev-expiry-delay` |
| DLQs | `seatrelay-dev-commands-dlq.fifo`, `seatrelay-dev-expiry-delay-dlq`, `seatrelay-dev-notify-dlq` |
| Functions | `seatrelay-dev-{api,worker,expiry-forwarder,sweep,notifier}` (nodejs22.x, arm64) |
| Dashboard | CloudWatch dashboard `seatrelay-dev` |
| Alarm topic | `seatrelay-dev-alarms` (e-mail subscription pending confirmation) |

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
was not republished** and still serves the previous bundle. Walkthrough accounts (Cognito, e-mail suppressed,
display names "… (staged)"): `walkthrough-{organiser,alice,bob,carol}@example.com`, created by
`tools/e2e/bin/ensure-users.sh` (recreated once on 2026-10-17, so the published screenshots start from empty
histories). The walkthrough leaves its staged organisations and workshops ("Staged walkthrough …", "Cloud Computing
Workshop (staged demo)") open on dev. Evidence: `results/2026-10-17-web-walkthrough-dev/`.

## seatrelay-web-pilot (deployed 2026-10-17, CREATE_COMPLETE)

| Output | Value |
|---|---|
| WebUrl | `https://diiztwl34x7s1.cloudfront.net` |
| DistributionId | `E8IW9Y948A3CG` |
| BucketName | `seatrelay-web-pilot-379549361891` |

Registered in Cognito as callback (`/callback`) and logout (`/`) URL together with dev and localhost.

## seatrelay-app-pilot (deployed 2026-10-17, CREATE_COMPLETE)

Parameters: `Stage=pilot AllowFaultFlags=false EmailEnabled=true WebOrigin=https://diiztwl34x7s1.cloudfront.net AlarmEmail=gengyuzccc@gmail.com`.

| Item | Value |
|---|---|
| ApiUrl | `https://dx40kccif3.execute-api.ap-southeast-1.amazonaws.com` |
| TableName | `seatrelay-pilot` (deletion protection ON, PITR ON, on-demand, stream NEW_AND_OLD_IMAGES) |
| Throttling | 50 rps / burst 100 (dev: 300 / 500) |
| Fault flags | `ALLOW_FAULT_FLAGS=false` (the API strips `_fault`) |
| E-mail | `EMAIL_ENABLED=true`, sender `gengyuzccc@gmail.com` (verified). While SES is in the sandbox only verified recipients receive mail; other recipients are recorded as FAILED and see in-app notifications |
| Sweep schedule | `seatrelay-pilot-sweep` (EventBridge Scheduler, rate 5 min) |

Checks after deployment: `/health` 200 `{"ok":true,"stage":"pilot"}`, `/me` without token 401, pilot SPA `env.js`
points at the pilot API.

First attempt failed CloudFormation early validation: SAM names a `ScheduleV2` event after its logical id when
`Name` is omitted, so the dev and pilot sweep schedules collided (`SweepFunctionEvery5Minutes`). Fixed by
`Name: !Sub seatrelay-${Stage}-sweep`; dev still carries the old name until its next deployment (after the
Table 3 run, so that the measurement is not disturbed).

## Lambda concurrency quota (account-level, ap-southeast-1)

`aws lambda get-account-settings` on 2026-10-17: `ConcurrentExecutions: 10`,
`UnreservedConcurrentExecutions: 10`, `FunctionCount: 10` (the five functions of `dev` and the five of
`pilot` share these 10 slots). An increase to 1,000 (quota `L-B99A9384`, "Concurrent executions") was
requested through Service Quotas; status `CASE_OPENED`, support case `179224956500721`. Until it is
granted, never generate concurrent load against AWS; the concurrency, backfill and k6 dev re-runs wait
for it (`docs/SUBMISSION-CHECKLIST.md`). Whether the quota caused the HTTP 503 responses of the
concurrency and backfill runs is not yet established (Final §4.2).
