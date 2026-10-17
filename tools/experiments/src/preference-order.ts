#!/usr/bin/env tsx
import { intOption, mapWithConcurrency } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import {
  PREFERENCE_CASES,
  expectedAfterRegister,
  expectedAfterRelease,
  fillerSeats,
  type PreferenceCase,
} from './lib/preferenceCases';
import { SUMMARY_HEADERS, markdownTable, summarize, summaryRow, type CsvRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  createWorkshop,
  ensureOrganisation,
  invariantSnapshot,
  latencySample,
  myRegistration,
  type LatencySample,
} from './lib/scenario';
import { describeRegistration, errorText, sessionLabeller, trySend } from './lib/steps';

/**
 * Table 3 "Preference, order" (plan §4), deployment half: the 20 fixed cases of
 * `lib/preferenceCases.ts` replayed through the API. Each case fills seats with filler accounts,
 * registers the participant with a preference list and (optionally) releases a seat; the
 * allocated session must always be the first acceptable session with a free seat and never a
 * non-acceptable one. The random half (2,000 sequences) is core's fast-check property test.
 */
const USAGE = `
preference-order — Table 3 "Preference, order": 20 fixed preference cases replayed

  pnpm --filter @seatrelay/experiments preference-order --target local|dev [--runs N] [--parallel 5]

Each case creates a 5-session workshop; accounts: participant <prefix>-1, fillers <prefix>-2 … -7.
--parallel N   cases in flight at once (default 5)
`;

const ORG_NAME = 'SeatRelay experiments';

interface CaseOutcome extends CsvRow {
  run: number;
  case: string;
  prefs: string;
  full: string;
  release: string;
  expected: string;
  actual: string;
  expectedAfterRelease: string;
  actualAfterRelease: string;
  offeredNonAcceptable: boolean;
  verifyOk: boolean;
  ok: boolean;
  workshopId: string;
}

const sessionList = (sessions: readonly number[]): string => sessions.map((n) => `S${n}`).join(' ');

async function runCase(
  ctx: ExperimentContext,
  run: number,
  orgId: string,
  organiser: Account,
  participant: Account,
  fillers: readonly Account[],
  c: PreferenceCase,
  samples: LatencySample[],
): Promise<CaseOutcome> {
  const scenario = c.id;
  const fullSessions = c.fills.flatMap((fill, i) => (fill >= (c.capacities[i] ?? 0) ? [i + 1] : []));
  const outcome: CaseOutcome = {
    run,
    case: c.id,
    prefs: sessionList(c.prefs),
    full: sessionList(fullSessions),
    release: c.release === undefined ? '' : `S${c.release}`,
    expected: expectedAfterRegister(c),
    actual: '',
    expectedAfterRelease: expectedAfterRelease(c) ?? '',
    actualAfterRelease: '',
    offeredNonAcceptable: false,
    verifyOk: false,
    ok: false,
    workshopId: '',
  };
  const ws = await createWorkshop(organiser, orgId, {
    title: `Preference ${c.id} r${run} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: c.capacities.map((capacity) => ({ capacity })),
  });
  outcome.workshopId = ws.wsId;
  const label = sessionLabeller(ws);
  const sessionId = (n: number): string => ws.sessionIds[n - 1] ?? '';
  const timeout = ctx.options.settleTimeoutMs;

  // 1. fillers take their seats (concurrently: each lists a single session)
  const seats = fillerSeats(c);
  if (seats.length > fillers.length) {
    throw new Error(`${c.id} needs ${seats.length} fillers, only ${fillers.length} accounts`);
  }
  const fillerOf = new Map<number, Account>();
  const filled = await Promise.all(
    seats.map(async ([session], index) => {
      const filler = fillers[index] as Account;
      if (!fillerOf.has(session)) {
        fillerOf.set(session, filler);
      }
      return trySend(filler, ws.wsId, { type: 'REGISTER', acceptable: [sessionId(session)] }, timeout);
    }),
  );
  const fillersOk = filled.every(
    (result) => result.ok && result.settled.record.result?.registration?.status === 'OFFERED',
  );
  const dash = await organiser.client.dashboard(orgId, ws.wsId);
  const freeNow = ws.sessionIds.map((id) => dash.sessions.find((session) => session.id === id)?.free ?? -1);
  const freeExpected = c.capacities.map((capacity, i) => capacity - (c.fills[i] ?? 0));
  ctx.check({
    run,
    scenario,
    step: 'precondition: fillers hold their seats',
    ok: fillersOk && freeNow.join(',') === freeExpected.join(','),
    expected: `free ${freeExpected.join(',')}`,
    actual: `free ${freeNow.join(',')}${fillersOk ? '' : `; filler errors: ${filled.map((result) => (result.ok ? result.settled.record.status : errorText(result.error))).join(',')}`}`,
  });

  // 2. the participant registers
  const prefs = c.prefs.map(sessionId);
  const registered = await trySend(participant, ws.wsId, { type: 'REGISTER', acceptable: prefs }, timeout);
  if (!registered.ok) {
    ctx.fail(scenario, 'participant REGISTER', registered.error, run);
    return outcome;
  }
  samples.push(latencySample(run, `${c.id} REGISTER`, registered.settled, { case: c.id }));
  const registration = registered.settled.record.result?.registration;
  outcome.actual = describeRegistration(registration, label);
  const offeredSession = registration?.currentOffer?.sessionId;
  outcome.offeredNonAcceptable = offeredSession !== undefined && !prefs.includes(offeredSession);
  ctx.check({
    run,
    scenario,
    step: `REGISTER [${outcome.prefs}] with ${outcome.full || 'nothing'} full`,
    ok: outcome.actual === outcome.expected && !outcome.offeredNonAcceptable,
    expected: outcome.expected,
    actual: outcome.actual,
    ms: registered.settled.settleMs,
  });

  // 3. optional release
  let afterOk = true;
  if (c.release !== undefined) {
    const filler = fillerOf.get(c.release);
    const cancelled =
      filler === undefined
        ? undefined
        : await trySend(filler, ws.wsId, { type: 'CANCEL_REGISTRATION' }, timeout);
    if (cancelled !== undefined && cancelled.ok) {
      samples.push(latencySample(run, `${c.id} release CANCEL`, cancelled.settled, { case: c.id }));
    }
    const me = await myRegistration(participant, ws.wsId);
    outcome.actualAfterRelease = describeRegistration(me, label);
    const offeredAfter = me?.currentOffer?.sessionId;
    if (offeredAfter !== undefined && !prefs.includes(offeredAfter)) {
      outcome.offeredNonAcceptable = true;
    }
    afterOk =
      cancelled !== undefined &&
      cancelled.ok &&
      cancelled.settled.record.status === 'APPLIED' &&
      outcome.actualAfterRelease === outcome.expectedAfterRelease &&
      !outcome.offeredNonAcceptable;
    ctx.check({
      run,
      scenario,
      step: `release S${c.release} (filler cancels)`,
      ok: afterOk,
      expected: outcome.expectedAfterRelease,
      actual: `${outcome.actualAfterRelease}${cancelled === undefined ? ' (no filler)' : cancelled.ok ? '' : ` (cancel: ${errorText(cancelled.error)})`}`,
    });
  }

  // 4. invariants
  const inv = await invariantSnapshot(organiser, orgId, ws.wsId);
  outcome.verifyOk = inv.ok;
  ctx.check({
    run,
    scenario,
    step: 'verify',
    ok: inv.ok,
    expected: 'verify ok, overCapacity 0, doubleHolds 0',
    actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}, overCapacity ${inv.overCapacity}, doubleHolds ${inv.doubleHolds}`,
  });
  outcome.ok = fillersOk && outcome.actual === outcome.expected && afterOk && inv.ok && !outcome.offeredNonAcceptable;
  return outcome;
}

runExperiment({
  name: 'preference-order',
  tableRow: 'Preference, order (plan §4, Table 3) — deployment replay of 20 fixed cases',
  criterion: 'the allocated session is always the first acceptable session with a free seat; a non-acceptable session is never offered; verify ok',
  usage: USAGE,
  defaultHoldSeconds: 900,
  options: { parallel: { type: 'string' } },
  async run(ctx) {
    const parallel = Math.max(1, intOption(ctx.values, 'parallel', 5));
    const organiser = await ctx.accounts.organiser();
    const maxFillers = Math.max(...PREFERENCE_CASES.map((c) => fillerSeats(c).length));
    const accounts = await ctx.accounts.participants(1 + maxFillers);
    const [participant, ...fillers] = accounts;
    if (participant === undefined) {
      throw new Error('participant account missing');
    }
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);
    ctx.param('parallel', parallel);
    ctx.param('participant', participant.email);
    ctx.param('fillers', fillers.map((account) => account.email));

    const outcomes: CaseOutcome[] = [];
    const samples: LatencySample[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      const results = await mapWithConcurrency(PREFERENCE_CASES, parallel, async (c) => {
        try {
          return await runCase(ctx, run, org.id, organiser, participant, fillers, c, samples);
        } catch (error) {
          ctx.fail(c.id, 'case aborted', error, run);
          return undefined;
        }
      });
      outcomes.push(...results.filter((result): result is CaseOutcome => result !== undefined));
    }

    const passed = outcomes.filter((outcome) => outcome.ok).length;
    const nonAcceptable = outcomes.filter((outcome) => outcome.offeredNonAcceptable).length;
    const settle = summarize(samples.map((sample) => sample.settleMs));
    const lines = [
      '## Result',
      '',
      `- Cases: **${passed}/${PREFERENCE_CASES.length * ctx.options.runs}** as predicted by the oracle (first acceptable session with a free seat)`,
      `- Offers of a non-acceptable session: **${nonAcceptable}** (target 0)`,
      '- Random-sequence half of this row: core property test (`packages/core`, ≥ 2,000 fast-check sequences; `checkInvariants` after every step).',
      '',
      '## Cases',
      '',
      markdownTable(
        ['run', 'case', 'preferences', 'full before', 'expected', 'actual', 'release', 'expected after', 'actual after', 'verdict'],
        outcomes.map((outcome) => [
          outcome.run,
          `${outcome.case}: ${PREFERENCE_CASES.find((c) => c.id === outcome.case)?.note ?? ''}`,
          outcome.prefs,
          outcome.full || '—',
          outcome.expected,
          outcome.actual,
          outcome.release || '—',
          outcome.expectedAfterRelease || '—',
          outcome.actualAfterRelease || '—',
          outcome.ok ? 'PASS' : 'FAIL',
        ]),
      ),
      '',
      '## Command latencies',
      '',
      markdownTable(SUMMARY_HEADERS, [summaryRow('settle, client-observed', settle)]),
    ];
    return {
      summary: lines.join('\n'),
      rows: outcomes,
      extraFiles: { 'latency.csv': samples },
      ok: passed === PREFERENCE_CASES.length * ctx.options.runs && nonAcceptable === 0,
      extra: { cases: outcomes.length, passed, offeredNonAcceptable: nonAcceptable, settleMs: settle },
    };
  },
});
