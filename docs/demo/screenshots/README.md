# Walkthrough screenshots

Captured by `tools/e2e/src/walkthrough.ts` on 2026-10-24 against the deployed **dev** stack
(https://d2ni5e1z674t04.cloudfront.net), Chromium, 1440×900, light theme. **Staged:** test accounts whose names say "(staged)",
scripted actions; not user evidence. Regenerate with `pnpm --filter @seatrelay/e2e walkthrough`.

| File | Window | Shows |
|---|---|---|
| `01-home-signed-out.png` | Organiser | Home page before sign-in (stage badge "dev") |
| `02-hosted-ui-sign-in.png` | Organiser | Cognito hosted UI (classic): Organiser signs in with e-mail and password |
| `03-home-signed-in.png` | Organiser | Back from the hosted UI: signed in (name from the ID token in the top bar) |
| `04-organisation-created.png` | Organiser | Organiser area: the new organisation |
| `05-wizard-basics.png` | Organiser | Create-workshop wizard, step 1: title, mode UNIFIED, hold 60 s |
| `06-wizard-sessions.png` | Organiser | Wizard step 2: three sessions with small capacities |
| `07-wizard-review.png` | Organiser | Wizard step 3: review before creating |
| `08-dashboard-new.png` | Organiser | Dashboard of the new workshop: three sessions, nothing allocated yet |
| `09-public-page-signed-out.png` | Alice | Public workshop page before sign-in: sessions, free seats, queue length |
| `10-register-preferences.png` | Alice | Registration form: two acceptable sessions in preference order (1 = Session 2) |
| `11-request-received.png` | Alice | "Request received": the 202 came back, the outcome is not known yet (polling) |
| `12-offer-countdown.png` | Alice | Seat held in Session 2 (her first choice) with the live countdown; toast "Registration applied" |
| `13-confirmed.png` | Alice | Seat confirmed; "Cancel my seat" is the only action left |
| `14-queued.png` | Bob | Bob is queued at position 1 for Session 2; the page refreshes every 10 s while queued |
| `15-cancel-confirm.png` | Alice | Cancelling asks for confirmation inline |
| `16-cancelled.png` | Alice | After the cancellation the page says what happened and offers "Register again" |
| `17-offer-after-cancellation.png` | Bob | Bob's page, without a reload: the cancelled seat is now held for him |
| `18-queued.png` | Carol | Carol is queued at position 1 behind the seat held for Bob |
| `19-dashboard-queue-offer.png` | Organiser | Dashboard: Carol queued, the seat held for Bob with its countdown, the backfill log |
| `20-offer-expiring.png` | Bob | Bob's hold in its last seconds |
| `21-after-expiry.png` | Bob | After the expiry Bob's page says his hold expired and offers "Register again" |
| `22-offer-after-expiry.png` | Carol | Carol's page: the expired seat was relayed to her without anyone acting |
| `23-confirmed.png` | Carol | Carol confirmed in Session 2 |
| `24-dashboard-backfill-log.png` | Organiser | Backfill log: cancellation relayed in the same transaction, expiry relayed by the timer path |
| `25-dashboard-attendance.png` | Organiser | Confirmed list with the attendance tick saved |
| `26-dashboard-verify-ok.png` | Organiser | "Verify invariants": all invariants hold; CSV downloaded |
| `27-dashboard-overview.png` | Organiser | Dashboard header and counters at the end of the walkthrough |
| `28-dashboard-full.png` | Organiser | The whole dashboard at the end of the walkthrough (full page) |
| `29-my-registrations.png` | Alice | My registrations (Alice): the cancelled registration under Past |
| `30-my-registrations-ended.png` | Bob | My registrations (Bob): his registration ended after the hold expired |
| `31-notifications.png` | Bob | Notification centre (Bob): the in-app record of his offer and its expiry |
