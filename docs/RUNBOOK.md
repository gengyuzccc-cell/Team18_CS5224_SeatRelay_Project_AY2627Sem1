# SeatRelay runbook

Operational procedures for the cloud deployment (AWS, `ap-southeast-1`) and the on-premise reference
deployment (Docker Compose). Sections marked *Smoke* are the acceptance checks of plan §3 step 12.

## 0. Prerequisites

| Tool | Version used | Install |
|---|---|---|
| Node / pnpm | 22 / 10 | `corepack enable` |
| AWS CLI | v2 (v1 also works) | `pip install awscli` or installer |
| AWS SAM CLI | 1.169+ | `pip install aws-sam-cli` |
| Docker + Compose v2 | 29 / 5 | Docker Desktop (WSL2 on Windows) |
| k6 | 1.3 | GitHub release binary |
| jq | any | package manager |

Credentials: an IAM user `seatrelay-deployer` (AdministratorAccess during the project) with an access
key. On a laptop: `aws configure` (region `ap-southeast-1`). In the cloud build environment: add
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION=ap-southeast-1` as environment
secrets (see `docs/aws-setup.md`). Verify with `aws sts get-caller-identity`.

## 1. Cloud deployment

Three stacks (plan §2.4): `seatrelay-auth` (deployed once, never deleted), `seatrelay-app-<stage>`
and `seatrelay-web-<stage>` with `<stage>` ∈ {dev, pilot}. SAM configuration lives in
`services/aws/samconfig.toml`; templates in `services/aws/templates/`.

### 1.1 First-time, day 0

```bash
tools/scripts/bin/activate-cost-tags.sh                  # cost allocation tag "Project" (24 h delay)
cd services/aws
sam deploy --config-env auth \
  --parameter-overrides SenderEmail=team@example.com BudgetEmail=team@example.com \
                        MonthlyBudgetUsd=20 AnnualBudgetUsd=60
```

* The SES identity sends a verification e-mail to `SenderEmail`; click it.
* Request SES production access with the text in `docs/ses-production-request.md`.
* Cognito's own mailer is limited to 50 e-mails/day/account; keep `EmailSendingAccount: COGNITO_DEFAULT`
  until SES production access is granted.

### 1.2 Deploy / update a stage (dev or pilot)

```bash
STAGE=dev ALARM_EMAIL=team@example.com tools/scripts/bin/deploy-all.sh
```

`deploy-all.sh` = `pnpm --filter @seatrelay/aws build` (esbuild bundles into `services/aws/dist/<fn>/index.mjs`)
→ `sam deploy --config-env web-dev` → `sam deploy --config-env dev --parameter-overrides WebOrigin=<cloudfront url> …`
→ registers the CloudFront URL as Cognito callback/logout URL → `deploy-web.sh` (build + S3 upload + invalidation).

Stage differences: dev has `AllowFaultFlags=true`, `EmailEnabled=false`, throttle 300 rps / 500 burst,
no table deletion protection; pilot has `AllowFaultFlags=false`, `EmailEnabled=true`, 50 / 100,
deletion protection on.

Manual equivalents:

```bash
cd services/aws && pnpm build
sam deploy --config-env dev --parameter-overrides Stage=dev WebOrigin=https://dxxxx.cloudfront.net AllowFaultFlags=true EmailEnabled=false AlarmEmail=team@example.com
sam deploy --config-env web-dev
STAGE=dev tools/scripts/bin/deploy-web.sh
```

### 1.3 Acceptance after deployment (plan §3 step 7)

```bash
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'seatrelay')].[StackName,StackStatus]" --output table
curl -s "$(aws cloudformation describe-stacks --stack-name seatrelay-app-dev --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)/health"
```

Expected: all stacks `CREATE_COMPLETE`/`UPDATE_COMPLETE`; `/health` returns `{"ok":true,...}`;
hosted UI at `https://seatrelay-<account>.auth.ap-southeast-1.amazoncognito.com/login?client_id=<web client>&response_type=code&scope=openid+email+profile&redirect_uri=<web url>/callback`
allows sign-up and sign-in; CloudWatch dashboard `seatrelay-dev`, alarms and the two budgets exist.

### 1.4 Test users and tokens (experiments)

```bash
pnpm --filter @seatrelay/scripts exec tsx src/create-test-users.ts --count 60 --prefix loaduser --password 'Passw0rd!' --stage dev
```

Users are created with `--message-action SUPPRESS` (no e-mail) and a permanent password; the script
caches ID tokens for k6 in `tools/loadtest/.token-cache.dev.json` (git-ignored). Tokens are minted via
the `tooling` app client (`USER_PASSWORD_AUTH`, plain JSON `InitiateAuth` call, no SigV4).

### 1.5 Tear-down

```bash
STAGE=dev tools/scripts/bin/teardown.sh        # empties the S3 bucket, deletes web + app stacks; keeps auth
```

### 1.6 Daily cost snapshot

```bash
tools/scripts/bin/cost-snapshot.sh             # -> results/cost/snapshots/<date>.json
```

## 2. On-premise reference (Docker Compose)

```bash
pnpm local:up            # = docker compose -f services/local/docker-compose.yml up --build -d
pnpm local:down          # stops and removes volumes
```

| Service | URL | Notes |
|---|---|---|
| Web (nginx, same SPA build) | http://localhost:8081 | `/env.js` generated at start |
| API (Fastify + in-process worker/timer/notifier) | http://localhost:3000 | `/health` |
| Keycloak 26 (realm `seatrelay`) | http://localhost:8080 | admin / admin; users `organiser@example.com`, `alice@…`, `bob@…`, `carol@…` password `Passw0rd!` |
| Mailpit | http://localhost:8025 | all outgoing e-mail |
| PostgreSQL 16 | localhost:5432 | `seatrelay/seatrelay`, schema from `services/local/sql/schema.sql` |

Issuer pitfall (plan §2.7): the browser and the server both use issuer `http://localhost:8080/realms/seatrelay`;
the server fetches JWKS through the container network (`OIDC_JWKS_URL=http://keycloak:8080/...`).

Token for scripts (password grant, `tooling` client):

```bash
curl -s -X POST http://localhost:8080/realms/seatrelay/protocol/openid-connect/token \
  -d grant_type=password -d client_id=tooling -d username=alice@example.com -d 'password=Passw0rd!' -d scope=openid | jq -r .id_token
```

## 3. Smoke test (both deployments)

Script: `tools/experiments/src/smoke.ts` (`pnpm --filter @seatrelay/experiments exec tsx src/smoke.ts --target local|dev`).
It performs, with three accounts, the scenario of plan §3 step 12 and asserts every step:

1. Organiser creates an organisation and a workshop with 2 sessions (capacity 1 each, `holdSeconds=60`).
2. Alice registers (acceptable: S1, S2) → polling `GET /commands/{id}` reaches `APPLIED`; she holds an
   OFFER for S1 within one settlement.
3. Alice accepts → `CONFIRMED` S1; Bob registers (S1 only) → `QUEUED` position 1.
4. Alice cancels → in the **same** settlement Bob gets an OFFER for S1 (backfill latency ≈ 0 ms, cause `CANCELLED_CONFIRMED`).
5. Bob lets the offer expire: after ~60 s the TICK (delay queue / timer loop) expires it; Carol (queued) gets the seat
   → backfill record cause `EXPIRED` with `latencyMs` = tick delay (single-digit seconds expected).
6. Bob tries to accept after `expiresAt` → `REJECTED (OFFER_EXPIRED)`.
7. `GET …/verify` → `ok: true`; DLQs empty (cloud) / `commands` table has no `FAILED` rows (local).

## 4. Fault injection (dev only)

Commands may carry `_fault: BEFORE_COMMIT | AFTER_COMMIT | TIMER_SEND` when the stack parameter
`AllowFaultFlags=true`. `BEFORE_COMMIT` throws before the transaction (message is retried, nothing
written), `AFTER_COMMIT` throws after the transaction (retry hits `COMMAND_ALREADY_SETTLED` and acks),
`TIMER_SEND` throws while sending the expiry timer (retry resends; duplicate ticks are harmless).

## 5. Alarms and what to do

| Alarm | Meaning | Action |
|---|---|---|
| `commands-dlq-not-empty` | a command failed 3 times (infrastructure error) | read the DLQ message, fix, redrive with `aws sqs start-message-move-task` |
| `commands-oldest-message-age > 120 s` | worker backlog / stuck message group | check worker errors, raise `WorkerMaxConcurrency` |
| `notify-dlq-not-empty` | notification batch exhausted retries | inspect SES quota / sandbox state |
| `notifier-iterator-age > 60 s` | stream consumer lagging | check SES throttling |
| budget 50/80/100 % | spend (credits excluded) | pause experiments; `teardown.sh dev` |
