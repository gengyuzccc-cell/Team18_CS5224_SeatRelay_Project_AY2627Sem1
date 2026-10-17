# @seatrelay/e2e

Real-browser walkthrough of a deployed SeatRelay stage. Four people in four isolated Chromium
contexts sign in through the **Cognito hosted UI** and drive the **deployed SPA** exactly as a
person would: no API shortcuts, no injected tokens. Every visible state is asserted; any mismatch
stops the run with a full-page screenshot of every window. The same run produces:

- the screenshots for the slides and the report: `docs/demo/screenshots/NN-name.png`
  (1440×900, light theme) plus `docs/demo/screenshots/README.md`, which lists what each one shows;
- the backup demo video: `docs/demo/backup-demo.mp4` (H.264, 1280 px wide, ≤ 25 MB) with its
  chapter list `docs/demo/backup-demo-chapters.txt`;
- an evidence summary: `results/<date>-web-walkthrough-<stage>[-n]/` (`summary.md`, `meta.json`,
  `run.log`).

**Staged.** Every account is a test account whose display name says "(staged)", the organisation
and workshop titles say so too, and the video carries a "Staged walkthrough" label on every frame.
The run is operational evidence that the deployed web app works end to end. It is not user
evidence and never stands in for the user study.

## Run it

```bash
pnpm install
pnpm --filter @seatrelay/e2e ensure-users     # once: creates the four accounts (AWS credentials needed)
pnpm --filter @seatrelay/e2e walkthrough      # full run against dev, about 5 minutes
```

| Flag | Default | Meaning |
|---|---|---|
| `--web <url>` / `E2E_WEB_URL` | `https://d2ni5e1z674t04.cloudfront.net` | SPA to drive; API and hosted UI come from its `/env.js` |
| `--stage <name>` / `E2E_STAGE` | `dev` | must match `stage` in `/env.js` |
| `--prefix <p>` / `E2E_PREFIX` | `walkthrough` | accounts `<p>-{organiser,alice,bob,carol}@example.com`; password `E2E_PASSWORD` or `SEATRELAY_TEST_PASSWORD` (required; never the public local default) |
| `--headed` | off | show the browser windows |
| `--no-video` | video on | skip the recordings and the cut |
| `--no-publish` | publish on | keep screenshots and video in `out/` only |
| `--no-results` | results on | do not write `results/…` |
| `--beat <ms>` | `900` | pause after each visible step (pacing of the video) |
| `--type-delay <ms>` | `25` | per-key typing delay |
| `--out`, `--screenshots`, `--video` | see above | output locations (relative to where `pnpm` was started) |

Only a passing run publishes: a failing run leaves the screenshots and the video already in
`docs/demo/` untouched. Everything of a run (screenshots, raw per-window recordings `videos/*/*.webm`,
the cut, `chapters.txt`, the CSV export, `events.json` with every observed UI change and API request,
`failures/*.png`) stays in `tools/e2e/out/<timestamp>/`, which git ignores.

**Accounts.** `bin/ensure-users.sh` creates the four accounts in the stage's user pool with the AWS
CLI (`admin-create-user --message-action SUPPRESS`, then `admin-set-user-password --permanent`); no
e-mail is sent. The walkthrough itself needs no AWS credentials: it only knows the passwords.

**Browser.** `playwright` is pinned to 1.56.1, the release whose Chromium build (`chromium-1194`)
is installed under `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` on the team's cloud machine). If
that build is missing, `src/lib/browser.ts` uses the newest `chromium-<rev>` it finds there, or
`CHROMIUM_PATH`. On your own laptop, `pnpm --filter @seatrelay/e2e exec playwright install chromium`
fetches the matching build. The browser uses the machine's proxy settings; the script makes no
HTTP request from Node itself (even the preflight reads `/env.js` and `/health` through a page).

**Load.** Strictly sequential, one person acting at a time: a few requests per second at most
(command polls 300 → 500 → 1000 ms, status pages and the dashboard every 10 s). That is safe under
the account's Lambda concurrency quota of 10. Do not run several walkthroughs at once.

## What it does and checks

Following `docs/DEMO.md` (beats D1–D4; the fault injection D5 stays a terminal step):

| Step | Window | Asserted in the browser |
|---|---|---|
| Sign in | Organiser | home page with the stage badge; "Sign in" → classic hosted UI form → back on `/` with the name from the ID token in the top bar, the OIDC user in `localStorage`, no `code`/`state` left in the address bar |
| Organisation | Organiser | created in the organiser area, listed under *My organisations* |
| Workshop | Organiser | 3-step wizard: UNIFIED, hold 60 s, Sessions 1–3 (2, 3 and 4 days ahead, capacities 2 / 1 / 1) → dashboard with three sessions, nothing held; share link = public page |
| Register | Alice | public page signed out ("Want a seat?") → hosted UI → back on the workshop page; ticks Session 1 then 2 (ranks 1, 2), ▲ moves Session 2 to rank 1; "Register (2 sessions)" → "Request received, waiting for the outcome…" → toast "Registration applied" → status card: seat in Session 2 held, countdown between 0:30 and 1:00 (the order of these states is checked from the page's own change log) |
| Accept | Alice | "Accept seat" → "Seat confirmed in Session 2", toast "Accept applied" |
| Queue | Bob | Session 2 shows 0 free; registers for Session 2 only → "Queued at position 1"; Waiting = 1 |
| Cancel → backfill | Alice, Bob | "Cancel my seat" → "Release your seat?" → "Yes, cancel" → toast "Cancellation applied", the form is back; **Bob's page, without a reload**, shows the seat held for him within one 10 s refresh |
| Third person | Carol | registers for Session 2 → "Queued at position 1" |
| Dashboard | Organiser | Offered (1) = Bob, Queue (1) = Carol, backfill log "confirmed seat cancelled", reallocated, `1/1` |
| Expiry → backfill | Bob, Carol | Bob does nothing; his card leaves the offered state after `expiresAt` and the form returns; **Carol's page** shows the relayed seat within 45 s of `expiresAt`; Carol accepts |
| Review | Organiser | counters Queued 0 / Offered 0 / Confirmed 1 / Distinct served 1 / Backfills 2/2; backfill log with both causes and their latency; Session 2 = 1 confirmed, 0 free; attendance tick → "Attended", Attended 1; "Export CSV" downloads a CSV with the participants; "Verify invariants" → "All invariants hold" |
| Look back | Alice, Bob | *My registrations* → *Past* (Alice cancelled, Bob ended with its reason); Bob's notification centre |
| Sign out | Alice | "Sign out" → hosted UI `/logout` → back on `/` signed out, no stored user; "Sign in" again shows the hosted UI form (no silent sign-in) |
| Layout | all | regression checks for the layout fixes found by the first run: buttons in column containers keep their width, the wizard's step-1 fields are top-aligned, the centred "Sign in to register" stays centred |

It also records, per window, every API request (method, path, status, duration) and every console
error; `summary.md` lists API responses ≥ 400 and console errors (both 0 on a clean run), the poll
offsets of every command after its 202, and the 10 s refresh gaps of a queued participant's page.

## How the video is cut

Playwright records one video per page, so `src/lib/director.ts` keeps a timeline of whose window is
"on screen" while that person acts (`director.cut(actor, caption, speed)`). After the run, every
segment is taken from that person's recording (input-level `-ss`/`-t`), long waits are sped up
(marked "N× speed"), a caption bar is added under the page (who acts, what happens, "Staged
walkthrough · dev stack · date"), a 5 s intro card states what the video is, and ffmpeg concatenates
and encodes it (libx264, CRF 28, 1280 px wide). `test/director.test.ts` covers the time mapping and
the ffmpeg arguments.
