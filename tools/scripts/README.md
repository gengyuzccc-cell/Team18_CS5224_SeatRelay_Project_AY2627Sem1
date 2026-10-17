# @seatrelay/scripts — operational scripts

Plan §3 step 14: test accounts and token caches, the demo preset, the user-study reset, plus
the shell scripts for deployment, tear-down and cost snapshots. The package also exports the
small libraries that `tools/loadtest` and `tools/experiments` reuse (`src/lib`).

Everything talks to SeatRelay through the public API (plan §2.5): seeded state is produced by
the engine (seq, offers, queue positions), never written into storage directly.

```
pnpm --filter @seatrelay/scripts <script> -- [options]      # --help on every script
```

| Script | What it does |
| --- | --- |
| `create-test-users` | Cognito: `--count N` accounts `<prefix>-i@<domain>` via `AdminCreateUser` (`MessageAction: SUPPRESS`, no e-mail) + `AdminSetUserPassword` (permanent); idempotent (`UsernameExistsException` is fine). Mints ID tokens with `InitiateAuth USER_PASSWORD_AUTH` on the `tooling` app client (unsigned HTTPS JSON call, `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`) and writes `tools/loadtest/.token-cache.<stage>.json`. Pool and client ids come from the outputs `UserPoolId` / `ToolingClientId` of stack `seatrelay-auth` unless `--pool-id` / `--client-id` are given. |
| `get-tokens-keycloak` | Local stack: the same cache format (`.token-cache.local.json`) through the password grant of the public `tooling` client. Users: the four realm users (default), `--users FILE` (JSON `[{ email, password?, name? }]` or one e-mail per line) or `--count N --prefix p --domain d` (generated). Missing accounts are created through the Keycloak admin API (bootstrap admin / admin of the compose file) and existing ones get `--password` set, unless `--no-create`. |
| `seed-demo` | The demo preset of `docs/DEMO.md`: organisation + one workshop with 3 sessions (capacity 2 / 2 / 1, `--hold 60` s by default so an expiry can be shown live) and N participants registered with varied preference lists (`[S1,S2,S3] [S2,S3] [S3,S1] [S1] [S2,S1,S3] [S3]`, cycling). Prints org / workshop / session ids and each participant's state as JSON. |
| `seed-study` | Resets one user-study round to the tables of `docs/user-study/tasks-participant.md` §1 / `tasks-organiser.md` §1 (`--track participant\|organiser --dataset A\|B`). Re-running = reset. |
| `bin/deploy-all.sh`, `bin/deploy-web.sh`, `bin/teardown.sh`, `bin/cost-snapshot.sh`, `bin/activate-cost-tags.sh` | Bash (Git Bash / WSL on Windows); see the header comment of each. |

## Targets and credentials

`--target local` (default) talks to `http://localhost:3000` and Keycloak at
`http://localhost:8080` (override with `--api`, `TARGET_API`, `KEYCLOAK_BASE`, `KEYCLOAK_ADMIN`,
`KEYCLOAK_ADMIN_PASSWORD`). `--target dev|pilot` reads the API URL from the `ApiUrl` output of
`seatrelay-app-<stage>` and the Cognito ids from `seatrelay-auth`, which needs AWS credentials
(`aws configure`, `AWS_PROFILE`, region `ap-southeast-1`). Without credentials every script
fails fast, before doing anything, with:

```
error: No AWS credentials were found. Configure them first (aws configure / AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, region ap-southeast-1); nothing was changed.
Pass --api <ApiUrl> (or set TARGET_API) to skip the CloudFormation lookup.
```

`--api`, `--pool-id` and `--client-id` bypass CloudFormation entirely; `--dry-run` prints the
plan of `create-test-users`, `seed-demo` and `seed-study` without any network call.

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
per VU; Keycloak ID tokens last 60 min, Cognito ones 1 h by default — mint again before a long
matrix.

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
   previous round's W1/W2/W3 and anything a participant created in O1. There is no delete route
   in the API, so cancelled workshops stay visible as CANCELLED in the organiser's list and old
   registrations of the persona appear as ENDED in "My registrations"; the live state is exact.
3. The dataset's workshops are created (`holdSeconds 1800`, sessions on the dates and
   Singapore times of the tables), confirmed people are REGISTERed on their single session and
   ACCEPT their offer, then the queue entries REGISTER in seq order with their preference
   lists.
4. The dashboard is compared with the table (capacity / confirmed / free per session, queue
   order and positions, no outstanding offer, distinct participants) and `/verify` must be ok;
   any difference exits non-zero and is printed.

`--json` prints the ids (org, workshops, sessions) for the facilitator sheet; `--dry-run` the
plan. The in-memory test (`test/study.test.ts`) drives the same code against
`@seatrelay/service` and checks the answer keys (T1 → OFFERED Tue, T2 → QUEUED #3/#4,
O2 → Hui Min / Oscar, O3 → Samuel / Quentin).

## Library (`src/lib`, exported from the package)

| Module | Exports |
| --- | --- |
| `api.ts` | `ApiClient` (typed routes, `sendCommand()` = POST + `GET /commands/{id}` polling with the plan §1.3 backoff 300 → 500 → 1000 → 2000 ms, 5 s after 30 s; returns client-observed and server-side settle latency), `ApiHttpError`, `expectApplied`, `pollDelayMs`. `fetch` is injectable. |
| `aws.ts` | `getStackOutputs`, `requireOutput`, `assertAwsCredentials` (fail fast), `STACKS`, `awsRegion`. |
| `cognito.ts` / `keycloak.ts` | `cognitoEnsureUser`, `cognitoInitiateAuth`, `resolveCognitoIds`; `KeycloakAdmin`, `keycloakPasswordGrant`, `REALM_USERS`. Both expose a `UserProvider`. |
| `users.ts` | `provisionUsers(provider, specs)` → accounts + ID tokens, `generatedUserSpecs`. |
| `targets.ts` | `resolveTarget` (API base per target), `userProviderFor`. |
| `tokenCache.ts` | read / write / merge of the cache; `findCachedUser`, `isTokenFresh`. |
| `seed.ts`, `seedDemo.ts`, `seedStudy.ts`, `study.ts` | the seeding primitives (`findOrCreateOrg`, `cancelOrgWorkshops`, `confirmSeat`, `joinQueue`) and the study tables. |
| `cli.ts` | `parseCli` (`node:util` parseArgs + `--help`), `runMain`, `log`, `REPO_ROOT`. |

## Checks

```bash
pnpm --filter @seatrelay/scripts typecheck
pnpm --filter @seatrelay/scripts test        # vitest: API client against the in-memory service, Cognito/CloudFormation with aws-sdk-client-mock, Keycloak with a fake fetch, study tables + seeding
```
