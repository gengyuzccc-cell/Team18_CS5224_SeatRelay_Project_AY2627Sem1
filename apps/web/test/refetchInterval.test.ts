import type { WorkshopPublicView } from '@seatrelay/contracts';
import {
  environmentManager,
  focusManager,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMED_REFRESH_MS,
  LIVE_REFRESH_MS,
  myRegistrationsRefetchInterval,
  workshopRefetchInterval,
} from '../src/api/queries';
import { queryKeys } from '../src/api/queryKeys';
import { at, cancelled, confirmed, list, listed, summary, workshopView, WS } from './fixtures';

describe('refetch interval functions', () => {
  it('refresh while QUEUED/OFFERED, never decided by tab visibility', () => {
    expect(workshopRefetchInterval(workshopView(summary()))).toBe(LIVE_REFRESH_MS);
    expect(workshopRefetchInterval(workshopView(summary({ status: 'OFFERED' })))).toBe(
      LIVE_REFRESH_MS,
    );
    expect(workshopRefetchInterval(undefined)).toBe(false);
    expect(workshopRefetchInterval(workshopView())).toBe(false);
    expect(myRegistrationsRefetchInterval(list(listed(summary(), at(5))))).toBe(LIVE_REFRESH_MS);
    expect(myRegistrationsRefetchInterval(list(listed(cancelled, at(5))))).toBe(false);
  });

  it('a CONFIRMED participant’s page refreshes every 30 s (free seats / waiting stay current)', () => {
    expect(CONFIRMED_REFRESH_MS).toBe(30_000);
    expect(workshopRefetchInterval(workshopView(confirmed))).toBe(CONFIRMED_REFRESH_MS);
    expect(myRegistrationsRefetchInterval(list(listed(confirmed, at(5))))).toBe(
      CONFIRMED_REFRESH_MS,
    );
    // a queued or offered registration elsewhere keeps the faster refresh
    expect(
      myRegistrationsRefetchInterval(list(listed(confirmed, at(5)), listed(summary(), at(6)))),
    ).toBe(LIVE_REFRESH_MS);
  });
});

/**
 * Review finding: an interval function answering `false` while `document.hidden` is only
 * re-evaluated when the query updates, so a fetch that completed in a hidden tab (e.g. the
 * invalidation after a command settled) switched the 10 s refresh off for good when the user came
 * back within `staleTime`. With a plain interval and `refetchIntervalInBackground: false`,
 * query-core pauses while hidden and resumes on return.
 */
describe('status page refresh across a hidden tab (useWorkshop options)', () => {
  const page = { visibilityState: 'visible' as DocumentVisibilityState, hidden: false };

  beforeEach(() => {
    vi.useFakeTimers();
    page.visibilityState = 'visible';
    page.hidden = false;
    vi.stubGlobal('document', page);
    environmentManager.setIsServer(() => false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    environmentManager.setIsServer(() => typeof window === 'undefined');
  });

  function setVisible(visible: boolean) {
    page.visibilityState = visible ? 'visible' : 'hidden';
    page.hidden = !visible;
    focusManager.onFocus(); // what the visibilitychange listener does in the browser
  }

  it('pauses while hidden and resumes after a fetch that completed in the hidden tab', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: false } },
    });
    let fetches = 0;
    const observer = new QueryObserver<WorkshopPublicView>(queryClient, {
      queryKey: queryKeys.workshop(WS, true),
      queryFn: async () => {
        fetches += 1;
        return workshopView(summary());
      },
      refetchInterval: (query) => workshopRefetchInterval(query.state.data),
      refetchIntervalInBackground: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);

    setVisible(false);
    await queryClient.invalidateQueries({ queryKey: ['workshop', WS] }); // settled in background
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetches).toBe(2);

    setVisible(true); // back within staleTime: no focus refetch
    await vi.advanceTimersByTimeAsync(0);
    const afterReturn = fetches;
    await vi.advanceTimersByTimeAsync(3 * LIVE_REFRESH_MS);
    expect(fetches - afterReturn).toBeGreaterThanOrEqual(2);

    setVisible(false);
    const hiddenFrom = fetches;
    await vi.advanceTimersByTimeAsync(3 * LIVE_REFRESH_MS);
    expect(fetches).toBe(hiddenFrom);

    unsubscribe();
    queryClient.clear();
  });

  it('CONFIRMED: refreshes every 30 s while visible, not at all while hidden', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: false } },
    });
    let fetches = 0;
    const observer = new QueryObserver<WorkshopPublicView>(queryClient, {
      queryKey: queryKeys.workshop(WS, true),
      queryFn: async () => {
        fetches += 1;
        return workshopView(confirmed);
      },
      refetchInterval: (query) => workshopRefetchInterval(query.state.data),
      refetchIntervalInBackground: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS * 2); // 20 s: no 10 s refresh any more
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(CONFIRMED_REFRESH_MS * 3 - LIVE_REFRESH_MS * 2);
    expect(fetches).toBe(4);

    setVisible(false);
    await vi.advanceTimersByTimeAsync(CONFIRMED_REFRESH_MS * 3);
    expect(fetches).toBe(4);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(CONFIRMED_REFRESH_MS * 2);
    expect(fetches).toBeGreaterThanOrEqual(6);

    unsubscribe();
    queryClient.clear();
  });
});
