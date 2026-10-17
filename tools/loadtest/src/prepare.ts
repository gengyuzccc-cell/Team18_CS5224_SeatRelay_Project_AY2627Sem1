#!/usr/bin/env tsx
import type { CreateWorkshopInput } from '@seatrelay/contracts';
import {
  ApiClient,
  CliError,
  DAY_MS,
  DEFAULT_PASSWORD,
  HOUR_MS,
  findCachedUser,
  findOrCreateOrg,
  intOption,
  isoFromNow,
  isTokenFresh,
  log,
  parseCli,
  parseTarget,
  provisionUsers,
  readTokenCache,
  resolveTarget,
  runMain,
  stringOption,
  tokenCachePath,
  userProviderFor,
} from '@seatrelay/scripts';
import {
  readScenarioFile,
  SCENARIO_NAMES,
  scenarioFilePath,
  scenarioWorkshopIds,
  writeScenarioFile,
  type ScenarioFile,
} from './lib/scenario';

const USAGE = `
prepare — create the workshops the k6 scenarios use and write tools/loadtest/.scenario.<target>.json

  pnpm --filter @seatrelay/loadtest prepare-scenario -- --target local|dev [options]

Options
  --target NAME          local (compose stack) or dev|pilot (default local)
  --api URL              API base URL (default per target; TARGET_API also works)
  --scenario NAME        cross-workshop | hotspot | both (default both)
  --workshops N          workshops of the cross-workshop scenario (default 10; hotspot always 1)
  --capacity N           capacity of every session (default 1000)
  --hold SECONDS         holdSeconds (default 60)
  --sessions N           sessions per workshop (default 2, max 5)
  --starts-in-days D     first session starts in D days (default 7; the cut-off never hits)
  --organiser-email E    organiser account (default organiser@example.com on local,
                         loadtest.organiser@example.com otherwise). Its token is taken from the
                         token cache when present, otherwise minted (account created if missing)
  --password PASS        password for minting/creating the organiser (default Passw0rd!)
  --org-name NAME        organisation (default "SeatRelay loadtest"; reused when it exists)
  --token-cache FILE     token cache (default tools/loadtest/.token-cache.<target>.json)
  --scenario-file FILE   output (default tools/loadtest/.scenario.<target>.json)
  --keep-previous        do not CANCEL_WORKSHOP the workshops of the previous scenario file
  --pool-id / --client-id   Cognito ids (dev; default: outputs of stack seatrelay-auth)
`;

runMain(async () => {
  const { values } = parseCli(
    {
      target: { type: 'string' },
      api: { type: 'string' },
      scenario: { type: 'string' },
      workshops: { type: 'string' },
      capacity: { type: 'string' },
      hold: { type: 'string' },
      sessions: { type: 'string' },
      'starts-in-days': { type: 'string' },
      'organiser-email': { type: 'string' },
      password: { type: 'string' },
      'org-name': { type: 'string' },
      'token-cache': { type: 'string' },
      'scenario-file': { type: 'string' },
      'keep-previous': { type: 'boolean' },
      'pool-id': { type: 'string' },
      'client-id': { type: 'string' },
    },
    USAGE,
  );
  const targetName = parseTarget(stringOption(values, 'target'));
  const scenarioChoice = stringOption(values, 'scenario', 'both') as string;
  const scenarios =
    scenarioChoice === 'both'
      ? [...SCENARIO_NAMES]
      : SCENARIO_NAMES.filter((name) => name === scenarioChoice);
  if (scenarios.length === 0) {
    throw new CliError(`--scenario must be ${SCENARIO_NAMES.join('|')}|both`);
  }
  const crossCount = intOption(values, 'workshops', 10);
  const capacity = intOption(values, 'capacity', 1000);
  const holdSeconds = intOption(values, 'hold', 60);
  const sessionsPerWorkshop = intOption(values, 'sessions', 2);
  const startsInDays = intOption(values, 'starts-in-days', 7);
  const password = stringOption(values, 'password', DEFAULT_PASSWORD) as string;
  const organiserEmail =
    stringOption(values, 'organiser-email') ??
    (targetName === 'local' ? 'organiser@example.com' : 'loadtest.organiser@example.com');
  const orgName = stringOption(values, 'org-name', 'SeatRelay loadtest') as string;
  const cacheFile = tokenCachePath(targetName, stringOption(values, 'token-cache'));
  const scenarioFile = scenarioFilePath(targetName, stringOption(values, 'scenario-file'));

  const apiFlag = stringOption(values, 'api');
  const target = await resolveTarget({
    target: targetName,
    ...(apiFlag === undefined ? {} : { api: apiFlag }),
  });
  log('target', { ...target });

  // Organiser token: from the cache when fresh, otherwise minted (and the account created).
  let organiserToken: string | undefined;
  try {
    const cache = readTokenCache(cacheFile);
    const cached = findCachedUser(cache, organiserEmail);
    if (cached !== undefined && isTokenFresh(cached)) {
      organiserToken = cached.idToken;
      log('organiser token from cache', { email: organiserEmail, file: cacheFile });
    }
  } catch {
    organiserToken = undefined;
  }
  if (organiserToken === undefined) {
    const poolId = stringOption(values, 'pool-id');
    const clientId = stringOption(values, 'client-id');
    const provider = await userProviderFor(target, {
      cognito: {
        ...(poolId === undefined ? {} : { userPoolId: poolId }),
        ...(clientId === undefined ? {} : { clientId }),
      },
    });
    const [user] = await provisionUsers(provider, [
      { email: organiserEmail, password, name: 'Loadtest Organiser' },
    ]);
    if (user === undefined) {
      throw new CliError(`could not mint a token for ${organiserEmail}`);
    }
    organiserToken = user.idToken;
    log('organiser token minted', {
      email: organiserEmail,
      provider: provider.kind,
      created: user.created,
    });
  }

  const api = new ApiClient({ baseUrl: target.apiBase });
  const organiser = api.withToken(organiserToken);
  const { organization } = await findOrCreateOrg(organiser, orgName, log);

  const previous = readScenarioFile(scenarioFile);
  if (previous !== undefined && values['keep-previous'] !== true) {
    for (const wsId of scenarioWorkshopIds(previous)) {
      try {
        const settled = await organiser.sendCommand(
          wsId,
          { type: 'CANCEL_WORKSHOP' },
          { timeoutMs: 30_000 },
        );
        log('previous workshop cancelled', {
          workshopId: wsId,
          status: settled.record.status,
          reason: settled.record.reason,
        });
      } catch (error) {
        log('previous workshop not cancelled (ignored)', {
          workshopId: wsId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result: ScenarioFile = {
    target: target.name,
    apiBase: target.apiBase,
    createdAt: new Date().toISOString(),
    organiserEmail,
    orgId: organization.id,
    scenarios: {},
    workshops: {},
  };
  for (const scenario of scenarios) {
    const count = scenario === 'hotspot' ? 1 : crossCount;
    const ids: string[] = [];
    for (let k = 1; k <= count; k += 1) {
      const body: CreateWorkshopInput = {
        title: `loadtest ${scenario} #${k} ${stamp}`,
        description: `k6 ${scenario} workshop (capacity ${capacity}, hold ${holdSeconds} s).`,
        mode: 'UNIFIED',
        holdSeconds,
        sessions: Array.from({ length: Math.min(5, Math.max(2, sessionsPerWorkshop)) }, (_, i) => ({
          title: `Session ${i + 1}`,
          startsAt: isoFromNow(startsInDays * DAY_MS + i * 4 * HOUR_MS),
          capacity,
        })),
      };
      const created = await organiser.createWorkshop(organization.id, body);
      ids.push(created.workshop.id);
      result.workshops[created.workshop.id] = {
        title: body.title,
        sessionIds: created.sessions.map((session) => session.id),
        capacity,
        holdSeconds,
      };
    }
    result.scenarios[scenario] = { workshopIds: ids };
    log('workshops created', { scenario, count: ids.length });
  }
  writeScenarioFile(scenarioFile, result);
  log('scenario file written', { file: scenarioFile });
  process.stdout.write(
    `${JSON.stringify(
      {
        target: target.name,
        apiBase: target.apiBase,
        orgId: organization.id,
        scenarioFile,
        scenarios: Object.fromEntries(
          Object.entries(result.scenarios).map(([name, entry]) => [name, entry.workshopIds.length]),
        ),
      },
      null,
      2,
    )}\n`,
  );
});
