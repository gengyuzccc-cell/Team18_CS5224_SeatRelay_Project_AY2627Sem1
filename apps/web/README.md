# @seatrelay/web

The SeatRelay single-page app (plan §2.6): Vite 6 + React 18 + TypeScript, react-router 6,
TanStack Query 5, react-oidc-context 3 / oidc-client-ts 3. One build serves both CloudFront
(`tools/scripts/bin/deploy-web.sh`) and the on-prem nginx (`services/local/nginx`).

```
pnpm --filter @seatrelay/web dev        # http://localhost:5173 against the docker-compose stack
pnpm --filter @seatrelay/web typecheck  # tsc
pnpm --filter @seatrelay/web test       # vitest (backoff, poll loop, command runner, settled-result cache merge,
                                        #  refetch interval, API errors, server clock, session renewal, env, …)
pnpm --filter @seatrelay/web build      # tsc + vite build → dist/
```

## Runtime configuration: `/env.js`

`index.html` loads `<script src="/env.js">` before the bundle. The file assigns
`window.__SEATRELAY_ENV__`; nothing is baked in at build time, so the same `dist/` works for
every stage. `public/env.js` holds the `pnpm dev` defaults (local Keycloak + Fastify API) and is
**overwritten at deploy time** by `deploy-web.sh` (Cognito values from the SAM stack outputs) and
generated at container start by `services/local/nginx/entrypoint.sh` (from `VITE_*` variables).

| Field            | Type                      | Meaning                                                                                       | Local default                            |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `provider`       | `'cognito' \| 'keycloak'` | Which logout flow to use (Cognito has no `end_session_endpoint`)                              | `keycloak`                               |
| `authority`      | string                    | OIDC issuer; discovery at `<authority>/.well-known/openid-configuration`                      | `http://localhost:8080/realms/seatrelay` |
| `clientId`       | string                    | Public PKCE client; also the `aud` the API checks on the ID token                             | `seatrelay-web`                          |
| `hostedUiDomain` | string                    | Cognito hosted UI base URL (`https://….amazoncognito.com`); required for `cognito`, else `''` | `''`                                     |
| `apiBaseUrl`     | string                    | API origin, no trailing slash                                                                 | `http://localhost:3000`                  |
| `stage`          | string                    | Label in the header badge (`local`, `dev`, `pilot`)                                           | `local`                                  |

Missing fields fall back to the defaults; a wrong type, an unknown provider or `cognito`
without `hostedUiDomain` renders a configuration error instead of the app (`src/env.ts`). A
missing `window.__SEATRELAY_ENV__` falls back to the local defaults only under `vite dev` or on a
loopback origin (`localhost`, `127.0.0.1`); on a deployed origin it means `/env.js` did not load
and the app shows the configuration error instead of sending sign-in to `localhost:8080`.

## Authentication (plan §2.4)

Authorization code + PKCE, `redirect_uri = <origin>/callback`, scopes `openid email profile`,
`automaticSilentRenew` through the refresh token, user persisted in `localStorage`. The **ID
token** is sent as `Authorization: Bearer` on every API call. Sign-out (`src/auth/authAdapter.ts`):

- Cognito: `removeUser()` then `https://<hostedUiDomain>/logout?client_id=<clientId>&logout_uri=<origin>/`
  (the registered logout URLs carry the trailing slash).
- Keycloak: `signoutRedirect({ post_logout_redirect_uri: '<origin>/' })` (RP-initiated logout).

Session renewal (`src/auth/sessionRenewal.tsx`): oidc-client-ts only arms its renew timer for a
token that is still valid at page load, so a stored user whose ID token expired while the tab was
closed is refreshed once at start-up with its refresh token (the session reads as loading
meanwhile, so no signed-out UI flashes). A 401 for the token that was sent triggers one renew; if
there is no refresh token or the renewed token is refused too, the stored user is removed and the
UI offers a new sign-in. API Gateway's own `{"message":"Unauthorized"}` / `"Too Many Requests"`
bodies are mapped to `UNAUTHORIZED` / `TOO_MANY_REQUESTS` (`src/api/client.ts`).

## Command flow (plan §1.3)

`src/commands/`: the browser generates `commandId` (`crypto.randomUUID()`) and keeps it until the
command settles, so retries are idempotent. `POST /workshops/{id}/commands` → 202 → poll
`GET /commands/{id}` with 300 → 500 → 1000 → 2000 ms (capped); after 30 s the cadence drops to
5 s with a "still processing" hint. Toasts distinguish _request received_ from the terminal
_APPLIED_ ("Session 2 seat is held for you — confirm within 14:59", "queued at position 3") or
_REJECTED_ (human-readable reason, also shown inline next to the button that sent it).

- **The poll response updates the UI** (`src/api/settledRegistrations.ts`): an APPLIED result's
  `registration` is written into the cached workshop view (`me`) and `/me/registrations` before
  anything is refetched. `GET /me/registrations` reads a GSI on AWS (eventually consistent), so
  each response is merged with the poll results the server has not caught up with yet: an entry
  counts as caught up when its persisted state equals the poll result or its `updatedAt` is later
  than the command's `settledAt` (overlays expire after 60 s as a safety net).
- **Retries** (`src/commands/commandRunner.ts`): network errors, 5xx and 429 keep the
  `commandId`; while such a request can be retried, the form inputs stay locked ("Retry previous
  request" or "Discard and edit"), so the retried body is what is on screen. A 4xx is final: the
  next submit gets a fresh `commandId`.
- **Leaving the page** does not cancel a command: polling continues for up to 2 min and the toast
  (above the router) shows the outcome; after that it is replaced by a non-sticky "check My
  registrations" hint.
- **Refresh**: status pages refetch every 10 s while a registration is QUEUED/OFFERED, the
  dashboard every 10 s; `refetchIntervalInBackground: false` pauses this while the tab is hidden
  (the interval stays a plain number so a fetch finishing in a hidden tab cannot switch it off).
- **Server time** (plan §1.4, `src/util/serverClock.ts`): the offer countdown, settlement copy
  and cut-off checks use the server clock, estimated from `GET /health` (`time`) at start-up and
  every 10 min. The countdown never disables Accept; the server's tick-first logic decides.

## Routes

| Path                          | Page                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/`                           | Home: sign-in, my registrations summary, open-a-workshop, organiser link                                                |
| `/callback`                   | OIDC redirect target                                                                                                    |
| `/workshops/:wsId`            | Public view (sessions capacity/free, queue length), registration form, my status card, share link                       |
| `/me/registrations`           | Live + past registrations with status cards                                                                             |
| `/me/notifications`           | Notification centre, mark read                                                                                          |
| `/org`                        | My organisations, create organisation, add organiser                                                                    |
| `/org/:orgId/workshops`       | Workshop list + 3-step create wizard (mode, holdSeconds, 2–5 sessions)                                                  |
| `/org/:orgId/workshops/:wsId` | Dashboard: edit title/description, sessions table, queue, offered, confirmed, backfill log, actions, verify, CSV export |

Anonymous visitors read `GET /public/workshops/{wsId}`; signed-in users read `GET /workshops/{wsId}`
(which includes `me`). Workshops/sessions in the transient `CANCELLING` status render a
"Cancelling…" badge and are treated like `CANCELLED` for every action.
