# @seatrelay/local — on-premise reference deployment

The on-prem counterpart of `services/aws` (plan §2.7): the same `@seatrelay/service` application
layer and `@seatrelay/core` engine, run as **one Node process** on **PostgreSQL** instead of
Lambda + DynamoDB + SQS. It exists for the cost comparison and for proving functional parity:
the `apps/web` SPA build, the k6 scripts and the smoke flow are identical for both targets.

```
browser ──> nginx (web, :8081)  ──>  Fastify API (server, :3000) ──> PostgreSQL (:5432)
                │                         │  in-process loops: worker · timers · sweep · notifier · janitor
                └──> Keycloak (:8080)     └──> Mailpit SMTP (:1025, UI :8025)
```

| Piece | Cloud equivalent | Here |
| --- | --- | --- |
| API | API Gateway + `api` Lambda | `src/server.ts`: Fastify 5, one catch-all route per method around `createApiApp().handle` |
| Auth | Cognito JWT authorizer | `src/auth.ts`: `jose` RS256 verification against the Keycloak JWKS (`iss`, `aud`, `exp`) |
| Storage | DynamoDB single table | `sql/schema.sql` + `src/adapters/postgres/store.ts` (live and history tables) |
| Command queue | `commands.fifo` | `commands` table, FIFO per workshop, `dedup_id` unique (`src/adapters/postgres/queue.ts`) |
| Expiry timers | `expiry-delay` queue + forwarder | `timers` table + `src/timers.ts` (due rows → TICK commands) |
| Worker | `worker` Lambda | `src/worker.ts`: claim with `FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock(hashtext(workshop_id))`, `processCommand` in one transaction |
| Sweep | EventBridge 5-min rule | `createSweepLoop` (`src/timers.ts`) every `SWEEP_INTERVAL_MS` |
| Notifier | DynamoDB Streams + SES | `src/notifier.ts`: PENDING rows → nodemailer SMTP → SENT / FAILED / SKIPPED |
| TTL | DynamoDB TTL | `src/janitor.ts`: deletes expired `command_results` / `notifications`, old timers and DONE queue rows |
| Metrics | CloudWatch EMF | `src/metrics.ts`: in-process aggregates, `GET /metrics`, flushed to the log every `METRICS_FLUSH_MS` |

Storage adapters map data 1:1 (every engine `Change` is one row operation) and run no business
logic (CONVENTIONS §4).

## Run it

Prerequisites: Docker with Compose v2 (the compose file builds the images, so Node is not
needed on the host for this path).

```sh
docker compose -f services/local/docker-compose.yml up --build -d     # or: pnpm local:up
docker compose -f services/local/docker-compose.yml ps                # server must be "healthy"
docker compose -f services/local/docker-compose.yml logs -f server    # JSON logs
docker compose -f services/local/docker-compose.yml down -v           # or: pnpm local:down (drops the data)
```

| URL | What |
| --- | --- |
| http://localhost:8081 | the SPA (nginx; `/env.js` generated at start from `VITE_*` variables) |
| http://localhost:3000/health | API liveness (`{ ok: true }`), also the compose health check |
| http://localhost:3000/metrics | metric summary since the last window (`count/sum/min/max/p50/p95`) |
| http://localhost:8080 | Keycloak (admin / admin); realm `seatrelay` imported from `keycloak/realm-export.json` |
| http://localhost:8025 | Mailpit inbox (every notification e-mail lands here) |
| localhost:5432 | PostgreSQL `seatrelay` / `seatrelay`, database `seatrelay` |

The server applies `sql/schema.sql` on every start (every statement is `IF NOT EXISTS`, under an
advisory lock, so several instances may start at once); the postgres container also applies it
once through its init hook. The stack is healthy when `docker compose ps` shows `server`
as `healthy` (it waits for postgres and Keycloak to be healthy first; Keycloak takes ~30–60 s).

### Images (`Dockerfile`, build context = repository root)

| Target | Base | Contents |
| --- | --- | --- |
| `base` | `node:22-alpine` | pnpm via corepack, `pnpm install --frozen-lockfile` filtered to `@seatrelay/local...` and `@seatrelay/web...`, sources |
| `server` | `base` | `node --import tsx src/main.ts` in `services/local`, port 3000, `HEALTHCHECK` on `/health`, runs as `node` |
| `webbuild` | `base` | `pnpm --filter @seatrelay/web build` |
| `web` | `nginx:1.27-alpine` | the Vite build + `nginx/default.conf` (SPA fallback, immutable `/assets`) + `nginx/entrypoint.sh` |

`Dockerfile.dockerignore` keeps `node_modules`, build outputs, `.git`, `results/` and
`report/` out of the context (the context is < 1 MB).

**Behind a TLS-intercepting proxy** (`corepack`/`pnpm install` fail with
`certificate verify failed` during the build): drop the proxy's root CA as `*.crt` or `*.pem`
into `docker/ca-certificates/` (git-ignored). The `base` stage appends it to the system bundle
and exports `NODE_EXTRA_CA_CERTS`, so Node, wget and pnpm trust it. The folder may stay empty.

### From source (without the server image)

```sh
docker compose -f services/local/docker-compose.yml up -d postgres keycloak mailpit
DATABASE_URL=postgres://seatrelay:seatrelay@localhost:5432/seatrelay \
OIDC_ISSUER=http://localhost:8080/realms/seatrelay \
OIDC_JWKS_URL=http://localhost:8080/realms/seatrelay/protocol/openid-connect/certs \
OIDC_AUDIENCE=seatrelay-web,tooling SMTP_URL=smtp://localhost:1025 EMAIL_ENABLED=true \
ALLOW_FAULT_FLAGS=true WEB_ORIGIN=http://localhost:5173,http://localhost:8081 \
pnpm --filter @seatrelay/local dev            # tsx watch src/main.ts
```

## Configuration (environment variables only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `PG_POOL_SIZE` | `10` | connections in the pool (API + loops share it) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listener |
| `STAGE` | `local` | reported in `/health` and logs |
| `LOG_LEVEL` | `info` | `debug` also logs every poll of `/commands/{id}` and every processed command |
| `OIDC_ISSUER` | — (required) | expected `iss` claim, the **browser-visible** issuer (`http://localhost:8080/realms/seatrelay`) |
| `OIDC_JWKS_URL` | — (required) | JWKS endpoint reachable **from the server** (inside compose `http://keycloak:8080/...`) |
| `OIDC_AUDIENCE` | `` (any) | comma-separated accepted `aud` values (client ids `seatrelay-web,tooling`) |
| `WEB_ORIGIN` | `` (any origin) | comma-separated CORS origins |
| `ALLOW_FAULT_FLAGS` | `false` | keep `_fault` on command bodies and honour it in the worker (plan §2.4) |
| `EMAIL_ENABLED` | `false` | `false` marks notifications `SKIPPED` (still visible in the in-app notification centre) |
| `SMTP_URL` | — | `smtp://host:port` for nodemailer (Mailpit: `smtp://mailpit:1025`) |
| `SENDER_EMAIL` | `seatrelay@local.test` | `From:` address |
| `WORKER_POLL_MS` | `200` | idle wait of the worker loop (it runs back-to-back while the queue has work) |
| `WORKER_MAX_ATTEMPTS` | `3` | deliveries before a command is parked as `FAILED` (the DLQ) |
| `WORKER_RETRY_BACKOFF_MS` | `1000` | retry delay = backoff × attempt |
| `TIMER_POLL_MS` | `1000` | poll interval of the expiry timer loop |
| `NOTIFIER_POLL_MS` / `NOTIFIER_MAX_ATTEMPTS` | `1000` / `3` | notifier loop |
| `SWEEP_INTERVAL_MS` | `300000` | safety-net sweep (plan §1.2) |
| `JANITOR_INTERVAL_MS` | `600000` | TTL clean-up interval |
| `METRICS_FLUSH_MS` | `60000` | metric summary log line interval |

The Keycloak issuer caveat (plan §2.7): the browser and the server must see the **same** `iss`
string, so compose sets `KC_HOSTNAME=http://localhost:8080` and the server verifies
`OIDC_ISSUER=http://localhost:8080/realms/seatrelay` while fetching the keys from the
container-internal `OIDC_JWKS_URL`.

## Getting a token

Browser: the SPA signs in through the public PKCE client `seatrelay-web`. Tooling (curl, k6,
the smoke script): the public client `tooling` has the password grant enabled. Test users in
`keycloak/realm-export.json`: `organiser@example.com`, `alice@example.com`, `bob@example.com`,
`carol@example.com`, all with password `Passw0rd!`. The API verifies the **ID token**
(`sub`/`email`/`name` claims, `aud` = client id).

```sh
TOKEN=$(curl -s -X POST http://localhost:8080/realms/seatrelay/protocol/openid-connect/token \
  -d grant_type=password -d client_id=tooling -d scope=openid \
  -d username=alice@example.com -d 'password=Passw0rd!' | jq -r .id_token)

curl -s http://localhost:3000/me -H "authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3000/orgs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Team 18"}'
```

Routes are those of plan §2.5 (`createApiApp`): `/orgs…`, `/workshops/{wsId}`,
`/workshops/{wsId}/commands` (202 + poll `/commands/{id}`), `/me…`,
`/orgs/{orgId}/workshops/{wsId}/{dashboard,attendance,export.csv,verify}`, plus the
server-only `/public/workshops/{wsId}` (anonymous view, never reads the token) and `/metrics`.

## Smoke test (RUNBOOK §3)

```sh
services/local/scripts/smoke.sh        # needs curl, jq, python3; ~65 s (the 60 s hold elapses)
```

Organiser creates an org and a workshop (2 sessions × capacity 1, `holdSeconds` 60); alice
registers → OFFER S1, accepts → CONFIRMED; bob registers → QUEUED #1; alice cancels → bob is
OFFERED in the same settlement (backfill `CANCELLED_CONFIRMED`, 0 ms); carol queues; bob lets
the offer expire → carol gets the seat (backfill `EXPIRED`, latency = tick delay); bob's late
accept → `REJECTED (OFFER_EXPIRED)`; `/verify` is `ok` and the `commands` table has no `FAILED`
rows. Every step prints the (abridged) responses and asserts them; the Mailpit inbox shows the
five notification e-mails.

## Tests

```sh
pnpm --filter @seatrelay/local typecheck
pnpm --filter @seatrelay/local test          # vitest; the store tests need PostgreSQL
pnpm lint
```

`test/store.test.ts` runs against the real database (`TEST_DATABASE_URL` or `DATABASE_URL`,
default the compose postgres on `localhost:5432`) in its own schema `seatrelay_test`, dropped
and recreated per run; when PostgreSQL is unreachable the suite is skipped with a message
telling you to start it. It covers: the schema applies idempotently, `commit` version conflict →
`VERSION`, settled command → `COMMAND_ALREADY_SETTLED`, archives move rows to history, the R1
unique index (UNIFIED and PER_SESSION scopes), queue dedup, the due-timer query, the worker
(order, tick-first expiry, fault flags, invalid payloads) and the notifier states.

## How the worker keeps the cloud semantics

- **One transaction per command**: claim (`FOR UPDATE SKIP LOCKED`, head-of-line per workshop)
  → advisory lock on the workshop → `loadSnapshot` → `decide` → timer rows → `commit` (engine
  writes, notifications, `CommandResult` settled only while still `ACCEPTED`) → continuation
  enqueue → mark `DONE`. The version condition (`UPDATE workshops … WHERE version = expected`)
  is kept even though the lock already serialises writers, so the adapter honours the port
  contract on its own.
- **Infrastructure errors** roll everything back; the row is retried after
  `WORKER_RETRY_BACKOFF_MS × attempt` and parked as `FAILED` after `WORKER_MAX_ATTEMPTS`
  (inspect with `SELECT * FROM commands WHERE status = 'FAILED'`). Deterministic rejections
  never throw.
- **Fault flags** (`ALLOW_FAULT_FLAGS=true`): `BEFORE_COMMIT` / `TIMER_SEND` throw before the
  commit (clean rollback, redelivery settles the command); `AFTER_COMMIT` keeps the committed
  decision and redelivers the message, which is acknowledged as `COMMAND_ALREADY_SETTLED`.
- **Timers** are inserted inside the same transaction, so a rolled-back decision leaves no
  timer; a TICK's dedup id `tick#offerId#expiresAt` drops duplicates. The worker expires by
  server time, so a late tick is a no-op and the 5-minute sweep is only a safety net.
