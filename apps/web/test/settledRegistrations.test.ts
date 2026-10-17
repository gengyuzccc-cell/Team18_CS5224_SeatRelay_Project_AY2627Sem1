import type { MyRegistrationListView } from '@seatrelay/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { myRegistrationsRefetchInterval } from '../src/api/queries';
import { queryKeys } from '../src/api/queryKeys';
import {
  applyCommandResult,
  caughtUp,
  mergeSettledRegistrations,
  patchWorkshopView,
  SettledRegistrations,
  settledRegistrationsFor,
  type SettledRegistration,
} from '../src/api/settledRegistrations';
import {
  at,
  cancelled,
  confirmed,
  list,
  listed,
  S1,
  S2,
  sessions,
  settledView,
  summary,
  workshop,
  workshopView,
  WS,
} from './fixtures';

function overlay(
  registration = cancelled,
  settledAt = at(101),
  extra: Partial<SettledRegistration> = {},
): SettledRegistration {
  return { workshopId: WS, registration, settledAt, receivedAt: 0, ...extra };
}

function statuses(view: MyRegistrationListView | undefined): string[] {
  return (view?.registrations ?? []).map((entry) => entry.registration.status);
}

describe('mergeSettledRegistrations', () => {
  it('replaces a stale (pre-command) entry with the poll result and keeps the overlay', () => {
    const stale = list(listed(confirmed, at(50)));
    const { list: merged, pending } = mergeSettledRegistrations(stale, [overlay()]);
    expect(statuses(merged)).toEqual(['CANCELLED']);
    expect(merged.registrations[0]?.registration.updatedAt).toBe(at(101));
    expect(merged.registrations[0]?.registration.createdAt).toBe(at(1));
    expect(pending).toHaveLength(1);
  });

  it('drops the overlay once the server reflects the command (decision time ≤ settledAt)', () => {
    const fresh = list(listed(cancelled, at(100)));
    const { list: merged, pending } = mergeSettledRegistrations(fresh, [overlay()]);
    expect(merged).toEqual(fresh);
    expect(pending).toEqual([]);
  });

  it('lets a later change win over the poll result (updatedAt after settledAt)', () => {
    const offered = summary({
      status: 'OFFERED',
      queuePosition: undefined,
      currentOffer: { id: 'offer-2', sessionId: S2, expiresAt: at(1000) },
    });
    const queued = summary({ status: 'QUEUED', queuePosition: 3 });
    const later = list(listed(offered, at(140)));
    const { list: merged, pending } = mergeSettledRegistrations(later, [overlay(queued)]);
    expect(statuses(merged)).toEqual(['OFFERED']);
    expect(pending).toEqual([]);
  });

  it('ignores the derived queue position when deciding whether the server caught up', () => {
    const queuedNow = { ...listed(summary({ queuePosition: 2 }), at(100)).registration };
    expect(caughtUp(queuedNow, overlay(summary({ queuePosition: 5 })))).toBe(true);
  });

  it('inserts a registration the index does not list yet (REGISTER) when the workshop is known', () => {
    const queued = summary({ seq: 4, queuePosition: 2 });
    const { list: merged, pending } = mergeSettledRegistrations(list(), [
      overlay(queued, at(101), { workshop, sessions }),
    ]);
    expect(merged.registrations).toHaveLength(1);
    expect(merged.registrations[0]?.registration).toMatchObject({ status: 'QUEUED', seq: 4 });
    expect(pending).toHaveLength(1);
  });

  it('keeps only the newest copy when the live and the archived item are both listed', () => {
    const both = list(listed(confirmed, at(50)), listed(cancelled, at(100)));
    const { list: merged } = mergeSettledRegistrations(both, []);
    expect(statuses(merged)).toEqual(['CANCELLED']);
  });
});

describe('SettledRegistrations', () => {
  it('forgets an overlay after the maximum age', () => {
    let now = 0;
    const store = new SettledRegistrations(1_000, () => now);
    store.record(overlay());
    expect(statuses(store.apply(list(listed(confirmed, at(50)))))).toEqual(['CANCELLED']);
    now = 1_001;
    expect(statuses(store.apply(list(listed(confirmed, at(50)))))).toEqual(['CONFIRMED']);
    expect(store.size).toBe(0);
  });

  it('keeps the most recent poll result per registration', () => {
    const store = new SettledRegistrations(60_000, () => 0);
    store.record(overlay(cancelled, at(200)));
    store.record(overlay(confirmed, at(150)));
    expect(statuses(store.apply(list(listed(confirmed, at(50)))))).toEqual(['CANCELLED']);
  });
});

describe('patchWorkshopView', () => {
  it('replaces my live registration and removes it once CANCELLED/ENDED', () => {
    expect(patchWorkshopView(workshopView(summary()), confirmed).me).toEqual(confirmed);
    expect(patchWorkshopView(workshopView(confirmed), cancelled)).not.toHaveProperty('me');
  });

  it('adds a new registration and leaves another seq alone', () => {
    expect(patchWorkshopView(workshopView(), summary()).me).toEqual(summary());
    const other = summary({ seq: 2, acceptable: [S2] });
    expect(patchWorkshopView(workshopView(summary({ acceptable: [S1] })), other).me?.seq).toBe(1);
  });
});

/**
 * The reviewer's scenario (AWS: `GET /me/registrations` reads GSI1): CONFIRMED card → "Cancel my
 * seat" → poll APPLIED → the refetch issued right after returns the pre-command item.
 */
describe('a settled CANCEL against a lagging /me/registrations index', () => {
  it('shows the poll result, not the stale read, and keeps it until the index catches up', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let indexed: MyRegistrationListView = list(listed(confirmed, at(50)));
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.myRegistrations,
      // Same queryFn shape as useMyRegistrations.
      queryFn: async () => settledRegistrationsFor(queryClient).apply(structuredClone(indexed)),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    expect(statuses(observer.getCurrentResult().data)).toEqual(['CONFIRMED']);
    expect(queryClient.getQueryData(queryKeys.workshop(WS, true))).toBeUndefined();

    // The poll answers APPLIED with the registration; the cache is patched before any refetch.
    queryClient.setQueryData(queryKeys.workshop(WS, true), workshopView(confirmed));
    applyCommandResult(queryClient, settledView('APPLIED', cancelled));
    expect(
      statuses(queryClient.getQueryData<MyRegistrationListView>(queryKeys.myRegistrations)),
    ).toEqual(['CANCELLED']);
    expect(queryClient.getQueryData(queryKeys.workshop(WS, true))).not.toHaveProperty('me');

    // onSettled → refetch + invalidation while the index still has the old item.
    await observer.refetch();
    await queryClient.invalidateQueries({ queryKey: queryKeys.myRegistrations });
    const data = observer.getCurrentResult().data;
    expect(statuses(data)).toEqual(['CANCELLED']);
    expect(myRegistrationsRefetchInterval(data)).toBe(false);

    // The index catches up (archived item, decision time ≤ settledAt): the overlay is retired.
    indexed = list(listed(cancelled, at(100)));
    await observer.refetch();
    expect(statuses(observer.getCurrentResult().data)).toEqual(['CANCELLED']);
    expect(settledRegistrationsFor(queryClient).size).toBe(0);
    unsubscribe();
    queryClient.clear();
  });

  it('changes nothing for a REJECTED command or an organiser command', () => {
    const queryClient = new QueryClient();
    const before = list(listed(confirmed, at(50)));
    queryClient.setQueryData(queryKeys.myRegistrations, before);
    applyCommandResult(queryClient, settledView('REJECTED'));
    applyCommandResult(queryClient, settledView('APPLIED', undefined, { type: 'SET_CAPACITY' }));
    expect(queryClient.getQueryData(queryKeys.myRegistrations)).toBe(before);
    expect(settledRegistrationsFor(queryClient).size).toBe(0);
  });
});
