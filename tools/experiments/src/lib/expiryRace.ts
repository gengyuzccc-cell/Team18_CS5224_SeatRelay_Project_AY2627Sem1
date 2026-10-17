/**
 * Verdicts of the expiry-race experiment (plan §4 "Expiry race", §1.2 tick-first). Expiry is
 * judged by server time when the worker PROCESSES a command, not when the API accepted it, so
 * an ACCEPT that reaches the API at `expiresAt − margin` can still be processed after
 * `expiresAt` when the queue latency exceeds the margin.
 */

export interface AcceptRecord {
  status: string;
  reason?: string;
  acceptedAt: string;
  settledAt?: string;
}

/**
 * Consistency of an ACCEPT outcome with the server's timestamps: APPLIED ⇒ accepted before
 * `expiresAt`; REJECTED(OFFER_EXPIRED) ⇒ settled at or after it.
 */
export function consistentWithServerTime(record: AcceptRecord, expiresAtMs: number): boolean {
  if (record.status === 'APPLIED') {
    return Date.parse(record.acceptedAt) < expiresAtMs;
  }
  if (record.reason === 'OFFER_EXPIRED') {
    return record.settledAt !== undefined && Date.parse(record.settledAt) >= expiresAtMs;
  }
  return false;
}

export type EarlyVerdict = 'PASS' | 'INCONCLUSIVE' | 'FAIL';

/**
 * The early ACCEPT (sent to reach the API before `expiresAt`):
 * - PASS: APPLIED, accepted before `expiresAt`;
 * - INCONCLUSIVE: REJECTED(OFFER_EXPIRED) settled at or after `expiresAt` (consistent with the
 *   server clock), either because the worker processed it after `expiresAt` (queue latency
 *   exceeded the margin) or because the request itself reached the API after `expiresAt` (the
 *   send timing missed, e.g. a cold start or a network spike on a long client-server path).
 *   Both are correct tick-first behaviour that says nothing about the early case, so the trial
 *   is repeated with a fresh workshop;
 * - FAIL: anything else (no settlement, another rejection, an outcome the server timestamps
 *   contradict, e.g. APPLIED although accepted after `expiresAt`, or REJECTED(OFFER_EXPIRED)
 *   although settled before `expiresAt`).
 */
export function classifyEarly(record: AcceptRecord | undefined, expiresAtMs: number): EarlyVerdict {
  if (record === undefined || !consistentWithServerTime(record, expiresAtMs)) {
    return 'FAIL';
  }
  if (record.status === 'APPLIED') {
    return 'PASS';
  }
  // REJECTED(OFFER_EXPIRED) and consistent with the server clock (settled at/after expiresAt):
  // the trial did not exercise the early case, whether the queue or the network made it late.
  return 'INCONCLUSIVE';
}

/** Processing the relay and settling the ACCEPT in the same worker pass are this close (ms). */
export const SAME_PASS_MS = 100;

/**
 * Which pass relayed the expired seat in a late trial, from the EXPIRED backfill record's
 * `reallocatedAt` and the late ACCEPT's `acceptedAt` / `settledAt`.
 */
export function relayOrder(
  reallocatedAtMs: number,
  acceptedAtMs: number,
  settledAtMs: number | undefined,
): string {
  if (reallocatedAtMs < acceptedAtMs) {
    return 'timer tick processed before the ACCEPT arrived';
  }
  if (settledAtMs !== undefined && settledAtMs - reallocatedAtMs <= SAME_PASS_MS) {
    return "the ACCEPT's own tick-first pass relayed the seat (timer tick not processed yet)";
  }
  return 'timer tick processed while the ACCEPT was queued';
}
