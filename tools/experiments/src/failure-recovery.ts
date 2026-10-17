#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import type { DashboardView, FaultFlag, NotificationView } from '@seatrelay/contracts';
import { intOption, mapWithConcurrency } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import {
  awaitRedelivery,
  describeRedelivery,
  recordRedeliveryCheck,
  redeliveryOk,
  traceText,
  type RedeliveryOutcome,
} from './lib/redelivery';
import { markdownTable, summarize, type CsvRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  createWorkshop,
  ensureOrganisation,
  invariantSnapshot,
  myRegistration,
  sleep,
  waitFor,
  type CreatedWorkshop,
} from './lib/scenario';
import { describeRegistration, errorText, notificationsIn, sessionLabeller, trySend } from './lib/steps';

/**
 * Table 3 "Failure recovery" (plan §4, §2.4):
 *
 * - `_fault: BEFORE_COMMIT` (crash before the transaction): nothing is written, the message is
 *   redelivered and the command settles exactly once;
 * - `_fault: AFTER_COMMIT` (crash after the transaction): the record is already settled, the
 *   redelivery is acknowledged as COMMAND_ALREADY_SETTLED, effects exactly once;
 * - `_fault: TIMER_SEND` (crash while scheduling the expiry timer, before the commit): the
 *   redelivery schedules the timer and commits; the offer it created still expires on time
 *   through the timer path (not the 5-minute sweep) and is relayed to the next person;
 * - notifier outage (dev/pilot only): reserved concurrency 0 on the notifier function
 *   (PutFunctionConcurrency), notifications are generated and stay PENDING, concurrency is
 *   restored, and the time until every backlog notification is SENT / SKIPPED / FAILED is
 *   measured (target < 5 min). On the local stack the notifier is an in-process loop that cannot
 *   be stopped from outside: documented and skipped; only the no-outage baseline is measured.
 *
 * Every fault case records how the redelivery was observed (local: `commands` row deliveries;
 * AWS: worker log lines via Logs Insights, written to raw.csv `trace` and summary.md) so that
 * recovery is traceable; on AWS a redelivery the logs do not show fails the case. On AWS the
 * BEFORE_COMMIT / TIMER_SEND commands can only settle on the redelivery, so their server
 * settle time must also span the commands queue's visibility timeout. The dead-letter queues /
 * FAILED rows must stay empty.
 */
const USAGE = `
failure-recovery — Table 3 "Failure recovery": injected crashes and a notifier outage

  pnpm --filter @seatrelay/experiments failure-recovery --target local|dev [--runs N]
       [--hold 60] [--outage 60] [--notifications 10] [--recovery-limit 300]
       [--faults auto|on|off] [--redelivery-wait S]

--outage S            dev/pilot: how long the notifier stays at reserved concurrency 0 (default 60)
--notifications N     notifications generated during the outage / for the baseline (default 10)
--recovery-limit S    notifier recovery target and polling limit after the restore (default 300)
Accounts: <prefix>-1 … <prefix>-max(4, N+1). Each fault run needs about --hold + 20 s (local)
or 2 × the 120 s SQS visibility timeout + --hold (dev).
`;

const ORG_NAME = 'SeatRelay experiments';
const TERMINAL_NOTIFICATION = new Set(['SENT', 'SKIPPED', 'FAILED']);

interface FaultRow extends CsvRow {
  run: number;
  fault: FaultFlag;
  command: string;
  commandId: string;
  workshopId: string;
  status: string;
  reason: string;
  /** settledAt − acceptedAt: includes the redelivery delay for BEFORE_COMMIT / TIMER_SEND. */
  serverSettleMs: number | undefined;
  clientSettleMs: number | undefined;
  deliveries: number | undefined;
  redelivery: string;
  /** Delivery trace (local `commands` row / AWS worker log lines). */
  trace: string;
  effect: string;
  effectOk: boolean;
  ok: boolean;
}

interface NotifierRow extends CsvRow {
  run: number;
  phase: 'baseline' | 'outage';
  notifications: number;
  pendingAtRestore: number | undefined;
  /** Seconds from the restore (outage) or from the settlement (baseline) to the last one processed. */
  recoverySeconds: number | undefined;
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
  detail: string;
  ok: boolean;
}

interface WorkshopCounts {
  seq: number;
  held: number;
  confirmed: number;
  backfills: number;
}

function countsOf(dash: DashboardView, sessionId: string): WorkshopCounts {
  const session = dash.sessions.find((candidate) => candidate.id === sessionId);
  return { seq: dash.workshop.seq, held: session?.held ?? -1, confirmed: session?.confirmed ?? -1, backfills: dash.backfills.length };
}

async function kindCount(account: Account, wsId: string, kind: NotificationView['kind']): Promise<number> {
  return (await notificationsIn(account, wsId)).filter((notification) => notification.kind === kind).length;
}

function serverMs(acceptedAt: string | undefined, settledAt: string | undefined): number | undefined {
  return acceptedAt === undefined || settledAt === undefined ? undefined : Date.parse(settledAt) - Date.parse(acceptedAt);
}

/** Records the redelivery observation (a skip on local without psql, a failure on AWS). */
function recordRedelivery(ctx: ExperimentContext, run: number, fault: FaultFlag, outcome: RedeliveryOutcome): boolean {
  return recordRedeliveryCheck(ctx, {
    run,
    scenario: fault,
    step: 'the crashed delivery was redelivered and acknowledged (traceable)',
    outcome,
  });
}

/** SQS visibility timeout of the commands FIFO (services/aws/templates/app.yaml). */
export const COMMANDS_VISIBILITY_TIMEOUT_MS = 120_000;

/**
 * AWS: a BEFORE_COMMIT / TIMER_SEND command commits only on its redelivery, which SQS makes
 * visible again after the visibility timeout; a server settle far below it means the fault
 * did not fire (e.g. `_fault` stripped by the API).
 */
function recordSettledOnRedelivery(
  ctx: ExperimentContext,
  run: number,
  fault: FaultFlag,
  serverSettleMs: number | undefined,
): boolean {
  if (ctx.ops.kind !== 'aws') {
    return true;
  }
  const minMs = Math.round(COMMANDS_VISIBILITY_TIMEOUT_MS * 0.8);
  const ok = serverSettleMs !== undefined && serverSettleMs >= minMs;
  ctx.check({
    run, scenario: fault, step: 'settled only on the redelivery (server settle spans the visibility timeout)',
    ok, expected: `settledAt − acceptedAt ≥ ${minMs} ms (visibility timeout ${COMMANDS_VISIBILITY_TIMEOUT_MS / 1000} s)`,
    actual: serverSettleMs === undefined ? 'not settled' : `${serverSettleMs} ms`,
  });
  return ok;
}

async function faultRun(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  people: { A: Account; B: Account; C: Account; D: Account },
  rows: FaultRow[],
): Promise<void> {
  const { A, B, C, D } = people;
  const timeout = ctx.options.settleTimeoutMs;
  const ws: CreatedWorkshop = await createWorkshop(organiser, orgId, {
    title: `Failure recovery r${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: [{ capacity: 1 }, { capacity: 1 }],
  });
  const label = sessionLabeller(ws);
  const [s1, s2] = ws.sessionIds as [string, string];
  ctx.param(`run${run}.workshopId`, ws.wsId);
  const dashboard = () => organiser.client.dashboard(orgId, ws.wsId);
  const sinceMs = Date.now();

  // ---- BEFORE_COMMIT: A registers for S2; the first delivery crashes before the transaction.
  {
    const before = countsOf(await dashboard(), s2);
    const commandId = randomUUID();
    const postedAt = Date.now();
    const sent = await trySend(A, ws.wsId, { type: 'REGISTER', acceptable: [s2], commandId, _fault: 'BEFORE_COMMIT' }, timeout);
    const record = sent.ok ? sent.settled.record : undefined;
    // The settlement already required the redelivery: count the wait from the POST.
    const redelivery = await awaitRedelivery(ctx, commandId, { sinceMs, crashedAtMs: postedAt });
    const after = countsOf(await dashboard(), s2);
    const offers = await kindCount(A, ws.wsId, 'OFFER');
    const effectOk = after.seq - before.seq === 1 && after.held === 1 && offers === 1 && record?.result?.registration?.status === 'OFFERED';
    const effect = `seq +${after.seq - before.seq}, S2 held ${after.held}, OFFER notifications ${offers}, A ${describeRegistration(record?.result?.registration, label)}`;
    ctx.check({
      run, scenario: 'BEFORE_COMMIT', step: 'REGISTER settles APPLIED after the redelivery',
      ok: record?.status === 'APPLIED', expected: 'APPLIED',
      actual: sent.ok ? `${record?.status} after ${sent.settled.settleMs} ms (server ${sent.settled.serverSettleMs ?? '?'} ms)` : errorText(sent.error),
    });
    recordRedelivery(ctx, run, 'BEFORE_COMMIT', redelivery);
    const serverSettleMs = serverMs(record?.acceptedAt, record?.settledAt);
    const onRedelivery = recordSettledOnRedelivery(ctx, run, 'BEFORE_COMMIT', serverSettleMs);
    ctx.check({ run, scenario: 'BEFORE_COMMIT', step: 'effect applied exactly once', ok: effectOk, expected: 'seq +1, S2 held 1, 1 OFFER notification, A OFFERED@S2', actual: effect });
    rows.push({
      run, fault: 'BEFORE_COMMIT', command: 'REGISTER', commandId, workshopId: ws.wsId,
      status: record?.status ?? 'UNSETTLED', reason: record?.reason ?? (sent.ok ? '' : errorText(sent.error)),
      serverSettleMs, clientSettleMs: sent.ok ? sent.settled.settleMs : undefined,
      deliveries: redelivery.deliveries, redelivery: describeRedelivery(redelivery), trace: traceText(redelivery), effect, effectOk,
      ok: record?.status === 'APPLIED' && effectOk && onRedelivery && redeliveryOk(ctx.ops.kind, redelivery),
    });
  }

  // ---- AFTER_COMMIT: A accepts; the first delivery crashes right after the transaction.
  {
    const offerId = (await myRegistration(A, ws.wsId))?.currentOffer?.id ?? 'missing';
    const commandId = randomUUID();
    const sent = await trySend(A, ws.wsId, { type: 'ACCEPT_OFFER', offerId, commandId, _fault: 'AFTER_COMMIT' }, timeout);
    const record = sent.ok ? sent.settled.record : undefined;
    const redelivery = await awaitRedelivery(ctx, commandId, { sinceMs, crashedAtMs: Date.now() });
    const after = countsOf(await dashboard(), s2);
    const confirmedNotes = await kindCount(A, ws.wsId, 'CONFIRMED');
    const reread = await A.client.getCommand(commandId);
    const unchanged = record !== undefined && reread.status === record.status && reread.settledAt === record.settledAt;
    const effectOk = after.confirmed === 1 && after.held === 0 && confirmedNotes === 1 && unchanged;
    const effect = `S2 confirmed ${after.confirmed} held ${after.held}, CONFIRMED notifications ${confirmedNotes}, record unchanged after redelivery ${unchanged}`;
    ctx.check({
      run, scenario: 'AFTER_COMMIT', step: 'ACCEPT settles APPLIED on the crashing delivery',
      ok: record?.status === 'APPLIED', expected: 'APPLIED',
      actual: sent.ok ? `${record?.status} after ${sent.settled.settleMs} ms` : errorText(sent.error),
    });
    recordRedelivery(ctx, run, 'AFTER_COMMIT', redelivery);
    ctx.check({ run, scenario: 'AFTER_COMMIT', step: 'effect applied exactly once', ok: effectOk, expected: 'S2 confirmed 1 held 0, 1 CONFIRMED notification, record unchanged', actual: effect });
    rows.push({
      run, fault: 'AFTER_COMMIT', command: 'ACCEPT_OFFER', commandId, workshopId: ws.wsId,
      status: record?.status ?? 'UNSETTLED', reason: record?.reason ?? (sent.ok ? '' : errorText(sent.error)),
      serverSettleMs: serverMs(record?.acceptedAt, record?.settledAt), clientSettleMs: sent.ok ? sent.settled.settleMs : undefined,
      deliveries: redelivery.deliveries, redelivery: describeRedelivery(redelivery), trace: traceText(redelivery), effect, effectOk,
      ok: record?.status === 'APPLIED' && effectOk && redeliveryOk(ctx.ops.kind, redelivery),
    });
  }

  // ---- TIMER_SEND: B registers for S1 (creates an offer + timer); the first delivery crashes at
  // the timer-scheduling point. C queues behind; B's offer must still expire through the timer.
  {
    const before = countsOf(await dashboard(), s1);
    const commandId = randomUUID();
    const postedAt = Date.now();
    const sent = await trySend(B, ws.wsId, { type: 'REGISTER', acceptable: [s1], commandId, _fault: 'TIMER_SEND' }, timeout);
    const record = sent.ok ? sent.settled.record : undefined;
    const redelivery = await awaitRedelivery(ctx, commandId, { sinceMs, crashedAtMs: postedAt });
    const offer = record?.result?.registration?.currentOffer;
    const cQueued = await trySend(C, ws.wsId, { type: 'REGISTER', acceptable: [s1] }, timeout);
    const mid = countsOf(await dashboard(), s1);
    const bOffers = await kindCount(B, ws.wsId, 'OFFER');
    ctx.check({
      run, scenario: 'TIMER_SEND', step: 'REGISTER settles APPLIED after the redelivery',
      ok: record?.status === 'APPLIED' && offer !== undefined, expected: 'APPLIED with an offer',
      actual: sent.ok ? `${record?.status} ${describeRegistration(record?.result?.registration, label)} after ${sent.settled.settleMs} ms` : errorText(sent.error),
    });
    recordRedelivery(ctx, run, 'TIMER_SEND', redelivery);
    const serverSettleMs = serverMs(record?.acceptedAt, record?.settledAt);
    const onRedelivery = recordSettledOnRedelivery(ctx, run, 'TIMER_SEND', serverSettleMs);
    let relay = 'not observed';
    let relayOk = false;
    if (offer !== undefined && cQueued.ok) {
      const expiresAt = Date.parse(offer.expiresAt);
      ctx.log(`run ${run}: waiting for B's offer to expire at ${offer.expiresAt} (~${Math.max(0, Math.round((expiresAt - Date.now()) / 1000))} s)`);
      try {
        await waitFor(
          'C to receive the seat of the expired offer',
          async () => ((await myRegistration(C, ws.wsId))?.status === 'OFFERED' ? true : undefined),
          { timeoutMs: Math.max(0, expiresAt - Date.now()) + 90_000, intervalMs: 1000 },
        );
        const expired = (await dashboard()).backfills.find((backfill) => backfill.cause === 'EXPIRED');
        relayOk = expired?.latencyMs !== undefined && expired.latencyMs < 15_000;
        relay = `EXPIRED backfill relayed to C after ${expired?.latencyMs ?? '?'} ms (timer path < 15 s; the sweep would take minutes)`;
      } catch (error) {
        relay = errorText(error);
      }
    }
    ctx.check({ run, scenario: 'TIMER_SEND', step: 'the offer still expires through the timer path', ok: relayOk, expected: 'EXPIRED backfill latencyMs < 15000', actual: relay });
    const effectOk = mid.seq - before.seq === 2 && mid.held === 1 && bOffers === 1;
    const effect = `seq +${mid.seq - before.seq} (B + C), S1 held ${mid.held}, B OFFER notifications ${bOffers}; ${relay}`;
    ctx.check({ run, scenario: 'TIMER_SEND', step: 'effect applied exactly once', ok: effectOk, expected: 'seq +2 (B, C), S1 held 1, 1 OFFER notification for B', actual: effect });
    rows.push({
      run, fault: 'TIMER_SEND', command: 'REGISTER', commandId, workshopId: ws.wsId,
      status: record?.status ?? 'UNSETTLED', reason: record?.reason ?? (sent.ok ? '' : errorText(sent.error)),
      serverSettleMs, clientSettleMs: sent.ok ? sent.settled.settleMs : undefined,
      deliveries: redelivery.deliveries, redelivery: describeRedelivery(redelivery), trace: traceText(redelivery), effect, effectOk: effectOk && relayOk,
      ok: record?.status === 'APPLIED' && effectOk && relayOk && onRedelivery && redeliveryOk(ctx.ops.kind, redelivery),
    });
  }

  // D is untouched by the faults: a plain command after them still settles normally.
  const plain = await trySend(D, ws.wsId, { type: 'REGISTER', acceptable: [s1, s2] }, timeout);
  ctx.check({
    run, scenario: 'after faults', step: 'a plain command on the same workshop settles normally',
    ok: plain.ok && plain.settled.record.status === 'APPLIED', expected: 'APPLIED',
    actual: plain.ok ? `${plain.settled.record.status} in ${plain.settled.settleMs} ms` : errorText(plain.error),
  });
  const inv = await invariantSnapshot(organiser, orgId, ws.wsId);
  ctx.check({
    run, scenario: 'after faults', step: 'verify',
    ok: inv.ok, expected: 'verify ok, overCapacity 0, doubleHolds 0',
    actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}, overCapacity ${inv.overCapacity}, doubleHolds ${inv.doubleHolds}`,
  });
}

interface NotificationState {
  total: number;
  pending: number;
  sent: number;
  skipped: number;
  failed: number;
}

async function notificationState(accounts: readonly Account[], wsId: string): Promise<NotificationState> {
  const lists = await mapWithConcurrency(accounts, 8, (account) => notificationsIn(account, wsId));
  const all = lists.flat();
  return {
    total: all.length,
    pending: all.filter((n) => !TERMINAL_NOTIFICATION.has(n.status)).length,
    sent: all.filter((n) => n.status === 'SENT').length,
    skipped: all.filter((n) => n.status === 'SKIPPED').length,
    failed: all.filter((n) => n.status === 'FAILED').length,
  };
}

/** N participants register for a fresh workshop with capacity N (N OFFER notifications). */
async function generateNotifications(
  ctx: ExperimentContext,
  orgId: string,
  organiser: Account,
  accounts: readonly Account[],
  title: string,
): Promise<{ ws: CreatedWorkshop; settled: number }> {
  const ws = await createWorkshop(organiser, orgId, {
    title,
    holdSeconds: Math.max(ctx.options.holdSeconds, 900),
    sessions: [{ capacity: accounts.length }, { capacity: 1 }],
  });
  const results = await mapWithConcurrency(accounts, 10, (account) =>
    trySend(account, ws.wsId, { type: 'REGISTER', acceptable: [ws.sessionIds[0] as string] }, ctx.options.settleTimeoutMs),
  );
  return { ws, settled: results.filter((result) => result.ok && result.settled.record.status === 'APPLIED').length };
}

/** Polls until no notification of the workshop is PENDING; seconds since `fromMs`, or undefined. */
async function awaitDelivered(
  accounts: readonly Account[],
  wsId: string,
  expected: number,
  fromMs: number,
  limitMs: number,
): Promise<{ seconds: number | undefined; state: NotificationState }> {
  let state = await notificationState(accounts, wsId);
  while (!(state.total >= expected && state.pending === 0)) {
    if (Date.now() - fromMs > limitMs) {
      return { seconds: undefined, state };
    }
    await sleep(1000);
    state = await notificationState(accounts, wsId);
  }
  return { seconds: (Date.now() - fromMs) / 1000, state };
}

async function notifierRun(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  accounts: readonly Account[],
  outageMs: number,
  limitMs: number,
  rows: NotifierRow[],
): Promise<void> {
  // Baseline: delivery without an outage (both targets).
  {
    const generated = await generateNotifications(ctx, orgId, organiser, accounts, `Notifier baseline r${run} (${ctx.runId.slice(0, 8)})`);
    const settledAt = Date.now();
    const { seconds, state } = await awaitDelivered(accounts, generated.ws.wsId, generated.settled, settledAt, limitMs);
    const ok = generated.settled === accounts.length && seconds !== undefined;
    rows.push({
      run, phase: 'baseline', notifications: state.total, pendingAtRestore: undefined, recoverySeconds: seconds,
      sent: state.sent, skipped: state.skipped, failed: state.failed, pending: state.pending,
      detail: `workshop ${generated.ws.wsId}; ${generated.settled}/${accounts.length} REGISTER applied`, ok,
    });
    ctx.check({
      run, scenario: 'notifier baseline', step: 'every notification leaves PENDING without an outage',
      ok, expected: `${accounts.length} processed`,
      actual: `${state.total - state.pending}/${state.total} processed (SENT ${state.sent}, SKIPPED ${state.skipped}, FAILED ${state.failed}) ${seconds === undefined ? 'not within the limit' : `${seconds.toFixed(1)} s after the last settlement`}`,
    });
  }

  // Outage: notifier reserved concurrency 0 (dev/pilot only).
  if (ctx.ops.kind === 'local') {
    ctx.skip('notifier outage', 'pause notifier, generate notifications, restore, measure recovery',
      'the local notifier is an in-process loop of the server container; it is not externally controllable (plan §4: documented and skipped)', run);
    return;
  }
  const paused = await ctx.ops.pauseNotifier();
  if (!paused.available) {
    ctx.skip('notifier outage', 'PutFunctionConcurrency 0', paused.detail, run);
    return;
  }
  let restored = false;
  try {
    ctx.log(`notifier paused (${paused.detail}); generating ${accounts.length} notifications`);
    const generated = await generateNotifications(ctx, orgId, organiser, accounts, `Notifier outage r${run} (${ctx.runId.slice(0, 8)})`);
    await sleep(outageMs);
    const atRestore = await notificationState(accounts, generated.ws.wsId);
    ctx.check({
      run, scenario: 'notifier outage', step: 'notifications back up while the notifier is stopped',
      ok: atRestore.pending > 0, expected: '> 0 PENDING at the restore',
      actual: `${atRestore.pending}/${atRestore.total} PENDING after ${Math.round(outageMs / 1000)} s`,
    });
    const resumed = await ctx.ops.resumeNotifier();
    restored = resumed.available;
    const restoredAt = Date.now();
    ctx.log(`notifier restored (${resumed.detail}); waiting for the backlog to drain`);
    const { seconds, state } = await awaitDelivered(accounts, generated.ws.wsId, generated.settled, restoredAt, limitMs);
    const ok = restored && seconds !== undefined && seconds < limitMs / 1000;
    rows.push({
      run, phase: 'outage', notifications: state.total, pendingAtRestore: atRestore.pending, recoverySeconds: seconds,
      sent: state.sent, skipped: state.skipped, failed: state.failed, pending: state.pending,
      detail: `${paused.detail}; ${resumed.detail}; workshop ${generated.ws.wsId}`, ok,
    });
    ctx.check({
      run, scenario: 'notifier outage', step: `backlog delivered within ${Math.round(limitMs / 1000)} s of the restore`,
      ok, expected: `0 PENDING, recovery < ${Math.round(limitMs / 1000)} s`,
      actual: `${state.pending} PENDING (SENT ${state.sent}, SKIPPED ${state.skipped}, FAILED ${state.failed}); recovery ${seconds === undefined ? 'not reached' : `${seconds.toFixed(1)} s`}`,
    });
  } finally {
    if (!restored) {
      const resumed = await ctx.ops.resumeNotifier();
      ctx.log(`notifier restore (finally): ${resumed.detail}`);
    }
  }
}

runExperiment({
  name: 'failure-recovery',
  tableRow: 'Failure recovery (plan §4, Table 3)',
  criterion: 'BEFORE_COMMIT / AFTER_COMMIT / TIMER_SEND: the command settles exactly once after the redelivery, traceable; notifier outage: backlog delivered < 5 min after the restore (seconds reported); dead letters empty',
  usage: USAGE,
  defaultHoldSeconds: 60,
  options: { outage: { type: 'string' }, notifications: { type: 'string' }, 'recovery-limit': { type: 'string' } },
  async run(ctx) {
    const outageMs = intOption(ctx.values, 'outage', 60) * 1000;
    const notificationCount = Math.max(1, intOption(ctx.values, 'notifications', 10));
    const limitMs = intOption(ctx.values, 'recovery-limit', 300) * 1000;
    const organiser = await ctx.accounts.organiser();
    const accounts = await ctx.accounts.participants(Math.max(4, notificationCount + 1));
    const [A, B, C, D] = accounts;
    if (A === undefined || B === undefined || C === undefined || D === undefined) {
      throw new Error('four participant accounts are required');
    }
    const notified = accounts.slice(1, 1 + notificationCount);
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);
    ctx.param('outageSeconds', outageMs / 1000);
    ctx.param('notifications', notificationCount);
    ctx.param('recoveryLimitSeconds', limitMs / 1000);

    const deadBefore = await ctx.ops.deadLetters();
    const faultRows: FaultRow[] = [];
    const notifierRows: NotifierRow[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      if (!ctx.options.faults) {
        ctx.skip('faults', 'BEFORE_COMMIT / AFTER_COMMIT / TIMER_SEND', 'fault flags off for this target (--faults off, or pilot)', run);
      } else {
        try {
          await faultRun(ctx, run, org.id, organiser, { A, B, C, D }, faultRows);
        } catch (error) {
          ctx.fail('faults', 'run aborted', error, run);
        }
      }
      try {
        await notifierRun(ctx, run, org.id, organiser, notified, outageMs, limitMs, notifierRows);
      } catch (error) {
        ctx.fail('notifier', 'run aborted', error, run);
      }
    }
    const deadAfter = await ctx.ops.deadLetters();
    if (deadAfter.available) {
      ctx.check({
        scenario: 'dead letters', step: 'no message dead-lettered by the run',
        ok: deadAfter.total <= (deadBefore.available ? deadBefore.total : 0),
        expected: `${deadBefore.available ? deadBefore.total : 0} (as before the run)`, actual: String(deadAfter.total), detail: deadAfter.detail,
      });
    } else {
      ctx.skip('dead letters', 'DLQ / FAILED rows', deadAfter.detail);
    }

    const outage = notifierRows.filter((row) => row.phase === 'outage');
    const baseline = notifierRows.filter((row) => row.phase === 'baseline');
    const recovery = summarize(outage.flatMap((row) => (row.recoverySeconds === undefined ? [] : [row.recoverySeconds])));
    const byFault = (fault: FaultFlag) => faultRows.filter((row) => row.fault === fault);
    const lines = [
      '## Result',
      '',
      ...(['BEFORE_COMMIT', 'AFTER_COMMIT', 'TIMER_SEND'] as const).map((fault) => {
        const rows = byFault(fault);
        const settle = summarize(rows.flatMap((row) => (row.serverSettleMs === undefined ? [] : [row.serverSettleMs])));
        return `- \`${fault}\`: ${rows.length === 0 ? 'not run (fault flags off)' : `${rows.filter((row) => row.ok).length}/${rows.length} settled exactly once; server settle incl. redelivery p50 ${Math.round(settle.p50)} ms, max ${Math.round(settle.max)} ms`}`;
      }),
      `- Notifier outage recovery: ${outage.length === 0 ? 'not run on this target (see skipped)' : `**${outage.filter((row) => row.ok).length}/${outage.length}** within ${Math.round(limitMs / 1000)} s; recovery seconds ${outage.map((row) => (row.recoverySeconds === undefined ? 'n/a' : row.recoverySeconds.toFixed(1))).join(', ')} (max ${Number.isNaN(recovery.max) ? 'n/a' : recovery.max.toFixed(1)} s)`}`,
      `- Notifier baseline (no outage): ${baseline.map((row) => (row.recoverySeconds === undefined ? 'n/a' : `${row.recoverySeconds.toFixed(1)} s`)).join(', ') || 'n/a'} from the last settlement to the last notification processed`,
      `- Dead letters after the run: ${deadAfter.available ? deadAfter.total : `not readable (${deadAfter.detail})`}`,
      '',
      'Server settle latency of a BEFORE_COMMIT / TIMER_SEND command includes the redelivery delay',
      '(local: retry backoff ≈ 1 s; AWS: the 120 s SQS visibility timeout); AFTER_COMMIT settles on the',
      'first delivery and only the acknowledgement is redelivered.',
      '',
      '## Fault cases',
      '',
      faultRows.length === 0
        ? 'Not run.'
        : markdownTable(
            ['run', 'fault', 'command', 'outcome', 'server settle ms', 'deliveries', 'effect', 'verdict'],
            faultRows.map((row) => [
              row.run, row.fault, row.command, `${row.status}${row.reason ? `(${row.reason})` : ''}`, row.serverSettleMs ?? '',
              row.deliveries ?? row.redelivery, row.effect, row.ok ? 'PASS' : 'FAIL',
            ]),
          ),
      '',
      ...(faultRows.length === 0
        ? []
        : [
            '## Delivery traces',
            '',
            'How each redelivery was observed (local: the `commands` row; AWS: worker log lines found by Logs Insights).',
            '',
            ...faultRows.map((row) => `- run ${row.run} \`${row.fault}\` (${row.commandId}): ${row.redelivery}${row.trace.length > 0 ? `\n  - ${row.trace.split(' | ').join('\n  - ')}` : ''}`),
            '',
          ]),
      '## Notifier',
      '',
      markdownTable(
        ['run', 'phase', 'notifications', 'PENDING at restore', 'recovery s', 'SENT', 'SKIPPED', 'FAILED', 'still PENDING', 'verdict'],
        notifierRows.map((row) => [
          row.run, row.phase, row.notifications, row.pendingAtRestore ?? '—',
          row.recoverySeconds === undefined ? 'n/a' : row.recoverySeconds.toFixed(1), row.sent, row.skipped, row.failed, row.pending, row.ok ? 'PASS' : 'FAIL',
        ]),
      ),
    ];
    return {
      summary: lines.join('\n'),
      rows: faultRows,
      extraFiles: { 'notifier.csv': notifierRows },
      extra: {
        faults: faultRows.map((row) => ({ run: row.run, fault: row.fault, ok: row.ok, serverSettleMs: row.serverSettleMs ?? null, deliveries: row.deliveries ?? null })),
        notifierRecoverySeconds: outage.map((row) => row.recoverySeconds ?? null),
        notifierBaselineSeconds: baseline.map((row) => row.recoverySeconds ?? null),
      },
    };
  },
});
