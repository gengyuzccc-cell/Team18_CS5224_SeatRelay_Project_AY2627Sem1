/**
 * Seeded pseudo-random numbers for the replay. Everything random in this package goes through
 * an `Rng` created from an explicit seed (mulberry32), so a seed reproduces a scenario and a
 * bootstrap exactly, on every platform. `Math.random` is never used.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** Bernoulli trial. */
  bool(probability: number): boolean;
  /** Index drawn proportionally to `weights` (all >= 0, not all zero). */
  weightedIndex(weights: readonly number[]): number;
  /** Exponential variate with mean 1. */
  exponential(): number;
}

/** mulberry32 (32-bit state, period ~2^32), kept as an unsigned 32-bit integer to stay exact. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes several integers into one 32-bit seed (derived streams: per seed, per metric, ...). */
export function mixSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const part of parts) {
    h = Math.imul(h ^ (part >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    float(min, max) {
      return min + next() * (max - min);
    },
    bool(probability) {
      return next() < probability;
    },
    weightedIndex(weights) {
      let total = 0;
      for (const weight of weights) {
        total += weight;
      }
      let roll = next() * total;
      for (let index = 0; index < weights.length; index += 1) {
        roll -= weights[index] ?? 0;
        if (roll < 0) {
          return index;
        }
      }
      return weights.length - 1;
    },
    exponential() {
      return -Math.log(1 - next());
    },
  };
}
