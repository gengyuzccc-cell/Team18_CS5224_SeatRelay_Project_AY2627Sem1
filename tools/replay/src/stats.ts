import { createRng, type Rng } from './prng';

/** Descriptive statistics and seeded bootstrap confidence intervals (no dependencies). */

export interface Summary {
  n: number;
  mean: number;
  median: number;
  sd: number;
  min: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  max: number;
}

export interface Interval {
  lo: number;
  hi: number;
}

/** Drops NaN (metrics without a sample in a run, e.g. no backfill happened). */
export function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/** Linear-interpolation quantile (type 7) of an ascending array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function quantile(values: readonly number[], q: number): number {
  return quantileSorted(
    [...values].sort((a, b) => a - b),
    q,
  );
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export function summarize(values: readonly number[]): Summary {
  const sorted = finite(values).sort((a, b) => a - b);
  const avg = mean(sorted);
  let variance = 0;
  for (const value of sorted) {
    variance += (value - avg) ** 2;
  }
  return {
    n: sorted.length,
    mean: avg,
    median: quantileSorted(sorted, 0.5),
    sd: sorted.length > 1 ? Math.sqrt(variance / (sorted.length - 1)) : 0,
    min: sorted[0] ?? Number.NaN,
    p5: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    p75: quantileSorted(sorted, 0.75),
    p95: quantileSorted(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/**
 * Percentile bootstrap CI of the mean: resample with replacement `resamples` times using the
 * given (seeded) generator and take the (1−level)/2 and 1−(1−level)/2 quantiles.
 */
export function bootstrapMeanCi(
  values: readonly number[],
  rng: Rng,
  resamples = 2000,
  level = 0.95,
): Interval {
  const sample = finite(values);
  if (sample.length === 0) {
    return { lo: Number.NaN, hi: Number.NaN };
  }
  const means = new Array<number>(resamples);
  for (let round = 0; round < resamples; round += 1) {
    let sum = 0;
    for (let index = 0; index < sample.length; index += 1) {
      sum += sample[Math.floor(rng.next() * sample.length)]!;
    }
    means[round] = sum / sample.length;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return { lo: quantileSorted(means, alpha), hi: quantileSorted(means, 1 - alpha) };
}

/** Paired differences `b[i] − a[i]` for the runs where both values are finite. */
export function pairedDifferences(a: readonly number[], b: readonly number[]): number[] {
  const diffs: number[] = [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      diffs.push(y - x);
    }
  }
  return diffs;
}

export function bootstrapRng(seed: number): Rng {
  return createRng(seed);
}
