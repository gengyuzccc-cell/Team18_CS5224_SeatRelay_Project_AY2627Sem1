/**
 * Numeric constants shared by every layer (web, API, worker, core).
 * The engine never hard-codes these; it reads `holdSeconds` from the workshop and
 * `cutoffAt` from the session, both produced by the API from these defaults.
 */
export const DEFAULT_HOLD_SECONDS = 900;
export const MIN_HOLD_SECONDS = 30;
export const MAX_HOLD_SECONDS = 86_400;

export const MIN_SESSIONS_PER_WORKSHOP = 2;
export const MAX_SESSIONS_PER_WORKSHOP = 5;

/** `cutoffAt = startsAt − 30 min`, fixed when the session is created (R4). */
export const CUTOFF_BEFORE_START_SECONDS = 30 * 60;

/** Browser polling hint returned with every 202 (plan §1.3). */
export const COMMAND_POLL_AFTER_MS = 300;

/** Data retention (plan §1.4): CommandResult 30 days, Notification 90 days. */
export const COMMAND_RESULT_TTL_SECONDS = 30 * 86_400;
export const NOTIFICATION_TTL_SECONDS = 90 * 86_400;

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5_000;
export const MAX_DISPLAY_NAME_LENGTH = 120;
export const MAX_ORG_NAME_LENGTH = 120;
