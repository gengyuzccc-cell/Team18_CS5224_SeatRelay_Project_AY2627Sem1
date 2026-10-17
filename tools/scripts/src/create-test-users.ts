#!/usr/bin/env tsx
import {
  assertCognitoAdminCredentials,
  COGNITO_ADMIN_HINT,
  cognitoUserProvider,
  resolveCognitoIds,
} from './lib/cognito';
import { fail, intOption, log, parseCli, runMain, stringOption } from './lib/cli';
import {
  mergeTokenCache,
  readTokenCache,
  tokenCachePath,
  writeTokenCache,
  type TokenCache,
} from './lib/tokenCache';
import { generatedUserSpecs, provisionUsers, testPassword, toCacheUser } from './lib/users';

const USAGE = `
create-test-users — Cognito test accounts + ID token cache for k6 / experiments (plan §3 step 14)

  SEATRELAY_TEST_PASSWORD=<private> pnpm --filter @seatrelay/scripts create-test-users -- --count 60 [options]

Options
  --count N            number of accounts (required)
  --prefix NAME        e-mail local-part prefix (default loaduser): loaduser-1@…, loaduser-2@…
  --domain DOMAIN      e-mail domain (default example.com)
  --password PASS      permanent password for every account (default $SEATRELAY_TEST_PASSWORD;
                       Cognito policy applies; the public local default is refused here)
  --stage STAGE        stage of the token cache file (default dev; --target is an alias)
  --pool-id ID         Cognito user pool id (default: output UserPoolId of stack seatrelay-auth)
  --client-id ID       tooling app client id (default: output ToolingClientId of seatrelay-auth)
  --region REGION      AWS region (default AWS_REGION / ap-southeast-1)
  --cache FILE         cache file (default tools/loadtest/.token-cache.<stage>.json)
  --concurrency N      parallel Cognito calls (default 5)
  --no-create          only mint tokens (accounts must exist with a permanent password)
  --dry-run            print the plan; no AWS call

Accounts are created with AdminCreateUser (MessageAction SUPPRESS, no e-mail) and
AdminSetUserPassword (permanent); UsernameExistsException is fine (idempotent). Tokens are
minted with InitiateAuth USER_PASSWORD_AUTH on the tooling client (plain HTTPS JSON call).
`;

runMain(async () => {
  const { values } = parseCli(
    {
      count: { type: 'string' },
      prefix: { type: 'string' },
      domain: { type: 'string' },
      password: { type: 'string' },
      stage: { type: 'string' },
      target: { type: 'string' },
      'pool-id': { type: 'string' },
      'client-id': { type: 'string' },
      region: { type: 'string' },
      cache: { type: 'string' },
      concurrency: { type: 'string' },
      'no-create': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    USAGE,
  );
  const count = intOption(values, 'count', 0);
  if (count < 1) {
    fail('--count must be ≥ 1', USAGE.trim());
  }
  const stage = stringOption(values, 'stage') ?? stringOption(values, 'target') ?? 'dev';
  const password = testPassword(stage, stringOption(values, 'password'));
  const specs = generatedUserSpecs({
    count,
    prefix: stringOption(values, 'prefix', 'loaduser') as string,
    domain: stringOption(values, 'domain', 'example.com') as string,
    password,
  });
  const cacheFile = tokenCachePath(stage, stringOption(values, 'cache'));
  const create = values['no-create'] !== true;

  if (values['dry-run'] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          stage,
          cacheFile,
          create,
          users: specs.map((spec) => spec.email),
          cognito: {
            userPoolId: stringOption(values, 'pool-id') ?? '(from stack seatrelay-auth)',
            clientId: stringOption(values, 'client-id') ?? '(from stack seatrelay-auth)',
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const ids = await resolveCognitoIds({
    ...(stringOption(values, 'pool-id') === undefined
      ? {}
      : { userPoolId: stringOption(values, 'pool-id') }),
    ...(stringOption(values, 'client-id') === undefined
      ? {}
      : { clientId: stringOption(values, 'client-id') }),
    ...(stringOption(values, 'region') === undefined
      ? {}
      : { region: stringOption(values, 'region') }),
  });
  log('cognito resolved', { ...ids });
  if (create) {
    await assertCognitoAdminCredentials(
      ids.region,
      undefined,
      `${COGNITO_ADMIN_HINT} To only mint tokens for accounts that already exist, pass --no-create (with --pool-id and --client-id no AWS call is made at all).`,
    );
  }
  const provider = cognitoUserProvider(ids);

  let created = 0;
  const users = await provisionUsers(provider, specs, {
    create,
    concurrency: intOption(values, 'concurrency', 5),
    onUser: (user, index) => {
      created += user.created ? 1 : 0;
      if ((index + 1) % 10 === 0 || index + 1 === specs.length) {
        log(`provisioned ${index + 1}/${specs.length}`);
      }
    },
  });

  let existing: TokenCache | undefined;
  try {
    existing = readTokenCache(cacheFile);
  } catch {
    existing = undefined;
  }
  const cache = mergeTokenCache(existing, users.map(toCacheUser), {
    target: stage,
    issuer: provider.issuer,
  });
  writeTokenCache(cacheFile, cache);
  const soonest = users.map((user) => user.expiresAt).sort()[0];
  log('token cache written', {
    file: cacheFile,
    users: cache.users.length,
    created,
    minted: users.length,
    firstExpiry: soonest,
  });
  process.stdout.write(
    `${JSON.stringify({ stage, cacheFile, users: users.length, created, firstExpiry: soonest })}\n`,
  );
});
