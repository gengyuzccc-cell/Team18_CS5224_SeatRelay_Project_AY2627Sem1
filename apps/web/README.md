# @seatrelay/web

The SeatRelay single-page app (plan §2.6): Vite 6 + React 18 + TypeScript, react-router 6,
TanStack Query 5, react-oidc-context 3 / oidc-client-ts 3. One build serves both CloudFront
(`tools/scripts/bin/deploy-web.sh`) and the on-prem nginx (`services/local/nginx`).

```
pnpm --filter @seatrelay/web dev        # http://localhost:5173 against the docker-compose stack
pnpm --filter @seatrelay/web typecheck  # tsc
pnpm --filter @seatrelay/web test       # vitest (backoff schedule, poll loop, preference reducer, auth adapter, env)
pnpm --filter @seatrelay/web build      # tsc + vite build → dist/
```

## Runtime configuration: `/env.js`

`index.html` loads `<script src="/env.js">` before the bundle. The file assigns
`window.__SEATRELAY_ENV__`; nothing is baked in at build time, so the same `dist/` works for
every stage. `public/env.js` holds the `pnpm dev` defaults (local Keycloak + Fastify API) and is
**overwritten at deploy time** by `deploy-web.sh` (Cognito values from the SAM stack outputs) and
generated at container start by `services/local/nginx/entrypoint.sh` (from `VITE_*` variables).

| Field            | Type                      | Meaning                                                                                      | Local default                               |
| ---------------- | ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `provider`       | `'cognito' \| 'keycloak'` | Which logout flow to use (Cognito has no `end_session_endpoint`)                             | `keycloak`                                  |
| `authority`      | string                    | OIDC issuer; discovery at `<authority>/.well-known/openid-configuration`                     | `http://localhost:8080/realms/seatrelay`    |
| `clientId`       | string                    | Public PKCE client; also the `aud` the API checks on the ID token                            | `seatrelay-web`                             |
| `hostedUiDomain` | string                    | Cognito hosted UI base URL (`https://….amazoncognito.com`); required for `cognito`, else `''` | `''`                                        |
| `apiBaseUrl`     | string                    | API origin, no trailing slash                                                                | `http://localhost:3000`                     |
| `stage`          | string                    | Label in the header badge (`local`, `dev`, `pilot`)                                          | `local`                                     |

Missing fields fall back to the defaults; a wrong type, an unknown provider or `cognito`
without `hostedUiDomain` renders a configuration error instead of the app (`src/env.ts`).

## Authentication (plan §2.4)

Authorization code + PKCE, `redirect_uri = <origin>/callback`, scopes `openid email profile`,
`automaticSilentRenew` through the refresh token, user persisted in `localStorage`. The **ID
token** is sent as `Authorization: Bearer` on every API call. Sign-out (`src/auth/authAdapter.ts`):

- Cognito: `removeUser()` then `https://<hostedUiDomain>/logout?client_id=<clientId>&logout_uri=<origin>/`
  (the registered logout URLs carry the trailing slash).
- Keycloak: `signoutRedirect({ post_logout_redirect_uri: '<origin>/' })` (RP-initiated logout).

## Command flow (plan §1.3)

`src/commands/`: the browser generates `commandId` (`crypto.randomUUID()`) and keeps it until the
command settles, so retries are idempotent. `POST /workshops/{id}/commands` → 202 → poll
`GET /commands/{id}` with 300 → 500 → 1000 → 2000 ms (capped); after 30 s the cadence drops to
5 s with a "still processing" hint. Toasts distinguish *request received* from the terminal
*APPLIED* ("Session 2 seat is held for you — confirm within 14:59", "queued at position 3") or
*REJECTED* (human-readable reason). Status pages refetch every 10 s while a registration is
QUEUED/OFFERED and pause when the tab is hidden.

## Routes

| Path                           | Page                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `/`                            | Home: sign-in, my registrations summary, open-a-workshop, organiser link                          |
| `/callback`                    | OIDC redirect target                                                                              |
| `/workshops/:wsId`             | Public view (sessions capacity/free, queue length), registration form, my status card, share link |
| `/me/registrations`            | Live + past registrations with status cards                                                       |
| `/me/notifications`            | Notification centre, mark read                                                                    |
| `/org`                         | My organisations, create organisation, add organiser                                              |
| `/org/:orgId/workshops`        | Workshop list + 3-step create wizard (mode, holdSeconds, 2–5 sessions)                            |
| `/org/:orgId/workshops/:wsId`  | Dashboard: sessions table, queue, offered, confirmed, backfill log, actions, verify, CSV export   |

Anonymous visitors read `GET /public/workshops/{wsId}`; signed-in users read `GET /workshops/{wsId}`
(which includes `me`). Workshops/sessions in the transient `CANCELLING` status render a
"Cancelling…" badge and are treated like `CANCELLED` for every action.
