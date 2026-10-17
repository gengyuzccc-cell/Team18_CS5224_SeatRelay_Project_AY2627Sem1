import { applyChanges, checkInvariants, parseIso } from '@seatrelay/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGES, generateScenario } from '../src/generator';
import { createRng, mixSeed, mulberry32 } from '../src/prng';
import { buildReport, type ReportMeta } from '../src/report';
import { runSeed } from '../src/runner';
import { simulate } from '../src/simulate';
import { bootstrapMeanCi, quantile, summarize } from '../src/stats';

const META: ReportMeta = {
  seedCount: 2,
  firstSeed: 1,
  lastSeed: 2,
  elapsedMs: 0,
  workers: 1,
  bootstrapSeed: 20261016,
  resamples: 200,
  generatedAt: '2026-10-16T00:00:00.000Z',
  invariantsCheckedEveryStep: true,
};

describe('prng', () => {
  it('is deterministic for a seed and uniform in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let index = 0; index < 1000; index += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    expect(mixSeed(1, 2)).not.toBe(mixSeed(2, 1));
    const rng = createRng(7);
    for (let index = 0; index < 200; index += 1) {
      const value = rng.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
    }
  });
});

describe('generator', () => {
  it('is deterministic and stays inside the documented ranges', () => {
    for (const seed of [1, 7, 42, 999]) {
      const scenario = generateScenario(seed);
      expect(generateScenario(seed)).toStrictEqual(scenario);
      const { params, sessions, participants } = scenario;
      expect(sessions.length).toBeGreaterThanOrEqual(DEFAULT_RANGES.sessions[0]);
      expect(sessions.length).toBeLessThanOrEqual(DEFAULT_RANGES.sessions[1]);
      for (const session of sessions) {
        expect(session.capacity).toBeGreaterThanOrEqual(DEFAULT_RANGES.capacity[0]);
        expect(session.capacity).toBeLessThanOrEqual(DEFAULT_RANGES.capacity[1]);
        expect(parseIso(session.cutoffAt)).toBe(parseIso(session.startsAt) - 30 * 60_000);
      }
      expect(params.oversubscription).toBeGreaterThanOrEqual(DEFAULT_RANGES.oversubscription[0]);
      expect(params.oversubscription).toBeLessThanOrEqual(DEFAULT_RANGES.oversubscription[1]);
      expect(participants.length).toBe(
        Math.max(sessions.length, Math.round(params.totalCapacity * params.oversubscription)),
      );
      expect(params.holdSeconds).toBeGreaterThanOrEqual(DEFAULT_RANGES.holdSeconds[0]);
      expect(params.holdSeconds).toBeLessThanOrEqual(DEFAULT_RANGES.holdSeconds[1]);
      expect(params.pAccept + params.pDecline + params.pIgnore).toBeCloseTo(1, 9);
      const ids = new Set(sessions.map((session) => session.id));
      let previousArrival = parseIso(scenario.openedAt);
      for (const participant of participants) {
        expect(participant.preferences.length).toBeGreaterThanOrEqual(1);
        expect(participant.preferences.length).toBeLessThanOrEqual(Math.min(3, sessions.length));
        expect(new Set(participant.preferences).size).toBe(participant.preferences.length);
        for (const sessionId of participant.preferences) {
          expect(ids.has(sessionId)).toBe(true);
          expect(participant.responses[sessionId]).toBeDefined();
          expect(participant.responses[sessionId]!.delayMs).toBeLessThanOrEqual(
            params.holdSeconds * 1000,
          );
        }
        const arrival = parseIso(participant.arrivalAt);
        expect(arrival).toBeGreaterThanOrEqual(previousArrival);
        previousArrival = arrival;
      }
      const lastCutoff = Math.max(...sessions.map((session) => parseIso(session.cutoffAt)));
      expect(parseIso(scenario.endsAt)).toBe(lastCutoff);
      expect(previousArrival).toBeLessThan(lastCutoff);
    }
  });

  it('produces different scenarios for different seeds', () => {
    expect(generateScenario(1)).not.toStrictEqual(generateScenario(2));
  });
});

describe('simulate', () => {
  it('reproduces identical output when the same seed is run twice', () => {
    const scenario = generateScenario(11);
    for (const mode of ['UNIFIED', 'PER_SESSION'] as const) {
      const first = simulate(scenario, mode);
      const second = simulate(scenario, mode);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first.metrics.decisions).toBeGreaterThan(50);
    }
    const withoutTiming = (rows: ReturnType<typeof runSeed>) =>
      JSON.stringify(rows.map(({ durationMs: _durationMs, ...row }) => row));
    expect(withoutTiming(runSeed(11))).toBe(withoutTiming(runSeed(11)));
  });

  it('keeps every invariant after every decision and never leaves a due offer live', () => {
    for (const seed of [1, 2, 3, 5]) {
      const scenario = generateScenario(seed);
      for (const mode of ['UNIFIED', 'PER_SESSION'] as const) {
        let steps = 0;
        const result = simulate(scenario, mode, {
          checkInvariants: true,
          onStep: (step) => {
            steps += 1;
            const report = checkInvariants(step.after, step.now);
            expect(
              report.violations,
              `${mode} seed ${seed} after ${step.command.type} at ${step.now}`,
            ).toEqual([]);
            expect(step.after).not.toBe(step.before);
            // the in-place store must produce exactly what core's applyChanges() returns
            expect(step.after).toStrictEqual(applyChanges(step.before, step.decision.writes));
            for (const offer of step.after.offers) {
              expect(parseIso(offer.expiresAt)).toBeGreaterThan(parseIso(step.now));
            }
          },
        });
        expect(steps).toBe(result.metrics.decisions);
        expect(steps).toBeGreaterThan(50);
        expect(result.metrics.invariant_violations).toBe(0);
        expect(result.rejections).toEqual({});
      }
    }
  });

  it('replays the same behaviour stream under both modes', () => {
    const scenario = generateScenario(3);
    const unified = simulate(scenario, 'UNIFIED');
    const perSession = simulate(scenario, 'PER_SESSION');
    expect(unified.metrics.participants).toBe(scenario.participants.length);
    expect(unified.metrics.registrations).toBe(scenario.participants.length);
    expect(perSession.metrics.registrations).toBe(
      scenario.participants.reduce((sum, participant) => sum + participant.preferences.length, 0),
    );
    expect(unified.snapshot.workshop.mode).toBe('UNIFIED');
    expect(perSession.snapshot.workshop.mode).toBe('PER_SESSION');
  });

  it('UNIFIED never has duplicate holds (C2) while PER_SESSION does', () => {
    let perSessionDuplicates = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const scenario = generateScenario(seed);
      const unified = simulate(scenario, 'UNIFIED').metrics;
      expect(unified.dup_hold_events).toBe(0);
      expect(unified.dup_hold_peak_users).toBe(0);
      expect(unified.dup_hold_seat_hours).toBe(0);
      expect(unified.duplicate_confirmed).toBe(0);
      expect(unified.distinct_served).toBeLessThanOrEqual(scenario.params.totalCapacity);
      const perSession = simulate(scenario, 'PER_SESSION').metrics;
      perSessionDuplicates += perSession.dup_hold_events;
      expect(perSession.confirmed_seats - perSession.duplicate_confirmed).toBe(
        perSession.distinct_served,
      );
    }
    expect(perSessionDuplicates).toBeGreaterThan(0);
  });

  it('relays released seats in the same decision (0 ms engine latency with ideal timers)', () => {
    const result = simulate(generateScenario(1), 'UNIFIED');
    expect(result.metrics.backfills_relayed).toBeGreaterThan(0);
    expect(result.metrics.backfill_relay_ms_mean).toBe(0);
    expect(result.metrics.seat_refill_samples).toBe(result.samples.refillMin.length);
    expect(result.metrics.seat_refill_samples + result.metrics.seat_refill_censored).toBe(
      result.metrics.seat_releases,
    );
    for (const minutes of result.samples.refillMin) {
      expect(minutes).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('stats', () => {
  it('computes interpolated quantiles and seeded bootstrap intervals', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.95)).toBe(5);
    expect(summarize([3, 1, 2]).median).toBe(2);
    expect(Number.isNaN(summarize([]).mean)).toBe(true);
    const values = Array.from({ length: 100 }, (_, index) => index);
    const first = bootstrapMeanCi(values, createRng(1), 500);
    const second = bootstrapMeanCi(values, createRng(1), 500);
    expect(second).toStrictEqual(first);
    expect(first.lo).toBeLessThan(49.5);
    expect(first.hi).toBeGreaterThan(49.5);
  });
});

describe('report', () => {
  it('writes one CSV row per seed and mode plus a deterministic summary and charts', () => {
    const rows = [...runSeed(1), ...runSeed(2)];
    const { files, comparisons } = buildReport(rows, META);
    expect(buildReport(rows, META).files).toStrictEqual(files);
    const csv = files['raw.csv']!.trim().split('\n');
    expect(csv).toHaveLength(5);
    expect(csv[0]).toMatch(/^seed,mode,nSessions,/);
    expect(csv[1]).toMatch(/^1,PER_SESSION,/);
    expect(csv[2]).toMatch(/^1,UNIFIED,/);
    const summary = files['summary.md']!;
    expect(summary).toContain('Distinct participants served');
    expect(summary).toContain('| UNIFIED | 2 |');
    for (const name of ['duplicate-holds.svg', 'distinct-served.svg', 'backfill-time.svg']) {
      expect(files[name]).toContain('<svg');
      expect(files[name]).toContain('PER_SESSION');
    }
    const served = comparisons.find((comparison) => comparison.spec.key === 'distinct_served')!;
    expect(served.unified.summary.n).toBe(2);
    expect(served.diff.summary.n).toBe(2);
  });
});
