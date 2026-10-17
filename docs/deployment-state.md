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

## seatrelay-web-dev (deployed 2026-10-16, CREATE_COMPLETE)

| Output | Value |
|---|---|
| WebUrl | `https://d2ni5e1z674t04.cloudfront.net` |
| DistributionId | `E26U29AH9791XC` |
| BucketName | `seatrelay-web-dev-379549361891` |

Callback/logout URLs registered in Cognito: `http://localhost:5173/callback`, `https://d2ni5e1z674t04.cloudfront.net/callback`
(logout: `http://localhost:5173/`, `https://d2ni5e1z674t04.cloudfront.net/`).

## seatrelay-app-dev

Not yet deployed (requires the Lambda bundles from `services/aws`).

## seatrelay-app-pilot / seatrelay-web-pilot

Not yet deployed.
