#!/usr/bin/env tsx
import type { CommandInput } from '@seatrelay/scripts';
import { intOption } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import { capacitiesFrom } from './lib/capacities';
import { metricSum, metricsBaseline, metricsForRun, metricsSection } from './lib/metrics';
import { SUMMARY_HEADERS, markdownTable, summarize, summaryRow, type CsvRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  createWorkshop,
  ensureOrganisation,
  invariantSnapshot,
  latencySample,
  randomPreferences,
  seededRandom,
  shuffle,
  type CreatedWorkshop,
  type InvariantSnapshot,
  type LatencySample,
} from './lib/scenario';
import { errorText, sessionLabeller, trySend, type SendOutcome } from './lib/steps';

/**
 * Table 3 "Concurrency" (plan §4: "50 个账号并发争 3 场共 5 席"): N accounts (default 50) race
 * in parallel for 3 sessions with 5 seats in total (capacities 2/2/1, i.e. 10 accounts per
 * seat), then every account holding an offer fires ACCEPT, DECLINE and CANCEL for it at the
 * same time, then the accounts the queue moved up accept at once. After every phase `verify`
 * must be ok (C1, C2, no starvation) with 0 over-capacity and 0 double holds. Every command's
 * client- and server-side settle latency is recorded; the META conflict retries of the window
 * are read from the target's metrics (expected 0: one FIFO consumer per workshop).
 */
const USAGE = `
concurrency — Table 3 "Concurrency": parallel registration race + same-account command race

  pnpm --filter @seatrelay/experiments concurrency --target local|dev [--runs N]
       [--accounts 50] [--capacities 2,2,1] [--seed 1]

--capacities LIST      per-session capacities, 2..5 sessions (default 2,2,1: plan §4 "3 sessions,
                       5 seats in total")
--sessions N --capacity C   alternative: N sessions of C seats each (instead of --capacities)

Accounts: <prefix>-1 … <prefix>-<accounts>. Preferences are seeded random non-empty
permutations of a subset of the sessions (reproducible with --seed).
`;

const ORG_NAME = 'SeatRelay experiments';

interface CommandRow extends CsvRow {
  run: number;
  phase: string;
  account: number;
  type: string;
  status: string;
  reason: string;
  acceptMs: number | undefined;
  settleMs: number | undefined;
  serverSettleMs: number | undefined;
  polls: number | undefined;
  settledAt: string;
  error: string;
}

interface RaceOutcome {
  account: number;
  issueOrder: string;
  first: 'ACCEPT' | 'DECLINE' | 'CANCEL' | 'unknown';
  accept: string;
  decline: string;
  cancel: string;
  ok: boolean;
}

function rowOf(run: number, phase: string, account: number, type: string, outcome: SendOutcome): CommandRow {
  if (!outcome.ok) {
    return {
      run, phase, account, type, status: 'ERROR', reason: '', acceptMs: undefined, settleMs: undefined,
      serverSettleMs: undefined, polls: undefined, settledAt: '', error: errorText(outcome.error),
    };
  }
  const { settled } = outcome;
  return {
    run,
    phase,
    account,
    type,
    status: settled.record.status,
    reason: settled.record.reason ?? '',
    acceptMs: settled.acceptMs,
    settleMs: settled.settleMs,
    serverSettleMs: settled.serverSettleMs,
    polls: settled.polls,
    settledAt: settled.record.settledAt ?? '',
    error: '',
  };
}

const statusText = (outcome: SendOutcome): string =>
  outcome.ok
    ? `${outcome.settled.record.status}${outcome.settled.record.reason === undefined ? '' : `(${outcome.settled.record.reason})`}`
    : `ERROR ${errorText(outcome.error)}`;

async function checkPhase(
  ctx: ExperimentContext,
  run: number,
  phase: string,
  organiser: Account,
  orgId: string,
  ws: CreatedWorkshop,
): Promise<InvariantSnapshot> {
  const inv = await invariantSnapshot(organiser, orgId, ws.wsId);
  ctx.check({
    run,
    scenario: phase,
    step: 'verify after phase',
    ok: inv.ok,
    expected: 'verify ok, overCapacity 0, doubleHolds 0',
    actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}, overCapacity ${inv.overCapacity}, doubleHolds ${inv.doubleHolds}`,
  });
  return inv;
}

async function runOnce(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  accounts: readonly Account[],
  params: { capacities: number[]; seed: number },
  rows: CommandRow[],
  samples: LatencySample[],
  races: RaceOutcome[],
): Promise<Record<string, number>> {
  const timeout = ctx.options.settleTimeoutMs;
  const ws = await createWorkshop(organiser, orgId, {
    title: `Concurrency r${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: params.capacities.map((capacity) => ({ capacity })),
  });
  const label = sessionLabeller(ws);
  ctx.param(`run${run}.workshopId`, ws.wsId);
  const indexOf = new Map(accounts.map((account, i) => [account.userId, i + 1]));
  const record = (phase: string, account: number, type: string, outcome: SendOutcome): void => {
    rows.push(rowOf(run, phase, account, type, outcome));
    if (outcome.ok) {
      samples.push(latencySample(run, phase, outcome.settled, { account }));
    }
  };

  // Phase 1: everybody registers at once.
  const random = seededRandom(params.seed * 1000 + run);
  const prefs = accounts.map(() => randomPreferences(ws.sessionIds, random));
  ctx.log(`phase 1: ${accounts.length} concurrent REGISTERs`);
  const registered = await Promise.all(
    accounts.map((account, i) => trySend(account, ws.wsId, { type: 'REGISTER', acceptable: prefs[i] as string[] }, timeout)),
  );
  registered.forEach((outcome, i) => record('1 register race', i + 1, 'REGISTER', outcome));
  const registerApplied = registered.filter((outcome) => outcome.ok && outcome.settled.record.status === 'APPLIED').length;
  ctx.check({
    run, scenario: '1 register race', step: 'every REGISTER settled APPLIED',
    ok: registerApplied === accounts.length, expected: String(accounts.length), actual: String(registerApplied),
    detail: registered.filter((outcome) => !outcome.ok || outcome.settled.record.status !== 'APPLIED').map(statusText).slice(0, 5).join('; ') || undefined,
  });
  const inv1 = await checkPhase(ctx, run, '1 register race', organiser, orgId, ws);
  const seqs = [...inv1.dashboard.queue.map((entry) => entry.seq), ...inv1.dashboard.offered.map((entry) => entry.seq)].sort((a, b) => a - b);
  const seqsOk = seqs.length === registerApplied && seqs.every((seq, i) => seq === i + 1);
  ctx.check({
    run, scenario: '1 register race', step: 'seq unique and gap-free (R2)',
    ok: seqsOk, expected: `1..${registerApplied}`, actual: seqs.length <= 12 ? seqs.join(',') : `${seqs.length} seqs, ${seqs[0]}..${seqs[seqs.length - 1]}`,
  });
  const positions = inv1.dashboard.queue.map((entry) => entry.queuePosition);
  ctx.check({
    run, scenario: '1 register race', step: 'queue positions contiguous',
    ok: positions.every((position, i) => position === i + 1), expected: `1..${positions.length}`,
    actual: positions.length <= 12 ? positions.join(',') : `${positions.length} entries`,
  });
  const offered = inv1.dashboard.offered;
  const capacityTotal = params.capacities.reduce((sum, capacity) => sum + capacity, 0);
  ctx.log(`phase 1 done: ${offered.length} offered, ${inv1.dashboard.queue.length} queued (capacity ${capacityTotal})`, {
    perSession: inv1.dashboard.sessions.map((session) => `${label(session.id)} held ${session.held}/${session.capacity}`).join(', '),
  });

  // Phase 2: each offer holder fires ACCEPT, DECLINE and CANCEL concurrently.
  ctx.log(`phase 2: ${offered.length} accounts × ACCEPT/DECLINE/CANCEL concurrently`);
  const byUser = new Map(accounts.map((account) => [account.userId, account]));
  const raceRandom = seededRandom(params.seed * 7919 + run);
  const raceResults = await Promise.all(
    offered.map(async (entry) => {
      const account = byUser.get(entry.userId);
      if (account === undefined) {
        return undefined;
      }
      const inputs: [string, CommandInput][] = [
        ['ACCEPT', { type: 'ACCEPT_OFFER', offerId: entry.offer.id }],
        ['DECLINE', { type: 'DECLINE_OFFER', offerId: entry.offer.id }],
        ['CANCEL', { type: 'CANCEL_REGISTRATION' }],
      ];
      // The three POSTs leave in a seeded random order per account, so that every command
      // gets to arrive first in some races (all three are in flight at the same time).
      const issueOrder = shuffle([0, 1, 2], raceRandom);
      const pending = new Array<Promise<SendOutcome>>(3);
      for (const i of issueOrder) {
        pending[i] = trySend(account, ws.wsId, (inputs[i] as [string, CommandInput])[1], timeout);
      }
      const outcomes = await Promise.all(pending);
      return { account, entry, inputs, outcomes, issueOrder: issueOrder.map((i) => inputs[i]?.[0] ?? '?').join('>') };
    }),
  );
  for (const result of raceResults) {
    if (result === undefined) {
      continue;
    }
    const index = indexOf.get(result.account.userId) ?? 0;
    result.outcomes.forEach((outcome, i) => record('2 same-account race', index, result.inputs[i]?.[0] ?? '?', outcome));
    const [accept, decline, cancel] = result.outcomes as [SendOutcome, SendOutcome, SendOutcome];
    const applied = (outcome: SendOutcome): boolean => outcome.ok && outcome.settled.record.status === 'APPLIED';
    const reasonOk = (outcome: SendOutcome): boolean =>
      outcome.ok &&
      (outcome.settled.record.status === 'APPLIED' ||
        ['OFFER_NOT_ACTIVE', 'NOT_REGISTERED'].includes(outcome.settled.record.reason ?? ''));
    const first: RaceOutcome['first'] = applied(accept) ? 'ACCEPT' : applied(decline) ? 'DECLINE' : applied(cancel) ? 'CANCEL' : 'unknown';
    const me = (await result.account.client.getWorkshop(ws.wsId)).me;
    const ok =
      !(applied(accept) && applied(decline)) &&
      [accept, decline, cancel].every(reasonOk) &&
      first !== 'unknown' &&
      me === undefined;
    races.push({ account: index, issueOrder: result.issueOrder, first, accept: statusText(accept), decline: statusText(decline), cancel: statusText(cancel), ok });
    ctx.check({
      run, scenario: '2 same-account race', step: `account ${index}: exactly one of ACCEPT/DECLINE/CANCEL took effect first, no live registration left`,
      ok,
      expected: 'never ACCEPT and DECLINE both applied; rejections OFFER_NOT_ACTIVE/NOT_REGISTERED; no live registration',
      actual: `first ${first}; ACCEPT ${statusText(accept)}, DECLINE ${statusText(decline)}, CANCEL ${statusText(cancel)}; live ${me === undefined ? 'none' : me.status}`,
    });
  }
  const inv2 = await checkPhase(ctx, run, '2 same-account race', organiser, orgId, ws);

  // Phase 3: the accounts the queue moved up accept at once.
  const newlyOffered = inv2.dashboard.offered;
  ctx.log(`phase 3: ${newlyOffered.length} newly offered accounts accept concurrently`);
  const accepted = await Promise.all(
    newlyOffered.map(async (entry) => {
      const account = byUser.get(entry.userId);
      return account === undefined
        ? undefined
        : { index: indexOf.get(entry.userId) ?? 0, outcome: await trySend(account, ws.wsId, { type: 'ACCEPT_OFFER', offerId: entry.offer.id }, timeout) };
    }),
  );
  let acceptedOk = 0;
  for (const result of accepted) {
    if (result !== undefined) {
      record('3 accept storm', result.index, 'ACCEPT', result.outcome);
      if (result.outcome.ok && result.outcome.settled.record.status === 'APPLIED') {
        acceptedOk += 1;
      }
    }
  }
  ctx.check({
    run, scenario: '3 accept storm', step: 'every ACCEPT of a live offer applied',
    ok: acceptedOk === newlyOffered.length, expected: String(newlyOffered.length), actual: String(acceptedOk),
  });
  const inv3 = await checkPhase(ctx, run, '3 accept storm', organiser, orgId, ws);
  const confirmedOk = inv3.dashboard.sessions.every((session) => session.confirmed <= session.capacity);
  ctx.check({
    run, scenario: '3 accept storm', step: 'confirmed ≤ capacity in every session',
    ok: confirmedOk && inv3.dashboard.counts.confirmed === acceptedOk,
    expected: `confirmed = ${acceptedOk}, ≤ capacity per session (${params.capacities.join('/')})`,
    actual: inv3.dashboard.sessions.map((session) => `${label(session.id)} ${session.confirmed}/${session.capacity}`).join(', '),
  });
  return {
    offeredAfterRace: offered.length,
    queuedAfterRace: inv1.dashboard.queue.length,
    relayedAfterSameAccountRace: newlyOffered.length,
    confirmedAtEnd: inv3.dashboard.counts.confirmed,
    backfills: inv3.dashboard.counts.backfills,
  };
}

runExperiment({
  name: 'concurrency',
  tableRow: 'Concurrency (plan §4, Table 3)',
  criterion: 'final state satisfies every invariant (verify ok, 0 over-capacity, 0 double holds) after each concurrent phase; META conflict retries recorded (expected 0)',
  usage: USAGE,
  defaultHoldSeconds: 900,
  options: {
    accounts: { type: 'string' },
    capacities: { type: 'string' },
    sessions: { type: 'string' },
    capacity: { type: 'string' },
    seed: { type: 'string' },
  },
  async run(ctx) {
    const count = intOption(ctx.values, 'accounts', 50);
    const params = {
      capacities: capacitiesFrom(ctx.values),
      seed: intOption(ctx.values, 'seed', 1),
    };
    const capacityTotal = params.capacities.reduce((sum, capacity) => sum + capacity, 0);
    const organiser = await ctx.accounts.organiser();
    ctx.log(`obtaining ${count} participant tokens`);
    const accounts = await ctx.accounts.participants(count);
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);
    ctx.param('accounts', count);
    ctx.param('sessions', params.capacities.length);
    ctx.param('capacities', params.capacities.join(','));
    ctx.param('capacityTotal', capacityTotal);
    ctx.param('seed', params.seed);

    const baseline = await metricsBaseline(ctx);
    const rows: CommandRow[] = [];
    const samples: LatencySample[] = [];
    const races: RaceOutcome[] = [];
    const perRun: Record<string, number>[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      try {
        perRun.push(await runOnce(ctx, run, org.id, organiser, accounts, params, rows, samples, races));
      } catch (error) {
        ctx.fail('concurrency', 'run aborted', error);
      }
    }
    const metrics = await metricsForRun(ctx, baseline, ['MetaConflictRetries', 'CommandSettledLatency', 'OffersCreated']);
    const conflicts = metricSum(metrics, 'MetaConflictRetries');

    const phases = ['1 register race', '2 same-account race', '3 accept storm'];
    const latencyRows = phases.flatMap((phase) => {
      const inPhase = samples.filter((sample) => sample.step === phase);
      return [
        summaryRow(`${phase}: client-observed`, summarize(inPhase.map((sample) => sample.settleMs))),
        summaryRow(`${phase}: server-side`, summarize(inPhase.flatMap((sample) => (sample.serverSettleMs === undefined ? [] : [sample.serverSettleMs])))),
      ];
    });
    const allClient = summarize(samples.map((sample) => sample.settleMs));
    const allServer = summarize(samples.flatMap((sample) => (sample.serverSettleMs === undefined ? [] : [sample.serverSettleMs])));
    const firstCounts = races.reduce<Record<string, number>>((acc, race) => ({ ...acc, [race.first]: (acc[race.first] ?? 0) + 1 }), {});
    const errors = rows.filter((row) => row.status === 'ERROR').length;
    const lines = [
      '## Result',
      '',
      `- Setup: ${count} concurrent accounts race for ${params.capacities.length} sessions with ${capacityTotal} seats in total (capacities ${params.capacities.join('/')}; ${(count / capacityTotal).toFixed(1)} accounts per seat)`,
      `- Commands: ${rows.length} (${errors} transport errors / settle timeouts)`,
      `- Same-account races: ${races.filter((race) => race.ok).length}/${races.length} consistent; first effective command: ${Object.entries(firstCounts).map(([first, n]) => `${first} ${n}`).join(', ') || 'none'}`,
      `- META conflict retries in the window: **${conflicts === undefined ? 'not available' : conflicts}** (expected 0: FIFO, one consumer per workshop)`,
      '',
      '## Per run',
      '',
      markdownTable(
        ['run', 'offered after race', 'queued after race', 'relayed after same-account race', 'confirmed at end', 'backfill records'],
        perRun.map((values, i) => [i + 1, values.offeredAfterRace ?? '', values.queuedAfterRace ?? '', values.relayedAfterSameAccountRace ?? '', values.confirmedAtEnd ?? '', values.backfills ?? '']),
      ),
      '',
      '## Settle latencies',
      '',
      markdownTable(SUMMARY_HEADERS, [
        ...latencyRows,
        summaryRow('all commands: client-observed', allClient),
        summaryRow('all commands: server-side', allServer),
      ]),
      '',
      '## Same-account races',
      '',
      markdownTable(
        ['account', 'POST order', 'first effective', 'ACCEPT', 'DECLINE', 'CANCEL', 'verdict'],
        races.map((race) => [race.account, race.issueOrder, race.first, race.accept, race.decline, race.cancel, race.ok ? 'PASS' : 'FAIL']),
      ),
      '',
      '## Metrics',
      '',
      ...metricsSection(metrics, { MetaConflictRetries: 'expected 0', CommandSettledLatency: 'server-side settle ms (sum / samples)' }),
    ];
    return {
      summary: lines.join('\n'),
      rows,
      ok: errors === 0,
      extra: { capacities: params.capacities, settleMs: allClient, serverSettleMs: allServer, metaConflictRetries: conflicts ?? null, raceFirst: firstCounts, perRun },
    };
  },
});
