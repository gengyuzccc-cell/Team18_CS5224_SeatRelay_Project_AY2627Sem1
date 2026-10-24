# SES production access: approval and end-to-end check (2026-10-24)

**Approval.** AWS answered support case `179219791000451`: the account is out of the SES sandbox in
ap-southeast-1, with a sending quota of 50,000 messages per 24 h and a maximum rate of 14 messages per
second. `aws sesv2 get-account` on 2026-10-24 confirms it (`sesv2-get-account.json`):
`ProductionAccessEnabled: true`, `ReviewDetails.Status: GRANTED`, `EnforcementStatus: HEALTHY`.

**Code change before enabling e-mail everywhere** (commit `bcd7bd1`). The synthetic test accounts use
reserved domains (`@example.com`), which would hard-bounce now that SES delivers to any address and
would hurt the account's reputation. The notifier now marks a notification to a reserved domain
(example.com/.net/.org, `.example`, `.test`, `.invalid`, `.localhost`; RFC 2606, RFC 6761) as SKIPPED
(in-app only) and never calls SES for it (`isReservedAddress` in `services/aws/src/handlers/notifier.ts`,
unit tests in `services/aws/test/notifier.test.ts`). Both app stacks were redeployed from that commit
(only `NotifierFunction` changed): `dev` now runs with `EmailEnabled=true` (was `false`), `pilot` keeps
`EmailEnabled=true`.

**End-to-end check on `dev`** (06:22–06:24 UTC). `seed-demo --target dev --participants
success@simulator.amazonses.com,ses.check.p2@example.com --title "SES check 2026-10-24"` created a
workshop with 60 s holds and registered both accounts; each received an offer, which then expired.
The notifier log (`notifier-log.json`, CloudWatch `/aws/lambda/seatrelay-dev-notifier`) shows:

| Recipient | Notifications | Outcome |
|---|---|---|
| SES mailbox simulator (`success@simulator.amazonses.com`) | OFFER, OFFER, EXPIRED | 3 × `notification sent`, each with an SES message id |
| `ses.check.p2@example.com` (reserved domain) | OFFER, EXPIRED, OFFER | 3 × `notification skipped (reserved test domain)`, no SES call |

The mailbox simulator accepts mail without delivering it to a person and does not affect the
account's bounce or complaint rates.

**Not changed: Cognito's verification e-mails.** Sign-up codes still come from Cognito's default
mailer (limit 50 e-mails per day for the user pool). The only verified SES identity is a gmail.com
address; mail sent from it through SES cannot be aligned with gmail.com's SPF/DKIM (DMARC `p=none`),
so moving the codes onto it would make them more likely to land in spam. To lift the 50/day limit,
verify a domain the team controls with Easy DKIM and set the user pool's `EmailSendingAccount` to
`DEVELOPER` (`services/aws/templates/auth.yaml`). The same applies to the notifier's own e-mails:
they are delivered, but recipients should be told to check their spam folder; the in-app
notifications (`/me/notifications`) remain the primary channel.
