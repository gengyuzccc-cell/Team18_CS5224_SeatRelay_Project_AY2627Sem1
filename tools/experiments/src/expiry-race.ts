#!/usr/bin/env tsx
import { intOption, type CommandInput } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import { classifyEarly, consistentWithServerTime, relayOrder, type EarlyVerdict } from './lib/expiryRace';
import { markdownTable, summarize, type CsvRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  createWorkshop,
  ensureOrganisation,
  invariantSnapshot,
  myRegistration,
  serverClockOffset,
  sleep,
  sleepUntil,
  waitFor,
  type ClockOffset,
} from './lib/scenario';
import { describeRegistration, errorText, sessionLabeller, trySend, type SendOutcome } from './lib/steps';

/**
 * Table 3 "Expiry race" (plan §4, §1.2 tick-first semantics). With holdSeconds = 60:
 *
 * - early: an ACCEPT that reaches the API at `expiresAt − margin` (server time) succeeds. Expiry
 *   is judged when the worker processes the command (tick-first), so when the queue latency
 *   exceeds the margin the ACCEPT is correctly REJECTED(OFFER_EXPIRED) although it arrived in
 *   time: such a trial is INCONCLUSIVE (not a failure) and repeated with a fresh workshop, up to
 *   `--early-attempts` per run; the worker pickup latency (settledAt − acceptedAt) is reported;
 * - late: an ACCEPT at `expiresAt + margin` is REJECTED(OFFER_EXPIRED) whether or not the
 *   expiry timer's TICK was processed first (the script records which one reached the worker
 *   first, from the backfill record of the relayed seat);
 * - late tick: a stale TICK for the expired offer injected straight into the command queue
 *   (local: `commands` row; dev: SQS SendMessage on the FIFO) has no effect on the newer offer
 *   the seat was relayed to (no commit, offer unchanged, still acceptable).
 *
 * Every outcome is also checked against the server's own timestamps: an APPLIED accept must
 * have been accepted before `expiresAt`, an OFFER_EXPIRED rejection must have settled at or
 * after it. The send instant is corrected by the server clock offset (NTP-style on /health).
 */
const USAGE = `
expiry-race — Table 3 "Expiry race": ACCEPT just before / just after expiresAt, and a stale TICK

  pnpm --filter @seatrelay/experiments expiry-race --target local|dev [--runs 3] [--hold 60]
       [--margin-ms 200] [--tick-wait 20] [--early-attempts 3]

Runs proceed in parallel (staggered by 2 s); each needs about holdSeconds + 15 s, plus one hold
per repeated early attempt.
Accounts: <prefix>-1 (early), <prefix>-2 (late, offer holder), <prefix>-3 (queued behind).
--tick-wait S          dev: how long to wait for the injected TICK to be processed (local polls the row)
--early-attempts N     early trials per run until one is conclusive (default 3): an early ACCEPT the
                       worker processes after expiresAt (queue latency > margin) is inconclusive
`;

const ORG_NAME = 'SeatRelay experiments';

interface TrialRow extends CsvRow {
  run: number;
  variant: 'early' | 'late';
  /** Early trials: 1-based attempt of the run (inconclusive attempts are repeated). */
  attempt: number;
  workshopId: string;
  offerId: string;
  marginMs: number;
  expiresAt: string;
  sentAtServerEst: string;
  acceptedAt: string;
  settledAt: string;
  arrivalOffsetMs: number | undefined;
  settleOffsetMs: number | undefined;
  /** settledAt − acceptedAt: queue + worker latency of the ACCEPT. */
  pickupMs: number | undefined;
  status: string;
  reason: string;
  order: string;
  consistent: boolean;
  /** PASS | INCONCLUSIVE | FAIL (early: see classifyEarly; late: PASS/FAIL). */
  verdict: EarlyVerdict;
  ok: boolean;
}

interface LateTickRow extends CsvRow {
  run: number;
  workshopId: string;
  injected: boolean;
  processed: string;
  versionBefore: number;
  versionAfter: number;
  newerOfferUnchanged: boolean;
  backfillsUnchanged: boolean;
  newerOfferAccepted: string;
  ok: boolean;
}

const statusOf = (outcome: SendOutcome): string =>
  outcome.ok ? `${outcome.settled.record.status}${outcome.settled.record.reason === undefined ? '' : `(${outcome.settled.record.reason})`}` : `ERROR ${errorText(outcome.error)}`;

/** Sends `input` so that it reaches the API at `targetServerMs` (server clock). */
async function sendAt(
  account: Account,
  wsId: string,
  input: CommandInput,
  targetServerMs: number,
  clock: ClockOffset,
  timeoutMs: number,
): Promise<{ outcome: SendOutcome; sentAtServerEst: number }> {
  const sendClientMs = targetServerMs - clock.offsetMs - clock.rttMs / 2;
  await sleepUntil(sendClientMs);
  const sentAtServerEst = Date.now() + clock.offsetMs;
  return { outcome: await trySend(account, wsId, input, timeoutMs), sentAtServerEst };
}

function trialRow(
  run: number,
  variant: 'early' | 'late',
  attempt: number,
  workshopId: string,
  offer: { id: string; expiresAt: string },
  marginMs: number,
  sent: { outcome: SendOutcome; sentAtServerEst: number },
  order: string,
  verdict: EarlyVerdict,
): TrialRow {
  const expiresAtMs = Date.parse(offer.expiresAt);
  const record = sent.outcome.ok ? sent.outcome.settled.record : undefined;
  return {
    run,
    variant,
    attempt,
    workshopId,
    offerId: offer.id,
    marginMs,
    expiresAt: offer.expiresAt,
    sentAtServerEst: new Date(sent.sentAtServerEst).toISOString(),
    acceptedAt: record?.acceptedAt ?? '',
    settledAt: record?.settledAt ?? '',
    arrivalOffsetMs: record === undefined ? undefined : Date.parse(record.acceptedAt) - expiresAtMs,
    settleOffsetMs: record?.settledAt === undefined ? undefined : Date.parse(record.settledAt) - expiresAtMs,
    pickupMs: record?.settledAt === undefined ? undefined : Date.parse(record.settledAt) - Date.parse(record.acceptedAt),
    status: record?.status ?? 'ERROR',
    reason: record?.reason ?? (sent.outcome.ok ? '' : errorText(sent.outcome.error)),
    order,
    consistent: sent.outcome.ok && consistentWithServerTime(sent.outcome.settled.record, expiresAtMs),
    verdict,
    ok: verdict === 'PASS',
  };
}

async function verifyCheck(ctx: ExperimentContext, run: number, organiser: Account, orgId: string, wsId: string, scenario: string): Promise<void> {
  const inv = await invariantSnapshot(organiser, orgId, wsId);
  ctx.check({
    run, scenario, step: 'verify',
    ok: inv.ok, expected: 'verify ok',
    actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}, overCapacity ${inv.overCapacity}, doubleHolds ${inv.doubleHolds}`,
  });
}

/**
 * Early ACCEPTs of one run: a fresh workshop per attempt, until an attempt is conclusive (PASS
 * or FAIL) or `maxAttempts` inconclusive ones (queue latency > margin) have been made.
 */
async function earlyTrials(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  A: Account,
  clock: ClockOffset,
  marginMs: number,
  maxAttempts: number,
): Promise<TrialRow[]> {
  const timeout = ctx.options.settleTimeoutMs;
  const rows: TrialRow[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ws = await createWorkshop(organiser, orgId, {
      title: `Expiry race early r${run}${attempt > 1 ? ` a${attempt}` : ''} (${ctx.runId.slice(0, 8)})`,
      holdSeconds: ctx.options.holdSeconds,
      sessions: [{ capacity: 1 }, { capacity: 1 }],
    });
    ctx.param(`run${run}.early${attempt}.workshopId`, ws.wsId);
    const [e1] = ws.sessionIds as [string];
    const reg = await A.client.sendCommand(ws.wsId, { type: 'REGISTER', acceptable: [e1] }, { timeoutMs: timeout });
    const offer = reg.record.result?.registration?.currentOffer;
    if (offer === undefined) {
      throw new Error(`early setup failed: A ${reg.record.status}${reg.record.reason ? `(${reg.record.reason})` : ''}`);
    }
    const expiresAtMs = Date.parse(offer.expiresAt);
    ctx.log(`run ${run} early attempt ${attempt}: offer expires at ${offer.expiresAt}; ACCEPT due at expiresAt − ${marginMs} ms`);
    const sent = await sendAt(A, ws.wsId, { type: 'ACCEPT_OFFER', offerId: offer.id }, expiresAtMs - marginMs, clock, timeout);
    const verdict = classifyEarly(sent.outcome.ok ? sent.outcome.settled.record : undefined, expiresAtMs);
    const row = trialRow(run, 'early', attempt, ws.wsId, offer, marginMs, sent, 'n/a', verdict);
    rows.push(row);
    const timing = `arrived ${row.arrivalOffsetMs ?? '?'} ms, settled ${row.settleOffsetMs ?? '?'} ms relative to expiresAt (worker pickup ${row.pickupMs ?? '?'} ms)`;
    ctx.check({
      run, scenario: 'early', step: `attempt ${attempt}: outcome consistent with the server clock`,
      ok: row.consistent, expected: 'APPLIED ⇒ acceptedAt < expiresAt; OFFER_EXPIRED ⇒ settledAt ≥ expiresAt',
      actual: `${row.status}${row.reason ? `(${row.reason})` : ''} acceptedAt ${row.acceptedAt} settledAt ${row.settledAt}`,
    });
    await verifyCheck(ctx, run, organiser, orgId, ws.wsId, 'early');
    if (verdict !== 'INCONCLUSIVE') {
      ctx.check({
        run, scenario: 'early', step: `ACCEPT at expiresAt − ${marginMs} ms succeeds`,
        ok: verdict === 'PASS', expected: 'APPLIED',
        actual: `${statusOf(sent.outcome)}; ${timing}${attempt > 1 ? `; attempt ${attempt} (${attempt - 1} inconclusive before)` : ''}`,
      });
      return rows;
    }
    ctx.log(
      `run ${run} early attempt ${attempt} INCONCLUSIVE: ${statusOf(sent.outcome)}; ${timing}: the worker processed the ACCEPT after expiresAt (queue latency > ${marginMs} ms margin)${attempt < maxAttempts ? '; repeating with a fresh workshop' : ''}`,
    );
  }
  ctx.check({
    run, scenario: 'early', step: `ACCEPT at expiresAt − ${marginMs} ms succeeds (a conclusive trial within ${maxAttempts} attempts)`,
    ok: false, expected: 'APPLIED in one of the attempts',
    actual: `all ${maxAttempts} attempts processed after expiresAt (worker pickup ${rows.map((row) => row.pickupMs ?? '?').join(' / ')} ms > ${marginMs} ms margin)`,
  });
  return rows;
}

/** The late ACCEPT of one run, the relay of the expired seat and the stale TICK. */
async function lateTrial(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  people: { B: Account; C: Account },
  clock: ClockOffset,
  marginMs: number,
  tickWaitMs: number,
): Promise<{ rows: TrialRow[]; lateTick?: LateTickRow }> {
  const { B, C } = people;
  const timeout = ctx.options.settleTimeoutMs;
  const wsL = await createWorkshop(organiser, orgId, {
    title: `Expiry race late r${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: [{ capacity: 1 }, { capacity: 1 }],
  });
  ctx.param(`run${run}.late.workshopId`, wsL.wsId);
  const [l1] = wsL.sessionIds as [string];
  const bReg = await B.client.sendCommand(wsL.wsId, { type: 'REGISTER', acceptable: [l1] }, { timeoutMs: timeout });
  const cReg = await C.client.sendCommand(wsL.wsId, { type: 'REGISTER', acceptable: [l1] }, { timeoutMs: timeout });
  const offerB = bReg.record.result?.registration?.currentOffer;
  const cState = cReg.record.result?.registration?.status;
  if (offerB === undefined || cState !== 'QUEUED') {
    throw new Error(`late setup failed: B ${bReg.record.status}, C ${cState}`);
  }
  const expiresB = Date.parse(offerB.expiresAt);
  ctx.log(`run ${run} late: offer expires at ${offerB.expiresAt}; waiting ~${Math.round((expiresB - Date.now() - clock.offsetMs) / 1000)} s`);
  const late = await sendAt(B, wsL.wsId, { type: 'ACCEPT_OFFER', offerId: offerB.id }, expiresB + marginMs, clock, timeout);

  // late: must be rejected OFFER_EXPIRED, whatever reached the worker first
  const lateExpired =
    late.outcome.ok && late.outcome.settled.record.status === 'REJECTED' && late.outcome.settled.record.reason === 'OFFER_EXPIRED';
  let order = 'unknown';
  let newerOffer: { id: string; expiresAt: string } | undefined;
  try {
    const cMe = await waitFor(
      'C to receive the relayed seat',
      async () => {
        const me = await myRegistration(C, wsL.wsId);
        return me?.status === 'OFFERED' ? me : undefined;
      },
      { timeoutMs: ctx.target.name === 'local' ? 30_000 : 90_000, intervalMs: 500 },
    );
    newerOffer = cMe.currentOffer;
    const dash = await organiser.client.dashboard(orgId, wsL.wsId);
    const expired = dash.backfills.find((record) => record.cause === 'EXPIRED' && record.reallocatedAt !== undefined);
    if (expired?.reallocatedAt !== undefined && late.outcome.ok) {
      const { record } = late.outcome.settled;
      order = relayOrder(
        Date.parse(expired.reallocatedAt),
        Date.parse(record.acceptedAt),
        record.settledAt === undefined ? undefined : Date.parse(record.settledAt),
      );
    }
    ctx.check({
      run, scenario: 'late', step: 'the expired seat is relayed to the next in queue',
      ok: newerOffer !== undefined && expired !== undefined,
      expected: 'C OFFERED, EXPIRED backfill record relayed',
      actual: `C ${describeRegistration(cMe, sessionLabeller(wsL))}; EXPIRED record latency ${expired?.latencyMs ?? 'n/a'} ms`,
    });
  } catch (error) {
    ctx.fail('late', 'the expired seat is relayed to the next in queue', error, run);
  }
  const lateRow = trialRow(run, 'late', 1, wsL.wsId, offerB, marginMs, late, order, lateExpired ? 'PASS' : 'FAIL');
  ctx.check({
    run, scenario: 'late', step: `ACCEPT at expiresAt + ${marginMs} ms rejected OFFER_EXPIRED`,
    ok: lateExpired, expected: 'REJECTED(OFFER_EXPIRED)',
    actual: `${statusOf(late.outcome)}; arrived ${lateRow.arrivalOffsetMs ?? '?'} ms after expiresAt; ${order}`,
  });
  ctx.check({
    run, scenario: 'late', step: 'outcome consistent with the server clock',
    ok: lateRow.consistent, expected: 'OFFER_EXPIRED ⇒ settledAt ≥ expiresAt',
    actual: `${lateRow.status}${lateRow.reason ? `(${lateRow.reason})` : ''} settledAt ${lateRow.settledAt}`,
  });

  // late tick: a stale TICK for B's expired offer must not touch C's newer offer
  let lateTick: LateTickRow | undefined;
  if (newerOffer !== undefined) {
    const before = await organiser.client.dashboard(orgId, wsL.wsId);
    const injected = await ctx.ops.injectLateTick({
      type: 'TICK',
      workshopId: wsL.wsId,
      source: 'TIMER',
      offerId: offerB.id,
      expiresAt: offerB.expiresAt,
    });
    if (!injected.available) {
      ctx.skip('late tick', 'inject a stale TICK into the command queue', injected.detail, run);
    } else {
      let processed = `waited ${Math.round(tickWaitMs / 1000)} s`;
      if (ctx.ops.kind === 'local' && injected.dedupId !== undefined) {
        const dedupId = injected.dedupId;
        try {
          const trace = await waitFor(
            'the injected TICK to be processed',
            async () => {
              const row = await ctx.ops.commandTrace(dedupId);
              return row.status === 'DONE' || row.status === 'FAILED' ? row : undefined;
            },
            { timeoutMs: 15_000, intervalMs: 300 },
          );
          processed = `commands row ${trace.status}`;
        } catch (error) {
          processed = `not observed (${errorText(error)})`;
        }
      } else {
        await sleep(tickWaitMs);
      }
      const after = await organiser.client.dashboard(orgId, wsL.wsId);
      const cNow = await myRegistration(C, wsL.wsId);
      const unchanged =
        cNow?.status === 'OFFERED' && cNow.currentOffer?.id === newerOffer.id && cNow.currentOffer.expiresAt === newerOffer.expiresAt;
      const backfillsUnchanged = after.backfills.length === before.backfills.length;
      const accepted = await trySend(C, wsL.wsId, { type: 'ACCEPT_OFFER', offerId: newerOffer.id }, timeout);
      const acceptedOk = accepted.ok && accepted.settled.record.status === 'APPLIED';
      const ok = unchanged && backfillsUnchanged && after.workshop.version === before.workshop.version && acceptedOk;
      lateTick = {
        run,
        workshopId: wsL.wsId,
        injected: true,
        processed,
        versionBefore: before.workshop.version,
        versionAfter: after.workshop.version,
        newerOfferUnchanged: unchanged,
        backfillsUnchanged,
        newerOfferAccepted: statusOf(accepted),
        ok,
      };
      ctx.check({
        run, scenario: 'late tick', step: 'stale TICK has no effect on the newer offer',
        ok: unchanged && backfillsUnchanged && after.workshop.version === before.workshop.version,
        expected: 'newer offer unchanged, no new backfill record, workshop version unchanged (no commit)',
        actual: `offer ${unchanged ? 'unchanged' : `changed (${describeRegistration(cNow, sessionLabeller(wsL))})`}, backfills ${before.backfills.length}→${after.backfills.length}, version ${before.workshop.version}→${after.workshop.version}; ${processed}; ${injected.detail}`,
      });
      ctx.check({
        run, scenario: 'late tick', step: 'the newer offer can still be accepted',
        ok: acceptedOk, expected: 'APPLIED', actual: statusOf(accepted),
      });
    }
  }

  await verifyCheck(ctx, run, organiser, orgId, wsL.wsId, 'late');
  return { rows: [lateRow], ...(lateTick === undefined ? {} : { lateTick }) };
}

async function trial(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  people: { A: Account; B: Account; C: Account },
  clock: ClockOffset,
  marginMs: number,
  tickWaitMs: number,
  earlyAttempts: number,
): Promise<{ rows: TrialRow[]; lateTick?: LateTickRow }> {
  const [early, late] = await Promise.all([
    earlyTrials(ctx, run, orgId, organiser, people.A, clock, marginMs, earlyAttempts).catch((error: unknown) => {
      ctx.fail('early', 'trial aborted', error, run);
      return [] as TrialRow[];
    }),
    lateTrial(ctx, run, orgId, organiser, people, clock, marginMs, tickWaitMs).catch(
      (error: unknown): { rows: TrialRow[]; lateTick?: LateTickRow } => {
        ctx.fail('late', 'trial aborted', error, run);
        return { rows: [] };
      },
    ),
  ]);
  return { rows: [...early, ...late.rows], ...(late.lateTick === undefined ? {} : { lateTick: late.lateTick }) };
}

runExperiment({
  name: 'expiry-race',
  tableRow: 'Expiry race (plan §4, Table 3; tick-first, §1.2)',
  criterion: 'ACCEPT at expiresAt − 200 ms succeeds (a trial whose queue latency exceeds the margin is inconclusive under tick-first and repeated); ACCEPT at expiresAt + 200 ms is REJECTED(OFFER_EXPIRED) regardless of timer arrival; a late TICK has no effect on a newer offer',
  usage: USAGE,
  defaultHoldSeconds: 60,
  options: { 'margin-ms': { type: 'string' }, 'tick-wait': { type: 'string' }, 'early-attempts': { type: 'string' } },
  async run(ctx) {
    const marginMs = intOption(ctx.values, 'margin-ms', 200);
    const tickWaitMs = intOption(ctx.values, 'tick-wait', 20) * 1000;
    const earlyAttempts = Math.max(1, intOption(ctx.values, 'early-attempts', 3));
    const organiser = await ctx.accounts.organiser();
    const [A, B, C] = await ctx.accounts.participants(3);
    if (A === undefined || B === undefined || C === undefined) {
      throw new Error('three participant accounts are required');
    }
    const org = await ensureOrganisation(organiser, ORG_NAME);
    const clock = await serverClockOffset(ctx.anonymous, 9);
    ctx.param('orgId', org.id);
    ctx.param('marginMs', marginMs);
    ctx.param('earlyAttempts', earlyAttempts);
    ctx.param('clockOffset', clock);
    ctx.log(`server clock offset ${Math.round(clock.offsetMs)} ms (rtt ${clock.rttMs} ms)`);

    const results = await Promise.all(
      Array.from({ length: ctx.options.runs }, async (_, i) => {
        const run = i + 1;
        await sleep(i * 2000);
        try {
          return await trial(ctx, run, org.id, organiser, { A, B, C }, clock, marginMs, tickWaitMs, earlyAttempts);
        } catch (error) {
          ctx.fail('expiry-race', 'trial aborted', error, run);
          return { rows: [] as TrialRow[] };
        }
      }),
    );
    const rows = results.flatMap((result) => result.rows);
    const lateTicks = results.flatMap((result) => (result.lateTick === undefined ? [] : [result.lateTick]));
    const early = rows.filter((row) => row.variant === 'early');
    const late = rows.filter((row) => row.variant === 'late');
    const runsWithEarlyPass = new Set(early.filter((row) => row.verdict === 'PASS').map((row) => row.run)).size;
    const inconclusive = early.filter((row) => row.verdict === 'INCONCLUSIVE');
    const pickup = summarize(rows.flatMap((row) => (row.pickupMs === undefined ? [] : [row.pickupMs])));
    const orders = late.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.order]: (acc[row.order] ?? 0) + 1 }), {});
    const arrivalError = summarize(
      rows.flatMap((row) => (row.arrivalOffsetMs === undefined ? [] : [Math.abs(Math.abs(row.arrivalOffsetMs) - marginMs)])),
    );
    const lines = [
      '## Result',
      '',
      `- Early ACCEPT (reaching the API at expiresAt − ${marginMs} ms) applied: **${runsWithEarlyPass}/${ctx.options.runs} runs**; attempts ${early.length}: ${early.filter((row) => row.verdict === 'PASS').length} applied, ${inconclusive.length} inconclusive, ${early.filter((row) => row.verdict === 'FAIL').length} failed`,
      `- Inconclusive early attempts (REJECTED(OFFER_EXPIRED) although accepted before expiresAt, because the worker processed them after it: queue latency > ${marginMs} ms margin, correct under tick-first; repeated with a fresh workshop): ${inconclusive.length === 0 ? 'none' : inconclusive.map((row) => `run ${row.run} attempt ${row.attempt} (pickup ${row.pickupMs ?? '?'} ms)`).join(', ')}`,
      `- Worker pickup latency of the ACCEPTs (settledAt − acceptedAt): p50 ${Number.isNaN(pickup.p50) ? 'n/a' : Math.round(pickup.p50)} ms, max ${Number.isNaN(pickup.max) ? 'n/a' : Math.round(pickup.max)} ms${ctx.target.name === 'local' ? `; the local worker polls the commands table every 200 ms (WORKER_POLL_MS), so a pickup of up to ~200 ms is normal there and an early attempt is inconclusive whenever it exceeds the ${marginMs} ms margin` : ''}`,
      `- Late ACCEPT (expiresAt + ${marginMs} ms) rejected OFFER_EXPIRED: **${late.filter((row) => row.ok).length}/${late.length}**`,
      `- Which reached the worker first in the late trials: ${Object.entries(orders).map(([order, n]) => `${order}: ${n}`).join('; ') || 'n/a'}`,
      `- Outcomes consistent with the server clock: ${rows.filter((row) => row.consistent).length}/${rows.length}`,
      `- Stale TICK injected: ${lateTicks.length === 0 ? 'not on this target (see skipped)' : `${lateTicks.filter((row) => row.ok).length}/${lateTicks.length} without effect on the newer offer`}`,
      `- Send timing: server clock offset ${Math.round(clock.offsetMs)} ms (rtt ${clock.rttMs} ms); |arrival − planned| p50 ${Math.round(arrivalError.p50)} ms, max ${Math.round(arrivalError.max)} ms`,
      '',
      'Expiry is decided by server time when the command is processed (tick-first): a command arriving before expiresAt',
      'can still lose if it waits in the queue past expiresAt; `settledAt − expiresAt` shows that lag for every trial.',
      '',
      '## Trials',
      '',
      markdownTable(
        ['run', 'variant', 'attempt', 'arrival − expiresAt (ms)', 'settled − expiresAt (ms)', 'pickup (ms)', 'outcome', 'which first', 'consistent', 'verdict'],
        rows.map((row) => [
          row.run, row.variant, row.attempt, row.arrivalOffsetMs ?? '', row.settleOffsetMs ?? '', row.pickupMs ?? '', `${row.status}${row.reason ? `(${row.reason})` : ''}`,
          row.order, row.consistent, row.verdict,
        ]),
      ),
      '',
      '## Stale TICK',
      '',
      lateTicks.length === 0
        ? 'Not injected on this target.'
        : markdownTable(
            ['run', 'processed', 'version before → after', 'newer offer unchanged', 'backfills unchanged', 'newer offer ACCEPT', 'verdict'],
            lateTicks.map((row) => [row.run, row.processed, `${row.versionBefore} → ${row.versionAfter}`, row.newerOfferUnchanged, row.backfillsUnchanged, row.newerOfferAccepted, row.ok ? 'PASS' : 'FAIL']),
          ),
    ];
    return {
      summary: lines.join('\n'),
      rows,
      extraFiles: lateTicks.length === 0 ? {} : ({ 'late-tick.csv': lateTicks } as Record<string, CsvRow[]>),
      // Inconclusive early attempts are not failures; every run needs an applied early attempt.
      ok:
        late.length === ctx.options.runs &&
        runsWithEarlyPass === ctx.options.runs &&
        rows.every((row) => row.verdict !== 'FAIL' && row.consistent),
      extra: {
        clockOffset: clock,
        orders,
        lateTicks: lateTicks.length,
        earlyAttempts: early.length,
        earlyInconclusive: inconclusive.length,
        pickupMs: pickup,
      },
    };
  },
});
