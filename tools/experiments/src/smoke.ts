#!/usr/bin/env tsx
import { SUMMARY_HEADERS, markdownTable, summarize, summaryRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  createWorkshop,
  describeSettled,
  ensureOrganisation,
  invariantSnapshot,
  latencySample,
  myRegistration,
  requireRegistration,
  waitFor,
  type LatencySample,
} from './lib/scenario';

/**
 * The RUNBOOK §3 smoke scenario (plan §3 step 12), asserted step by step. It is the acceptance
 * test of both deployments: three participant accounts and one organiser go through register
 * → offer → accept → confirm, cancellation-driven backfill in the same settlement, an expiry
 * (holdSeconds elapses) relayed to the next person by the timer path, a late accept rejected
 * with OFFER_EXPIRED, and finally `verify` plus the dead-letter check.
 */
const USAGE = `
smoke — RUNBOOK §3 scenario against a running deployment (acceptance test)

  pnpm --filter @seatrelay/experiments smoke -- --target local|dev [--runs N] [--hold 60]

Each run creates a fresh workshop (2 sessions × capacity 1, holdSeconds = --hold) and waits for
one hold to elapse (~--hold seconds). Accounts: the organiser plus <prefix>-1/2/3 (alice, bob,
carol roles).
`;

const ORG_NAME = 'SeatRelay experiments';

async function smokeOnce(ctx: ExperimentContext, orgId: string, samples: LatencySample[]): Promise<void> {
  const run = ctx.currentRun;
  const scenario = 'smoke';
  const organiser = await ctx.accounts.organiser();
  const [alice, bob, carol] = await ctx.accounts.participants(3);
  if (alice === undefined || bob === undefined || carol === undefined) {
    throw new Error('three participant accounts are required');
  }
  const hold = ctx.options.holdSeconds;

  // 1. workshop
  const ws = await createWorkshop(organiser, orgId, {
    title: `Smoke workshop ${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: hold,
    sessions: [{ capacity: 1 }, { capacity: 1 }],
  });
  const [s1, s2] = ws.sessionIds;
  if (s1 === undefined || s2 === undefined) {
    throw new Error('workshop has fewer than two sessions');
  }
  ctx.check({
    scenario,
    step: '1 workshop created',
    ok: ws.sessions.length === 2 && ws.holdSeconds === hold,
    detail: `workshop ${ws.wsId}, sessions ${s1}, ${s2}`,
  });

  // 2. alice registers → OFFERED S1
  const aliceReg = await alice.client.sendCommand(ws.wsId, { type: 'REGISTER', acceptable: [s1, s2] });
  samples.push(latencySample(run, '2 alice REGISTER', aliceReg));
  const aliceState = requireRegistration(aliceReg, 'alice REGISTER');
  ctx.check({
    scenario,
    step: '2 alice OFFERED S1',
    ok: aliceState.status === 'OFFERED' && aliceState.currentOffer?.sessionId === s1,
    expected: `OFFERED@${s1}`,
    actual: describeSettled(aliceReg),
    ms: aliceReg.settleMs,
  });
  const aliceOffer = aliceState.currentOffer?.id ?? '';

  // 3. alice accepts; bob queues
  const aliceAccept = await alice.client.sendCommand(ws.wsId, { type: 'ACCEPT_OFFER', offerId: aliceOffer });
  samples.push(latencySample(run, '3 alice ACCEPT_OFFER', aliceAccept));
  const confirmed = aliceAccept.record.result?.registration;
  ctx.check({
    scenario,
    step: '3 alice CONFIRMED S1',
    ok: confirmed?.status === 'CONFIRMED' && confirmed.confirmedSessionId === s1,
    expected: `CONFIRMED@${s1}`,
    actual: describeSettled(aliceAccept),
    ms: aliceAccept.settleMs,
  });
  const bobReg = await bob.client.sendCommand(ws.wsId, { type: 'REGISTER', acceptable: [s1] });
  samples.push(latencySample(run, '3 bob REGISTER', bobReg));
  const bobState = bobReg.record.result?.registration;
  ctx.check({
    scenario,
    step: '3 bob QUEUED position 1',
    ok: bobState?.status === 'QUEUED' && bobState.queuePosition === 1,
    expected: 'QUEUED#1',
    actual: describeSettled(bobReg),
    ms: bobReg.settleMs,
  });

  // 4. alice cancels → bob offered in the same settlement
  const aliceCancel = await alice.client.sendCommand(ws.wsId, { type: 'CANCEL_REGISTRATION' });
  samples.push(latencySample(run, '4 alice CANCEL_REGISTRATION', aliceCancel));
  ctx.check({
    scenario,
    step: '4 alice CANCEL relays one offer',
    ok: aliceCancel.record.status === 'APPLIED' && aliceCancel.record.result?.offersCreated === 1,
    expected: 'APPLIED offersCreated=1',
    actual: `${describeSettled(aliceCancel)} offersCreated=${aliceCancel.record.result?.offersCreated}`,
    ms: aliceCancel.settleMs,
  });
  const bobMe = await myRegistration(bob, ws.wsId);
  ctx.check({
    scenario,
    step: '4 bob OFFERED S1',
    ok: bobMe?.status === 'OFFERED' && bobMe.currentOffer?.sessionId === s1,
    expected: `OFFERED@${s1}`,
    actual: `${bobMe?.status}@${bobMe?.currentOffer?.sessionId}`,
  });
  const bobOffer = bobMe?.currentOffer;
  const dash4 = await organiser.client.dashboard(orgId, ws.wsId);
  const cancelBackfills = dash4.backfills.filter((record) => record.cause === 'CANCELLED_CONFIRMED');
  ctx.check({
    scenario,
    step: '4 backfill CANCELLED_CONFIRMED latency 0',
    ok: dash4.backfills.length === 1 && cancelBackfills[0]?.latencyMs === 0 && cancelBackfills[0].newUserId === bob.userId,
    expected: '1 record, latencyMs 0, newUserId bob',
    actual: JSON.stringify(dash4.backfills.map((record) => ({ cause: record.cause, latencyMs: record.latencyMs }))),
  });

  // 5. carol queues; bob's offer expires; carol gets the seat through the timer path
  const carolReg = await carol.client.sendCommand(ws.wsId, { type: 'REGISTER', acceptable: [s1] });
  samples.push(latencySample(run, '5 carol REGISTER', carolReg));
  ctx.check({
    scenario,
    step: '5 carol QUEUED',
    ok: carolReg.record.result?.registration?.status === 'QUEUED',
    expected: 'QUEUED',
    actual: describeSettled(carolReg),
    ms: carolReg.settleMs,
  });
  const expiresAt = bobOffer === undefined ? Date.now() + hold * 1000 : Date.parse(bobOffer.expiresAt);
  ctx.log(`waiting for bob's offer to expire at ${new Date(expiresAt).toISOString()} (~${Math.max(0, Math.round((expiresAt - Date.now()) / 1000))} s)`);
  let observedAt = '';
  try {
    const carolMe = await waitFor(
      'carol to be OFFERED after the expiry',
      async () => {
        const me = await myRegistration(carol, ws.wsId);
        return me?.status === 'OFFERED' ? me : undefined;
      },
      { timeoutMs: Math.max(0, expiresAt - Date.now()) + 90_000, intervalMs: 1000 },
    );
    observedAt = new Date().toISOString();
    ctx.check({
      scenario,
      step: '5 carol OFFERED S1 after expiry',
      ok: carolMe.currentOffer?.sessionId === s1,
      expected: `OFFERED@${s1}`,
      actual: `${carolMe.status}@${carolMe.currentOffer?.sessionId} observed ${observedAt}`,
      ms: Date.now() - expiresAt,
    });
  } catch (error) {
    ctx.fail(scenario, '5 carol OFFERED S1 after expiry', error);
  }
  const dash5 = await organiser.client.dashboard(orgId, ws.wsId);
  const expired = dash5.backfills.filter((record) => record.cause === 'EXPIRED');
  const expiryLatency = expired[0]?.latencyMs;
  ctx.check({
    scenario,
    step: '5 backfill EXPIRED relayed within 15 s',
    ok: expired.length === 1 && expiryLatency !== undefined && expiryLatency < 15_000,
    expected: '1 EXPIRED record, latencyMs < 15000',
    actual: JSON.stringify(expired.map((record) => ({ latencyMs: record.latencyMs, reallocatedAt: record.reallocatedAt }))),
    ...(expiryLatency === undefined ? {} : { ms: expiryLatency }),
  });
  ctx.param(`run${run}.expiryBackfillLatencyMs`, expiryLatency ?? null);

  // 6. bob's late accept
  const bobAccept = await bob.client.sendCommand(ws.wsId, { type: 'ACCEPT_OFFER', offerId: bobOffer?.id ?? 'missing' });
  samples.push(latencySample(run, '6 bob ACCEPT_OFFER (late)', bobAccept));
  ctx.check({
    scenario,
    step: '6 bob late ACCEPT rejected OFFER_EXPIRED',
    ok: bobAccept.record.status === 'REJECTED' && bobAccept.record.reason === 'OFFER_EXPIRED',
    expected: 'REJECTED(OFFER_EXPIRED)',
    actual: describeSettled(bobAccept),
    ms: bobAccept.settleMs,
  });

  // 7. verify + dead letters
  const inv = await invariantSnapshot(organiser, orgId, ws.wsId);
  ctx.check({
    scenario,
    step: '7 verify ok, no over-capacity, no double holds',
    ok: inv.ok,
    expected: 'ok=true overCapacity=0 doubleHolds=0',
    actual: `ok=${inv.verify.ok} overCapacity=${inv.overCapacity} doubleHolds=${inv.doubleHolds} violations=${JSON.stringify(inv.verify.violations)}`,
  });
  const dead = await ctx.ops.deadLetters();
  if (dead.available) {
    ctx.check({ scenario, step: '7 dead letters empty', ok: dead.total === 0, expected: '0', actual: String(dead.total), detail: dead.detail });
  } else {
    ctx.log(`dead-letter check skipped: ${dead.detail}`);
  }
  ctx.param(`run${run}.workshopId`, ws.wsId);
}

runExperiment({
  name: 'smoke',
  tableRow: 'Acceptance smoke test (RUNBOOK §3, plan §3 step 12; both deployments)',
  criterion: 'every step asserts; cancellation backfill in the same settlement (0 ms); expiry relayed by the timer path within 15 s; late ACCEPT → OFFER_EXPIRED; verify ok; DLQ / FAILED rows empty',
  usage: USAGE,
  async run(ctx) {
    const organiser = await ctx.accounts.organiser();
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);
    const samples: LatencySample[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      try {
        await smokeOnce(ctx, org.id, samples);
      } catch (error) {
        ctx.fail('smoke', 'scenario aborted', error);
      }
    }
    const settle = summarize(samples.map((sample) => sample.settleMs));
    const server = summarize(samples.flatMap((sample) => (sample.serverSettleMs === undefined ? [] : [sample.serverSettleMs])));
    const expiryLatencies = Object.entries(ctx.params)
      .filter(([key, value]) => key.endsWith('expiryBackfillLatencyMs') && typeof value === 'number')
      .map(([, value]) => value as number);
    const lines = [
      '## Steps',
      '',
      markdownTable(
        ['run', 'step', 'result', 'expected', 'actual', 'ms'],
        ctx.checks.map((row) => [row.run, row.step, row.ok ? 'PASS' : 'FAIL', row.expected, row.actual, row.ms === undefined ? '' : Math.round(row.ms)]),
      ),
      '',
      '## Latencies',
      '',
      markdownTable(SUMMARY_HEADERS, [
        summaryRow('command settle, client-observed (POST → terminal poll)', settle),
        summaryRow('command settle, server-side (settledAt − acceptedAt)', server),
        summaryRow('expiry-driven backfill (reallocatedAt − expiresAt)', summarize(expiryLatencies)),
      ]),
      '',
      'Cancellation-driven backfills happen inside the cancelling command\'s own settlement (latencyMs 0 by construction; asserted in step 4).',
    ];
    return {
      summary: lines.join('\n'),
      rows: samples,
      extra: { settleMs: settle, serverSettleMs: server, expiryBackfillLatencyMs: expiryLatencies },
    };
  },
});
