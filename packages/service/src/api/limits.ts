import type { Registration } from '@seatrelay/contracts';
import { compareIso } from '@seatrelay/core';

/**
 * Caps on the two per-user lists the API returns whole (the contract has no paging): a real
 * participant has a handful of registrations and notifications, the experiments' synthetic
 * accounts have thousands, and every registration costs one workshop snapshot read. Beyond the
 * cap the newest entries win, so what the pages show is what the user did last.
 */
export const MAX_MY_REGISTRATIONS = 500;
export const MAX_MY_NOTIFICATIONS = 500;

/** The `limit` most recently updated registrations, newest first (ties: higher seq first). */
export function mostRecentRegistrations(
  registrations: readonly Registration[],
  limit: number = MAX_MY_REGISTRATIONS,
): Registration[] {
  return [...registrations]
    .sort((a, b) => compareIso(b.updatedAt, a.updatedAt) || b.seq - a.seq)
    .slice(0, limit);
}
