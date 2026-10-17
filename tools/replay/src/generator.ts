import { cutoffFor, parseIso, toIso } from '@seatrelay/core';
import { createRng, mixSeed, type Rng } from './prng';

/**
 * Scenario generator (plan §4 "Mechanism comparison"). One seed produces one workshop with
 * 2–5 sessions, an oversubscribed population of participants arriving over a window, and a
 * fully pre-drawn behaviour stream per participant (how they react to each session's offer,
 * whether they cancel, give up or tidy up duplicate registrations). The same scenario object
 * is then replayed under UNIFIED and PER_SESSION mode, so every difference in the metrics
 * comes from the mechanism, not from the random stream.
 */

export const SCENARIO_OPENED_AT = '2026-11-02T00:00:00.000Z';

export type OfferReaction = 'ACCEPT' | 'DECLINE' | 'IGNORE';

export interface GeneratorRanges {
  /** Sessions per workshop (inclusive). */
  sessions: [number, number];
  /** Capacity per session (inclusive). */
  capacity: [number, number];
  /** participants = round(totalCapacity × oversubscription). */
  oversubscription: [number, number];
  /** Workshop `holdSeconds` (inclusive). */
  holdSeconds: [number, number];
  /** Length of the arrival window in hours, starting when registration opens. */
  arrivalWindowHours: [number, number];
  /** Hours after the end of the arrival window at which each session starts. */
  sessionLeadHours: [number, number];
  /** P(1 acceptable session), P(2), P(3); truncated to the session count. */
  preferenceSizeWeights: [number, number, number];
  /** Probability of accepting an offer for a session the participant has no other hold for. */
  pAccept: [number, number];
  /** Probability of declining such an offer (the rest is "no response": the offer expires). */
  pDecline: [number, number];
  /** Probability that a confirmed participant later cancels (uniformly before cut-off). */
  pCancel: [number, number];
  /** Probability that a participant who is still only queued gives up after a while. */
  pAbandon: [number, number];
  /** PER_SESSION only: probability of cancelling the other registrations once confirmed. */
  pCleanup: [number, number];
  /** PER_SESSION only: probability of accepting a second offer while already holding a seat. */
  pHoard: [number, number];
  /** PER_SESSION only: probability of declining a second offer (the rest is ignored). */
  pSecondaryDecline: [number, number];
  /** Clean-up delay after the first confirmation: `max × u²` hours. */
  cleanupDelayHoursMax: number;
  /** Waiting time before a queued-only participant gives up, in hours. */
  abandonAfterHours: [number, number];
}

export const DEFAULT_RANGES: Readonly<GeneratorRanges> = Object.freeze({
  sessions: [2, 5],
  capacity: [5, 30],
  oversubscription: [1.2, 3.0],
  holdSeconds: [60, 900],
  arrivalWindowHours: [1, 72],
  sessionLeadHours: [2, 120],
  preferenceSizeWeights: [0.3, 0.45, 0.25],
  pAccept: [0.55, 0.9],
  pDecline: [0.05, 0.25],
  pCancel: [0, 0.2],
  pAbandon: [0, 0.15],
  pCleanup: [0.2, 0.8],
  pHoard: [0.1, 0.4],
  pSecondaryDecline: [0.2, 0.5],
  cleanupDelayHoursMax: 12,
  abandonAfterHours: [0.5, 48],
} satisfies GeneratorRanges);

export interface ScenarioSession {
  id: string;
  title: string;
  startsAt: string;
  cutoffAt: string;
  capacity: number;
  /** Relative demand weight used when drawing preference sets (hot sessions exist). */
  popularity: number;
}

export interface OfferResponse {
  reaction: OfferReaction;
  /** Delay between the offer and the ACCEPT/DECLINE (ignored for IGNORE). */
  delayMs: number;
}

export interface Participant {
  index: number;
  userId: string;
  email: string;
  arrivalAt: string;
  /** Acceptable sessionIds in preference order (1–3). */
  preferences: string[];
  /** Reaction to an offer for each acceptable session (same in both modes). */
  responses: Record<string, OfferResponse>;
  /** PER_SESSION only: reaction to an offer while already holding a seat elsewhere. */
  secondaryReaction: OfferReaction;
  cleansUp: boolean;
  cleanupDelayMs: number;
  cancels: boolean;
  /** Position of the cancellation between the first confirmation and that session's cut-off. */
  cancelFraction: number;
  abandons: boolean;
  abandonAfterMs: number;
}

export interface ScenarioParams {
  nSessions: number;
  totalCapacity: number;
  oversubscription: number;
  nParticipants: number;
  holdSeconds: number;
  arrivalWindowHours: number;
  pAccept: number;
  pDecline: number;
  pIgnore: number;
  pCancel: number;
  pAbandon: number;
  pCleanup: number;
  pHoard: number;
  pSecondaryDecline: number;
}

export interface Scenario {
  seed: number;
  openedAt: string;
  /** Latest cut-off: nothing can change the outcome after it. */
  endsAt: string;
  params: ScenarioParams;
  sessions: ScenarioSession[];
  participants: Participant[];
}

const HOUR_MS = 3_600_000;

function drawReaction(rng: Rng, pAccept: number, pDecline: number): OfferReaction {
  const roll = rng.next();
  if (roll < pAccept) {
    return 'ACCEPT';
  }
  if (roll < pAccept + pDecline) {
    return 'DECLINE';
  }
  return 'IGNORE';
}

/** Weighted sampling without replacement. */
function samplePreferences(
  rng: Rng,
  sessions: readonly ScenarioSession[],
  count: number,
): string[] {
  const pool = sessions.map((session) => ({ id: session.id, weight: session.popularity }));
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = rng.weightedIndex(pool.map((entry) => entry.weight));
    picked.push(pool[index]!.id);
    pool.splice(index, 1);
  }
  return picked;
}

export function generateScenario(
  seed: number,
  ranges: Readonly<GeneratorRanges> = DEFAULT_RANGES,
): Scenario {
  const rng = createRng(mixSeed(seed, 0x5ea7));
  const openedMs = parseIso(SCENARIO_OPENED_AT);

  const nSessions = rng.int(ranges.sessions[0], ranges.sessions[1]);
  const capacities: number[] = [];
  const popularities: number[] = [];
  for (let index = 0; index < nSessions; index += 1) {
    capacities.push(rng.int(ranges.capacity[0], ranges.capacity[1]));
    popularities.push(0.25 + rng.exponential());
  }
  const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
  const oversubscription = rng.float(ranges.oversubscription[0], ranges.oversubscription[1]);
  const nParticipants = Math.max(nSessions, Math.round(totalCapacity * oversubscription));
  const holdSeconds = rng.int(ranges.holdSeconds[0], ranges.holdSeconds[1]);
  const arrivalWindowHours = rng.float(ranges.arrivalWindowHours[0], ranges.arrivalWindowHours[1]);
  const windowEndMs = openedMs + Math.round(arrivalWindowHours * HOUR_MS);

  const starts: number[] = [];
  for (let index = 0; index < nSessions; index += 1) {
    const leadHours = rng.float(ranges.sessionLeadHours[0], ranges.sessionLeadHours[1]);
    starts.push(windowEndMs + Math.round(leadHours * 60) * 60_000); // whole minutes
  }
  starts.sort((a, b) => a - b);
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index]! <= starts[index - 1]!) {
      starts[index] = starts[index - 1]! + 60_000; // keep start times distinct
    }
  }
  const sessions: ScenarioSession[] = starts.map((startMs, index) => {
    const startsAt = toIso(startMs);
    return {
      id: `S${index + 1}`,
      title: `Session ${index + 1}`,
      startsAt,
      cutoffAt: cutoffFor(startsAt),
      capacity: capacities[index]!,
      popularity: popularities[index]!,
    };
  });

  const pAccept = rng.float(ranges.pAccept[0], ranges.pAccept[1]);
  const pDecline = Math.min(rng.float(ranges.pDecline[0], ranges.pDecline[1]), 0.98 - pAccept);
  const pCancel = rng.float(ranges.pCancel[0], ranges.pCancel[1]);
  const pAbandon = rng.float(ranges.pAbandon[0], ranges.pAbandon[1]);
  const pCleanup = rng.float(ranges.pCleanup[0], ranges.pCleanup[1]);
  const pHoard = rng.float(ranges.pHoard[0], ranges.pHoard[1]);
  const pSecondaryDecline = rng.float(ranges.pSecondaryDecline[0], ranges.pSecondaryDecline[1]);

  const sizeWeights = ranges.preferenceSizeWeights.slice(0, Math.min(3, nSessions));
  const participants: Participant[] = [];
  for (let index = 0; index < nParticipants; index += 1) {
    // Front-loaded arrivals: most people register soon after the announcement.
    const arrivalMs = openedMs + Math.round(arrivalWindowHours * HOUR_MS * rng.next() ** 1.7);
    const count = rng.weightedIndex(sizeWeights) + 1;
    const preferences = samplePreferences(rng, sessions, count);
    const responses: Record<string, OfferResponse> = {};
    for (const sessionId of preferences) {
      const reaction = drawReaction(rng, pAccept, pDecline);
      const delayMs = Math.round(holdSeconds * 1000 * rng.next() ** 2);
      responses[sessionId] = { reaction, delayMs };
    }
    const secondaryReaction = drawReaction(rng, pHoard, pSecondaryDecline);
    const cleansUp = rng.bool(pCleanup);
    const cleanupDelayMs = Math.round(ranges.cleanupDelayHoursMax * HOUR_MS * rng.next() ** 2);
    const cancels = rng.bool(pCancel);
    const cancelFraction = rng.float(0.05, 0.95);
    const abandons = rng.bool(pAbandon);
    const abandonAfterMs = Math.round(
      rng.float(ranges.abandonAfterHours[0], ranges.abandonAfterHours[1]) * HOUR_MS,
    );
    participants.push({
      index,
      userId: `u${index + 1}`,
      email: `u${index + 1}@replay.example`,
      arrivalAt: toIso(arrivalMs),
      preferences,
      responses,
      secondaryReaction,
      cleansUp,
      cleanupDelayMs,
      cancels,
      cancelFraction,
      abandons,
      abandonAfterMs,
    });
  }
  participants.sort((a, b) => parseIso(a.arrivalAt) - parseIso(b.arrivalAt) || a.index - b.index);

  const endsAt = toIso(Math.max(...sessions.map((session) => parseIso(session.cutoffAt))));
  return {
    seed,
    openedAt: SCENARIO_OPENED_AT,
    endsAt,
    params: {
      nSessions,
      totalCapacity,
      oversubscription,
      nParticipants,
      holdSeconds,
      arrivalWindowHours,
      pAccept,
      pDecline,
      pIgnore: 1 - pAccept - pDecline,
      pCancel,
      pAbandon,
      pCleanup,
      pHoard,
      pSecondaryDecline,
    },
    sessions,
    participants,
  };
}
