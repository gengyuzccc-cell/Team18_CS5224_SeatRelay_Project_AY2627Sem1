import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkshopMode } from '@seatrelay/contracts';
import { DEFAULT_RANGES, type ScenarioParams } from './generator';
import { METRIC_KEYS, type RunMetrics, type RunSamples } from './metrics';
import { mixSeed } from './prng';
import {
  bootstrapMeanCi,
  bootstrapRng,
  finite,
  pairedDifferences,
  summarize,
  type Interval,
  type Summary,
} from './stats';

/** One row of `raw.csv`: one seed under one mode. */
export interface RunRow {
  seed: number;
  mode: WorkshopMode;
  params: ScenarioParams;
  metrics: RunMetrics;
  samples: RunSamples;
  durationMs: number;
}

export const PARAM_KEYS: readonly (keyof ScenarioParams)[] = [
  'nSessions',
  'totalCapacity',
  'nParticipants',
  'oversubscription',
  'holdSeconds',
  'arrivalWindowHours',
  'pAccept',
  'pDecline',
  'pIgnore',
  'pCancel',
  'pAbandon',
  'pCleanup',
  'pHoard',
  'pSecondaryDecline',
];

export interface MetricSpec {
  key: keyof RunMetrics;
  label: string;
  unit: string;
  /** Shown in the headline table. */
  headline?: boolean;
  digits?: number;
}

export const METRIC_SPECS: readonly MetricSpec[] = [
  { key: 'distinct_served', label: 'Distinct participants served', unit: 'people', headline: true },
  {
    key: 'fill_rate',
    label: 'Fill rate (served / total capacity)',
    unit: 'ratio',
    headline: true,
    digits: 3,
  },
  {
    key: 'seats_wasted',
    label: 'Seats wasted at cut-off (capacity − confirmed)',
    unit: 'seats',
    headline: true,
  },
  {
    key: 'duplicate_confirmed',
    label: 'Duplicate confirmed seats at the end (manual clean-up steps)',
    unit: 'seats',
    headline: true,
  },
  {
    key: 'dup_hold_events',
    label: 'Duplicate-hold events (user reaches ≥2 holds)',
    unit: 'events',
    headline: true,
  },
  {
    key: 'dup_hold_peak_users',
    label: 'Duplicate holds: peak users holding ≥2 seats',
    unit: 'users',
    headline: true,
  },
  {
    key: 'dup_hold_seat_hours',
    label: 'Duplicate holds: extra seat-hours tied up',
    unit: 'seat-hours',
    headline: true,
  },
  {
    key: 'seat_refill_min_mean',
    label: 'Seat refill time, per-run mean',
    unit: 'min',
    headline: true,
  },
  {
    key: 'seat_refill_min_p50',
    label: 'Seat refill time, per-run p50',
    unit: 'min',
    headline: true,
  },
  {
    key: 'seat_refill_min_p95',
    label: 'Seat refill time, per-run p95',
    unit: 'min',
    headline: true,
  },
  { key: 'seat_refill_samples', label: 'Seat releases with a confirmed refill', unit: 'count' },
  { key: 'seat_refill_censored', label: 'Seat releases never refilled (censored)', unit: 'count' },
  {
    key: 'backfill_relay_ms_mean',
    label: 'Backfill relay latency (reallocatedAt − releasedAt), mean',
    unit: 'ms',
    headline: true,
  },
  { key: 'backfill_relay_ms_p50', label: 'Backfill relay latency, p50', unit: 'ms' },
  { key: 'backfill_relay_ms_p95', label: 'Backfill relay latency, p95', unit: 'ms' },
  { key: 'backfills_relayed', label: 'Backfills relayed (someone was waiting)', unit: 'count' },
  { key: 'releases_unrelayed', label: 'Releases with nobody waiting', unit: 'count' },
  { key: 'seat_releases', label: 'Seat releases (expiry, decline, cancel)', unit: 'count' },
  { key: 'offers_created', label: 'Offers created', unit: 'count' },
  { key: 'offers_accepted', label: 'Offers accepted', unit: 'count' },
  { key: 'offers_declined', label: 'Offers declined', unit: 'count' },
  { key: 'offers_expired', label: 'Offers expired', unit: 'count' },
  { key: 'offers_revoked', label: 'Offers revoked (cancelled while held)', unit: 'count' },
  { key: 'cancellations', label: 'Registrations cancelled by participants', unit: 'count' },
  { key: 'ended_cutoff', label: 'Registrations ended at cut-off (still queued)', unit: 'count' },
  { key: 'confirmed_seats', label: 'Confirmed seats at the end', unit: 'seats' },
  { key: 'registrations', label: 'Registrations accepted by the engine', unit: 'count' },
  { key: 'participants', label: 'Participants', unit: 'people' },
  { key: 'decisions', label: 'Engine decisions', unit: 'count' },
  { key: 'rejected', label: 'Rejected commands', unit: 'count' },
  { key: 'invariant_violations', label: 'Invariant violations', unit: 'count' },
];

export interface ModeStats {
  summary: Summary;
  ci: Interval;
}

export interface MetricComparison {
  spec: MetricSpec;
  unified: ModeStats;
  perSession: ModeStats;
  /** Paired per-seed differences PER_SESSION − UNIFIED. */
  diff: ModeStats;
}

export interface CompareOptions {
  bootstrapSeed: number;
  resamples: number;
}

export const DEFAULT_BOOTSTRAP_SEED = 20261016;
export const DEFAULT_RESAMPLES = 2000;

/* ---------- raw.csv ---------- */

function csvNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

export function toCsv(rows: readonly RunRow[]): string {
  const header = ['seed', 'mode', ...PARAM_KEYS, ...METRIC_KEYS, 'duration_ms'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        String(row.seed),
        row.mode,
        ...PARAM_KEYS.map((key) => csvNumber(row.params[key])),
        ...METRIC_KEYS.map((key) => csvNumber(row.metrics[key])),
        String(row.durationMs),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/* ---------- statistics ---------- */

function groupBySeed(rows: readonly RunRow[]): Map<number, Partial<Record<WorkshopMode, RunRow>>> {
  const bySeed = new Map<number, Partial<Record<WorkshopMode, RunRow>>>();
  for (const row of rows) {
    const entry = bySeed.get(row.seed) ?? {};
    entry[row.mode] = row;
    bySeed.set(row.seed, entry);
  }
  return new Map([...bySeed.entries()].sort((a, b) => a[0] - b[0]));
}

export function compareMetrics(
  rows: readonly RunRow[],
  options: CompareOptions = { bootstrapSeed: DEFAULT_BOOTSTRAP_SEED, resamples: DEFAULT_RESAMPLES },
): MetricComparison[] {
  const bySeed = groupBySeed(rows);
  const entries = [...bySeed.values()];
  return METRIC_SPECS.map((spec, index) => {
    const unified = entries.map((entry) => entry.UNIFIED?.metrics[spec.key] ?? Number.NaN);
    const perSession = entries.map((entry) => entry.PER_SESSION?.metrics[spec.key] ?? Number.NaN);
    const diffs = pairedDifferences(unified, perSession);
    const stats = (values: number[], stream: number): ModeStats => ({
      summary: summarize(values),
      ci: bootstrapMeanCi(
        values,
        bootstrapRng(mixSeed(options.bootstrapSeed, index, stream)),
        options.resamples,
      ),
    });
    return {
      spec,
      unified: stats(unified, 1),
      perSession: stats(perSession, 2),
      diff: stats(diffs, 3),
    };
  });
}

export interface PooledComparison {
  label: string;
  unit: string;
  unified: ModeStats;
  perSession: ModeStats;
}

/** Pools the raw samples of every run per mode (descriptive; runs are not weighted equally). */
export function poolSamples(
  rows: readonly RunRow[],
  key: keyof RunSamples,
): Record<WorkshopMode, number[]> {
  const pooled: Record<WorkshopMode, number[]> = { UNIFIED: [], PER_SESSION: [] };
  for (const row of rows) {
    pooled[row.mode].push(...row.samples[key]);
  }
  return pooled;
}

export function comparePooled(
  rows: readonly RunRow[],
  options: CompareOptions,
): PooledComparison[] {
  const specs: { key: keyof RunSamples; label: string; unit: string }[] = [
    {
      key: 'refillMin',
      label: 'Seat refill time, every release with a waiter pooled',
      unit: 'min',
    },
    { key: 'relayMs', label: 'Backfill relay latency, every relayed backfill pooled', unit: 'ms' },
  ];
  return specs.map((spec, index) => {
    const pooled = poolSamples(rows, spec.key);
    const stats = (values: number[], stream: number): ModeStats => ({
      summary: summarize(values),
      ci: bootstrapMeanCi(
        values,
        bootstrapRng(mixSeed(options.bootstrapSeed, 1000 + index, stream)),
        options.resamples,
      ),
    });
    return {
      label: spec.label,
      unit: spec.unit,
      unified: stats(pooled.UNIFIED, 1),
      perSession: stats(pooled.PER_SESSION, 2),
    };
  });
}

/* ---------- summary.md ---------- */

export interface ReportMeta {
  seedCount: number;
  firstSeed: number;
  lastSeed: number;
  elapsedMs: number;
  workers: number;
  bootstrapSeed: number;
  resamples: number;
  generatedAt: string;
  invariantsCheckedEveryStep: boolean;
}

export function fmt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) {
    return '–';
  }
  return value.toFixed(digits);
}

function ciText(ci: Interval, digits: number): string {
  return `[${fmt(ci.lo, digits)}, ${fmt(ci.hi, digits)}]`;
}

function metricRow(comparison: MetricComparison): string {
  const digits = comparison.spec.digits ?? 2;
  const { spec, unified, perSession, diff } = comparison;
  return (
    `| ${spec.label} (${spec.unit}) ` +
    `| ${fmt(unified.summary.mean, digits)} ${ciText(unified.ci, digits)} | ${fmt(unified.summary.median, digits)} ` +
    `| ${fmt(perSession.summary.mean, digits)} ${ciText(perSession.ci, digits)} | ${fmt(perSession.summary.median, digits)} ` +
    `| ${fmt(diff.summary.mean, digits)} ${ciText(diff.ci, digits)} | ${diff.summary.n} |`
  );
}

const TABLE_HEADER =
  '| metric | UNIFIED mean [95% CI] | UNIFIED median | PER_SESSION mean [95% CI] | PER_SESSION median | Δ PER_SESSION − UNIFIED, paired mean [95% CI] | n |\n' +
  '|---|---|---|---|---|---|---|';

function paramsTable(rows: readonly RunRow[]): string {
  const bySeed = groupBySeed(rows);
  const scenarios = [...bySeed.values()].map(
    (entry) => (entry.UNIFIED ?? entry.PER_SESSION)!.params,
  );
  const lines = ['| parameter | mean | min | max |', '|---|---|---|---|'];
  for (const key of PARAM_KEYS) {
    const values = scenarios.map((params) => params[key]);
    const stats = summarize(values);
    const digits =
      Number.isInteger(stats.min) && Number.isInteger(stats.max) && key !== 'oversubscription'
        ? 1
        : 3;
    lines.push(
      `| ${key} | ${fmt(stats.mean, digits)} | ${fmt(stats.min, digits)} | ${fmt(stats.max, digits)} |`,
    );
  }
  return lines.join('\n');
}

function totalsTable(rows: readonly RunRow[]): string {
  const lines = [
    '| mode | runs | decisions | registrations | offers | expired | declined | accepted | cancellations | invariant violations | run time |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const mode of ['UNIFIED', 'PER_SESSION'] as const) {
    const mine = rows.filter((row) => row.mode === mode);
    const sum = (key: keyof RunMetrics) => mine.reduce((total, row) => total + row.metrics[key], 0);
    const seconds = mine.reduce((total, row) => total + row.durationMs, 0) / 1000;
    lines.push(
      `| ${mode} | ${mine.length} | ${sum('decisions')} | ${sum('registrations')} | ${sum('offers_created')} | ${sum('offers_expired')} | ${sum('offers_declined')} | ${sum('offers_accepted')} | ${sum('cancellations')} | ${sum('invariant_violations')} | ${seconds.toFixed(1)} s |`,
    );
  }
  return lines.join('\n');
}

function pooledTable(pooled: readonly PooledComparison[]): string {
  const lines = [
    '| samples pooled over all runs | mode | n | mean [95% CI] | p50 | p95 | max |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const entry of pooled) {
    for (const mode of ['UNIFIED', 'PER_SESSION'] as const) {
      const stats = mode === 'UNIFIED' ? entry.unified : entry.perSession;
      lines.push(
        `| ${entry.label} (${entry.unit}) | ${mode} | ${stats.summary.n} | ${fmt(stats.summary.mean)} ${ciText(stats.ci, 2)} | ${fmt(stats.summary.median)} | ${fmt(stats.summary.p95)} | ${fmt(stats.summary.max)} |`,
      );
    }
  }
  return lines.join('\n');
}

export function renderSummaryMarkdown(
  rows: readonly RunRow[],
  comparisons: readonly MetricComparison[],
  pooled: readonly PooledComparison[],
  meta: ReportMeta,
): string {
  const headline = comparisons.filter((comparison) => comparison.spec.headline);
  const ranges = DEFAULT_RANGES;
  const violations = rows.reduce((total, row) => total + row.metrics.invariant_violations, 0);
  return `# Mechanism comparison: UNIFIED vs PER_SESSION (replay, simulated clock)

Generated by \`pnpm replay\` (\`tools/replay\`) on ${meta.generatedAt}: seeds ${meta.firstSeed}–${meta.lastSeed} (${meta.seedCount} scenarios × 2 modes = ${rows.length} runs), ${meta.workers} worker thread(s), ${(meta.elapsedMs / 1000).toFixed(1)} s wall clock. Confidence intervals are percentile bootstraps of the mean (${meta.resamples} resamples, PRNG seed ${meta.bootstrapSeed}); the paired difference resamples per-seed differences. Raw rows: \`raw.csv\`.

## Method

Each seed draws one workshop and one population, then replays the **same arrival and behaviour stream** through the real engine (\`@seatrelay/core\` \`decide()\`, its \`Change[]\` applied to the live snapshot exactly as \`applyChanges()\` does) twice:

- **UNIFIED** (SeatRelay): one registration per participant carrying the full preference list; one queue per workshop; at most one OFFERED/CONFIRMED hold per person (C2).
- **PER_SESSION** (baseline, plan §2.2): the participant registers separately in every session they find acceptable (as with per-session forms); each session has its own queue and no cross-session constraint. Once confirmed somewhere, the participant cleans up the other registrations only with probability p_cleanup, after a delay; a second offer that arrives while they already hold a seat is accepted (hoarded), declined or ignored according to the drawn secondary reaction.

Expiry is driven exactly like production: every new offer yields a timer, the loop feeds a \`TICK\` back at \`expiresAt\` (and at \`nextDueAt\` / every cut-off, as the sweep would). Timers are ideal, so the engine's relay latency is the pure engine latency.

Scenario ranges (uniform unless stated): sessions ${ranges.sessions[0]}–${ranges.sessions[1]}, capacity ${ranges.capacity[0]}–${ranges.capacity[1]} per session, oversubscription ${ranges.oversubscription[0]}–${ranges.oversubscription[1]}× total capacity, holdSeconds ${ranges.holdSeconds[0]}–${ranges.holdSeconds[1]}, arrival window ${ranges.arrivalWindowHours[0]}–${ranges.arrivalWindowHours[1]} h (front-loaded arrivals), sessions start ${ranges.sessionLeadHours[0]}–${ranges.sessionLeadHours[1]} h after the window (cut-off = start − 30 min), 1–3 acceptable sessions per participant (P = ${ranges.preferenceSizeWeights.join('/')}, drawn by session popularity), p_accept ${ranges.pAccept[0]}–${ranges.pAccept[1]}, p_decline ${ranges.pDecline[0]}–${ranges.pDecline[1]} (rest: no response, the hold expires), response delay = holdSeconds × u², p_cancel ${ranges.pCancel[0]}–${ranges.pCancel[1]} (confirmed participants cancel before cut-off), p_abandon ${ranges.pAbandon[0]}–${ranges.pAbandon[1]} (queued-only participants give up after ${ranges.abandonAfterHours[0]}–${ranges.abandonAfterHours[1]} h), PER_SESSION p_cleanup ${ranges.pCleanup[0]}–${ranges.pCleanup[1]} (delay ≤ ${ranges.cleanupDelayHoursMax} h), p_hoard ${ranges.pHoard[0]}–${ranges.pHoard[1]}, p_secondary_decline ${ranges.pSecondaryDecline[0]}–${ranges.pSecondaryDecline[1]}.

Metric definitions (all computed from engine outputs, identically for both modes):

- **duplicate holds**: a (user, moment) where the user holds ≥ 2 OFFERED/CONFIRMED seats across sessions; reported as events (user reaches ≥ 2 holds), peak concurrent users and extra seat-hours (∫ Σ_user max(0, holds − 1) dt). UNIFIED forbids this by construction (C2), so 0 is also an invariant check.
- **distinct participants served**: distinct users CONFIRMED after the last cut-off. **duplicate confirmed seats** = confirmed seats − distinct users: seats that an organiser has to chase and release by hand (manual clean-up proxy).
- **seats wasted**: Σ_sessions (capacity − confirmed) read at each session's cut-off.
- **backfill relay latency**: \`reallocatedAt − releasedAt\` of the engine's BackfillRecords (same-decision relay; with ideal timers it is 0 ms by construction, infrastructure delay is measured on the deployed system instead).
- **seat refill time**: for every released seat (expiry, decline, cancellation), minutes until the relay chain starting at that release ends in a confirmation by a participant who does not already hold a confirmed seat (released → offered → expired/declined → re-offered → … → accepted). An acceptance by someone already confirmed elsewhere (a hoarded duplicate, PER_SESSION only) is followed to the later cancellation of that seat. Releases whose chain never reaches a genuine confirmation (nobody waiting, the run ended, or the duplicate was kept) are counted as censored and excluded from the time statistics.

## Headline results

${TABLE_HEADER}
${headline.map(metricRow).join('\n')}

![duplicate holds](duplicate-holds.svg)

![distinct participants served](distinct-served.svg)

![seat refill time](backfill-time.svg)

## Pooled samples

Per-run statistics above weight every seed equally; this table pools the individual samples of all runs instead (so busy scenarios weigh more).

${pooledTable(pooled)}

## All metrics

${TABLE_HEADER}
${comparisons.map(metricRow).join('\n')}

## Scenario parameters over the ${meta.seedCount} seeds

${paramsTable(rows)}

## Totals and sanity checks

${totalsTable(rows)}

Invariants (\`checkInvariants\`) were checked ${meta.invariantsCheckedEveryStep ? 'after every decision' : 'at the end of every run'}: ${violations} violation(s). Charts: box = p25–p75, line = median, whiskers = p5–p95, ◆ = mean with its 95% bootstrap CI underneath.
`;
}

/* ---------- SVG charts (no dependencies) ---------- */

const COLORS = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  UNIFIED: '#2a78d6',
  PER_SESSION: '#eb6834',
} as const;

export interface ChartPanel {
  label: string;
  unit: string;
  unified: readonly number[];
  perSession: readonly number[];
  unifiedCi: Interval;
  perSessionCi: Interval;
}

function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const factor =
    residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return factor * magnitude;
}

function ticksFor(max: number, count = 5): number[] {
  if (!(max > 0)) {
    return [0, 1];
  }
  const step = niceStep(max / count);
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tickLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function renderBoxChart(
  title: string,
  subtitle: string,
  panels: readonly ChartPanel[],
): string {
  const width = 760;
  const labelX = 24;
  const plotX = 150;
  const plotW = 560;
  const headerH = 64;
  const panelTitleH = 26;
  const rowH = 46;
  const axisH = 34;
  const panelH = panelTitleH + 2 * rowH + axisH;
  const height = headerH + panels.length * panelH + 12;
  const font = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"';
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${COLORS.surface}"/>`);
  parts.push(
    `<text x="${labelX}" y="28" ${font} font-size="16" font-weight="600" fill="${COLORS.ink}">${escapeXml(title)}</text>`,
  );
  parts.push(
    `<text x="${labelX}" y="48" ${font} font-size="12" fill="${COLORS.inkSecondary}">${escapeXml(subtitle)}</text>`,
  );
  // legend (two series: always present)
  const legendX = width - 250;
  parts.push(
    `<rect x="${legendX}" y="18" width="12" height="12" rx="2" fill="${COLORS.UNIFIED}"/>`,
  );
  parts.push(
    `<text x="${legendX + 18}" y="29" ${font} font-size="12" fill="${COLORS.inkSecondary}">UNIFIED (SeatRelay)</text>`,
  );
  parts.push(
    `<rect x="${legendX + 130}" y="18" width="12" height="12" rx="2" fill="${COLORS.PER_SESSION}"/>`,
  );
  parts.push(
    `<text x="${legendX + 148}" y="29" ${font} font-size="12" fill="${COLORS.inkSecondary}">PER_SESSION</text>`,
  );

  panels.forEach((panel, index) => {
    const top = headerH + index * panelH;
    const series = [
      { mode: 'UNIFIED' as const, values: finite(panel.unified), ci: panel.unifiedCi },
      { mode: 'PER_SESSION' as const, values: finite(panel.perSession), ci: panel.perSessionCi },
    ];
    const summaries = series.map((entry) => summarize(entry.values));
    let max = 0;
    summaries.forEach((summary, position) => {
      const ci = series[position]!.ci;
      for (const candidate of [summary.p95, summary.mean, ci.hi]) {
        if (Number.isFinite(candidate)) {
          max = Math.max(max, candidate);
        }
      }
    });
    const ticks = ticksFor(max * 1.08);
    const domain = ticks[ticks.length - 1]! > 0 ? ticks[ticks.length - 1]! : 1;
    const x = (value: number) => plotX + (Math.min(Math.max(value, 0), domain) / domain) * plotW;
    parts.push(
      `<text x="${labelX}" y="${top + 16}" ${font} font-size="13" font-weight="600" fill="${COLORS.ink}">${escapeXml(panel.label)}</text>`,
    );
    const plotTop = top + panelTitleH;
    const plotBottom = plotTop + 2 * rowH;
    for (const tick of ticks) {
      const tx = x(tick);
      parts.push(
        `<line x1="${tx.toFixed(1)}" y1="${plotTop}" x2="${tx.toFixed(1)}" y2="${plotBottom}" stroke="${COLORS.grid}" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${tx.toFixed(1)}" y="${plotBottom + 16}" ${font} font-size="11" text-anchor="middle" fill="${COLORS.muted}">${tickLabel(tick)}</text>`,
      );
    }
    parts.push(
      `<line x1="${plotX}" y1="${plotBottom}" x2="${plotX + plotW}" y2="${plotBottom}" stroke="${COLORS.baseline}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${plotX + plotW}" y="${plotBottom + 30}" ${font} font-size="11" text-anchor="end" fill="${COLORS.muted}">${escapeXml(panel.unit)}</text>`,
    );

    series.forEach((entry, position) => {
      const summary = summaries[position]!;
      const color = COLORS[entry.mode];
      const cy = plotTop + position * rowH + rowH / 2 - 4;
      parts.push(
        `<text x="${labelX}" y="${cy + 4}" ${font} font-size="12" fill="${COLORS.inkSecondary}">${entry.mode}</text>`,
      );
      if (summary.n === 0) {
        parts.push(
          `<text x="${plotX + 4}" y="${cy + 4}" ${font} font-size="11" fill="${COLORS.muted}">no samples</text>`,
        );
        return;
      }
      const tooltip = `${entry.mode}: n=${summary.n}, mean ${fmt(summary.mean)} [${fmt(entry.ci.lo)}, ${fmt(entry.ci.hi)}], median ${fmt(summary.median)}, p5 ${fmt(summary.p5)}, p25 ${fmt(summary.p25)}, p75 ${fmt(summary.p75)}, p95 ${fmt(summary.p95)}`;
      parts.push(`<g><title>${escapeXml(tooltip)}</title>`);
      // whiskers p5–p95
      parts.push(
        `<line x1="${x(summary.p5).toFixed(1)}" y1="${cy}" x2="${x(summary.p95).toFixed(1)}" y2="${cy}" stroke="${color}" stroke-width="1.5"/>`,
      );
      for (const end of [summary.p5, summary.p95]) {
        parts.push(
          `<line x1="${x(end).toFixed(1)}" y1="${cy - 6}" x2="${x(end).toFixed(1)}" y2="${cy + 6}" stroke="${color}" stroke-width="1.5"/>`,
        );
      }
      // box p25–p75 (at least 2px wide so a degenerate distribution stays visible)
      const boxLeft = x(summary.p25);
      const boxWidth = Math.max(2, x(summary.p75) - boxLeft);
      parts.push(
        `<rect x="${boxLeft.toFixed(1)}" y="${cy - 9}" width="${boxWidth.toFixed(1)}" height="18" rx="2" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="1.5"/>`,
      );
      // median
      parts.push(
        `<line x1="${x(summary.median).toFixed(1)}" y1="${cy - 9}" x2="${x(summary.median).toFixed(1)}" y2="${cy + 9}" stroke="${color}" stroke-width="2"/>`,
      );
      // mean (diamond) with its CI bar underneath
      const mx = x(summary.mean);
      parts.push(
        `<path d="M ${mx.toFixed(1)} ${cy - 5} l 5 5 l -5 5 l -5 -5 z" fill="${color}" stroke="${COLORS.surface}" stroke-width="1.5"/>`,
      );
      if (Number.isFinite(entry.ci.lo) && Number.isFinite(entry.ci.hi)) {
        const cyCi = cy + 15;
        parts.push(
          `<line x1="${x(entry.ci.lo).toFixed(1)}" y1="${cyCi}" x2="${x(entry.ci.hi).toFixed(1)}" y2="${cyCi}" stroke="${COLORS.inkSecondary}" stroke-width="2"/>`,
        );
      }
      parts.push('</g>');
      parts.push(
        `<text x="${plotX + plotW + 8}" y="${cy + 4}" ${font} font-size="11" fill="${COLORS.inkSecondary}">${fmt(summary.mean)}</text>`,
      );
    });
  });
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

function values(rows: readonly RunRow[], mode: WorkshopMode, key: keyof RunMetrics): number[] {
  return rows.filter((row) => row.mode === mode).map((row) => row.metrics[key]);
}

function panel(
  rows: readonly RunRow[],
  comparisons: readonly MetricComparison[],
  key: keyof RunMetrics,
  label: string,
): ChartPanel {
  const comparison = comparisons.find((candidate) => candidate.spec.key === key)!;
  return {
    label,
    unit: comparison.spec.unit,
    unified: values(rows, 'UNIFIED', key),
    perSession: values(rows, 'PER_SESSION', key),
    unifiedCi: comparison.unified.ci,
    perSessionCi: comparison.perSession.ci,
  };
}

export function renderCharts(
  rows: readonly RunRow[],
  comparisons: readonly MetricComparison[],
  pooled: readonly PooledComparison[],
): Record<string, string> {
  const n = new Set(rows.map((row) => row.seed)).size;
  const refill = poolSamples(rows, 'refillMin');
  const refillPooled = pooled.find((entry) => entry.unit === 'min')!;
  const legend = `${n} seeds per mode; box p25–p75, line median, whiskers p5–p95, diamond mean, bar 95% bootstrap CI of the mean`;
  return {
    'duplicate-holds.svg': renderBoxChart(
      'Duplicate holds per run',
      `A user holding two or more OFFERED/CONFIRMED seats at once. ${legend}`,
      [
        panel(rows, comparisons, 'dup_hold_peak_users', 'Peak users holding ≥ 2 seats'),
        panel(
          rows,
          comparisons,
          'dup_hold_seat_hours',
          'Extra seat-hours tied up by duplicate holds',
        ),
      ],
    ),
    'distinct-served.svg': renderBoxChart(
      'Distinct participants served per run',
      `Distinct users CONFIRMED after the last cut-off, and seats left empty. ${legend}`,
      [
        panel(rows, comparisons, 'distinct_served', 'Distinct participants served'),
        panel(rows, comparisons, 'seats_wasted', 'Seats wasted at cut-off (capacity − confirmed)'),
      ],
    ),
    'backfill-time.svg': renderBoxChart(
      'Seat refill time per run',
      `Minutes from a seat release until the relay chain ends in a confirmation. ${legend}`,
      [
        {
          label: `Seat refill time, every release with a waiter pooled (${refill.UNIFIED.length} / ${refill.PER_SESSION.length} samples)`,
          unit: 'min',
          unified: refill.UNIFIED,
          perSession: refill.PER_SESSION,
          unifiedCi: refillPooled.unified.ci,
          perSessionCi: refillPooled.perSession.ci,
        },
        panel(rows, comparisons, 'seat_refill_min_mean', 'Seat refill time, per-run mean (min)'),
      ],
    ),
  };
}

/* ---------- writing ---------- */

export function buildReport(
  rows: readonly RunRow[],
  meta: ReportMeta,
): { files: Record<string, string>; comparisons: MetricComparison[] } {
  const sorted = [...rows].sort((a, b) => a.seed - b.seed || a.mode.localeCompare(b.mode));
  const options: CompareOptions = { bootstrapSeed: meta.bootstrapSeed, resamples: meta.resamples };
  const comparisons = compareMetrics(sorted, options);
  const pooled = comparePooled(sorted, options);
  const files: Record<string, string> = {
    'raw.csv': toCsv(sorted),
    'summary.md': renderSummaryMarkdown(sorted, comparisons, pooled, meta),
    ...renderCharts(sorted, comparisons, pooled),
  };
  return { files, comparisons };
}

export function writeReport(
  outDir: string,
  rows: readonly RunRow[],
  meta: ReportMeta,
): { paths: string[]; comparisons: MetricComparison[] } {
  mkdirSync(outDir, { recursive: true });
  const { files, comparisons } = buildReport(rows, meta);
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(outDir, name);
    writeFileSync(path, content, 'utf8');
    paths.push(path);
  }
  return { paths, comparisons };
}

/** Markdown table of the headline metrics (printed by the CLI). */
export function headlineTable(comparisons: readonly MetricComparison[]): string {
  return `${TABLE_HEADER}\n${comparisons
    .filter((comparison) => comparison.spec.headline)
    .map(metricRow)
    .join('\n')}`;
}
