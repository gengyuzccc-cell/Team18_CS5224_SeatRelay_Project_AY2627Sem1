# web-walkthrough — real-browser walkthrough of the dev stack

**Staged walkthrough with test accounts: operational evidence that the deployed web app works end to end in a real browser; not user evidence.**

- Verdict: **PASS** (45 explicit checks passed; every visible state asserted with Playwright)
- Started 2026-10-24T08:25:04.593Z, finished 2026-10-24T08:28:54.613Z (230 s)
- Web https://d2ni5e1z674t04.cloudfront.net → API https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com; Cognito hosted UI https://seatrelay-379549361891.auth.ap-southeast-1.amazoncognito.com; browser 141.0.7390.37 (/opt/pw-browsers/chromium-1194/chrome-linux/chrome)
- Commit: cb160d25da1582c5afa85b0928d4c6e453ff4886 (dirty)
- Script: `tools/e2e/src/walkthrough.ts`; screenshots `docs/demo/screenshots/`; video `docs/demo/backup-demo.mp4`

## What was staged

- Organisation **Staged walkthrough 24 Oct, 16:25**, workshop **Cloud Computing Workshop (staged demo)** (`a54fbda5-fd83-400d-829b-4f4ce811ed3a`), UNIFIED, hold 60 s, Sessions 1–3 with capacities 2 / 1 / 1; created through the UI wizard.
- Alice: Session 2 > Session 1 (ordered with ▲) → offered Session 2 → accepted → cancelled. Bob: Session 2 only → queued → offered by the cancellation backfill → left to expire. Carol: Session 2 only → queued → offered by the expiry backfill → accepted → attendance ticked. CSV export, verify.

## Observed in the browser

- OIDC: authorization code + PKCE through the hosted UI for all 4 accounts; each returned to the page it started from with the user in localStorage and no code/state left in the address bar.
- Alice's REGISTER: 1771 ms from "Sending…" to the offer card (POST → 202 → polls). Every command (offsets of each GET /commands/{id} from the 202):
  - alice REGISTER: 202 in 743 ms, polls at +301 ms
  - alice ACCEPT_OFFER: 202 in 372 ms, polls at +302 ms
  - bob REGISTER: 202 in 700 ms, polls at +301 ms
  - alice CANCEL_REGISTRATION: 202 in 384 ms, polls at +314 ms
  - carol REGISTER: 202 in 598 ms, polls at +305 ms
  - carol ACCEPT_OFFER: 202 in 366 ms, polls at +296 ms
- Sign-in: hosted UI round trip for all 4 accounts; sign-out cleared the stored user and the hosted UI asked for the password again.
- Bob's Past entry: "Cloud Computing Workshop (staged demo) ended: your hold on Session 2 expired · 24 Oct 2026, 4:27 pm".
- Cancellation backfill: dashboard latency 0 ms; Bob's page showed the offer 5190 ms after the cancellation settled (10 s refresh; observed refresh gaps 10295, 10324, 10440, 10335, 10316, 10332 ms).
- Expiry backfill: dashboard latency 137 ms; Carol's page showed the relayed offer 7231 ms after `expiresAt`.
- Backfill log header: "2/2 reallocated · p50 0 ms · p95 137 ms · max 137 ms". CSV: 4 lines, header `seq,userId,email,displayName,status,endReason,acceptable,confirmedSessionId,confirmedSessionTitle,currentOfferId,offerSessionId,offerExpiresAt,attended,createdAt,updatedAt`.
- API responses ≥ 400 or failed: 0; console errors: 0.

## Notes

- Bob's page around the expiry (status card states): none@08:26:07 → none@08:26:09 → none@08:26:14 → none@08:26:19 → queued@08:26:25 → offered@08:26:35 → none@08:27:30 → ended@08:27:31; offer expiresAt 2026-10-24T08:27:29.120Z.

## Checks

| step | check | ok | detail |
|---|---|---|---|
| preflight | env.js names the API, the hosted UI and the stage | yes | https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com https://seatrelay-379549361891.auth.ap-southeast-1.amazoncognito.com dev |
| preflight | API /health ok on stage dev | yes | {"ok":true,"service":"seatrelay","stage":"dev","time":"2026-10-24T08:25:06.546Z"} |
| organiser signs in through the hosted UI | Organiser: authorization request = code flow with PKCE (S256), scopes openid email profile | yes | {"responseType":"code","method":"S256","challenge":true,"scope":"openid email profile"} |
| organiser signs in through the hosted UI | Organiser: token request = authorization_code grant with a code_verifier | yes | {"grantType":"authorization_code","verifier":true} |
| organiser signs in through the hosted UI | Organiser: OIDC user stored in localStorage after the callback | yes | oidc.user:https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ZZ7UsL6Ib:6f926dm22ulrv8gfjro2db1ac |
| organiser signs in through the hosted UI | Organiser: back on / without code/state in the address bar | yes | https://d2ni5e1z674t04.cloudfront.net/ |
| organiser signs in through the hosted UI | layout: "Go to the organiser area" keeps its own width (not stretched across the card) | yes | width ratio 0.44 |
| organiser creates a workshop with three sessions | layout: wizard step 1, the Mode select and the Hold input are top-aligned | yes | offset 0.0 px |
| organiser creates a workshop with three sessions | layout: "Add session" keeps its own width | yes | width ratio 0.12 |
| organiser creates a workshop with three sessions | Session 1: capacity 2, nothing held, all free | yes | Session 1 26 Oct 2026, 10:00 am / Open / 2 / 0 / 0 / 2 / 0 |
| organiser creates a workshop with three sessions | Session 2: capacity 1, nothing held, all free | yes | Session 2 27 Oct 2026, 10:00 am / Open / 1 / 0 / 0 / 1 / 0 |
| organiser creates a workshop with three sessions | Session 3: capacity 1, nothing held, all free | yes | Session 3 28 Oct 2026, 2:00 pm / Open / 1 / 0 / 0 / 1 / 0 |
| organiser creates a workshop with three sessions | share link points at the public workshop page | yes | https://d2ni5e1z674t04.cloudfront.net/workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a |
| organiser creates a workshop with three sessions | layout: "Edit details" keeps its own width | yes | width ratio 0.08 |
| organiser creates a workshop with three sessions | layout: "Cancel session" keeps its own width in the Manage cell | yes | width ratio 0.57 |
| Alice signs in from the share link | layout: Alice's "Sign in to register" stays centred in its panel | yes | 0.0 px off centre |
| Alice signs in from the share link | Alice: authorization request = code flow with PKCE (S256), scopes openid email profile | yes | {"responseType":"code","method":"S256","challenge":true,"scope":"openid email profile"} |
| Alice signs in from the share link | Alice: token request = authorization_code grant with a code_verifier | yes | {"grantType":"authorization_code","verifier":true} |
| Alice signs in from the share link | Alice: OIDC user stored in localStorage after the callback | yes | oidc.user:https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ZZ7UsL6Ib:6f926dm22ulrv8gfjro2db1ac |
| Alice signs in from the share link | Alice: back on /workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a without code/state in the address bar | yes | https://d2ni5e1z674t04.cloudfront.net/workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a |
| Alice picks two sessions and orders them | tick order sets the ranks: Session 1 = 1, Session 2 = 2 | yes | Session 1,Session 2 |
| Alice picks two sessions and orders them | ▲ moves Session 2 to rank 1 | yes | Session 2,Session 1 / 1,2 |
| Alice registers: request received, then a held seat with a countdown | countdown shows the 60 s hold (between 0:30 and 1:00) | yes | 57 s |
| Alice registers: request received, then a held seat with a countdown | visible order: "Request received" before "Registration applied" | yes | toast:Sending… → toast:Request received / Processing… the result will appear here. → status:Request received, waiting for the outcome… → toast:Registration applied / A seat in Session 2 is held for you — confirm within 00:58. → card:offered |
| Bob registers for the full session and is queued | layout: Bob's "Sign in to register" stays centred in its panel | yes | 0.0 px off centre |
| Bob registers for the full session and is queued | Bob: authorization request = code flow with PKCE (S256), scopes openid email profile | yes | {"responseType":"code","method":"S256","challenge":true,"scope":"openid email profile"} |
| Bob registers for the full session and is queued | Bob: token request = authorization_code grant with a code_verifier | yes | {"grantType":"authorization_code","verifier":true} |
| Bob registers for the full session and is queued | Bob: OIDC user stored in localStorage after the callback | yes | oidc.user:https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ZZ7UsL6Ib:6f926dm22ulrv8gfjro2db1ac |
| Bob registers for the full session and is queued | Bob: back on /workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a without code/state in the address bar | yes | https://d2ni5e1z674t04.cloudfront.net/workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a |
| Bob registers for the full session and is queued | public table: Session 2 has 0 free before Bob registers | yes | Session 2 / 27 Oct 2026, 10:00 am cut-off 27 Oct 2026, 9:30 am / Open / 1 / 0 / 0 |
| Bob's status page picks up the backfill on its 10 s refresh | Bob sees the offer without reloading, within one refresh period (+ slack) | yes | 5190 ms after the cancellation settled |
| Bob's status page picks up the backfill on its 10 s refresh | Bob's countdown is running (≤ 60 s) | yes | 53 s |
| Carol registers for Session 2 and is queued behind the held seat | layout: Carol's "Sign in to register" stays centred in its panel | yes | 0.0 px off centre |
| Carol registers for Session 2 and is queued behind the held seat | Carol: authorization request = code flow with PKCE (S256), scopes openid email profile | yes | {"responseType":"code","method":"S256","challenge":true,"scope":"openid email profile"} |
| Carol registers for Session 2 and is queued behind the held seat | Carol: token request = authorization_code grant with a code_verifier | yes | {"grantType":"authorization_code","verifier":true} |
| Carol registers for Session 2 and is queued behind the held seat | Carol: OIDC user stored in localStorage after the callback | yes | oidc.user:https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ZZ7UsL6Ib:6f926dm22ulrv8gfjro2db1ac |
| Carol registers for Session 2 and is queued behind the held seat | Carol: back on /workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a without code/state in the address bar | yes | https://d2ni5e1z674t04.cloudfront.net/workshops/a54fbda5-fd83-400d-829b-4f4ce811ed3a |
| dashboard: offer, queue and the cancellation backfill | backfill log: Session 2, "confirmed seat cancelled", reallocated to Bob | yes | 4:26:29 pm / Session 2 / confirmed seat cancelled / 4:26:29 pm / 0 ms / Bob (staged) <walkthrough-bob@example.com> |
| Carol's page picks up the automatic backfill | Carol sees the relayed seat within 45 s of the expiry | yes | 7231 ms |
| dashboard: backfill log, counters, distinct served | backfill log lists the expiry and the cancellation, both reallocated, holders named | yes | 4:27:29 pm / Session 2 / offer expired / 4:27:29 pm / 137 ms / Carol (staged) <walkthrough-carol@example.com> ;; 4:26:29 pm / Session 2 / confirmed seat cancelled / 4:26:29 pm / 0 ms / Bob (staged) <walkthrough-bob@example.com> |
| dashboard: backfill log, counters, distinct served | Session 2: capacity 1, confirmed 1, held 0, free 0, waiting 0 | yes | Session 2 27 Oct 2026, 10:00 am / Open / 1 / 1 / 0 / 0 / 0 |
| dashboard: CSV export and verify invariants | CSV export downloaded with a header and the participants | yes | seatrelay-a54fbda5-fd83-400d-829b-4f4ce811ed3a.csv: 4 lines; header seq,userId,email,displayName,status,endReason,acceptable,confirmedSessionId,confirmedSessionTitle,currentOfferId,offerSessionId,offerExpiresAt,attended,createdAt,updatedAt |
| Alice signs out (hosted UI logout round trip) | Alice: no OIDC user left in localStorage after sign-out | yes |  |
| Alice signs out (hosted UI logout round trip) | after sign-out the hosted UI asks for credentials again (no silent sign-in) | yes | /login |
| Alice signs out (hosted UI logout round trip) | video ≤ 25 MB | yes | 2.3 MB, 164 s |
