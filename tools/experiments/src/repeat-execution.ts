#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import type { CommandResultView, DashboardView, NotificationKind } from '@seatrelay/contracts';
import { ApiHttpError, intOption, type CommandInput } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import {
  commandBody,
  pollCommand,
  postConcurrently,
  settledFingerprint,
  type PostOutcome,
} from './lib/poll';
import { awaitRedelivery, describeRedelivery, type RedeliveryOutcome } from './lib/redelivery';
import { markdownTable, type CsvRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import { createWorkshop, ensureOrganisation, invariantSnapshot, type CreatedWorkshop } from './lib/scenario';
import { describeRegistration, errorText, notificationsIn, sessionLabeller, trySend } from './lib/steps';

/**
 * Table 3 "Repeat execution" (plan §4, C3): the same commandId POSTed N times (default 5)
 * concurrently must yield one command record that settles once (APPLIED or REJECTED), every
 * later GET returns the identical record, and the workshop shows the effect exactly once (one
 * registration / one confirmed seat / one released seat, one notification). With fault flags
 * (dev, and the local stack, both run with ALLOW_FAULT_FLAGS=true) `_fault: AFTER_COMMIT`
 * crashes the worker right after its commit: the redelivery must be acknowledged as already
 * settled, so the effects are still applied exactly once.
 */
const USAGE = `
repeat-execution — Table 3 "Repeat execution": duplicate commandIds and crash-after-commit redelivery

  pnpm --filter @seatrelay/experiments repeat-execution --target local|dev [--runs N] [--copies 5]
       [--faults auto|on|off] [--redelivery-wait S]

Accounts: <prefix>-1 … <prefix>-4. The AFTER_COMMIT cases wait for the redelivery (local:
commands row; dev: SQS visibility timeout 120 s, then the worker log lines).
`;

const ORG_NAME = 'SeatRelay experiments';

interface ProbeRow extends CsvRow {
  run: number;
  case: string;
  commandId: string;
  copies: number;
  accepted202: number;
  createdStatuses: string;
  finalStatus: string;
  reason: string;
  identicalReads: boolean;
  repostIdentical: boolean;
  effectCheck: string;
  effectOk: boolean;
  deliveries: string;
  ok: boolean;
}

interface Effects {
  seq: number;
  sessions: Record<string, { capacity: number; confirmed: number; held: number }>;
  backfills: Record<string, number>;
  live: Record<string, string>;
}

async function effects(organiser: Account, orgId: string, ws: CreatedWorkshop, people: readonly Account[]): Promise<Effects> {
  const dash: DashboardView = await organiser.client.dashboard(orgId, ws.wsId);
  const label = sessionLabeller(ws);
  const sessions: Effects['sessions'] = {};
  for (const session of dash.sessions) {
    sessions[label(session.id)] = { capacity: session.capacity, confirmed: session.confirmed, held: session.held };
  }
  const backfills: Record<string, number> = {};
  for (const record of dash.backfills) {
    backfills[record.cause] = (backfills[record.cause] ?? 0) + 1;
  }
  const live: Record<string, string> = {};
  for (const person of people) {
    const entries = [
      ...dash.queue.filter((entry) => entry.userId === person.userId).map((entry) => `QUEUED#${entry.queuePosition}`),
      ...dash.offered.filter((entry) => entry.userId === person.userId).map((entry) => `OFFERED@${label(entry.offer.sessionId)}`),
      ...dash.confirmed.filter((entry) => entry.userId === person.userId).map((entry) => `CONFIRMED@${label(entry.sessionId)}`),
    ];
    live[person.email] = entries.length === 0 ? 'none' : entries.join('+');
  }
  return { seq: dash.workshop.seq, sessions, backfills, live };
}

async function countNotifications(account: Account, wsId: string, kind: NotificationKind): Promise<number> {
  return (await notificationsIn(account, wsId)).filter((notification) => notification.kind === kind).length;
}

interface ProbeResult {
  commandId: string;
  record: CommandResultView | undefined;
  posts: PostOutcome[];
  identicalReads: boolean;
  repostIdentical: boolean;
}

/**
 * POSTs one commandId `copies` times at once, polls it to a terminal state, then reads it
 * `copies` times and re-POSTs it once more; every read must carry the identical settled record.
 */
async function duplicateProbe(
  ctx: ExperimentContext,
  run: number,
  name: string,
  account: Account,
  wsId: string,
  input: CommandInput,
  copies: number,
): Promise<ProbeResult> {
  const commandId = randomUUID();
  const body = commandBody(input, commandId);
  const startedAt = Date.now();
  const posts = await postConcurrently(account.client, wsId, body, copies);
  const ok202 = posts.filter((post) => post.ok && post.view.commandId === commandId).length;
  ctx.check({
    run, scenario: name, step: `${copies} concurrent POSTs of one commandId answered 202 with that commandId`,
    ok: ok202 === copies, expected: String(copies), actual: String(ok202),
    detail: posts.filter((post) => !post.ok).map((post) => (post.ok ? '' : errorText(post.error))).join('; ') || undefined,
  });
  let record: CommandResultView | undefined;
  try {
    record = (await pollCommand(account.client, commandId, { startedAt, timeoutMs: ctx.options.settleTimeoutMs })).record;
  } catch (error) {
    ctx.fail(name, 'poll to a terminal state', error, run);
    return { commandId, record: undefined, posts, identicalReads: false, repostIdentical: false };
  }
  const reference = settledFingerprint(record);
  const reads = await Promise.all(Array.from({ length: copies }, () => account.client.getCommand(commandId)));
  const identicalReads = reads.every((read) => settledFingerprint(read) === reference);
  ctx.check({
    run, scenario: name, step: `${copies} GETs return the identical settled record`,
    ok: identicalReads, expected: `${record.status} settledAt ${record.settledAt}`,
    actual: identicalReads ? 'identical' : reads.map((read) => `${read.status}@${read.settledAt}`).join(', '),
  });
  const repost = await account.client.postCommand(wsId, body);
  const repostIdentical = settledFingerprint(repost) === reference;
  ctx.check({
    run, scenario: name, step: 're-POST after settlement returns the settled record (no re-execution)',
    ok: repostIdentical, expected: `${record.status} settledAt ${record.settledAt}`, actual: `${repost.status} settledAt ${repost.settledAt}`,
  });
  return { commandId, record, posts, identicalReads, repostIdentical };
}

function probeRow(run: number, name: string, copies: number, probe: ProbeResult, effectCheck: string, effectOk: boolean, deliveries = ''): ProbeRow {
  return {
    run,
    case: name,
    commandId: probe.commandId,
    copies,
    accepted202: probe.posts.filter((post) => post.ok).length,
    createdStatuses: probe.posts.map((post) => (post.ok ? post.view.status : 'ERROR')).join('/'),
    finalStatus: probe.record?.status ?? 'UNSETTLED',
    reason: probe.record?.reason ?? '',
    identicalReads: probe.identicalReads,
    repostIdentical: probe.repostIdentical,
    effectCheck,
    effectOk,
    deliveries,
    ok: probe.record !== undefined && probe.identicalReads && probe.repostIdentical && effectOk,
  };
}

async function runOnce(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  people: { A: Account; B: Account; C: Account; D: Account },
  copies: number,
  rows: ProbeRow[],
): Promise<void> {
  const { A, B, C, D } = people;
  const everyone = [A, B, C, D];
  const timeout = ctx.options.settleTimeoutMs;
  const ws = await createWorkshop(organiser, orgId, {
    title: `Repeat execution r${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: [{ capacity: 1 }, { capacity: 2 }],
  });
  const label = sessionLabeller(ws);
  const [s1, s2] = ws.sessionIds as [string, string];
  ctx.param(`run${run}.workshopId`, ws.wsId);
  const effect = (name: string, ok: boolean, expected: string, actual: string): boolean =>
    ctx.check({ run, scenario: name, step: 'effect applied exactly once', ok, expected, actual });

  // 1. REGISTER ×N
  let before = await effects(organiser, orgId, ws, everyone);
  const register = await duplicateProbe(ctx, run, 'REGISTER ×N', A, ws.wsId, { type: 'REGISTER', acceptable: [s1] }, copies);
  let after = await effects(organiser, orgId, ws, everyone);
  let offers = await countNotifications(A, ws.wsId, 'OFFER');
  let ok = after.seq - before.seq === 1 && after.live[A.email] === 'OFFERED@S1' && offers === 1 && after.sessions.S1?.held === 1;
  let text = `seq +${after.seq - before.seq}, A ${after.live[A.email]}, S1 held ${after.sessions.S1?.held}, OFFER notifications ${offers}`;
  effect('REGISTER ×N', ok, 'seq +1, A OFFERED@S1, S1 held 1, 1 OFFER notification', text);
  rows.push(probeRow(run, 'REGISTER ×N', copies, register, text, ok));
  const offerId = register.record?.result?.registration?.currentOffer?.id ?? '';

  // 2. same commandId reused by another user → 409; by the same user with another body → the original record
  try {
    await C.client.postCommand(ws.wsId, commandBody({ type: 'REGISTER', acceptable: [s2] }, register.commandId));
    ctx.check({ run, scenario: 'commandId reuse', step: 'another user reusing a commandId', ok: false, expected: '409 CONFLICT', actual: '202' });
  } catch (error) {
    const status = error instanceof ApiHttpError ? `${error.status} ${error.code}` : errorText(error);
    ctx.check({ run, scenario: 'commandId reuse', step: 'another user reusing a commandId', ok: status === '409 CONFLICT', expected: '409 CONFLICT', actual: status });
  }
  const sameUserOtherBody = await A.client.postCommand(ws.wsId, commandBody({ type: 'CANCEL_REGISTRATION' }, register.commandId));
  ctx.check({
    run, scenario: 'commandId reuse', step: 'same user, same commandId, different body → the original record (idempotency key wins)',
    ok: sameUserOtherBody.type === 'REGISTER' && sameUserOtherBody.status === register.record?.status,
    expected: `REGISTER ${register.record?.status}`, actual: `${sameUserOtherBody.type} ${sameUserOtherBody.status}`,
  });
  const stillOffered = await effects(organiser, orgId, ws, everyone);
  ctx.check({ run, scenario: 'commandId reuse', step: 'no effect', ok: stillOffered.live[A.email] === 'OFFERED@S1', expected: 'A OFFERED@S1', actual: `A ${stillOffered.live[A.email]}` });

  // 3. ACCEPT ×N
  before = after;
  const accept = await duplicateProbe(ctx, run, 'ACCEPT ×N', A, ws.wsId, { type: 'ACCEPT_OFFER', offerId }, copies);
  after = await effects(organiser, orgId, ws, everyone);
  const confirmedNotes = await countNotifications(A, ws.wsId, 'CONFIRMED');
  ok = after.sessions.S1?.confirmed === 1 && after.sessions.S1?.held === 0 && confirmedNotes === 1 && accept.record?.status === 'APPLIED';
  text = `S1 confirmed ${after.sessions.S1?.confirmed} held ${after.sessions.S1?.held}, CONFIRMED notifications ${confirmedNotes}`;
  effect('ACCEPT ×N', ok, 'S1 confirmed 1, held 0, 1 CONFIRMED notification', text);
  rows.push(probeRow(run, 'ACCEPT ×N', copies, accept, text, ok));

  // 4. CANCEL ×N with B queued behind: one release, one relay
  const bQueued = await trySend(B, ws.wsId, { type: 'REGISTER', acceptable: [s1] }, timeout);
  ctx.check({
    run, scenario: 'CANCEL ×N', step: 'B queues behind A',
    ok: bQueued.ok && bQueued.settled.record.result?.registration?.status === 'QUEUED',
    expected: 'QUEUED#1', actual: bQueued.ok ? describeRegistration(bQueued.settled.record.result?.registration, label) : errorText(bQueued.error),
  });
  before = await effects(organiser, orgId, ws, everyone);
  const cancel = await duplicateProbe(ctx, run, 'CANCEL ×N', A, ws.wsId, { type: 'CANCEL_REGISTRATION' }, copies);
  after = await effects(organiser, orgId, ws, everyone);
  const bOffers = await countNotifications(B, ws.wsId, 'OFFER');
  ok =
    after.sessions.S1?.confirmed === 0 &&
    after.sessions.S1?.held === 1 &&
    (after.backfills.CANCELLED_CONFIRMED ?? 0) === 1 &&
    after.live[B.email] === 'OFFERED@S1' &&
    after.live[A.email] === 'none' &&
    bOffers === 1;
  text = `S1 confirmed ${after.sessions.S1?.confirmed} held ${after.sessions.S1?.held}, CANCELLED_CONFIRMED records ${after.backfills.CANCELLED_CONFIRMED ?? 0}, B ${after.live[B.email]} (${bOffers} OFFER notifications), A ${after.live[A.email]}`;
  effect('CANCEL ×N', ok, 'S1 confirmed 0 held 1, 1 CANCELLED_CONFIRMED record, B OFFERED@S1 once, A none', text);
  rows.push(probeRow(run, 'CANCEL ×N', copies, cancel, text, ok));

  // 5. DECLINE ×N (B lists S1 only → ENDED; one release)
  const bOffer = (await B.client.getWorkshop(ws.wsId)).me?.currentOffer?.id ?? '';
  const decline = await duplicateProbe(ctx, run, 'DECLINE ×N', B, ws.wsId, { type: 'DECLINE_OFFER', offerId: bOffer }, copies);
  after = await effects(organiser, orgId, ws, everyone);
  ok = after.sessions.S1?.held === 0 && (after.backfills.DECLINED ?? 0) === 1 && after.live[B.email] === 'none';
  text = `S1 held ${after.sessions.S1?.held}, DECLINED records ${after.backfills.DECLINED ?? 0}, B ${after.live[B.email]}`;
  effect('DECLINE ×N', ok, 'S1 held 0, 1 DECLINED record, B none', text);
  rows.push(probeRow(run, 'DECLINE ×N', copies, decline, text, ok));

  // 6. AFTER_COMMIT: the redelivery of an already committed command must not re-apply it
  if (!ctx.options.faults) {
    ctx.skip('AFTER_COMMIT', 'crash after commit + redelivery', 'fault flags off for this target (--faults off, or pilot)', run);
  } else {
    before = await effects(organiser, orgId, ws, everyone);
    const sinceMs = Date.now();
    const registerId = randomUUID();
    const reg = await trySend(D, ws.wsId, { type: 'REGISTER', acceptable: [s2], commandId: registerId, _fault: 'AFTER_COMMIT' }, timeout);
    const regCrashedAt = Date.now();
    const regRecord = reg.ok ? reg.settled.record : undefined;
    const dOffer = regRecord?.result?.registration?.currentOffer?.id ?? '';
    const acceptId = randomUUID();
    const acc = await trySend(D, ws.wsId, { type: 'ACCEPT_OFFER', offerId: dOffer, commandId: acceptId, _fault: 'AFTER_COMMIT' }, timeout);
    const accCrashedAt = Date.now();
    const accRecord = acc.ok ? acc.settled.record : undefined;
    ctx.check({
      run, scenario: 'AFTER_COMMIT', step: 'REGISTER and ACCEPT settle APPLIED on the first (crashing) delivery',
      ok: regRecord?.status === 'APPLIED' && accRecord?.status === 'APPLIED',
      expected: 'APPLIED, APPLIED',
      actual: `${reg.ok ? regRecord?.status : errorText(reg.error)}, ${acc.ok ? accRecord?.status : errorText(acc.error)}`,
    });
    const redeliveries: [string, RedeliveryOutcome][] = [];
    for (const [name, id, crashedAtMs] of [['REGISTER', registerId, regCrashedAt], ['ACCEPT', acceptId, accCrashedAt]] as const) {
      const outcome = await awaitRedelivery(ctx, id, { sinceMs, crashedAtMs });
      redeliveries.push([name, outcome]);
      if (outcome.deliveries !== undefined) {
        ctx.check({
          run, scenario: 'AFTER_COMMIT', step: `${name} was redelivered (the fault fired) and acknowledged`,
          ok: outcome.deliveries >= 2, expected: '≥ 2 deliveries', actual: describeRedelivery(outcome),
        });
      } else {
        ctx.skip('AFTER_COMMIT', `${name} delivery count`, describeRedelivery(outcome), run);
      }
    }
    after = await effects(organiser, orgId, ws, everyone);
    const dOffers = await countNotifications(D, ws.wsId, 'OFFER');
    const dConfirmed = await countNotifications(D, ws.wsId, 'CONFIRMED');
    const regAgain = await D.client.getCommand(registerId);
    const accAgain = await D.client.getCommand(acceptId);
    ok =
      after.seq - before.seq === 1 &&
      after.live[D.email] === 'CONFIRMED@S2' &&
      after.sessions.S2?.confirmed === 1 &&
      after.sessions.S2?.held === 0 &&
      dOffers === 1 &&
      dConfirmed === 1 &&
      regRecord !== undefined &&
      accRecord !== undefined &&
      settledFingerprint(regAgain) === settledFingerprint(regRecord) &&
      settledFingerprint(accAgain) === settledFingerprint(accRecord);
    text = `seq +${after.seq - before.seq}, D ${after.live[D.email]}, S2 confirmed ${after.sessions.S2?.confirmed} held ${after.sessions.S2?.held}, notifications OFFER ${dOffers} CONFIRMED ${dConfirmed}, records unchanged after redelivery: ${regRecord !== undefined && settledFingerprint(regAgain) === settledFingerprint(regRecord)}/${accRecord !== undefined && settledFingerprint(accAgain) === settledFingerprint(accRecord)}`;
    effect('AFTER_COMMIT', ok, 'seq +1, D CONFIRMED@S2, S2 confirmed 1 held 0, 1 OFFER + 1 CONFIRMED notification, records unchanged', text);
    const deliveries = redeliveries.map(([name, outcome]) => `${name}: ${outcome.deliveries ?? '?'}`).join(', ');
    for (const [name, record, id] of [['REGISTER (AFTER_COMMIT)', regRecord, registerId], ['ACCEPT (AFTER_COMMIT)', accRecord, acceptId]] as const) {
      rows.push({
        run, case: name, commandId: id, copies: 1, accepted202: record === undefined ? 0 : 1, createdStatuses: '',
        finalStatus: record?.status ?? 'UNSETTLED', reason: record?.reason ?? '', identicalReads: true, repostIdentical: true,
        effectCheck: text, effectOk: ok, deliveries, ok,
      });
    }
  }

  const inv = await invariantSnapshot(organiser, orgId, ws.wsId);
  ctx.check({
    run, scenario: 'final', step: 'verify',
    ok: inv.ok, expected: 'verify ok, overCapacity 0, doubleHolds 0',
    actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}, overCapacity ${inv.overCapacity}, doubleHolds ${inv.doubleHolds}`,
  });
}

runExperiment({
  name: 'repeat-execution',
  tableRow: 'Repeat execution (plan §4, Table 3; C3)',
  criterion: 'no double booking or double release: one command record, settled once (APPLIED once), identical on every read; AFTER_COMMIT redelivery applies nothing twice',
  usage: USAGE,
  defaultHoldSeconds: 900,
  options: { copies: { type: 'string' } },
  async run(ctx) {
    const copies = Math.max(2, intOption(ctx.values, 'copies', 5));
    const organiser = await ctx.accounts.organiser();
    const [A, B, C, D] = await ctx.accounts.participants(4);
    if (A === undefined || B === undefined || C === undefined || D === undefined) {
      throw new Error('four participant accounts are required');
    }
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);
    ctx.param('copies', copies);
    const rows: ProbeRow[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      try {
        await runOnce(ctx, run, org.id, organiser, { A, B, C, D }, copies, rows);
      } catch (error) {
        ctx.fail('repeat-execution', 'run aborted', error);
      }
    }
    const lines = [
      '## Result',
      '',
      `- Probes: ${rows.filter((row) => row.ok).length}/${rows.length} with one settled record, identical reads and the effect exactly once`,
      `- Fault flags: ${ctx.options.faults ? 'on (AFTER_COMMIT cases ran)' : 'off (AFTER_COMMIT cases skipped)'}`,
      '',
      '## Probes',
      '',
      markdownTable(
        ['run', 'case', 'POSTs → 202', '202 statuses', 'final', 'identical reads', 're-POST identical', 'deliveries', 'effect', 'verdict'],
        rows.map((row) => [
          row.run, row.case, `${row.copies} → ${row.accepted202}`, row.createdStatuses, `${row.finalStatus}${row.reason ? `(${row.reason})` : ''}`,
          row.identicalReads, row.repostIdentical, row.deliveries || '—', row.effectCheck, row.ok ? 'PASS' : 'FAIL',
        ]),
      ),
    ];
    return {
      summary: lines.join('\n'),
      rows,
      ok: rows.length > 0 && rows.every((row) => row.ok),
      extra: { probes: rows.length, passed: rows.filter((row) => row.ok).length, copies },
    };
  },
});
