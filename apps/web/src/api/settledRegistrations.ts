import type {
  CommandResultView,
  MyRegistrationListView,
  MyRegistrationView,
  RegistrationStatus,
  RegistrationSummary,
  SessionView,
  WorkshopPublic,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';

/**
 * Plan §1.3: the poll response of a settled command carries the registration it touched, and the
 * UI updates from that response alone, because a read issued right after settlement can be
 * stale. `GET /workshops/{id}` is a consistent read, so its cached `me` is patched and then simply
 * refetched. `GET /me/registrations` is served from a GSI on AWS (eventually consistent): a
 * refetch issued a few milliseconds after the poll saw APPLIED can still return the pre-command
 * item. So the poll result is kept as an overlay, and every `/me/registrations` response is merged
 * with the overlays the server has not caught up with yet.
 *
 * "Caught up" needs no client clock. The worker stamps the registration's `updatedAt` with the
 * decision time, which is at or before the command's `settledAt`. Commands of one workshop are
 * serialised, so any later change carries an `updatedAt` after that `settledAt`. A fetched entry
 * therefore reflects the command when its persisted state equals the poll result, and supersedes
 * it when its `updatedAt` is later than `settledAt`. Anything else is a stale read.
 */

/** Safety net: an overlay the server never confirms (e.g. the workshop was deleted) is dropped. */
export const SETTLED_OVERLAY_MAX_MS = 60_000;

export interface SettledRegistration {
  workshopId: string;
  registration: RegistrationSummary;
  /** `CommandResultView.settledAt` (server clock). */
  settledAt: string;
  /** Used to insert the entry while the list does not contain it yet (REGISTER, archive in flight). */
  workshop?: WorkshopPublic;
  sessions?: SessionView[];
  /** Local clock when the poll answered; only compared with the local clock (overlay expiry). */
  receivedAt: number;
}

type ListedRegistration = MyRegistrationView['registration'];

const FINAL_STATUSES: readonly RegistrationStatus[] = ['CANCELLED', 'ENDED'];

export function isFinalStatus(status: RegistrationStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export function registrationKey(workshopId: string, seq: number): string {
  return `${workshopId}#${seq}`;
}

/** Same persisted state; `queuePosition` is derived from the other registrations and ignored. */
export function sameRegistrationState(a: RegistrationSummary, b: RegistrationSummary): boolean {
  return (
    a.status === b.status &&
    a.seq === b.seq &&
    a.acceptable.length === b.acceptable.length &&
    a.acceptable.every((id, index) => b.acceptable[index] === id) &&
    a.currentOffer?.id === b.currentOffer?.id &&
    a.currentOffer?.expiresAt === b.currentOffer?.expiresAt &&
    a.confirmedSessionId === b.confirmedSessionId &&
    a.endReason === b.endReason
  );
}

/** The fetched entry already reflects the settled command, or a change made after it. */
export function caughtUp(fetched: ListedRegistration, settled: SettledRegistration): boolean {
  return (
    sameRegistrationState(fetched, settled.registration) ||
    Date.parse(fetched.updatedAt) > Date.parse(settled.settledAt)
  );
}

/** The API's order: most recently updated first, then highest seq. */
export function compareListed(a: MyRegistrationView, b: MyRegistrationView): number {
  const byUpdated = Date.parse(b.registration.updatedAt) - Date.parse(a.registration.updatedAt);
  return byUpdated !== 0 ? byUpdated : b.registration.seq - a.registration.seq;
}

function keyOf(entry: MyRegistrationView): string {
  return registrationKey(entry.workshop.id, entry.registration.seq);
}

function withSettled(
  settled: SettledRegistration,
  createdAt: string,
): MyRegistrationView['registration'] {
  return { ...settled.registration, createdAt, updatedAt: settled.settledAt };
}

export interface MergeResult {
  list: MyRegistrationListView;
  /** Overlays the server has not caught up with yet (keep them for the next response). */
  pending: SettledRegistration[];
}

/**
 * Merges a `/me/registrations` response with poll results. While an index propagates, the live
 * and the archived copy of one registration can both be listed; the most recently updated copy
 * is kept.
 */
export function mergeSettledRegistrations(
  list: MyRegistrationListView,
  settled: readonly SettledRegistration[],
): MergeResult {
  const byKey = new Map<string, MyRegistrationView>();
  for (const entry of list.registrations) {
    const key = keyOf(entry);
    const existing = byKey.get(key);
    if (existing === undefined || compareListed(entry, existing) < 0) {
      byKey.set(key, entry);
    }
  }
  const pending: SettledRegistration[] = [];
  for (const overlay of settled) {
    const key = registrationKey(overlay.workshopId, overlay.registration.seq);
    const fetched = byKey.get(key);
    if (fetched !== undefined) {
      if (caughtUp(fetched.registration, overlay)) {
        continue;
      }
      byKey.set(key, {
        ...fetched,
        registration: withSettled(overlay, fetched.registration.createdAt),
      });
      pending.push(overlay);
      continue;
    }
    if (overlay.workshop !== undefined && overlay.sessions !== undefined) {
      byKey.set(key, {
        workshop: overlay.workshop,
        sessions: overlay.sessions,
        registration: withSettled(overlay, overlay.settledAt),
      });
    }
    pending.push(overlay);
  }
  return { list: { registrations: [...byKey.values()].sort(compareListed) }, pending };
}

/**
 * `me` in the workshop view is the caller's live registration with the lowest seq. A
 * CANCELLED/ENDED result removes it (the refetch that follows brings back the next live one in
 * PER_SESSION mode).
 */
export function patchWorkshopView(
  view: WorkshopPublicView,
  registration: RegistrationSummary,
): WorkshopPublicView {
  const me = view.me;
  const final = isFinalStatus(registration.status);
  if (me !== undefined && me.seq === registration.seq) {
    if (final) {
      const next = { ...view };
      delete next.me;
      return next;
    }
    return { ...view, me: registration };
  }
  if (!final && (me === undefined || registration.seq < me.seq)) {
    return { ...view, me: registration };
  }
  return view;
}

/** Overlays recorded from poll results, consumed by every `/me/registrations` response. */
export class SettledRegistrations {
  #entries = new Map<string, SettledRegistration>();
  readonly #maxAgeMs: number;
  readonly #localNow: () => number;

  constructor(maxAgeMs: number = SETTLED_OVERLAY_MAX_MS, localNow: () => number = Date.now) {
    this.#maxAgeMs = maxAgeMs;
    this.#localNow = localNow;
  }

  get size(): number {
    this.#expire();
    return this.#entries.size;
  }

  /** Keeps the most recent poll result per registration; `receivedAt` is this store's clock. */
  record(entry: Omit<SettledRegistration, 'receivedAt'>): void {
    const key = registrationKey(entry.workshopId, entry.registration.seq);
    const existing = this.#entries.get(key);
    if (existing !== undefined && Date.parse(existing.settledAt) > Date.parse(entry.settledAt)) {
      return;
    }
    this.#entries.set(key, { ...entry, receivedAt: this.#localNow() });
  }

  /** Merges a server response (or the cached list) and forgets the overlays it already reflects. */
  apply(list: MyRegistrationListView): MyRegistrationListView {
    this.#expire();
    if (this.#entries.size === 0) {
      return list;
    }
    const merged = mergeSettledRegistrations(list, [...this.#entries.values()]);
    this.#entries = new Map(
      merged.pending.map((entry) => [
        registrationKey(entry.workshopId, entry.registration.seq),
        entry,
      ]),
    );
    return merged.list;
  }

  #expire(): void {
    const now = this.#localNow();
    for (const [key, entry] of this.#entries) {
      if (now - entry.receivedAt > this.#maxAgeMs) {
        this.#entries.delete(key);
      }
    }
  }
}

const stores = new WeakMap<QueryClient, SettledRegistrations>();

/** One overlay store per QueryClient (the app has one). */
export function settledRegistrationsFor(queryClient: QueryClient): SettledRegistrations {
  let store = stores.get(queryClient);
  if (store === undefined) {
    store = new SettledRegistrations();
    stores.set(queryClient, store);
  }
  return store;
}

/**
 * Writes the registration carried by an APPLIED poll response into every cached view, before
 * anything is refetched. Commands without a registration (organiser commands) change nothing here.
 */
export function applyCommandResult(queryClient: QueryClient, view: CommandResultView): void {
  const registration = view.result?.registration;
  if (view.status !== 'APPLIED' || registration === undefined) {
    return;
  }
  const wsId = view.workshopId;
  queryClient.setQueryData<WorkshopPublicView>(queryKeys.workshop(wsId, true), (current) =>
    current === undefined ? current : patchWorkshopView(current, registration),
  );

  const workshopView = queryClient.getQueryData<WorkshopPublicView>(queryKeys.workshop(wsId, true));
  const listed = queryClient
    .getQueryData<MyRegistrationListView>(queryKeys.myRegistrations)
    ?.registrations.find((entry) => entry.workshop.id === wsId);
  const workshop = listed?.workshop ?? workshopView?.workshop;
  const sessions = listed?.sessions ?? workshopView?.sessions;
  const store = settledRegistrationsFor(queryClient);
  store.record({
    workshopId: wsId,
    registration,
    settledAt: view.settledAt ?? view.acceptedAt,
    ...(workshop !== undefined && sessions !== undefined ? { workshop, sessions } : {}),
  });
  queryClient.setQueryData<MyRegistrationListView>(queryKeys.myRegistrations, (current) =>
    current === undefined ? current : store.apply(current),
  );
}
