#!/usr/bin/env tsx
import { ApiClient } from './lib/api';
import { CliError, enumOption, intOption, log, parseCli, runMain, stringOption } from './lib/cli';
import { renderStudyTable, seedStudy, studyAccounts, type SeededWorkshop } from './lib/seedStudy';
import {
  STUDY_DATASETS,
  STUDY_HOLD_SECONDS,
  STUDY_ORG_NAME,
  STUDY_TRACKS,
  studySessionStartsAt,
  studySessionTitle,
  studyState,
  type StudyWorkshopExpectation,
} from './lib/study';
import { parseTarget, resolveTarget, userProviderFor } from './lib/targets';
import { testPassword } from './lib/users';

const USAGE = `
seed-study — reset the SeatRelay state of one user-study round (tasks-participant.md §1 /
tasks-organiser.md §1). Re-running = reset: every workshop of the study organisation is
cancelled and the dataset's workshops are recreated exactly as specified.

  pnpm --filter @seatrelay/scripts seed-study -- --track participant|organiser --dataset A|B [--target local|dev]

Options
  --track TRACK          participant (W1/W2) or organiser (W3)           (required)
  --dataset A|B                                                           (required)
  --target NAME          local (compose stack) or dev|pilot; --stage is an alias (default local)
  --api URL              API base URL (default per target; TARGET_API also works)
  --password PASS        password of every study account (default $SEATRELAY_TEST_PASSWORD;
                         Passw0rd! on the local stack only)
  --org-name NAME        study organisation (default "NUS Data Club", owned by study.riley@)
  --concurrency N        parallel account provisioning (default 4)
  --pool-id / --client-id   Cognito ids (default: outputs of stack seatrelay-auth)
  --json                 print only the machine-readable summary on stdout
  --dry-run              print the plan; no network

Accounts: study.riley@example.com (organiser persona, owner of the organisation),
study.jordan@example.com (participant persona; exists, has no registration) and one
first.last@example.com account per dummy registrant. All use --password.
`;

runMain(async () => {
  const { values } = parseCli(
    {
      track: { type: 'string' },
      dataset: { type: 'string' },
      target: { type: 'string' },
      stage: { type: 'string' },
      api: { type: 'string' },
      password: { type: 'string' },
      'org-name': { type: 'string' },
      concurrency: { type: 'string' },
      'pool-id': { type: 'string' },
      'client-id': { type: 'string' },
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    USAGE,
  );
  if (values.track === undefined || values.dataset === undefined) {
    throw new CliError('--track and --dataset are required', { hint: USAGE.trim() });
  }
  const track = enumOption(values, 'track', STUDY_TRACKS, 'participant');
  const dataset = enumOption(values, 'dataset', STUDY_DATASETS, 'A');
  const targetName = parseTarget(stringOption(values, 'target') ?? stringOption(values, 'stage'));
  const password = testPassword(targetName, stringOption(values, 'password'));
  const orgName = stringOption(values, 'org-name', STUDY_ORG_NAME) as string;

  if (values['dry-run'] === true) {
    const state = studyState(track, dataset);
    const { riley, jordan, registrants } = studyAccounts(track, dataset, password);
    const plan = {
      dryRun: true,
      track,
      dataset,
      target: targetName,
      orgName,
      accounts: {
        organiser: riley.email,
        participant: jordan.email,
        registrants: registrants.map((spec) => spec.email),
      },
      workshops: state.workshops.map((workshop) => ({
        code: workshop.code,
        title: workshop.title,
        holdSeconds: STUDY_HOLD_SECONDS,
        sessions: workshop.sessions.map((spec) => ({
          key: spec.key,
          title: studySessionTitle(spec),
          startsAt: studySessionStartsAt(spec),
          capacity: spec.capacity,
          confirmed: spec.confirmed,
        })),
        queue: workshop.queue,
      })),
    };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
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

  const summary = await seedStudy({
    api: new ApiClient({ baseUrl: target.apiBase }),
    provider,
    track,
    dataset,
    password,
    orgName,
    concurrency: intOption(values, 'concurrency', 4),
    log,
  });

  if (values.json === true) {
    const { users: _users, expectations: _expectations, ...rest } = summary;
    process.stdout.write(
      `${JSON.stringify({ ...rest, target: target.name, apiBase: target.apiBase }, null, 2)}\n`,
    );
  } else {
    const lines = [
      `Seeded ${track} track, dataset ${dataset} on ${target.name} (${target.apiBase})`,
      `Organisation "${summary.orgName}" (${summary.orgId}), owner ${summary.accounts.organiser}; ${summary.cancelledWorkshops.length} previous workshop(s) cancelled`,
      ...summary.workshops.map((workshop: SeededWorkshop, i) =>
        renderStudyTable(summary.expectations[i] as StudyWorkshopExpectation, workshop),
      ),
      `Accounts: ${summary.accounts.participant} (no registration), ${summary.accounts.organiser}, ${summary.accounts.registrants.length} registrants — password ${password}`,
      `verify: ${summary.verify.map((v) => `${v.code} ${v.ok ? 'ok' : 'VIOLATIONS'}`).join(', ')}`,
      `Persona notifications marked read: ${summary.personaNotificationsMarkedRead} (earlier rounds stay listed under "Past"; the API cannot delete them)`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  if (summary.problems.length > 0) {
    throw new CliError(
      `seeded state differs from the task tables:\n  ${summary.problems.join('\n  ')}`,
    );
  }
});
