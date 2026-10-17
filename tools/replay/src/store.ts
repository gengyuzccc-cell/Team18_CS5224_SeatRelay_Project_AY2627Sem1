import { byRelease, bySeq, type Change, type WorkshopSnapshot } from '@seatrelay/core';

/**
 * The replay's storage adapter. It maps a decision's `Change[]` onto the live snapshot exactly
 * like core's `applyChanges()` (upsert / remove per entity kind, registrations sorted by seq)
 * but in place: `decide()` never mutates its input and works on its own deep copy, so once the
 * writes are applied the previous snapshot is not needed and the second full `structuredClone`
 * per decision (about a third of the replay's CPU time) is avoided. No business logic lives
 * here (CONVENTIONS §4). The test suite asserts that the result equals
 * `applyChanges(before, writes)` after every decision.
 */
export function applyChangesInPlace(
  snapshot: WorkshopSnapshot,
  writes: readonly Change[],
): WorkshopSnapshot {
  for (const change of writes) {
    switch (change.kind) {
      case 'PUT_WORKSHOP_STATE': {
        const { workshop } = snapshot;
        workshop.status = change.status;
        workshop.seq = change.seq;
        workshop.version = change.version;
        workshop.updatedAt = change.updatedAt;
        if (change.nextDueAt === undefined) {
          delete workshop.nextDueAt;
        } else {
          workshop.nextDueAt = change.nextDueAt;
        }
        break;
      }
      case 'PUT_SESSION': {
        const index = snapshot.sessions.findIndex((session) => session.id === change.session.id);
        if (index === -1) {
          snapshot.sessions.push(change.session);
        } else {
          snapshot.sessions[index] = change.session;
        }
        break;
      }
      case 'PUT_REGISTRATION': {
        const index = snapshot.registrations.findIndex(
          (registration) => registration.seq === change.registration.seq,
        );
        if (index === -1) {
          snapshot.registrations.push(change.registration);
        } else {
          snapshot.registrations[index] = change.registration;
        }
        break;
      }
      case 'ARCHIVE_REGISTRATION':
        snapshot.registrations = snapshot.registrations.filter(
          (registration) => registration.seq !== change.registration.seq,
        );
        break;
      case 'PUT_OFFER': {
        const index = snapshot.offers.findIndex((offer) => offer.id === change.offer.id);
        if (index === -1) {
          snapshot.offers.push(change.offer);
        } else {
          snapshot.offers[index] = change.offer;
        }
        break;
      }
      case 'ARCHIVE_OFFER':
        snapshot.offers = snapshot.offers.filter((offer) => offer.id !== change.offer.id);
        break;
      case 'PUT_PENDING_BACKFILL': {
        const index = snapshot.pendingBackfills.findIndex(
          (record) => record.id === change.record.id,
        );
        if (index === -1) {
          snapshot.pendingBackfills.push(change.record);
        } else {
          snapshot.pendingBackfills[index] = change.record;
        }
        break;
      }
      case 'PUT_BACKFILL':
      case 'ARCHIVE_BACKFILL':
        snapshot.pendingBackfills = snapshot.pendingBackfills.filter(
          (record) => record.id !== change.record.id,
        );
        break;
    }
  }
  snapshot.registrations.sort(bySeq);
  snapshot.pendingBackfills.sort(byRelease);
  return snapshot;
}
