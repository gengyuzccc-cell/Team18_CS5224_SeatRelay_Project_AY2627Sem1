# @seatrelay/scripts — operational scripts

Plan §3 step 14: test accounts and token caches, the demo preset, the user-study reset, plus
the shell scripts for deployment, tear-down and cost snapshots. The package also exports the
small libraries that `tools/loadtest` and `tools/experiments` reuse (`src/lib`).

Everything talks to SeatRelay through the public API (plan §2.5): seeded state is produced by
the engine (seq, offers, queue positions), never written into storage directly.

```
pnpm --filter @seatrelay/scripts <script> -- [options]      # --help on every script
```

Run the commands from the repository root. Relative paths given as options (`--cache`,
`--users`, …) are resolved against the directory the command was typed in (pnpm's
`INIT_CWD`), although `pnpm --filter` executes the script inside `tools/scripts`. The `--`
separator is optional.

| Script | What it does |
| --- | --- |
| `create-test-users` | Cognito: `--count N` accounts `<prefix>-i@<domain>` via `AdminCreateUser` (`MessageAction: SUPPRESS`, no e-mail) + `AdminSetUserPassword` (permanent); idempotent (`UsernameExistsException` is fine). Mints ID tokens with `InitiateAuth USER_PASSWORD_AUTH` on the `tooling` app client (unsigned HTTPS JSON call, `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`) and writes `tools/loadtest/.token-cache.<stage>.json`. Pool and client ids come from the outputs `UserPoolId` / `ToolingClientId` of stack `seatrelay-auth` unless `--pool-id` / `--client-id` are given. |
| `get-tokens-keycloak` | Local stack: the same cache format (`.token-cache.local.json`) through the password grant of the public `tooling` client. Users: the four realm users (default), `--users FILE` (JSON `[{ email, password?, name? }]` or one e-mail per line) or `--count N --prefix p --domain d` (generated). Missing accounts are created through the Keycloak admin API (bootstrap admin / admin of the compose file) and existing ones get `--password` set, unless `--no-create`. |
| `seed-demo` | The demo preset of `docs/DEMO.md`: organisation + one workshop with 3 sessions (capacity 2 / 2 / 1, `--hold 60` s by default so an expiry can be shown live) and N participants registered with varied preference lists (`[S1,S2,S3] [S2,S3] [S3,S1] [S1] [S2,S1,S3] [S3]`, cycling). Earlier workshops with the same title in the demo organisation are cancelled first (`--keep-previous` keeps them), so a re-run yields one clean demo workshop. Prints org / workshop / session ids, each session's free / held seats and queue length, and each participant's state as JSON. |
| `seed-study` | Resets one user-study round to the tables of `docs/user-study/tasks-participant.md` §1 / `tasks-organiser.md` §1 (`--track participant\|organiser --dataset A\|B`). Re-running = reset. |
| `bin/deploy-all.sh`, `bin/deploy-web.sh`, `bin/teardown.sh`, `bin/cost-snapshot.sh`, `bin/activate-cost-tags.sh` | Bash (Git Bash / WSL on Windows); see the header comment of each. |

## Targets and credentials

`--target local` (default) talks to `http://localhost:3000` and Keycloak at
`http://localhost:8080` (see the environment table below). `--target dev|pilot` reads the API
URL from the `ApiUrl` output of `seatrelay-app-<stage>` and the Cognito ids from
`seatrelay-auth`, which needs AWS credentials (`aws configure`, `AWS_PROFILE`, region
`ap-southeast-1`). Creating Cognito accounts (`create-test-users`, and `seed-demo` /
`seed-study` on dev, which create their accounts) is a signed admin call and needs them too;
minting tokens (`InitiateAuth`) does not.

Without credentials every script fails fast, before changing anything (exit code 2):

```
error: No AWS credentials were found. Configure them first (aws configure / AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, region ap-southeast-1); nothing was changed. (Could not load credentials from any providers)
Pass --api <ApiUrl> (or set TARGET_API) to skip the CloudFormation lookup.
```

Credentials that exist but are rejected (expired session, wrong keys, missing permission) are
reported the same way, naming the call (`DescribeStacks seatrelay-auth: …`,
`Cognito AdminCreateUser/AdminSetUserPassword for x@example.com: …`), instead of an SDK stack
trace. An unreachable API or Keycloak is reported with its URL and the connection error
(`Keycloak is not reachable at http://localhost:8080 (connect ECONNREFUSED …)` + a hint to
check `docker compose ps`).

`--api`, `--pool-id` and `--client-id` bypass CloudFormation; `create-test-users --no-create
--pool-id … --client-id …` makes no AWS call at all (it only mints tokens for existing
accounts). `--dry-run` prints the plan of `create-test-users`, `seed-demo` and `seed-study`
without any network call.

### Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TARGET_API` | seed-demo, seed-study (and loadtest) | API base URL; overrides the per-target default / stack lookup (`--api` wins) |
| `KEYCLOAK_BASE` | local target | Keycloak base URL (default `http://localhost:8080`) |
| `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT` | local target | realm (default `seatrelay`), public client with direct access grants (default `tooling`) |
| `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD` | local target | bootstrap admin of `services/local/docker-compose.yml` (default `admin` / `admin`) |
| `COGNITO_USER_POOL_ID`, `COGNITO_TOOLING_CLIENT_ID` | dev/pilot | same as `--pool-id` / `--client-id` |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | dev/pilot | region of the stacks (default `ap-southeast-1`) |
| `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, … | dev/pilot | standard SDK credential chain |
| `INIT_CWD` | all | set by pnpm; base directory for relative path options |

## Token cache format

`tools/loadtest/.token-cache.<target>.json` (git-ignored):

```json
{
  "target": "local",
  "issuer": "http://localhost:8080/realms/seatrelay",
  "issuedAt": "2026-10-17T06:40:00.000Z",
  "users": [
    { "email": "alice@example.com", "idToken": "eyJ…", "expiresAt": "2026-10-17T07:40:00.000Z", "userId": "4c94…", "name": "Alice Participant" }
  ]
}
```

Re-running merges by e-mail and drops expired entries. k6 (`tools/loadtest`) needs one entry
per VU. Keycloak ID tokens last 60 min (realm `accessTokenLifespan`), ID tokens of the Cognito
`tooling` client 12 h (`templates/auth.yaml`); `run-matrix` refuses to start when the tokens
would expire before the matrix ends.

## Examples

```bash
# local stack (docker compose up first)
pnpm --filter @seatrelay/scripts get-tokens-keycloak                       # 4 realm users
pnpm --filter @seatrelay/scripts get-tokens-keycloak -- --count 60 --prefix loaduser   # 60 accounts for 50 VUs
pnpm --filter @seatrelay/scripts seed-demo -- --target local
pnpm --filter @seatrelay/scripts seed-study -- --track participant --dataset A --target local

# dev stage (credentials configured)
pnpm --filter @seatrelay/scripts create-test-users -- --count 60 --prefix loaduser --password 'Passw0rd!' --stage dev
pnpm --filter @seatrelay/scripts seed-demo -- --target dev
pnpm --filter @seatrelay/scripts seed-study -- --track organiser --dataset B --target dev
```

## seed-study: what "reset" means

1. Accounts `study.riley@example.com` (organiser persona, owner of **NUS Data Club**),
   `study.jordan@example.com` (participant persona, never registered) and one
   `first.last@example.com` account per dummy registrant (`Mei Lin Chua` →
   `meilin.chua@example.com`, the convention of `control-condition-setup.md` §5) exist with
   `--password` (default `Passw0rd!`). The facilitator plays Mei Lin / Farah with that password.
2. Every OPEN/CLOSED workshop of the study organisation is cancelled (`CANCEL_WORKSHOP`): the
   previous round's W1/W2/W3 and anything a participant created in O1. This also ends every
   registration of the personas (Jordan's T1/T2 registrations, the registrant Mei Lin / Farah
   cancelled in O2). There is no delete route in the API, so cancelled workshops stay visible
   as CANCELLED in the organiser's list and the persona's old registrations are listed under
   "Past" in "My registrations"; the live state ("Current", dashboards) is exact.
3. The dataset's workshops are created (`holdSeconds 1800`, sessions on the dates and
   Singapore times of the tables), confirmed people are REGISTERed on their single session and
   ACCEPT their offer, then the queue entries REGISTER in seq order with their preference
   lists.
4. The dashboard is compared with the table (capacity / confirmed / free per session, queue
   order and positions, no outstanding offer, distinct participants) and `/verify` must be ok;
   any difference exits non-zero and is printed.
5. Every unread in-app notification of the two personas is marked read (previous rounds'
   offers and the WORKSHOP_CANCELLED notices step 2 causes), so the notification badge starts
   at zero; the notifications themselves cannot be deleted through the API.

`--json` prints the ids (org, workshops, sessions) for the facilitator sheet; `--dry-run` the
plan. The in-memory test (`test/study.test.ts`) drives the same code against
`@seatrelay/service` and checks the answer keys (T1 → OFFERED Tue, T2 → QUEUED #3/#4,
O2 → Hui Min / Oscar, O3 → Samuel / Quentin).

## Library (`src/lib`, exported from the package)

| Module | Exports |
| --- | --- |
| `api.ts` | `ApiClient` (typed routes, `sendCommand()` = POST + `GET /commands/{id}` polling with the plan §1.3 backoff 300 → 500 → 1000 → 2000 ms, 5 s after 30 s; returns client-observed and server-side settle latency), `ApiHttpError` (non-2xx with the `{ code, message }` body), `ApiNetworkError` (no HTTP answer), `expectApplied`, `pollDelayMs`. `fetch` is injectable. |
| `aws.ts` | `getStackOutputs`, `requireOutput`, `assertAwsCredentials` (fail fast), `explainAwsError` (credential errors → `CliError`), `STACKS`, `awsRegion`. |
| `cognito.ts` / `keycloak.ts` | `cognitoEnsureUser`, `cognitoInitiateAuth`, `resolveCognitoIds`, `assertCognitoAdminCredentials`; `KeycloakAdmin`, `keycloakPasswordGrant`, `REALM_USERS`. Both expose a `UserProvider`. |
| `users.ts` | `provisionUsers(provider, specs)` → accounts + ID tokens, `generatedUserSpecs`. |
| `targets.ts` | `resolveTarget` (API base per target), `userProviderFor`. |
| `tokenCache.ts` | read / write / merge of the cache; `findCachedUser`, `isTokenFresh`. |
| `seed.ts`, `seedDemo.ts`, `seedStudy.ts`, `study.ts` | the seeding primitives (`findOrCreateOrg`, `cancelOrgWorkshops`, `confirmSeat`, `joinQueue`) and the study tables. |
| `cli.ts` | `parseCli` (`node:util` parseArgs + `--help`, ignores a leading `--`), `runMain` (operational errors without stack traces), `resolveUserPath` (`INIT_CWD`), `log`, `REPO_ROOT`. |

## Checks

```bash
pnpm --filter @seatrelay/scripts typecheck
pnpm --filter @seatrelay/scripts test        # vitest: API client against the in-memory service, Cognito/CloudFormation with aws-sdk-client-mock (incl. rejected credentials), Keycloak with a fake fetch, study tables + seeding + reset, demo preset + re-run
```
