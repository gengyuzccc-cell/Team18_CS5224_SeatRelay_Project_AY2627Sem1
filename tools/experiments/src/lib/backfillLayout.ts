/**
 * Layout of the backfill experiment (plan §4 "Backfill latency"): how many workshops, seats and
 * registrations are needed so that `offers` offers expire with a full layer of people queued
 * behind them for each of `rounds` rounds, plus `cancellations` cancellation-driven samples.
 */
export interface BackfillLayout {
  workshops: number;
  sessions: number;
  capacity: number;
  rounds: number;
  /** Seats per workshop. */
  seats: number;
  /** Expiry samples per run. */
  offers: number;
  /** Cancellation-driven samples per workshop. */
  extraPerWorkshop: number;
  /** Registrations per workshop (= accounts needed). */
  registrantsPerWorkshop: number;
}

/** Derives the per-workshop layout from the CLI parameters (unit-tested). */
export function backfillLayout(params: { offers: number; workshops: number; sessions: number; rounds: number; cancellations: number }): BackfillLayout {
  const workshops = Math.max(1, params.workshops);
  const sessions = Math.min(5, Math.max(2, params.sessions));
  const rounds = Math.max(1, params.rounds);
  const capacity = Math.max(1, Math.ceil(params.offers / (workshops * sessions * rounds)));
  const seats = sessions * capacity;
  const extraPerWorkshop = Math.min(seats, Math.ceil(Math.max(0, params.cancellations) / workshops));
  return {
    workshops,
    sessions,
    capacity,
    rounds,
    seats,
    offers: workshops * seats * rounds,
    extraPerWorkshop,
    registrantsPerWorkshop: seats * (rounds + 1) + extraPerWorkshop,
  };
}
