#!/usr/bin/env tsx
import type { BackfillRecord, DashboardView } from '@seatrelay/contracts';
import { intOption, mapWithConcurrency } from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import { metricSum, metricsBaseline, metricsForRun, metricsSection } from './lib/metrics';
import {
  SUMMARY_HEADERS,
  formatNumber,
  markdownTable,
  outliers,
  summarize,
  summaryRow,
  type CsvRow,
} from './lib/results';
import { backfillLayout, type BackfillLayout } from './lib/backfillLayout';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  createWorkshop,
  ensureOrganisation,
  invariantSnapshot,
  seededRandom,
  shuffle,
  sleep,
  type CreatedWorkshop,
} from './lib/scenario';
import { errorText, sessionLabeller, trySend } from './lib/steps';

/**
 * Table 3 "Backfill latency" (plan §4, §1.2). holdSeconds = 60; `--offers` (default 100) offers
 * are left to expire while other people are queued behind them, so every expiry must be relayed
 * by the timer path (per-offer delay message → forwarder → FIFO on AWS; timer loop locally).
 *
 * Layout: W workshops × `--sessions` sessions × `--capacity` seats = seats per round. In each
 * workshop seats × (rounds + 1) + extra accounts register (every session acceptable, seeded
 * random order), so the first holders' offers expire with a full layer queued behind them; with
 * `--rounds R` the relayed offers are left to expire again (R layers). Latency per sample =
 * `reallocatedAt − releasedAt` of the dashboard backfill record (`releasedAt` = the offer's
 * `expiresAt` for an EXPIRED record). Afterwards, in each workshop `extra` current holders
 * cancel, which relays their seats to the `extra` people still queued: the cancellation-driven
 * backfills (same settlement, ≈ 0 ms) are reported separately. On dev/pilot the run's
 * `SweepLateExpiries` sum is read from CloudWatch (expected 0: the 5-minute sweep never had to
 * expire anything late); locally from GET /metrics.
 */
const USAGE = `
backfill — Table 3 "Backfill latency": offers left to expire with people queued behind

  pnpm --filter @seatrelay/experiments backfill --target local|dev [--runs N] [--hold 60]
       [--offers 100] [--workshops 10] [--sessions 2] [--rounds 1] [--cancellations 20]
       [--outlier-ms 10000] [--wait-extra S] [--keep] [--seed 1]

--offers N         expiry samples per run; rounded up to a multiple of workshops × sessions × capacity
--workshops W      workshops in parallel (default 10); --capacity = offers / (W × sessions × rounds)
--rounds R         expiry layers per workshop (each adds about --hold seconds; default 1)
--cancellations N  cancellation-driven backfills per run (default 20, spread over the workshops)
--wait-extra S     how long after the last expected expiry to keep waiting (default 120 local,
                   420 dev/pilot so that sweep-caught expiries are observed, not missed)
--keep             do not cancel the workshops at the end (default: CANCEL_WORKSHOP cleans up)
Accounts: <prefix>-1 … <prefix>-<seats per workshop × (R + 1) + extra>, reused in every workshop.
`;

const ORG_NAME = 'SeatRelay experiments';

interface SampleRow extends CsvRow {
  run: number;
  workshopId: string;
  session: string;
  cause: string;
  releasedAt: string;
  reallocatedAt: string;
  latencyMs: number | undefined;
  /** Recomputed from the timestamps (must equal latencyMs). */
  recomputedMs: number | undefined;
  backfillId: string;
}

interface WorkshopOutcome {
  run: number;
  ws: CreatedWorkshop;
  registered: number;
  expectedExpiries: number;
  expiredReallocated: number;
  cancellations: number;
  waitedSeconds: number;
  verifyOk: boolean;
  error?: string;
}

function sampleOf(run: number, ws: CreatedWorkshop, record: BackfillRecord): SampleRow {
  const label = sessionLabeller(ws);
  return {
    run,
    workshopId: ws.wsId,
    session: label(record.sessionId),
    cause: record.cause,
    releasedAt: record.releasedAt,
    reallocatedAt: record.reallocatedAt ?? '',
    latencyMs: record.latencyMs,
    recomputedMs: record.reallocatedAt === undefined ? undefined : Date.parse(record.reallocatedAt) - Date.parse(record.releasedAt),
    backfillId: record.id,
  };
}

const expiredReallocated = (dash: DashboardView): BackfillRecord[] =>
  dash.backfills.filter((record) => record.cause === 'EXPIRED' && record.reallocatedAt !== undefined);

async function workshopFlow(
  ctx: ExperimentContext,
  run: number,
  index: number,
  orgId: string,
  organiser: Account,
  accounts: readonly Account[],
  layout: BackfillLayout,
  waitExtraMs: number,
  seed: number,
  keep: boolean,
  samples: SampleRow[],
): Promise<WorkshopOutcome> {
  const timeout = ctx.options.settleTimeoutMs;
  const ws = await createWorkshop(organiser, orgId, {
    title: `Backfill r${run} w${index + 1} (${ctx.runId.slice(0, 8)})`,
    holdSeconds: ctx.options.holdSeconds,
    sessions: Array.from({ length: layout.sessions }, () => ({ capacity: layout.capacity })),
  });
  const outcome: WorkshopOutcome = {
    run, ws, registered: 0, expectedExpiries: layout.seats * layout.rounds, expiredReallocated: 0, cancellations: 0, waitedSeconds: 0, verifyOk: false,
  };
  const dashboard = () => organiser.client.dashboard(orgId, ws.wsId);
  try {
    // Register: everybody accepts every session (seeded random preference order).
    const random = seededRandom(seed * 7_919 + run * 104_729 + index);
    const registrants = accounts.slice(0, layout.registrantsPerWorkshop);
    const results = await mapWithConcurrency(registrants, 8, (account) =>
      trySend(account, ws.wsId, { type: 'REGISTER', acceptable: shuffle(ws.sessionIds, random) }, timeout),
    );
    outcome.registered = results.filter((result) => result.ok && result.settled.record.status === 'APPLIED').length;
    const failures = results.filter((result) => !result.ok || result.settled.record.status !== 'APPLIED');
    ctx.check({
      run, scenario: `w${index + 1}`, step: 'every REGISTER applied',
      ok: failures.length === 0, expected: String(registrants.length), actual: String(outcome.registered),
      detail: failures.slice(0, 3).map((result) => (result.ok ? `${result.settled.record.status}(${result.settled.record.reason})` : errorText(result.error))).join('; ') || undefined,
    });

    // Wait for every expected expiry to be relayed (rounds × seats EXPIRED records reallocated).
    let dash = await dashboard();
    const firstExpiry = Math.min(...dash.offered.map((entry) => Date.parse(entry.offer.expiresAt)));
    const deadline = (Number.isFinite(firstExpiry) ? firstExpiry : Date.now()) + layout.rounds * ctx.options.holdSeconds * 1000 + waitExtraMs;
    const waitStarted = Date.now();
    while (expiredReallocated(dash).length < outcome.expectedExpiries && Date.now() < deadline) {
      await sleep(2000);
      dash = await dashboard();
    }
    outcome.waitedSeconds = Math.round((Date.now() - waitStarted) / 1000);
    const relayed = expiredReallocated(dash);
    outcome.expiredReallocated = relayed.length;
    ctx.check({
      run, scenario: `w${index + 1}`, step: `${outcome.expectedExpiries} expired offers relayed to the queue`,
      ok: relayed.length >= outcome.expectedExpiries, expected: String(outcome.expectedExpiries),
      actual: `${relayed.length} (EXPIRED records ${dash.backfills.filter((record) => record.cause === 'EXPIRED').length}, waited ${outcome.waitedSeconds} s)`,
    });

    // Cancellation-driven backfills: `extra` current holders cancel; the last layer is queued.
    if (layout.extraPerWorkshop > 0) {
      const byUser = new Map(accounts.map((account) => [account.userId, account]));
      const holders = dash.offered.slice(0, layout.extraPerWorkshop).flatMap((entry) => {
        const account = byUser.get(entry.userId);
        return account === undefined ? [] : [account];
      });
      const cancelled = await Promise.all(holders.map((account) => trySend(account, ws.wsId, { type: 'CANCEL_REGISTRATION' }, timeout)));
      outcome.cancellations = cancelled.filter((result) => result.ok && result.settled.record.status === 'APPLIED').length;
      dash = await dashboard();
      const cancelRecords = dash.backfills.filter((record) => record.cause === 'CANCELLED_OFFER');
      ctx.check({
        run, scenario: `w${index + 1}`, step: 'cancellation-driven backfills relayed in the same settlement',
        ok: outcome.cancellations === holders.length && cancelRecords.length === holders.length && cancelRecords.every((record) => record.latencyMs === 0),
        expected: `${holders.length} × CANCELLED_OFFER, latencyMs 0`,
        actual: `${outcome.cancellations} cancels applied; ${cancelRecords.length} records, latencies ${cancelRecords.map((record) => record.latencyMs ?? 'none').join(',')}`,
      });
    }
    for (const record of dash.backfills) {
      samples.push(sampleOf(run, ws, record));
    }

    const inv = await invariantSnapshot(organiser, orgId, ws.wsId);
    outcome.verifyOk = inv.ok;
    ctx.check({
      run, scenario: `w${index + 1}`, step: 'verify', ok: inv.ok, expected: 'verify ok',
      actual: `verify ${inv.verify.ok ? 'ok' : `FAILED ${inv.verify.violations.map((v) => v.code).join(',')}`}, overCapacity ${inv.overCapacity}, doubleHolds ${inv.doubleHolds}`,
    });
  } catch (error) {
    outcome.error = errorText(error);
    ctx.fail(`w${index + 1}`, 'workshop flow aborted', error, run);
  } finally {
    if (!keep) {
      // Nothing must stay pending: later expiries would relay to nobody and clutter the dashboard.
      await trySend(organiser, ws.wsId, { type: 'CANCEL_WORKSHOP' }, timeout);
    }
  }
  return outcome;
}

runExperiment({
  name: 'backfill',
  tableRow: 'Backfill latency (plan §4, Table 3)',
  criterion: 'expiry-driven backfill p95 ≤ 120 s (reallocatedAt − releasedAt; single-digit seconds expected), every expiry relayed, outliers listed; cancellation-driven backfills reported separately (≈ 0 ms); SweepLateExpiries = 0',
  usage: USAGE,
  defaultHoldSeconds: 60,
  options: {
    offers: { type: 'string' },
    workshops: { type: 'string' },
    sessions: { type: 'string' },
    rounds: { type: 'string' },
    cancellations: { type: 'string' },
    'outlier-ms': { type: 'string' },
    'wait-extra': { type: 'string' },
    keep: { type: 'boolean' },
    seed: { type: 'string' },
  },
  async run(ctx) {
    const layout = backfillLayout({
      offers: intOption(ctx.values, 'offers', 100),
      workshops: intOption(ctx.values, 'workshops', 10),
      sessions: intOption(ctx.values, 'sessions', 2),
      rounds: intOption(ctx.values, 'rounds', 1),
      cancellations: intOption(ctx.values, 'cancellations', 20),
    });
    const outlierMs = intOption(ctx.values, 'outlier-ms', 10_000);
    const waitExtraMs = intOption(ctx.values, 'wait-extra', ctx.target.name === 'local' ? 120 : 420) * 1000;
    const seed = intOption(ctx.values, 'seed', 1);
    const keep = ctx.values.keep === true;
    const targetP95Ms = 120_000;
    ctx.param('layout', layout);
    ctx.param('outlierMs', outlierMs);
    ctx.param('waitExtraSeconds', waitExtraMs / 1000);
    ctx.param('seed', seed);

    const organiser = await ctx.accounts.organiser();
    ctx.log(`obtaining ${layout.registrantsPerWorkshop} participant tokens`, { ...layout });
    const accounts = await ctx.accounts.participants(layout.registrantsPerWorkshop);
    const org = await ensureOrganisation(organiser, ORG_NAME);
    ctx.param('orgId', org.id);

    const baseline = await metricsBaseline(ctx);
    const samples: SampleRow[] = [];
    const outcomes: WorkshopOutcome[] = [];
    for (let run = 1; run <= ctx.options.runs; run += 1) {
      ctx.beginRun(run);
      ctx.log(`run ${run}: ${layout.workshops} workshops × ${layout.seats} seats, ${layout.offers} offers left to expire (hold ${ctx.options.holdSeconds} s)`);
      const results = await Promise.all(
        Array.from({ length: layout.workshops }, async (_, index) => {
          await sleep(index * 300); // stagger the registration bursts a little
          return workshopFlow(ctx, run, index, org.id, organiser, accounts, layout, waitExtraMs, seed, keep, samples);
        }),
      );
      outcomes.push(...results);
    }
    const metrics = await metricsForRun(ctx, baseline, ['SweepLateExpiries', 'BackfillLatency', 'OffersExpired']);
    const sweepLate = metricSum(metrics, 'SweepLateExpiries');
    if (sweepLate !== undefined) {
      ctx.check({ scenario: 'metrics', step: 'SweepLateExpiries in the window', ok: sweepLate === 0, expected: '0', actual: String(sweepLate), detail: metrics.detail });
    } else {
      ctx.skip('metrics', 'SweepLateExpiries', metrics.detail);
    }

    const expired = samples.filter((sample) => sample.cause === 'EXPIRED' && sample.latencyMs !== undefined);
    const unrelayedExpired = samples.filter((sample) => sample.cause === 'EXPIRED' && sample.latencyMs === undefined);
    const cancelled = samples.filter((sample) => sample.cause.startsWith('CANCELLED') && sample.latencyMs !== undefined);
    const expiredStats = summarize(expired.map((sample) => sample.latencyMs as number));
    const cancelStats = summarize(cancelled.map((sample) => sample.latencyMs as number));
    const mismatched = samples.filter((sample) => sample.latencyMs !== undefined && sample.recomputedMs !== sample.latencyMs);
    const slow = outliers(expired, (sample) => sample.latencyMs as number, outlierMs);
    const expectedTotal = layout.offers * ctx.options.runs;
    ctx.check({
      scenario: 'latency', step: `expiry-driven backfill p95 ≤ ${targetP95Ms / 1000} s`,
      ok: expired.length > 0 && expiredStats.p95 <= targetP95Ms, expected: `p95 ≤ ${targetP95Ms} ms`,
      actual: `p95 ${formatNumber(expiredStats.p95)} ms over ${expired.length} samples (max ${formatNumber(expiredStats.max)} ms)`,
    });
    ctx.check({
      scenario: 'latency', step: 'every expired offer relayed (sample count)',
      ok: expired.length >= expectedTotal, expected: `≥ ${expectedTotal}`, actual: String(expired.length),
    });
    ctx.check({
      scenario: 'latency', step: 'latencyMs = reallocatedAt − releasedAt on every record',
      ok: mismatched.length === 0, expected: '0 mismatches', actual: String(mismatched.length),
    });

    const fmtS = (ms: number) => (Number.isNaN(ms) ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
    const lines = [
      '## Result',
      '',
      `- Expiry-driven backfill latency (reallocatedAt − releasedAt, releasedAt = expiresAt): **p50 ${fmtS(expiredStats.p50)}, p95 ${fmtS(expiredStats.p95)}, max ${fmtS(expiredStats.max)}** over ${expired.length} samples (target p95 ≤ 120 s)`,
      `- Expired offers relayed: ${expired.length}/${expectedTotal} expected (${unrelayedExpired.length} EXPIRED records without reallocation: nobody left in the queue)`,
      `- Cancellation-driven backfills (same settlement): ${cancelled.length} samples, p50 ${formatNumber(cancelStats.p50)} ms, max ${formatNumber(cancelStats.max)} ms`,
      `- Outliers above max(${outlierMs} ms, p95): ${slow.length}`,
      `- SweepLateExpiries in the window: **${sweepLate === undefined ? `not available (${metrics.detail})` : sweepLate}** (expected 0)`,
      `- Layout: ${layout.workshops} workshops × ${layout.sessions} sessions × capacity ${layout.capacity}, ${layout.rounds} round(s), ${layout.registrantsPerWorkshop} registrations per workshop, holdSeconds ${ctx.options.holdSeconds}`,
      '',
      '## Latency distribution',
      '',
      markdownTable(SUMMARY_HEADERS, [
        summaryRow('EXPIRED (timer path)', expiredStats),
        summaryRow('CANCELLED_* (same settlement)', cancelStats),
      ]),
      '',
      '## Outliers',
      '',
      slow.length === 0
        ? `None above max(${outlierMs} ms, p95 = ${formatNumber(expiredStats.p95)} ms).`
        : markdownTable(
            ['run', 'workshop', 'session', 'releasedAt (expiresAt)', 'reallocatedAt', 'latency ms'],
            [...slow].sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0)).map((sample) => [sample.run, sample.workshopId, sample.session, sample.releasedAt, sample.reallocatedAt, sample.latencyMs ?? '']),
          ),
      '',
      '## Workshops',
      '',
      markdownTable(
        ['run', 'workshop', 'registered', 'expiries expected', 'relayed', 'cancellations', 'waited s', 'verify', 'error'],
        outcomes.map((outcome) => [outcome.run, outcome.ws.wsId, outcome.registered, outcome.expectedExpiries, outcome.expiredReallocated, outcome.cancellations, outcome.waitedSeconds, outcome.verifyOk ? 'ok' : 'FAIL', outcome.error ?? '']),
      ),
      '',
      '## Metrics',
      '',
      ...metricsSection(metrics, { SweepLateExpiries: 'expected 0', BackfillLatency: 'worker-side ms (sum / samples)', OffersExpired: 'offers expired by tick-first' }),
      '',
      '`raw.csv` holds one row per backfill record (cause, releasedAt, reallocatedAt, latencyMs); plot with',
      '`python3 tools/experiments/analysis/plot_results.py <this dir> --value latencyMs --group cause`.',
    ];
    return {
      summary: lines.join('\n'),
      rows: samples,
      extra: {
        expiredLatencyMs: expiredStats,
        cancelLatencyMs: cancelStats,
        outliers: slow.length,
        sweepLateExpiries: sweepLate ?? null,
        layout,
      },
    };
  },
});
