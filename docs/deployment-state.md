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

Callback/logout URLs registered in Cognito: `http://localhost:5173/callback`, `https://d2ni5e1z674t04.cloudfront.net/callback`
(logout: `http://localhost:5173/`, `https://d2ni5e1z674t04.cloudfront.net/`).

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

## seatrelay-app-pilot / seatrelay-web-pilot

Not yet deployed.
