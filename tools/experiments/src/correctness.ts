#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import type { BackfillCause, DashboardView, RejectReason } from '@seatrelay/contracts';
import { CliError, stringOption } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import { SUMMARY_HEADERS, markdownTable, summarize, summaryRow } from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import { createWorkshop, ensureOrganisation, type LatencySample, type SessionSpec } from './lib/scenario';
import {
  ScenarioRun,
  describeRegistration,
  emptyTotals,
  offerIdOf,
  type ExpectedOutcome,
  type InvariantTotals,
} from './lib/steps';

/**
 * Table 3 "Core correctness" (plan §4): scripted scenarios — register / confirm / decline /
 * cancel / capacity up and down / cancel session / cancel workshop (+ close/open registration
 * and the deterministic rejections) — each on a fresh workshop, every command sent like the
 * browser sends it, its outcome asserted, and `verify` plus the client-side over-capacity and
 * double-hold counters read after every step.
 */
const USAGE = `
correctness — Table 3 "Core correctness": scripted scenarios with verify after every step

  pnpm --filter @seatrelay/experiments correctness --target local|dev [--runs N] [--scenarios a,b]

Scenarios: 
Each scenario creates its own workshop (2 sessions, holdSeconds = --hold, default 900) in the
organiser's "SeatRelay experiments" organisation and uses participants <prefix>-1 … <prefix>-5.
Pass: every step as expected, 0 over-capacity, 0 double holds, verify ok after every step.
`;

const ORG_NAME = 'SeatRelay experiments';
const APPLIED = { status: 'APPLIED' } as const;
const rejected = (reason: RejectReason): ExpectedOutcome => ({ status: 'REJECTED', reason });

interface People {
  A: Account;
  B: Account;
  C: Account;
  D: Account;
  E: Account;
}

interface ScenarioDef {
  name: string;
  description: string;
  sessions: SessionSpec[];
  run(sr: ScenarioRun, p: People): Promise<void>;
}

async function dashboard(sr: ScenarioRun): Promise<DashboardView> {
  return sr.organiser.client.dashboard(sr.orgId, sr.wsId);
}

/** Asserts that the latest backfill record of `cause` was relayed to `who` within the same settlement. */
async function expectSameSettlementBackfill(sr: ScenarioRun, cause: BackfillCause, who: Account, count = 1): Promise<void> {
  const dash = await dashboard(sr);
  const records = dash.backfills.filter((record) => record.cause === cause);
  const relayed = records.filter((record) => record.newUserId === who.userId);
  sr.expect(
    `backfill ${cause} relayed in the same settlement`,
    records.length === count && relayed.length >= 1 && records.every((record) => record.latencyMs === 0),
    `${count} × ${cause}, latencyMs 0, one to ${who.email}`,
    JSON.stringify(records.map((record) => ({ session: sr.label(record.sessionId), latencyMs: record.latencyMs, toCaller: record.newUserId === who.userId }))),
  );
}

const SCENARIOS: ScenarioDef[] = [
  {
    name: 'register-confirm',
    description: 'REGISTER → OFFERED on the first preference with a free seat → ACCEPT → CONFIRMED; R1 duplicate rejected; queueing when full',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A, B, C }) {
      const [s1, s2] = [sr.s(1), sr.s(2)];
      const a = await sr.step('A REGISTER [S1,S2]', A, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'OFFERED@S1');
      await sr.step('A ACCEPT_OFFER', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      await sr.step('A REGISTER again (R1)', A, { type: 'REGISTER', acceptable: [s2] }, rejected('ALREADY_REGISTERED'));
      const b = await sr.step('B REGISTER [S2,S1]', B, { type: 'REGISTER', acceptable: [s2, s1] }, APPLIED, 'OFFERED@S2');
      await sr.step('C REGISTER [S1] (full)', C, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      await sr.step('B ACCEPT_OFFER', B, { type: 'ACCEPT_OFFER', offerId: offerIdOf(b) }, APPLIED, 'CONFIRMED@S2');
      const dash = await dashboard(sr);
      sr.expect(
        'dashboard counts',
        dash.counts.confirmed === 2 && dash.distinctParticipantsServed === 2 && dash.counts.queued === 1 && dash.counts.offered === 0,
        'confirmed 2, distinct served 2, queued 1, offered 0',
        `confirmed ${dash.counts.confirmed}, distinct served ${dash.distinctParticipantsServed}, queued ${dash.counts.queued}, offered ${dash.counts.offered}`,
      );
    },
  },
  {
    name: 'rejections',
    description: 'deterministic rejections leave no trace: duplicate/unknown preferences, unknown offer, cancel without registration',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A }) {
      const [s1] = [sr.s(1)];
      await sr.step('A REGISTER [S1,S1]', A, { type: 'REGISTER', acceptable: [s1, s1] }, rejected('DUPLICATE_SESSION_IN_PREFERENCES'));
      await sr.step('A REGISTER [unknown]', A, { type: 'REGISTER', acceptable: [randomUUID()] }, rejected('UNKNOWN_SESSION_IN_PREFERENCES'));
      await sr.step('A ACCEPT_OFFER unknown offer', A, { type: 'ACCEPT_OFFER', offerId: randomUUID() }, rejected('OFFER_NOT_FOUND'));
      await sr.step('A DECLINE_OFFER unknown offer', A, { type: 'DECLINE_OFFER', offerId: randomUUID() }, rejected('OFFER_NOT_FOUND'));
      await sr.step('A CANCEL_REGISTRATION (not registered)', A, { type: 'CANCEL_REGISTRATION' }, rejected('NOT_REGISTERED'));
      const a = await sr.step('A REGISTER [S1]', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      const seq = a?.record.result?.registration?.seq;
      sr.expect('rejected commands consumed no seq', seq === 1, 'seq 1', `seq ${seq}`);
    },
  },
  {
    name: 'decline',
    description: 'DECLINE drops the session (R5): next preference offered and the declined seat relayed, both in the same settlement; last preference declined → ENDED',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A, B }) {
      const [s1, s2] = [sr.s(1), sr.s(2)];
      const a = await sr.step('A REGISTER [S1,S2]', A, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'OFFERED@S1');
      await sr.step('B REGISTER [S1]', B, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      const declined = await sr.step('A DECLINE_OFFER S1', A, { type: 'DECLINE_OFFER', offerId: offerIdOf(a) }, APPLIED, 'OFFERED@S2');
      await sr.expectState('B gets the declined S1 seat', B, 'OFFERED@S1');
      await expectSameSettlementBackfill(sr, 'DECLINED', B);
      await sr.step('A DECLINE_OFFER S2 (last preference)', A, { type: 'DECLINE_OFFER', offerId: offerIdOf(declined) }, APPLIED, 'ENDED(NO_ACCEPTABLE_SESSION)');
      await sr.expectState('A has no live registration', A, 'none');
      await sr.step('A DECLINE_OFFER S1 again', A, { type: 'DECLINE_OFFER', offerId: offerIdOf(a) }, rejected('OFFER_NOT_ACTIVE'));
      const b = await sr.expectState('B still OFFERED S1', B, 'OFFERED@S1');
      await sr.step('B ACCEPT_OFFER', B, { type: 'ACCEPT_OFFER', offerId: b?.currentOffer?.id ?? '' }, APPLIED, 'CONFIRMED@S1');
    },
  },
  {
    name: 'cancel',
    description: 'CANCEL from CONFIRMED / OFFERED / QUEUED (R6): released seats relayed in the same settlement; re-registration gets a new seq at the tail',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A, B, C, D }) {
      const [s1] = [sr.s(1)];
      const a = await sr.step('A REGISTER [S1]', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      await sr.step('A ACCEPT_OFFER', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      await sr.step('B REGISTER [S1]', B, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      await sr.step('C REGISTER [S1]', C, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#2');
      await sr.step('A CANCEL_REGISTRATION (confirmed)', A, { type: 'CANCEL_REGISTRATION' }, APPLIED, 'CANCELLED');
      await sr.expectState('B gets the seat', B, 'OFFERED@S1');
      await sr.expectState('C moves up', C, 'QUEUED#1');
      await expectSameSettlementBackfill(sr, 'CANCELLED_CONFIRMED', B);
      await sr.step('B CANCEL_REGISTRATION (offered)', B, { type: 'CANCEL_REGISTRATION' }, APPLIED, 'CANCELLED');
      await sr.expectState('C gets the seat', C, 'OFFERED@S1');
      await expectSameSettlementBackfill(sr, 'CANCELLED_OFFER', C);
      const d = await sr.step('D REGISTER [S1]', D, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      await sr.step('D CANCEL_REGISTRATION (queued)', D, { type: 'CANCEL_REGISTRATION' }, APPLIED, 'CANCELLED');
      await sr.expectState('D has no live registration', D, 'none');
      await sr.step('D CANCEL_REGISTRATION again', D, { type: 'CANCEL_REGISTRATION' }, rejected('NOT_REGISTERED'));
      const again = await sr.step('A REGISTER [S1] again', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      const before = d?.record.result?.registration?.seq ?? 0;
      const after = again?.record.result?.registration?.seq ?? 0;
      sr.expect('re-registration gets a new seq at the tail (R6)', after > before && before > 0, `seq > ${before}`, `seq ${after}`);
    },
  },
  {
    name: 'capacity-up',
    description: 'SET_CAPACITY up relays the new seats to the queue in the same settlement (CAPACITY_UP backfills)',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A, B, C, D }) {
      const [s1, s2] = [sr.s(1), sr.s(2)];
      const organiser = sr.organiser;
      const a = await sr.step('A REGISTER [S1]', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      await sr.step('A ACCEPT_OFFER', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      await sr.step('B REGISTER [S1]', B, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      await sr.step('C REGISTER [S1]', C, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#2');
      await sr.step('D REGISTER [S2,S1]', D, { type: 'REGISTER', acceptable: [s2, s1] }, APPLIED, 'OFFERED@S2');
      const up = await sr.step('SET_CAPACITY S1 1 → 3', organiser, { type: 'SET_CAPACITY', sessionId: s1, capacity: 3 }, APPLIED);
      sr.expect('two offers created by the capacity increase', up?.record.result?.offersCreated === 2, 'offersCreated 2', `offersCreated ${up?.record.result?.offersCreated}`);
      await sr.expectState('B offered', B, 'OFFERED@S1');
      await sr.expectState('C offered', C, 'OFFERED@S1');
      await sr.expectState('D keeps S2', D, 'OFFERED@S2');
      const dash = await dashboard(sr);
      const s1View = dash.sessions.find((session) => session.id === s1);
      const capacityUp = dash.backfills.filter((record) => record.cause === 'CAPACITY_UP');
      sr.expect(
        'S1 3 seats, 0 free; 2 CAPACITY_UP backfills at 0 ms',
        s1View?.capacity === 3 && s1View.free === 0 && capacityUp.length === 2 && capacityUp.every((record) => record.latencyMs === 0),
        'capacity 3, free 0, 2 × CAPACITY_UP latency 0',
        `capacity ${s1View?.capacity}, free ${s1View?.free}, ${JSON.stringify(capacityUp.map((record) => record.latencyMs))}`,
      );
      const more = await sr.step('SET_CAPACITY S1 3 → 4 (nobody waiting)', organiser, { type: 'SET_CAPACITY', sessionId: s1, capacity: 4 }, APPLIED);
      sr.expect('no offer without demand', more?.record.result?.offersCreated === 0, 'offersCreated 0', `offersCreated ${more?.record.result?.offersCreated}`);
    },
  },
  {
    name: 'capacity-down',
    description: 'SET_CAPACITY below confirmed + held is rejected (R7), to exactly the usage is applied; invalid values rejected',
    sessions: [{ capacity: 3 }, { capacity: 1 }],
    async run(sr, { A, B, C }) {
      const [s1] = [sr.s(1)];
      const organiser = sr.organiser;
      const a = await sr.step('A REGISTER [S1]', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      await sr.step('A ACCEPT_OFFER', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      await sr.step('B REGISTER [S1]', B, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      await sr.step('SET_CAPACITY S1 3 → 1 (below usage 2)', organiser, { type: 'SET_CAPACITY', sessionId: s1, capacity: 1 }, rejected('CAPACITY_BELOW_USAGE'));
      await sr.step('SET_CAPACITY S1 → 0', organiser, { type: 'SET_CAPACITY', sessionId: s1, capacity: 0 }, rejected('INVALID_CAPACITY'));
      let s1View = (await dashboard(sr)).sessions.find((session) => session.id === s1);
      sr.expect('capacity unchanged after rejections', s1View?.capacity === 3, 'capacity 3', `capacity ${s1View?.capacity}`);
      await sr.step('SET_CAPACITY S1 3 → 2 (= usage)', organiser, { type: 'SET_CAPACITY', sessionId: s1, capacity: 2 }, APPLIED);
      s1View = (await dashboard(sr)).sessions.find((session) => session.id === s1);
      sr.expect('S1 capacity 2, free 0', s1View?.capacity === 2 && s1View.free === 0, 'capacity 2, free 0', `capacity ${s1View?.capacity}, free ${s1View?.free}`);
      await sr.step('C REGISTER [S1] (now full)', C, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'QUEUED#1');
      await sr.step('SET_CAPACITY unknown session', organiser, { type: 'SET_CAPACITY', sessionId: randomUUID(), capacity: 5 }, rejected('SESSION_NOT_FOUND'));
    },
  },
  {
    name: 'cancel-session',
    description: 'CANCEL_SESSION revokes held seats, releases confirmed ones and drops the session from every preference list; owners queue for their other sessions',
    sessions: [{ capacity: 2 }, { capacity: 1 }],
    async run(sr, { A, B, C, D, E }) {
      const [s1, s2] = [sr.s(1), sr.s(2)];
      const organiser = sr.organiser;
      const a = await sr.step('A REGISTER [S1,S2]', A, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'OFFERED@S1');
      await sr.step('A ACCEPT_OFFER', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      const b = await sr.step('B REGISTER [S1,S2]', B, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'OFFERED@S1');
      const c = await sr.step('C REGISTER [S2]', C, { type: 'REGISTER', acceptable: [s2] }, APPLIED, 'OFFERED@S2');
      await sr.step('C ACCEPT_OFFER', C, { type: 'ACCEPT_OFFER', offerId: offerIdOf(c) }, APPLIED, 'CONFIRMED@S2');
      await sr.step('D REGISTER [S1,S2] (both full)', D, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'QUEUED#1');
      await sr.step('CANCEL_SESSION S1', organiser, { type: 'CANCEL_SESSION', sessionId: s1 }, APPLIED);
      const s1View = (await dashboard(sr)).sessions.find((session) => session.id === s1);
      sr.expect(
        'S1 CANCELLED with no seats in use',
        s1View?.status === 'CANCELLED' && s1View.confirmed === 0 && s1View.held === 0,
        'CANCELLED, confirmed 0, held 0',
        `${s1View?.status}, confirmed ${s1View?.confirmed}, held ${s1View?.held}`,
      );
      await sr.expectState('A (was confirmed in S1) queues for S2', A, 'QUEUED#1');
      await sr.expectState('B (offer revoked) queues for S2', B, 'QUEUED#2');
      await sr.expectState('D queues for S2', D, 'QUEUED#3');
      await sr.expectState('C keeps S2', C, 'CONFIRMED@S2');
      await sr.step('B ACCEPT_OFFER revoked offer', B, { type: 'ACCEPT_OFFER', offerId: offerIdOf(b) }, rejected('OFFER_NOT_ACTIVE'));
      await sr.step('E REGISTER [S1] (cancelled)', E, { type: 'REGISTER', acceptable: [s1] }, rejected('NO_ACCEPTABLE_SESSION'));
      await sr.step('SET_CAPACITY S1 (cancelled)', organiser, { type: 'SET_CAPACITY', sessionId: s1, capacity: 5 }, rejected('SESSION_CANCELLED'));
      await sr.step('C CANCEL_REGISTRATION', C, { type: 'CANCEL_REGISTRATION' }, APPLIED, 'CANCELLED');
      await sr.expectState('A (lowest seq) gets S2', A, 'OFFERED@S2');
      await sr.expectState('B moves up', B, 'QUEUED#1');
      await sr.expectState('D moves up', D, 'QUEUED#2');
    },
  },
  {
    name: 'cancel-workshop',
    description: 'CANCEL_WORKSHOP ends every registration (WORKSHOP_CANCELLED), releases every seat and rejects later commands',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A, B, C, D }) {
      const [s1, s2] = [sr.s(1), sr.s(2)];
      const organiser = sr.organiser;
      const a = await sr.step('A REGISTER [S1]', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      await sr.step('A ACCEPT_OFFER', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      const b = await sr.step('B REGISTER [S2]', B, { type: 'REGISTER', acceptable: [s2] }, APPLIED, 'OFFERED@S2');
      await sr.step('C REGISTER [S1,S2]', C, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'QUEUED#1');
      await sr.step('CANCEL_WORKSHOP', organiser, { type: 'CANCEL_WORKSHOP' }, APPLIED);
      const dash = await dashboard(sr);
      sr.expect(
        'workshop and sessions CANCELLED, nothing live',
        dash.workshop.status === 'CANCELLED' &&
          dash.sessions.every((session) => session.status === 'CANCELLED' && session.confirmed === 0 && session.held === 0) &&
          dash.counts.queued + dash.counts.offered + dash.counts.confirmed === 0,
        'CANCELLED; sessions CANCELLED with 0 seats in use; 0 live registrations',
        `${dash.workshop.status}; sessions ${dash.sessions.map((session) => `${session.status}/${session.confirmed}/${session.held}`).join(' ')}; live ${dash.counts.queued + dash.counts.offered + dash.counts.confirmed}`,
      );
      for (const [name, who] of [['A', A], ['B', B], ['C', C]] as const) {
        await sr.expectState(`${name} has no live registration`, who, 'none');
      }
      const mine = (await A.client.myRegistrations()).registrations.find((entry) => entry.workshop.id === sr.wsId);
      const archived = describeRegistration(mine?.registration, sr.label);
      sr.expect('A sees ENDED(WORKSHOP_CANCELLED) in /me/registrations', archived === 'ENDED(WORKSHOP_CANCELLED)', 'ENDED(WORKSHOP_CANCELLED)', archived);
      await sr.step('D REGISTER after cancel', D, { type: 'REGISTER', acceptable: [s1] }, rejected('WORKSHOP_CANCELLED'));
      await sr.step('B ACCEPT_OFFER after cancel', B, { type: 'ACCEPT_OFFER', offerId: offerIdOf(b) }, rejected('WORKSHOP_CANCELLED'));
      await sr.step('CANCEL_WORKSHOP again', organiser, { type: 'CANCEL_WORKSHOP' }, rejected('WORKSHOP_CANCELLED'));
    },
  },
  {
    name: 'close-open',
    description: 'CLOSE_REGISTRATION blocks new registrations but keeps offers acceptable; OPEN_REGISTRATION reopens',
    sessions: [{ capacity: 1 }, { capacity: 1 }],
    async run(sr, { A, B }) {
      const [s1, s2] = [sr.s(1), sr.s(2)];
      const organiser = sr.organiser;
      const a = await sr.step('A REGISTER [S1]', A, { type: 'REGISTER', acceptable: [s1] }, APPLIED, 'OFFERED@S1');
      await sr.step('CLOSE_REGISTRATION', organiser, { type: 'CLOSE_REGISTRATION' }, APPLIED);
      await sr.step('B REGISTER while closed', B, { type: 'REGISTER', acceptable: [s1, s2] }, rejected('WORKSHOP_NOT_OPEN'));
      await sr.step('A ACCEPT_OFFER while closed', A, { type: 'ACCEPT_OFFER', offerId: offerIdOf(a) }, APPLIED, 'CONFIRMED@S1');
      await sr.step('CLOSE_REGISTRATION again', organiser, { type: 'CLOSE_REGISTRATION' }, rejected('INVALID_STATE'));
      await sr.step('OPEN_REGISTRATION', organiser, { type: 'OPEN_REGISTRATION' }, APPLIED);
      await sr.step('B REGISTER after reopening', B, { type: 'REGISTER', acceptable: [s1, s2] }, APPLIED, 'OFFERED@S2');
    },
  },
];

const SCENARIO_NAMES = SCENARIOS.map((scenario) => scenario.name);

interface ScenarioResult {
  run: number;
  name: string;
  workshopId: string;
  checks: number;
  failed: number;
  totals: InvariantTotals;
  error?: string;
}

function selectedScenarios(ctx: ExperimentContext): ScenarioDef[] {
  const raw = stringOption(ctx.values, 'scenarios');
  if (raw === undefined) {
    return SCENARIOS;
  }
  const wanted = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
  const unknown = wanted.filter((name) => !SCENARIO_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new CliError(`unknown scenario(s) ${unknown.join(', ')} (known: ${SCENARIO_NAMES.join(', ')})`);
  }
  return SCENARIOS.filter((scenario) => wanted.includes(scenario.name));
}

runExperiment({
  name: 'correctness',
  tableRow: 'Core correctness (plan §4, Table 3)',
  criterion: 'every scripted step as expected; verify ok after every step; 0 over-capacity; 0 double holds',
  usage: USAGE.replace('Scenarios: ', `Scenarios: ${SCENARIO_NAMES.join(', ')}`),
  defaultHoldSeconds: 900,
  options: { scenarios: { type: 'string' } },
  async run(ctx) {
    const scenarios = selectedScenarios(ctx);
    const organiser = await ctx.accounts.organiser();
    const [A, B, C, D, E] = await ctx.accounts.participants(5);
    if (A === undefined || B === undefined || C === undefined || D === undefined || E === undefined) {
      throw new Error('five participant accounts are required');
    }
    const people: People = { A, B, C, D, E };
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);
    ctx.param('scenarios', scenarios.map((scenario) => scenario.name));
    ctx.param('participants', [A, B, C, D, E].map((account) => account.email));

    const samples: LatencySample[] = [];
    const results: ScenarioResult[] = [];
    const grand = emptyTotals();
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      for (const scenario of scenarios) {
        const before = ctx.checks.length;
        const failedBefore = ctx.failedChecks.length;
        const totals = emptyTotals();
        let workshopId = '';
        let error: string | undefined;
        try {
          const ws = await createWorkshop(organiser, org.id, {
            title: `Correctness ${scenario.name} r${run} (${ctx.runId.slice(0, 8)})`,
            holdSeconds: ctx.options.holdSeconds,
            sessions: scenario.sessions,
          });
          workshopId = ws.wsId;
          ctx.log(`scenario ${scenario.name}: workshop ${ws.wsId}`);
          const sr = new ScenarioRun(ctx, scenario.name, organiser, org.id, ws, totals, samples);
          await sr.verify('workshop creation');
          await scenario.run(sr, people);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          ctx.fail(scenario.name, 'scenario aborted', caught);
        }
        grand.verifications += totals.verifications;
        grand.verifyFailures += totals.verifyFailures;
        grand.overCapacity += totals.overCapacity;
        grand.doubleHolds += totals.doubleHolds;
        for (const [code, count] of Object.entries(totals.violationCodes)) {
          grand.violationCodes[code] = (grand.violationCodes[code] ?? 0) + count;
        }
        results.push({
          run,
          name: scenario.name,
          workshopId,
          checks: ctx.checks.length - before,
          failed: ctx.failedChecks.length - failedBefore,
          totals,
          ...(error === undefined ? {} : { error }),
        });
      }
    }

    const settle = summarize(samples.map((sample) => sample.settleMs));
    const server = summarize(samples.flatMap((sample) => (sample.serverSettleMs === undefined ? [] : [sample.serverSettleMs])));
    const allPassed = results.every((result) => result.failed === 0);
    const lines = [
      '## Result',
      '',
      `- Scenarios: ${results.filter((result) => result.failed === 0).length}/${results.length} passed`,
      `- Over-capacity observations: **${grand.overCapacity}** (target 0) over ${grand.verifications} post-step reads`,
      `- Double holds: **${grand.doubleHolds}** (target 0)`,
      `- verify failures: ${grand.verifyFailures}${Object.keys(grand.violationCodes).length === 0 ? '' : ` (${Object.entries(grand.violationCodes).map(([code, count]) => `${code} × ${count}`).join(', ')})`}`,
      '',
      '## Scenarios',
      '',
      markdownTable(
        ['run', 'scenario', 'what it exercises', 'checks', 'failed', 'over-capacity', 'double holds', 'verdict'],
        results.map((result) => [
          result.run,
          result.name,
          SCENARIOS.find((scenario) => scenario.name === result.name)?.description ?? '',
          result.checks,
          result.failed,
          result.totals.overCapacity,
          result.totals.doubleHolds,
          result.failed === 0 ? 'PASS' : `FAIL${result.error === undefined ? '' : ` (${result.error})`}`,
        ]),
      ),
      '',
      '## Command latencies',
      '',
      markdownTable(SUMMARY_HEADERS, [
        summaryRow('settle, client-observed (POST → terminal poll)', settle),
        summaryRow('settle, server-side (settledAt − acceptedAt)', server),
      ]),
      '',
      '`raw.csv` lists every step (expected vs actual, settle ms); `latency.csv` every command.',
    ];
    return {
      summary: lines.join('\n'),
      extraFiles: { 'latency.csv': samples },
      ok: allPassed && grand.overCapacity === 0 && grand.doubleHolds === 0 && grand.verifyFailures === 0,
      extra: {
        scenarios: results.map((result) => ({ run: result.run, name: result.name, workshopId: result.workshopId, checks: result.checks, failed: result.failed })),
        overCapacity: grand.overCapacity,
        doubleHolds: grand.doubleHolds,
        verifications: grand.verifications,
        verifyFailures: grand.verifyFailures,
        settleMs: settle,
        serverSettleMs: server,
      },
    };
  },
});
