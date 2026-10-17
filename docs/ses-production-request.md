# SES production access request (ap-southeast-1)

> 团队摘要：SES 新账号处于 **sandbox**（每 24 h 200 封、1 封/秒、只能发给已验证地址）。试点要给真实参与者发邮件，必须申请 production access（免费，通常 24 小时内回复）。§2 是表单每一栏填什么，§3 是直接粘贴的用例说明，§5 是操作步骤。申请前先把发件身份验证完成（点邮件里的链接）。获批前 Cognito 继续用 `COGNITO_DEFAULT`（plan §2.4）。

Plan reference: `docs/plan/execution-plan.md` §2.4 (SES identity, notifier, `COGNITO_DEFAULT` until approval), §8 (10/15: submit the request), §9 (fallback if not approved: pilot e-mails only to verified team addresses, participants rely on in-app notifications). Live identifiers: `docs/deployment-state.md`.

## 1. Facts

| Item | Value |
|---|---|
| Account / region | `379549361891`, `ap-southeast-1` (Singapore) — the request is per region |
| Sending identity | the `SenderEmail` passed to the `seatrelay-auth` stack (`AWS::SES::EmailIdentity`); must show **Verified** before the request |
| Sandbox limits | 200 e-mails / 24 h, 1 e-mail / s, verified recipients only |
| What we ask for | production access; the default production quota is enough (check it on the Account dashboard after approval) |
| Expected volume | ≤ 2,000 e-mails / month; peak ≤ 300 / day during the pilot (3–7 Nov) and the user study; sending rate ≤ 1 / s (notifier throttle) |
| Mail type | Transactional only |

## 2. Form fields (SES console → Account dashboard → "Request production access")

| Field | What to enter |
|---|---|
| Mail type | **Transactional** |
| Website URL | the CloudFront URL of the web app from `docs/deployment-state.md` (e.g. `https://d2ni5e1z674t04.cloudfront.net`); add the public GitHub repository URL in the use-case text |
| Use case description | paste §3 verbatim, then fill the two `[ ]` placeholders |
| Additional contact addresses | the team mailbox (the same address used as `BudgetEmail` / `AlarmEmail`) |
| Preferred contact language | English |
| Acknowledgement | tick that you will only send to recipients who requested the mail and that you have a process for bounces and complaints |

If the form shows different or fewer fields, put the same content in the closest field.

## 3. Use case description — paste as is

```
SeatRelay is a workshop sign-up service built by Team 18 of the NUS CS5224 Cloud Computing course (AY2026/27 Semester 1) and used for a real pilot at the National University of Singapore in November 2026. Public code: [GitHub repository URL]. Web app: [CloudFront URL].

WHAT WE SEND
Transactional notifications only, each triggered by an action of the recipient or by the state of a registration the recipient created: (1) "a seat is held for you, confirm within 15 minutes", (2) seat confirmed, (3) held seat expired, (4) registration declined/cancelled, (5) session or workshop cancelled by the organiser, (6) registration ended. Optionally, Amazon Cognito will send sign-up verification codes and password resets through SES after approval. No newsletters, no marketing, no bulk mail.

HOW RECIPIENTS OPT IN
A recipient creates an account themselves (Amazon Cognito user pool, e-mail verified by code) and then registers for a specific workshop. We send only to that verified address and only about that registration. We never import or buy address lists. A recipient stops all e-mail by cancelling the registration or deleting the account; every message states why it was sent and names the organiser.

VOLUME
Up to 2,000 e-mails per month in total, peaks of at most 300 per day during the pilot (3-7 November 2026) and a user study, at no more than 1 e-mail per second. Sending is done by a single Lambda function from a DynamoDB stream; tests use the SES mailbox simulator addresses.

BOUNCES AND COMPLAINTS
The account-level suppression list is enabled for both bounces and complaints. Bounce and complaint feedback notifications for the sending identity are published to an SNS topic subscribed by the team mailbox and are reviewed daily. The sending function records every MessageRejected or bounce as a failed notification and does not retry that address; a complained or hard-bounced address is flagged so that the user receives in-app notifications only. Failures are counted in a CloudWatch metric with an alarm, and undeliverable work goes to a dead-letter queue that is also alarmed. Expected bounce rate is near zero because every address was verified by code at sign-up.

REGION
ap-southeast-1 only. Sending identity: the verified team address shown in this account; a domain identity will be added if the project obtains a domain.
```

Fill `[GitHub repository URL]` and `[CloudFront URL]` before pasting. If a reviewer asks for a sample, send §4.

## 4. Sample e-mail (if the reviewer asks)

```
Subject: [SeatRelay] A seat is held for you - Python for Data Analysis, Session 2 (Tue 4 Nov, 14:00)

Hi Mei,
A seat in Session 2 of "Python for Data Analysis" (organised by NUS Libraries) is held for you until 13:15 SGT.
Confirm or decline here: https://<web url>/me
If you do nothing, the seat is released to the next person on the waitlist.
You receive this because you registered for this workshop with this address. To stop these e-mails, cancel your registration on the same page.
```

## 5. Steps for the team

**Before submitting (10 min)**

1. Sign in to the AWS console as `seatrelay-deployer`, switch the region to **Asia Pacific (Singapore) ap-southeast-1**.
2. SES → Identities → the sender address: status must be **Verified**. If it is "Verification pending", open the e-mail "Amazon Web Services – Email Address Verification Request" and click the link (it expires after 24 h; re-send from the identity page if needed).
3. SES → Identities → the sender → **Notifications** → Edit feedback notifications: create an SNS topic `seatrelay-ses-feedback` (standard) with an e-mail subscription to the team mailbox (confirm the subscription e-mail), set it for **Bounce** and **Complaint**, keep "Include original email headers" on. This is what §3 promises.
4. SES → Configuration → Suppression list: confirm the account-level list is enabled for bounces and complaints (default).
5. Send one test e-mail from the identity page to `success@simulator.amazonses.com` and one to a team address to confirm sending works in the sandbox.

**Submit (5 min)**

6. SES → Account dashboard → **Request production access** (or **Get set up** → "Request production access"). Fill §2, paste §3, submit.
7. Note the support case number and the submission time in `docs/deployment-state.md` (SES line) — no secrets.

**After submitting**

8. Expect a reply within 24 h (up to 2 business days) from AWS Support to the account's root e-mail and the additional contact; if they ask for more information, reply in the same case with: the sample in §4, the repository URL, and the two sentences on opt-in and bounce handling from §3.
9. On approval: the Account dashboard shows "Production access: Enabled" and the new daily quota. Update `docs/deployment-state.md`. Deploy the pilot stage with `EmailEnabled=true` (`docs/RUNBOOK.md` §1.2). Optionally switch the Cognito user pool to send through SES (`EmailSendingAccount: DEVELOPER`, source ARN = the identity) to escape the 50 e-mails/day Cognito limit; do **not** do this before approval (sandbox would break sign-up verification codes for unverified addresses).
10. If denied: reply with clarifications (they usually ask about opt-in or complaint handling) and resubmit once; if still denied by 10/29, apply plan §9: pilot e-mails go only to verified team addresses, participants use in-app notifications, and the report states this.
