#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import type { CommandBody } from '@seatrelay/contracts';
import { ApiClient, type CommandInput } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import { answerMatches, statusOf, tamperToken } from './lib/httpProbe';
import { markdownTable, type CsvRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import { createWorkshop, ensureOrganisation, invariantSnapshot, myRegistration, type CreatedWorkshop } from './lib/scenario';
import { errorText, offerIdOf, trySend } from './lib/steps';

/**
 * Table 3 "Access control" (plan §4, C7, §2.8): negative cases only. Every probe states the
 * HTTP status (and error code) or the settled rejection reason it must produce:
 *
 * - no token / a tampered token → 401 on every authenticated route;
 * - a participant accepting / declining someone else's offer → REJECTED(OFFER_NOT_YOURS);
 * - an organiser of another organisation (and a plain participant) on the dashboard, export,
 *   verify, attendance, workshop list/creation, membership, PATCH and every organiser command
 *   (SET_CAPACITY, CANCEL_SESSION, CANCEL_WORKSHOP, CLOSE_REGISTRATION) → 403 FORBIDDEN;
 * - the victim's workshop addressed through the attacker's own organisation → 404;
 * - GET another user's command → 404 (the issuer and the workshop's organisers get 200);
 * - unknown workshop / command → 404; malformed command body → 400.
 *
 * Afterwards the workshop must be untouched (capacity, status, the victim's offer) and verify ok.
 */
const USAGE = `
access-control — Table 3 "Access control": 401 / 403 / 404 / OFFER_NOT_YOURS negative cases

  pnpm --filter @seatrelay/experiments access-control --target local|dev [--runs N]

Accounts: the organiser, the outsider (--outsider, organiser of another organisation) and
participants <prefix>-1 (victim) and <prefix>-2 (attacker).
`;

const ORG_NAME = 'SeatRelay experiments';
const OUTSIDER_ORG_NAME = 'SeatRelay experiments (outsider org)';

interface ProbeRow extends CsvRow {
  run: number;
  group: string;
  probe: string;
  who: string;
  method: string;
  path: string;
  expected: string;
  actual: string;
  ok: boolean;
}

async function runOnce(
  ctx: ExperimentContext,
  run: number,
  org: { id: string },
  outsiderOrg: { id: string },
  people: { organiser: Account; outsider: Account; victim: Account; attacker: Account },
  rows: ProbeRow[],
): Promise<void> {
  const { organiser, outsider, victim, attacker } = people;
  const timeout = ctx.options.settleTimeoutMs;
  const ws: CreatedWorkshop = await createWorkshop(organiser, org.id, {
    title: `Access control r${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: [{ capacity: 1 }, { capacity: 1 }],
  });
  const [s1, s2] = ws.sessionIds as [string, string];
  ctx.param(`run${run}.workshopId`, ws.wsId);
  const orgWs = `/orgs/${org.id}/workshops/${ws.wsId}`;

  const probe = async (group: string, name: string, who: string, client: ApiClient, method: string, path: string, expected: string, body?: unknown): Promise<boolean> => {
    const actual = await statusOf(client, method, path, body);
    const ok = answerMatches(expected, actual);
    rows.push({ run, group, probe: name, who, method, path, expected, actual, ok });
    ctx.check({ run, scenario: group, step: `${name} (${who}: ${method} ${path})`, ok, expected, actual });
    return ok;
  };
  const command = (input: CommandInput): CommandBody => ({ ...input, commandId: randomUUID() }) as CommandBody;

  // Setup: the victim holds an offer for S1 and has one settled command.
  const victimReg = await trySend(victim, ws.wsId, { type: 'REGISTER', acceptable: [s1] }, timeout);
  if (!victimReg.ok || victimReg.settled.record.result?.registration?.status !== 'OFFERED') {
    throw new Error(`setup: the victim's REGISTER did not produce an offer (${victimReg.ok ? victimReg.settled.record.status : errorText(victimReg.error)})`);
  }
  const victimOffer = offerIdOf(victimReg.settled);
  const victimCommandId = victimReg.settled.commandId;

  // 1. No token / tampered token → 401.
  const anonymous = ctx.anonymous;
  const tampered = new ApiClient({ baseUrl: ctx.target.apiBase, token: tamperToken(await victim.token()) });
  const authenticatedRoutes: [string, string, unknown?][] = [
    ['GET', '/me'],
    ['GET', '/me/registrations'],
    ['GET', '/me/notifications'],
    ['POST', `/workshops/${ws.wsId}/commands`, command({ type: 'REGISTER', acceptable: [s2] })],
    ['GET', `/commands/${victimCommandId}`],
    ['GET', `${orgWs}/dashboard`],
    ['GET', `${orgWs}/export.csv`],
    ['GET', `${orgWs}/verify`],
    ['POST', '/orgs', { name: 'should not exist' }],
    ['GET', `/orgs/${org.id}/workshops`],
  ];
  for (const [method, path, body] of authenticatedRoutes) {
    await probe('no token', 'missing token → 401', 'anonymous', anonymous, method, path, '401', body);
  }
  for (const [method, path, body] of authenticatedRoutes.slice(0, 6)) {
    await probe('no token', 'tampered token → 401', 'victim (bad signature)', tampered, method, path, '401', body);
  }
  await probe('no token', 'public health without a token', 'anonymous', anonymous, 'GET', '/health', '200');

  // 2. Someone else's offer → REJECTED(OFFER_NOT_YOURS).
  for (const type of ['ACCEPT_OFFER', 'DECLINE_OFFER'] as const) {
    const outcome = await trySend(attacker, ws.wsId, { type, offerId: victimOffer }, timeout);
    const actual = outcome.ok ? `${outcome.settled.record.status}${outcome.settled.record.reason === undefined ? '' : `(${outcome.settled.record.reason})`}` : `ERROR ${errorText(outcome.error)}`;
    const expected = 'REJECTED(OFFER_NOT_YOURS)';
    rows.push({ run, group: "someone else's offer", probe: `${type} of the victim's offer`, who: 'attacker', method: 'POST', path: `/workshops/${ws.wsId}/commands`, expected, actual, ok: actual === expected });
    ctx.check({ run, scenario: "someone else's offer", step: `attacker ${type} of the victim's offer`, ok: actual === expected, expected, actual });
  }
  const victimMe = await myRegistration(victim, ws.wsId);
  ctx.check({
    run, scenario: "someone else's offer", step: "the victim's offer is untouched",
    ok: victimMe?.status === 'OFFERED' && victimMe.currentOffer?.id === victimOffer, expected: `OFFERED ${victimOffer}`,
    actual: `${victimMe?.status ?? 'none'} ${victimMe?.currentOffer?.id ?? ''}`,
  });

  // 3. Cross-organisation organiser routes → 403 (outsider organiser and a plain participant).
  for (const [who, account] of [['outsider organiser', outsider], ['participant', attacker]] as const) {
    const client = account.client;
    const group = `cross-org (${who})`;
    await probe(group, 'dashboard', who, client, 'GET', `${orgWs}/dashboard`, '403 FORBIDDEN');
    await probe(group, 'CSV export', who, client, 'GET', `${orgWs}/export.csv`, '403 FORBIDDEN');
    await probe(group, 'verify', who, client, 'GET', `${orgWs}/verify`, '403 FORBIDDEN');
    await probe(group, 'attendance', who, client, 'PUT', `${orgWs}/attendance/${victim.userId}`, '403 FORBIDDEN', { attended: true });
    await probe(group, 'list workshops', who, client, 'GET', `/orgs/${org.id}/workshops`, '403 FORBIDDEN');
    await probe(group, 'create workshop', who, client, 'POST', `/orgs/${org.id}/workshops`, '403 FORBIDDEN', {
      title: 'intrusion', holdSeconds: 60,
      sessions: [
        { title: 'X1', startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 1 },
        { title: 'X2', startsAt: new Date(Date.now() + 90_000_000).toISOString(), capacity: 1 },
      ],
    });
    await probe(group, 'add self as member', who, client, 'POST', `/orgs/${org.id}/members`, '403 FORBIDDEN', { userId: account.userId });
    await probe(group, 'edit workshop', who, client, 'PATCH', `/workshops/${ws.wsId}`, '403 FORBIDDEN', { title: 'defaced' });
    const commandPath = `/workshops/${ws.wsId}/commands`;
    await probe(group, 'SET_CAPACITY', who, client, 'POST', commandPath, '403 FORBIDDEN', command({ type: 'SET_CAPACITY', sessionId: s1, capacity: 99 }));
    await probe(group, 'CANCEL_SESSION', who, client, 'POST', commandPath, '403 FORBIDDEN', command({ type: 'CANCEL_SESSION', sessionId: s2 }));
    await probe(group, 'CLOSE_REGISTRATION', who, client, 'POST', commandPath, '403 FORBIDDEN', command({ type: 'CLOSE_REGISTRATION' }));
    await probe(group, 'CANCEL_WORKSHOP', who, client, 'POST', commandPath, '403 FORBIDDEN', command({ type: 'CANCEL_WORKSHOP' }));
  }
  // The outsider's own organisation does not contain the victim's workshop.
  const viaOwnOrg = `/orgs/${outsiderOrg.id}/workshops/${ws.wsId}`;
  await probe('cross-org (own org path)', 'dashboard via own organisation', 'outsider organiser', outsider.client, 'GET', `${viaOwnOrg}/dashboard`, '404 NOT_FOUND');
  await probe('cross-org (own org path)', 'CSV export via own organisation', 'outsider organiser', outsider.client, 'GET', `${viaOwnOrg}/export.csv`, '404 NOT_FOUND');

  // 4. Another user's command → 404; issuer and organisers → 200.
  await probe('command visibility', "another participant reads the victim's command", 'attacker', attacker.client, 'GET', `/commands/${victimCommandId}`, '404 NOT_FOUND');
  await probe('command visibility', "an outsider organiser reads the victim's command", 'outsider organiser', outsider.client, 'GET', `/commands/${victimCommandId}`, '404 NOT_FOUND');
  await probe('command visibility', 'the issuer reads it', 'victim', victim.client, 'GET', `/commands/${victimCommandId}`, '200');
  await probe('command visibility', "the workshop's organiser reads it", 'organiser', organiser.client, 'GET', `/commands/${victimCommandId}`, '200');
  await probe('command visibility', 'unknown command', 'victim', victim.client, 'GET', `/commands/${randomUUID()}`, '404 NOT_FOUND');
  // Reusing the victim's commandId does not leak or overwrite it.
  await probe('command visibility', "re-POST of the victim's commandId by another user", 'attacker', attacker.client, 'POST', `/workshops/${ws.wsId}/commands`, '409 CONFLICT', {
    type: 'CANCEL_REGISTRATION', commandId: victimCommandId,
  });

  // 5. Unknown resources and malformed input.
  await probe('unknown / malformed', 'command on an unknown workshop', 'attacker', attacker.client, 'POST', `/workshops/${randomUUID()}/commands`, '404 NOT_FOUND', command({ type: 'REGISTER', acceptable: [s1] }));
  await probe('unknown / malformed', 'public view of an unknown workshop', 'attacker', attacker.client, 'GET', `/workshops/${randomUUID()}`, '404 NOT_FOUND');
  await probe('unknown / malformed', 'malformed command body', 'attacker', attacker.client, 'POST', `/workshops/${ws.wsId}/commands`, '400 VALIDATION_ERROR', { type: 'REGISTER', acceptable: 'S1', commandId: 'not-a-uuid' });
  await probe('unknown / malformed', 'unknown command type', 'attacker', attacker.client, 'POST', `/workshops/${ws.wsId}/commands`, '400 VALIDATION_ERROR', { type: 'TICK', commandId: randomUUID() });

  // 6. Nothing changed.
  const dash = await organiser.client.dashboard(org.id, ws.wsId);
  const session1 = dash.sessions.find((session) => session.id === s1);
  const session2 = dash.sessions.find((session) => session.id === s2);
  const untouched =
    dash.workshop.status === 'OPEN' &&
    dash.workshop.title === ws.view.workshop.title &&
    session1?.capacity === 1 &&
    session2?.status === 'OPEN' &&
    dash.offered.length === 1 &&
    dash.offered[0]?.userId === victim.userId &&
    dash.attendance.length === 0;
  ctx.check({
    run, scenario: 'after the attack', step: 'workshop untouched',
    ok: untouched, expected: 'OPEN, title unchanged, S1 capacity 1, S2 OPEN, only the victim offered, no attendance',
    actual: `${dash.workshop.status}, title ${dash.workshop.title === ws.view.workshop.title ? 'unchanged' : 'CHANGED'}, S1 capacity ${session1?.capacity}, S2 ${session2?.status}, offered ${dash.offered.map((entry) => (entry.userId === victim.userId ? 'victim' : entry.email)).join(',')}, attendance ${dash.attendance.length}`,
  });
  const orgNow = (await organiser.client.me()).organizations.find((candidate) => candidate.id === org.id);
  ctx.check({
    run, scenario: 'after the attack', step: 'organisation membership unchanged',
    ok: orgNow !== undefined && !orgNow.members.includes(outsider.userId) && !orgNow.members.includes(attacker.userId),
    expected: 'outsider and attacker not members', actual: orgNow === undefined ? 'organisation not visible' : `${orgNow.members.length} members`,
  });
  const inv = await invariantSnapshot(organiser, org.id, ws.wsId);
  ctx.check({
    run, scenario: 'after the attack', step: 'verify', ok: inv.ok, expected: 'verify ok',
    actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}`,
  });
}

runExperiment({
  name: 'access-control',
  tableRow: 'Access control (plan §4, Table 3; C7)',
  criterion: '401 without / with a tampered token; 403 on every cross-organisation organiser route and command; OFFER_NOT_YOURS for someone else\'s offer; 404 for another user\'s command; nothing changed',
  usage: USAGE,
  defaultHoldSeconds: 900,
  async run(ctx) {
    const organiser = await ctx.accounts.organiser();
    const outsider = await ctx.accounts.outsider();
    const [victim, attacker] = await ctx.accounts.participants(2);
    if (victim === undefined || attacker === undefined) {
      throw new Error('two participant accounts are required');
    }
    const org = await ensureOrganisation(organiser, ORG_NAME);
    const outsiderOrg = await ensureOrganisation(outsider, OUTSIDER_ORG_NAME);
    if (org.members.includes(outsider.userId) || org.members.includes(attacker.userId)) {
      throw new Error(`the outsider / attacker is a member of "${ORG_NAME}"; use other accounts (--outsider, --prefix)`);
    }
    ctx.param('orgId', org.id);
    ctx.param('outsiderOrgId', outsiderOrg.id);
    ctx.param('accounts', { organiser: organiser.email, outsider: outsider.email, victim: victim.email, attacker: attacker.email });

    const rows: ProbeRow[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      try {
        await runOnce(ctx, run, org, outsiderOrg, { organiser, outsider, victim, attacker }, rows);
      } catch (error) {
        ctx.fail('access-control', 'run aborted', error);
      }
    }
    const groups = [...new Set(rows.map((row) => row.group))];
    const lines = [
      '## Result',
      '',
      `- Negative probes: **${rows.filter((row) => row.ok).length}/${rows.length}** answered as expected`,
      '',
      markdownTable(
        ['group', 'probes', 'as expected', 'expected answers'],
        groups.map((group) => {
          const inGroup = rows.filter((row) => row.group === group);
          return [group, inGroup.length, inGroup.filter((row) => row.ok).length, [...new Set(inGroup.map((row) => row.expected))].join(', ')];
        }),
      ),
      '',
      '## Probes',
      '',
      markdownTable(
        ['run', 'group', 'probe', 'who', 'request', 'expected', 'actual', 'verdict'],
        rows.map((row) => [row.run, row.group, row.probe, row.who, `${row.method} ${row.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}')}`, row.expected, row.actual, row.ok ? 'PASS' : 'FAIL']),
      ),
    ];
    return {
      summary: lines.join('\n'),
      rows,
      ok: rows.length > 0 && rows.every((row) => row.ok),
      extra: { probes: rows.length, passed: rows.filter((row) => row.ok).length },
    };
  },
});
