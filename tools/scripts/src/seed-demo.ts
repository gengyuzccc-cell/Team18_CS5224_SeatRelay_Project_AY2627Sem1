#!/usr/bin/env tsx
import { ApiClient } from './lib/api';
import { CliError, intOption, log, parseCli, runMain, stringOption } from './lib/cli';
import { demoParticipants, demoWorkshopBody, seedDemo } from './lib/seedDemo';
import { parseTarget, resolveTarget, userProviderFor } from './lib/targets';
import { testPassword, type UserSpec } from './lib/users';

const USAGE = `
seed-demo — organisation + demo workshop (3 sessions, capacity 2/2/1) + N registered participants

  pnpm --filter @seatrelay/scripts seed-demo -- --target local|dev [options]

Options
  --target NAME          local (compose stack, Keycloak) or dev|pilot (Cognito); default local
  --api URL              API base URL (default: http://localhost:3000 for local, else the
                         ApiUrl output of stack seatrelay-app-<target>; TARGET_API also works)
  --organiser-email E    organiser account (default organiser@example.com on local,
                         demo.organiser@example.com otherwise); created when missing
  --participants X       N (demo.p1@… … demo.pN@…) or a comma-separated e-mail list
                         (default alice@,bob@,carol@example.com on local; 3 otherwise)
  --password PASS        password for accounts that must be created (default
                         $SEATRELAY_TEST_PASSWORD; Passw0rd! on the local stack only)
  --hold SECONDS         holdSeconds of the workshop (default 60; minimum 30)
  --org-name NAME        organisation name (default "SeatRelay Demo"; reused when it exists)
  --title TITLE          workshop title (default "Demo workshop")
  --starts-in-days D     first session starts in D days (default 3)
  --keep-previous        leave earlier workshops with the same title open (default: cancel
                         them, so a re-run yields one clean demo workshop)
  --pool-id / --client-id   Cognito ids (default: outputs of stack seatrelay-auth)
  --dry-run              print the plan only

Preference lists cycle through [S1,S2,S3] [S2,S3] [S3,S1] [S1] [S2,S1,S3] [S3], so with the
default three participants everybody holds an offer (S1, S2, S3) and a fourth would queue.
`;

runMain(async () => {
  const { values } = parseCli(
    {
      target: { type: 'string' },
      api: { type: 'string' },
      'organiser-email': { type: 'string' },
      participants: { type: 'string' },
      password: { type: 'string' },
      hold: { type: 'string' },
      'org-name': { type: 'string' },
      title: { type: 'string' },
      'starts-in-days': { type: 'string' },
      'keep-previous': { type: 'boolean' },
      'pool-id': { type: 'string' },
      'client-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    USAGE,
  );
  const targetName = parseTarget(stringOption(values, 'target'));
  const password = testPassword(targetName, stringOption(values, 'password'));
  const organiserEmail =
    stringOption(values, 'organiser-email') ??
    (targetName === 'local' ? 'organiser@example.com' : 'demo.organiser@example.com');
  const participants = demoParticipants(
    stringOption(values, 'participants') ??
      (targetName === 'local' ? 'alice@example.com,bob@example.com,carol@example.com' : '3'),
    password,
  );
  if (participants.length === 0) {
    throw new CliError('--participants resolved to nobody');
  }
  const organiser: UserSpec = { email: organiserEmail, password, name: 'Demo Organiser' };
  const preset = {
    orgName: stringOption(values, 'org-name', 'SeatRelay Demo') as string,
    title: stringOption(values, 'title', 'Demo workshop') as string,
    holdSeconds: intOption(values, 'hold', 60),
    startsInDays: intOption(values, 'starts-in-days', 3),
  };

  if (values['dry-run'] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          target: targetName,
          organiser: organiser.email,
          participants: participants.map((p) => p.email),
          orgName: preset.orgName,
          workshop: demoWorkshopBody(preset),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const apiFlag = stringOption(values, 'api');
  const target = await resolveTarget({
    target: targetName,
    ...(apiFlag === undefined ? {} : { api: apiFlag }),
  });
  log('target', { ...target });
  const poolId = stringOption(values, 'pool-id');
  const clientId = stringOption(values, 'client-id');
  const provider = await userProviderFor(target, {
    cognito: {
      ...(poolId === undefined ? {} : { userPoolId: poolId }),
      ...(clientId === undefined ? {} : { clientId }),
    },
  });

  const summary = await seedDemo({
    api: new ApiClient({ baseUrl: target.apiBase }),
    provider,
    organiser,
    participants,
    ...preset,
    keepPrevious: values['keep-previous'] === true,
    log,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        target: target.name,
        apiBase: target.apiBase,
        ...summary,
        organiser: { email: summary.organiser.email, password },
      },
      null,
      2,
    )}\n`,
  );
  if (!summary.verify) {
    throw new CliError('verify reported invariant violations on the demo workshop');
  }
});
