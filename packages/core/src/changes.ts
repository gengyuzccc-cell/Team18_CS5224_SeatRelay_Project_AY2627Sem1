import type {
  BackfillRecord,
  Offer,
  Registration,
  Session,
  WorkshopStatus,
} from '@seatrelay/contracts';
import { byRelease, bySeq, cloneSnapshot, type WorkshopSnapshot } from './snapshot';

/**
 * Writes produced by one decision. Each kind maps 1:1 onto storage operations
 * (DynamoDB items / Postgres rows); adapters never run business logic (CONVENTIONS §4).
 *
 * - `PUT_WORKSHOP_STATE` carries engine-owned fields only (never title/description, which the
 *   API edits synchronously). `version` is the snapshot version + 1: adapters condition the
 *   write on the snapshot version (optimistic lock of the whole workshop partition).
 * - `ARCHIVE_*` = delete the live item and put the history item with its final status.
 * - Backfill records: `PUT_BACKFILL` is a final (history) record, relayed or closed without a
 *   taker; `PUT_PENDING_BACKFILL` is a release that still waits for a taker while a REALLOCATE
 *   continuation is pending — a live item that `loadSnapshot` returns as `pendingBackfills`;
 *   `ARCHIVE_BACKFILL` moves such a pending record to history (delete live + put history) once
 *   it is relayed or closed.
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
  | { kind: 'PUT_BACKFILL'; record: BackfillRecord }
  | { kind: 'PUT_PENDING_BACKFILL'; record: BackfillRecord }
  | { kind: 'ARCHIVE_BACKFILL'; record: BackfillRecord };

export type ChangeKind = Change['kind'];

/**
 * Storage items one change costs in a single-transaction commit (plan §2.3, the DynamoDB
 * 100-item `TransactWriteItems` limit). The mapping is the pessimistic one an adapter that
 * follows the plan literally needs: a registration write also touches the `L#U#{userId}`
 * uniqueness marker (R1), and every `ARCHIVE_*` is a Delete of the live item plus a Put of the
 * history item. Adapters that write fewer items stay under the budget automatically.
 */
export const COMMIT_ITEM_COST: Readonly<Record<ChangeKind, number>> = Object.freeze({
  PUT_WORKSHOP_STATE: 1,
  PUT_SESSION: 1,
  PUT_REGISTRATION: 2,
  ARCHIVE_REGISTRATION: 3,
  PUT_OFFER: 1,
  ARCHIVE_OFFER: 2,
  PUT_BACKFILL: 1,
  PUT_PENDING_BACKFILL: 1,
  ARCHIVE_BACKFILL: 2,
});

/** Every notification is one item of the same transaction (the notifier reads them from storage). */
export const NOTIFICATION_ITEM_COST = 1;
/** The settled CommandResult of a user command is written in the same transaction. */
export const COMMAND_RESULT_ITEM_COST = 1;

/**
 * Items a commit of this decision needs under `COMMIT_ITEM_COST`, including one item per
 * notification and the CommandResult. The engine keeps every decision at or below
 * `limits.maxItemsPerDecision` with this very formula; adapters and tests use it to check a
 * commit against the transaction limit.
 */
export function estimateCommitItems(decision: {
  writes: readonly Change[];
  notifications: readonly unknown[];
}): number {
  let items = COMMAND_RESULT_ITEM_COST + decision.notifications.length * NOTIFICATION_ITEM_COST;
  for (const change of decision.writes) {
    items += COMMIT_ITEM_COST[change.kind];
  }
  return items;
}

function upsert<T>(items: T[], item: T, same: (a: T, b: T) => boolean): void {
  const index = items.findIndex((existing) => same(existing, item));
  if (index === -1) {
    items.push(item);
  } else {
    items[index] = item;
  }
}

/**
 * Pure: returns the snapshot that storage would load after committing `writes` (live items
 * only: `settledOffers`, a per-command augmentation, is dropped).
 * Used by tests, the in-memory store and the replay simulation.
 */
export function applyChanges(
  snapshot: WorkshopSnapshot,
  writes: readonly Change[],
): WorkshopSnapshot {
  const next = cloneSnapshot(snapshot);
  delete next.settledOffers;
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
      case 'PUT_PENDING_BACKFILL':
        upsert(next.pendingBackfills, structuredClone(change.record), (a, b) => a.id === b.id);
        break;
      case 'PUT_BACKFILL':
      case 'ARCHIVE_BACKFILL':
        next.pendingBackfills = next.pendingBackfills.filter(
          (record) => record.id !== change.record.id,
        );
        break;
    }
  }
  next.registrations.sort(bySeq);
  next.pendingBackfills.sort(byRelease);
  return next;
}
