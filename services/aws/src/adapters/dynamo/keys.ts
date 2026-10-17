/**
 * Single-table key design (plan §2.3). PK/SK strings; live (`L#`) and history (`H#`) prefixes
 * are separated inside the `WS#` partition so that the worker snapshot
 * (`Query PK = WS#{wsId} AND begins_with(SK, 'L#')`) never grows with settled data.
 *
 * | item                     | PK                | SK                              | GSI1PK        | GSI1SK                 |
 * |--------------------------|-------------------|---------------------------------|---------------|------------------------|
 * | Organization             | ORG#{orgId}       | META                            |               |                        |
 * | Org membership (1/member)| ORG#{orgId}       | M#{userId}                      | U#{userId}    | ORG#{orgId}            |
 * | Workshop                 | WS#{wsId}         | L#META                          | ORG#{orgId}   | WS#{createdAt}         |
 * | DUE marker (sparse)      | WS#{wsId}         | L#DUE                           | DUE           | {nextDueAt}#{wsId}     |
 * | Session                  | WS#{wsId}         | L#S#{sessionId}                 |               |                        |
 * | Registration (live)      | WS#{wsId}         | L#R#{seq:08d}                   | U#{userId}    | WS#{wsId}              |
 * | Registration (history)   | WS#{wsId}         | H#R#{seq:08d}                   | U#{userId}    | WS#{wsId}              |
 * | R1 unique marker         | WS#{wsId}         | L#U#{scope}  (scope = userId or userId#sessionId) |  |            |
 * | Offer (live, OFFERED)    | WS#{wsId}         | L#O#{offerId}                   |               |                        |
 * | Offer (history)          | WS#{wsId}         | H#O#{offerId}                   |               |                        |
 * | Backfill (pending, live) | WS#{wsId}         | L#BF#{releasedAt}#{id}          |               |                        |
 * | Backfill (history)       | WS#{wsId}         | H#BF#{releasedAt}#{id}          |               |                        |
 * | Attendance               | WS#{wsId}         | H#A#{userId}                    |               |                        |
 * | CommandResult            | CMD#{commandId}   | META                            |               |                        |
 * | Notification             | U#{userId}        | N#{createdAt}#{id}              |               |                        |
 *
 * The DUE marker is a separate live item (not attributes of L#META) because one item carries one
 * GSI1 key and the workshop META already uses GSI1 for the per-organisation listing; the marker is
 * put/deleted in the same transaction as the META update, so it is exactly as consistent.
 */

export const ENTITY_TYPES = [
  'ORGANIZATION',
  'ORG_MEMBER',
  'WORKSHOP',
  'DUE_MARKER',
  'SESSION',
  'REGISTRATION',
  'UNIQUE_MARKER',
  'OFFER',
  'BACKFILL',
  'ATTENDANCE',
  'COMMAND',
  'NOTIFICATION',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface ItemKey {
  PK: string;
  SK: string;
}

export const GSI1_NAME = 'GSI1';
export const DUE_GSI_PK = 'DUE';

/** Fixed-width seq so that live/history registration keys sort numerically. */
export const SEQ_WIDTH = 8;
export function padSeq(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0 || seq >= 10 ** SEQ_WIDTH) {
    throw new Error(`registration seq out of range: ${seq}`);
  }
  return String(seq).padStart(SEQ_WIDTH, '0');
}

/* ---------- partitions ---------- */

export const orgPk = (orgId: string): string => `ORG#${orgId}`;
export const workshopPk = (wsId: string): string => `WS#${wsId}`;
export const commandPk = (commandId: string): string => `CMD#${commandId}`;
export const userPk = (userId: string): string => `U#${userId}`;

/* ---------- sort keys ---------- */

export const META_SK = 'META';
export const WORKSHOP_META_SK = 'L#META';
export const DUE_MARKER_SK = 'L#DUE';
export const LIVE_PREFIX = 'L#';
export const HISTORY_PREFIX = 'H#';
export const SESSION_PREFIX = 'L#S#';
export const LIVE_REGISTRATION_PREFIX = 'L#R#';
export const HISTORY_REGISTRATION_PREFIX = 'H#R#';
export const UNIQUE_MARKER_PREFIX = 'L#U#';
export const LIVE_OFFER_PREFIX = 'L#O#';
export const HISTORY_OFFER_PREFIX = 'H#O#';
export const PENDING_BACKFILL_PREFIX = 'L#BF#';
export const HISTORY_BACKFILL_PREFIX = 'H#BF#';
export const ATTENDANCE_PREFIX = 'H#A#';
export const ORG_MEMBER_PREFIX = 'M#';
export const NOTIFICATION_PREFIX = 'N#';

export const orgKey = (orgId: string): ItemKey => ({ PK: orgPk(orgId), SK: META_SK });
export const orgMemberKey = (orgId: string, userId: string): ItemKey => ({
  PK: orgPk(orgId),
  SK: `${ORG_MEMBER_PREFIX}${userId}`,
});
export const workshopKey = (wsId: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: WORKSHOP_META_SK,
});
export const dueMarkerKey = (wsId: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: DUE_MARKER_SK,
});
export const sessionKey = (wsId: string, sessionId: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${SESSION_PREFIX}${sessionId}`,
});
export const liveRegistrationKey = (wsId: string, seq: number): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${LIVE_REGISTRATION_PREFIX}${padSeq(seq)}`,
});
export const historyRegistrationKey = (wsId: string, seq: number): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${HISTORY_REGISTRATION_PREFIX}${padSeq(seq)}`,
});
/** `scope` = core's `registrationScopeKey`: `userId` (UNIFIED) or `userId#sessionId` (PER_SESSION). */
export const uniqueMarkerKey = (wsId: string, scope: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${UNIQUE_MARKER_PREFIX}${scope}`,
});
export const liveOfferKey = (wsId: string, offerId: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${LIVE_OFFER_PREFIX}${offerId}`,
});
export const historyOfferKey = (wsId: string, offerId: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${HISTORY_OFFER_PREFIX}${offerId}`,
});
export const pendingBackfillKey = (wsId: string, releasedAt: string, id: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${PENDING_BACKFILL_PREFIX}${releasedAt}#${id}`,
});
export const historyBackfillKey = (wsId: string, releasedAt: string, id: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${HISTORY_BACKFILL_PREFIX}${releasedAt}#${id}`,
});
export const attendanceKey = (wsId: string, userId: string): ItemKey => ({
  PK: workshopPk(wsId),
  SK: `${ATTENDANCE_PREFIX}${userId}`,
});
export const commandKey = (commandId: string): ItemKey => ({
  PK: commandPk(commandId),
  SK: META_SK,
});
export const notificationKey = (userId: string, createdAt: string, id: string): ItemKey => ({
  PK: userPk(userId),
  SK: `${NOTIFICATION_PREFIX}${createdAt}#${id}`,
});

/* ---------- GSI1 ---------- */

export interface Gsi1Key {
  GSI1PK: string;
  GSI1SK: string;
}

/** Org membership: `U#{userId}` → `ORG#{orgId}`. */
export const orgMembershipGsi = (orgId: string, userId: string): Gsi1Key => ({
  GSI1PK: userPk(userId),
  GSI1SK: orgPk(orgId),
});
/** Workshops of an organisation in creation order: `ORG#{orgId}` → `WS#{createdAt}`. */
export const workshopGsi = (orgId: string, createdAt: string): Gsi1Key => ({
  GSI1PK: orgPk(orgId),
  GSI1SK: `WS#${createdAt}`,
});
/** Registrations (live and archived) of a user: `U#{userId}` → `WS#{wsId}`. */
export const registrationGsi = (userId: string, wsId: string): Gsi1Key => ({
  GSI1PK: userPk(userId),
  GSI1SK: `WS#${wsId}`,
});
/** Sparse DUE index: `DUE` → `{nextDueAt}#{wsId}` (ISO timestamps sort lexicographically). */
export const dueGsi = (nextDueAt: string, wsId: string): Gsi1Key => ({
  GSI1PK: DUE_GSI_PK,
  GSI1SK: `${nextDueAt}#${wsId}`,
});
/** Upper bound of a DUE query: every `{nextDueAt}#{wsId}` with `nextDueAt <= now`. */
export const dueGsiUpperBound = (now: string): string => `${now}#~`;

export const GSI1_ORG_PREFIX = 'ORG#';
export const GSI1_WORKSHOP_PREFIX = 'WS#';
