import type { Registration, WorkshopMode } from '@seatrelay/contracts';

/**
 * PER_SESSION baseline strategy (plan §2.2): registrations bind to a single session, every
 * session has its own queue and no cross-session constraint is applied, so the same user may
 * hold seats or queue places in several sessions at once (the "duplicate hold" phenomenon the
 * replay measures). UNIFIED mode is one queue per workshop with one live registration per user.
 *
 * All mode-dependent decisions of the engine go through these helpers.
 */

export function requiresSingleSession(mode: WorkshopMode): boolean {
  return mode === 'PER_SESSION';
}

/** Session a PER_SESSION registration is bound to (its only acceptable session). */
export function boundSessionId(registration: Pick<Registration, 'acceptable'>): string {
  return registration.acceptable[0] ?? '';
}

/** Queue scope: one queue per workshop (UNIFIED) or one per session (PER_SESSION). */
export function queueScopeKey(
  mode: WorkshopMode,
  registration: Pick<Registration, 'acceptable'>,
): string {
  return mode === 'PER_SESSION' ? boundSessionId(registration) : '*';
}

/** R1 uniqueness scope: per user per workshop (UNIFIED) or per user per session (PER_SESSION). */
export function registrationScopeKey(
  mode: WorkshopMode,
  registration: Pick<Registration, 'userId' | 'acceptable'>,
): string {
  return mode === 'PER_SESSION'
    ? `${registration.userId}#${boundSessionId(registration)}`
    : registration.userId;
}

/** C2 scope for OFFERED/CONFIRMED holds: per user (UNIFIED) or per user per session (PER_SESSION). */
export function holdScopeKey(mode: WorkshopMode, userId: string, sessionId: string): string {
  return mode === 'PER_SESSION' ? `${userId}#${sessionId}` : userId;
}

/** Whether a new registration by `userId` for `acceptable` collides with an existing live one (R1). */
export function registrationConflicts(
  mode: WorkshopMode,
  existing: Pick<Registration, 'userId' | 'acceptable'>,
  userId: string,
  acceptable: readonly string[],
): boolean {
  if (existing.userId !== userId) {
    return false;
  }
  if (mode === 'UNIFIED') {
    return true;
  }
  return acceptable.includes(boundSessionId(existing));
}
