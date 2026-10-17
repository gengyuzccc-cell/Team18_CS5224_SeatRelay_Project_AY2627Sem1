import { markdownTable } from './results';
import type { ExperimentContext } from './run';
import { sleep } from './scenario';
import type { MetricsBaseline, MetricsDelta } from './ops';

/**
 * Reading the SeatRelay metrics of one experiment window (CONVENTIONS §7) on either target:
 * local = deltas of the server's in-process `GET /metrics`; dev/pilot = CloudWatch
 * `GetMetricData` sums over the window, after `--metrics-wait` so that the EMF datapoints of
 * the run are ingested. Never throws: an unavailable source is reported as such.
 */

export async function metricsBaseline(ctx: ExperimentContext): Promise<MetricsBaseline> {
  try {
    return await ctx.ops.metricsBaseline();
  } catch {
    return { at: new Date() };
  }
}

export async function metricsForRun(
  ctx: ExperimentContext,
  baseline: MetricsBaseline,
  names: readonly string[],
): Promise<MetricsDelta> {
  if (ctx.ops.kind === 'aws' && ctx.options.metricsWaitMs > 0) {
    ctx.log(`waiting ${Math.round(ctx.options.metricsWaitMs / 1000)} s for CloudWatch to ingest the run's metrics`);
    await sleep(ctx.options.metricsWaitMs);
  }
  try {
    return await ctx.ops.metricsSince(baseline, names);
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error), values: {} };
  }
}

/** Sum of one metric in the window, or undefined when the source was unavailable. */
export function metricSum(delta: MetricsDelta, name: string): number | undefined {
  return delta.available ? (delta.values[name]?.sum ?? 0) : undefined;
}

export function metricsSection(delta: MetricsDelta, notes: Record<string, string> = {}): string[] {
  if (!delta.available) {
    return [`Metrics not read: ${delta.detail}`];
  }
  const names = Object.keys(delta.values);
  if (names.length === 0) {
    return [`Metrics: none requested (${delta.detail})`];
  }
  return [
    `Source: ${delta.detail}`,
    '',
    markdownTable(
      ['metric', 'sum', 'samples', 'note'],
      names.map((name) => [name, delta.values[name]?.sum ?? 0, delta.values[name]?.count ?? 0, notes[name] ?? '']),
    ),
  ];
}
