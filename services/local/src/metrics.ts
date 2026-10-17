import type { MetricName, MetricUnit, MetricsSink } from '@seatrelay/service';

export interface MetricSummary {
  unit: MetricUnit;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

interface Series {
  unit: MetricUnit;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Ring buffer of recent values for the percentiles. */
  recent: number[];
  cursor: number;
}

const RECENT_WINDOW = 2_000;

/**
 * In-process metrics sink (the on-prem counterpart of the EMF metrics, CONVENTIONS §7):
 * aggregates per metric name, no dimensions. Read through `GET /metrics` and flushed to the
 * log periodically; `reset()` starts a new window.
 */
export class LocalMetrics implements MetricsSink {
  private readonly series = new Map<MetricName, Series>();
  private windowStartedAt = new Date().toISOString();

  emit(name: MetricName, value: number, unit: MetricUnit = 'Count'): void {
    let series = this.series.get(name);
    if (series === undefined) {
      series = { unit, count: 0, sum: 0, min: value, max: value, recent: [], cursor: 0 };
      this.series.set(name, series);
    }
    series.count += 1;
    series.sum += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);
    if (series.recent.length < RECENT_WINDOW) {
      series.recent.push(value);
    } else {
      series.recent[series.cursor] = value;
      series.cursor = (series.cursor + 1) % RECENT_WINDOW;
    }
  }

  snapshot(): { since: string; metrics: Record<string, MetricSummary> } {
    const metrics: Record<string, MetricSummary> = {};
    for (const [name, series] of this.series) {
      const sorted = [...series.recent].sort((a, b) => a - b);
      metrics[name] = {
        unit: series.unit,
        count: series.count,
        sum: series.sum,
        min: series.min,
        max: series.max,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
    }
    return { since: this.windowStartedAt, metrics };
  }

  reset(): void {
    this.series.clear();
    this.windowStartedAt = new Date().toISOString();
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}
