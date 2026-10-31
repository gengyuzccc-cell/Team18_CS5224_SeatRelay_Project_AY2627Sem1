#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import { ApiClient } from './lib/api';
import { backfillsFileName, exportBackfills } from './lib/backfills';
import {
  CliError,
  log,
  parseCli,
  RESULTS_DIR,
  resolveUserPath,
  runMain,
  stringOption,
} from './lib/cli';
import { parseTarget, resolveTarget, userProviderFor } from './lib/targets';
import { testPassword } from './lib/users';

const USAGE = `
dashboard-backfills — export the organiser dashboard's backfill log of one or more workshops
as backfills-<wsId>.csv (columns cause,session,releasedAt,reallocatedAt,latencyMs,
recomputedMs,newParticipant,backfillId; the same file the pilot rehearsal writes). After the
real pilot, run it as the organiser and keep the files in results/pilot/ next to the CSV
exports (SUBMISSION-CHECKLIST row 1.4); report_numbers.py reads them for \\PilotBackfills.

  pnpm --filter @seatrelay/scripts dashboard-backfills -- --target pilot --organiser-email E [options]

Options
  --target NAME          local (compose stack, Keycloak) or dev|pilot (Cognito); default local
  --api URL              API base URL (default: http://localhost:3000 for local, else the
                         ApiUrl output of stack seatrelay-app-<target>; TARGET_API also works)
  --organiser-email E    the organiser account (must exist; no account is created)   (required)
  --password PASS        its password (default $SEATRELAY_TEST_PASSWORD; Passw0rd! on the
                         local stack only)
  --org-id ID            organisation (default: the organiser's only organisation; required
                         when the account belongs to several)
  --workshop ID          workshop id; repeatable (default: every workshop of the organisation)
  --out DIR              output directory (default results/pilot)
  --pool-id / --client-id   Cognito ids (default: outputs of stack seatrelay-auth)

Prints one JSON summary per workshop (file, rows, reallocated) on stdout.
newParticipant holds the new holder's opaque user id, not the e-mail.
`;

runMain(async () => {
  const { values } = parseCli(
    {
      target: { type: 'string' },
      api: { type: 'string' },
      'organiser-email': { type: 'string' },
      password: { type: 'string' },
      'org-id': { type: 'string' },
      workshop: { type: 'string', multiple: true },
      out: { type: 'string' },
      'pool-id': { type: 'string' },
      'client-id': { type: 'string' },
    },
    USAGE,
  );
  const targetName = parseTarget(stringOption(values, 'target'));
  const organiserEmail = stringOption(values, 'organiser-email');
  if (organiserEmail === undefined) {
    throw new CliError('--organiser-email is required', { hint: USAGE.trim() });
  }
  const password = testPassword(targetName, stringOption(values, 'password'));
  const outDir =
    values.out === undefined
      ? path.join(RESULTS_DIR, 'pilot')
      : resolveUserPath(String(values.out));
  const wanted: unknown = values.workshop;
  const workshopIds = Array.isArray(wanted) ? wanted.map(String) : [];

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
  const minted = await provider.mintIdToken(organiserEmail, password);
  const client = new ApiClient({ baseUrl: target.apiBase, token: minted.idToken });

  const me = await client.me();
  const orgFlag = stringOption(values, 'org-id');
  const organization =
    orgFlag === undefined
      ? me.organizations.length === 1
        ? me.organizations[0]
        : undefined
      : me.organizations.find((org) => org.id === orgFlag);
  if (organization === undefined) {
    const names = me.organizations.map((org) => `${org.id} (${org.name})`).join(', ');
    throw new CliError(
      orgFlag === undefined
        ? `${organiserEmail} belongs to ${me.organizations.length} organisations; pass --org-id`
        : `${organiserEmail} is not a member of organisation ${orgFlag}`,
      { hint: names.length > 0 ? `organisations: ${names}` : 'no organisations' },
    );
  }
  const ids =
    workshopIds.length > 0
      ? workshopIds
      : (await client.listWorkshops(organization.id)).workshops.map((workshop) => workshop.id);
  if (ids.length === 0) {
    throw new CliError(`organisation ${organization.id} has no workshops`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const wsId of ids) {
    const exported = await exportBackfills(client, organization.id, wsId);
    const file = path.join(outDir, backfillsFileName(wsId));
    fs.writeFileSync(file, exported.csv);
    log('written', { wsId, title: exported.title, rows: exported.rows.length });
    process.stdout.write(
      `${JSON.stringify({
        target: target.name,
        orgId: organization.id,
        wsId,
        title: exported.title,
        file: path.relative(process.cwd(), file),
        rows: exported.rows.length,
        reallocated: exported.rows.filter((row) => row.reallocatedAt !== '').length,
      })}\n`,
    );
  }
});
