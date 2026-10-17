/**
 * The 20 fixed preference cases of plan §4 "Preference, order" and their oracle. Each case is
 * a fresh 5-session workshop: `fills[i]` filler accounts occupy seats of session i+1 first
 * (each filler registers for that one session and holds an offer), then the participant
 * registers with `prefs` (1-based session numbers, in preference order). Optionally one filler
 * of session `release` then cancels.
 *
 * Rule under test (R3, plan §2.2): the participant is offered the FIRST session of their
 * preference list that has a free seat, and never a session outside the list; with none free
 * they queue, and a later release of an acceptable session is relayed to them while a release
 * of a non-acceptable one is not. Someone already holding an offer is never given a second one
 * (C2), even when a more preferred session frees up.
 */

export const PREFERENCE_SESSIONS = 5;

export interface PreferenceCase {
  id: string;
  note: string;
  /** Capacity of S1…S5. */
  capacities: readonly number[];
  /** Seats of S1…S5 taken by fillers before the participant registers (≤ capacity). */
  fills: readonly number[];
  /** Acceptable sessions in preference order (1-based). */
  prefs: readonly number[];
  /** 1-based session one of whose fillers cancels after the participant registered. */
  release?: number;
}

const ones = [1, 1, 1, 1, 1] as const;
const full = (...sessions: number[]): number[] =>
  Array.from({ length: PREFERENCE_SESSIONS }, (_, i) => (sessions.includes(i + 1) ? 1 : 0));

export const PREFERENCE_CASES: readonly PreferenceCase[] = [
  { id: 'P01', note: 'all free → first preference', capacities: ones, fills: full(), prefs: [1, 2, 3, 4, 5] },
  { id: 'P02', note: 'all free, preference order ≠ session order', capacities: ones, fills: full(), prefs: [3, 1] },
  { id: 'P03', note: 'first preference full → second', capacities: ones, fills: full(1), prefs: [1, 2] },
  { id: 'P04', note: 'two full → third', capacities: ones, fills: full(1, 2), prefs: [1, 2, 3] },
  { id: 'P05', note: 'four full → last preference', capacities: ones, fills: full(1, 2, 3, 4), prefs: [1, 2, 3, 4, 5] },
  { id: 'P06', note: 'all full → queue; middle preference released', capacities: ones, fills: full(1, 2, 3, 4, 5), prefs: [1, 2, 3, 4, 5], release: 3 },
  { id: 'P07', note: 'single acceptable session full → queue; it is released', capacities: ones, fills: full(2), prefs: [2], release: 2 },
  { id: 'P08', note: 'non-acceptable session released → stays queued', capacities: ones, fills: full(1, 2), prefs: [2], release: 1 },
  { id: 'P09', note: 'capacity 2 with one seat taken → still free', capacities: [2, 1, 1, 1, 1], fills: [1, 0, 0, 0, 0], prefs: [1, 2] },
  { id: 'P10', note: 'capacity 2 with both seats taken → next preference', capacities: [2, 1, 1, 1, 1], fills: [2, 0, 0, 0, 0], prefs: [1, 2] },
  { id: 'P11', note: 'reverse order, first preference full', capacities: ones, fills: full(5), prefs: [5, 4, 3, 2, 1] },
  { id: 'P12', note: 'reverse order, three full', capacities: ones, fills: full(5, 4, 3), prefs: [5, 4, 3, 2, 1] },
  { id: 'P13', note: 'free sessions exist but none acceptable → queue; acceptable one released', capacities: ones, fills: full(2, 4), prefs: [2, 4], release: 4 },
  { id: 'P14', note: 'only the single acceptable session is free', capacities: ones, fills: full(1, 2, 3, 5), prefs: [4] },
  { id: 'P15', note: 'odd sessions acceptable and full, even free → queue; last preference released', capacities: ones, fills: full(1, 3, 5), prefs: [1, 3, 5], release: 5 },
  { id: 'P16', note: 'capacity 2 first preference half taken', capacities: [1, 1, 2, 1, 1], fills: [0, 0, 1, 0, 0], prefs: [3, 2] },
  { id: 'P17', note: 'first preference full, second preference is S1', capacities: ones, fills: full(2), prefs: [2, 1] },
  { id: 'P18', note: 'all full → queue; first preference released', capacities: ones, fills: full(1, 2, 3, 4, 5), prefs: [1, 2, 3, 4, 5], release: 1 },
  { id: 'P19', note: 'both acceptable full → queue; second preference released', capacities: ones, fills: full(2, 4), prefs: [4, 2], release: 2 },
  { id: 'P20', note: 'holding the second preference, first preference released → no second offer, no upgrade', capacities: ones, fills: full(1), prefs: [1, 2], release: 1 },
];

/** First acceptable session (1-based) with a free seat, or undefined (→ QUEUED). */
export function firstFreePreference(c: PreferenceCase): number | undefined {
  return c.prefs.find((session) => (c.fills[session - 1] ?? 0) < (c.capacities[session - 1] ?? 0));
}

/** The participant's state right after REGISTER, in `describeRegistration` notation. */
export function expectedAfterRegister(c: PreferenceCase): string {
  const offered = firstFreePreference(c);
  return offered === undefined ? 'QUEUED#1' : `OFFERED@S${offered}`;
}

/** The participant's state after the release (undefined when the case has none). */
export function expectedAfterRelease(c: PreferenceCase): string | undefined {
  if (c.release === undefined) {
    return undefined;
  }
  const offered = firstFreePreference(c);
  if (offered !== undefined) {
    return `OFFERED@S${offered}`; // C2: an offer holder never gets a second one
  }
  return c.prefs.includes(c.release) ? `OFFERED@S${c.release}` : 'QUEUED#1';
}

/** Filler seats of the case as `[session (1-based), seatIndex]`, in session order. */
export function fillerSeats(c: PreferenceCase): [number, number][] {
  const seats: [number, number][] = [];
  c.fills.forEach((count, index) => {
    for (let seat = 0; seat < count; seat += 1) {
      seats.push([index + 1, seat]);
    }
  });
  return seats;
}

/** Structural sanity of the table (unit-tested): sizes, fills ≤ capacity, distinct prefs. */
export function validateCase(c: PreferenceCase): string[] {
  const problems: string[] = [];
  if (c.capacities.length !== PREFERENCE_SESSIONS || c.fills.length !== PREFERENCE_SESSIONS) {
    problems.push('capacities and fills must list 5 sessions');
  }
  c.fills.forEach((fill, i) => {
    if (fill > (c.capacities[i] ?? 0)) {
      problems.push(`S${i + 1}: fills ${fill} > capacity ${c.capacities[i]}`);
    }
  });
  if (c.prefs.length === 0 || new Set(c.prefs).size !== c.prefs.length) {
    problems.push('prefs must be non-empty and distinct');
  }
  if (c.prefs.some((session) => session < 1 || session > PREFERENCE_SESSIONS)) {
    problems.push('prefs out of range');
  }
  if (c.release !== undefined && (c.fills[c.release - 1] ?? 0) === 0) {
    problems.push(`release S${c.release} has no filler to cancel`);
  }
  return problems;
}
