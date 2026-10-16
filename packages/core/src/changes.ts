import type {
  BackfillRecord,
  Offer,
  Registration,
  Session,
  WorkshopStatus,
} from '@seatrelay/contracts';
import { bySeq, cloneSnapshot, type WorkshopSnapshot } from './snapshot';

/**
 * Writes produced by one decision. Each kind maps 1:1 onto storage operations
 * (DynamoDB items / Postgres rows); adapters never run business logic (CONVENTIONS §4).
 *
 * - `PUT_WORKSHOP_STATE` carries engine-owned fields only (never title/description, which the
 *   API edits synchronously). `version` is the snapshot version + 1: adapters condition the
 *   write on the snapshot version (optimistic lock of the whole workshop partition).
 * - `ARCHIVE_*` = delete the live item and put the history item with its final status.
 * - `PUT_BACKFILL` is append-only history; it never changes the live snapshot.
 *
 * At most one change per entity is emitted per decision (DynamoDB forbids two operations on
 * the same item in one transaction).
 */
export type Change =
  | {
      kind: 'PUT_WORKSHOP_STATE';
      workshopId: string;
      status: WorkshopStatus;
      seq: number;
      version: number;
      nextDueAt?: string;
      updatedAt: string;
    }
  | { kind: 'PUT_SESSION'; session: Session }
  | { kind: 'PUT_REGISTRATION'; registration: Registration }
  | { kind: 'ARCHIVE_REGISTRATION'; registration: Registration }
  | { kind: 'PUT_OFFER'; offer: Offer }
  | { kind: 'ARCHIVE_OFFER'; offer: Offer }
  | { kind: 'PUT_BACKFILL'; record: BackfillRecord };

export type ChangeKind = Change['kind'];

function upsert<T>(items: T[], item: T, same: (a: T, b: T) => boolean): void {
  const index = items.findIndex((existing) => same(existing, item));
  if (index === -1) {
    items.push(item);
  } else {
    items[index] = item;
  }
}

/**
 * Pure: returns the snapshot that storage would load after committing `writes`.
 * Used by tests, the in-memory store and the replay simulation.
 */
export function applyChanges(
  snapshot: WorkshopSnapshot,
  writes: readonly Change[],
): WorkshopSnapshot {
  const next = cloneSnapshot(snapshot);
  for (const change of writes) {
    switch (change.kind) {
      case 'PUT_WORKSHOP_STATE': {
        next.workshop.status = change.status;
        next.workshop.seq = change.seq;
        next.workshop.version = change.version;
        next.workshop.updatedAt = change.updatedAt;
        if (change.nextDueAt === undefined) {
          delete next.workshop.nextDueAt;
        } else {
          next.workshop.nextDueAt = change.nextDueAt;
        }
        break;
      }
      case 'PUT_SESSION':
        upsert(next.sessions, structuredClone(change.session), (a, b) => a.id === b.id);
        break;
      case 'PUT_REGISTRATION':
        upsert(next.registrations, structuredClone(change.registration), (a, b) => a.seq === b.seq);
        break;
      case 'ARCHIVE_REGISTRATION':
        next.registrations = next.registrations.filter(
          (registration) => registration.seq !== change.registration.seq,
        );
        break;
      case 'PUT_OFFER':
        upsert(next.offers, structuredClone(change.offer), (a, b) => a.id === b.id);
        break;
      case 'ARCHIVE_OFFER':
        next.offers = next.offers.filter((offer) => offer.id !== change.offer.id);
        break;
      case 'PUT_BACKFILL':
        break;
    }
  }
  next.registrations.sort(bySeq);
  return next;
}
