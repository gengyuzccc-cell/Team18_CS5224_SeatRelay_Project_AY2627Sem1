// @vitest-environment jsdom
import type {
  MyRegistrationListView,
  RegistrationSummary,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Queries from '../src/api/queries';
import { useMyRegistrations, useWorkshop } from '../src/api/queries';
import {
  LIST_CATCH_UP_ATTEMPTS,
  LIST_CATCH_UP_DELAY_MS,
  WorkshopPage,
} from '../src/pages/WorkshopPage';
import { cancelled, FIXTURE_NOW, list, listed, S2, summary, workshopView, WS } from './fixtures';

/**
 * The workshop page's effects in a DOM (the SSR tests in workshopPage.test.tsx cannot run them):
 * the list refetch when my live registration changes, the bounded catch-up loop while
 * `GET /me/registrations` is behind (also when a refetch fails, or the list has dropped the
 * registration), and "Register again". The clock is pinned to FIXTURE_NOW.
 */
vi.mock('../src/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof Queries>()),
  useWorkshop: vi.fn(),
  useMyRegistrations: vi.fn(),
}));
vi.mock('../src/auth/useSession', () => ({
  useSession: () => ({
    isLoading: false,
    isAuthenticated: true,
    profile: undefined,
    error: undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
  }),
}));
vi.mock('../src/commands/useCommand', () => ({
  useCommand: () => ({
    state: { phase: 'idle' },
    busy: false,
    canRetry: false,
    run: async () => undefined,
    retry: async () => undefined,
    reset: () => undefined,
  }),
}));

/** What the mocked hooks return; `respond*` change it and re-render, as a fetch result would. */
interface Server {
  view: WorkshopPublicView;
  list: MyRegistrationListView;
  listUpdatedAt: number;
  listErrorUpdatedAt: number;
}

let server: Server;
let root: Root;
let container: HTMLDivElement;
const refetchList = vi.fn(async () => undefined);
const refetchWorkshop = vi.fn(async () => undefined);

function queryResult<T>(
  data: T,
  dataUpdatedAt: number,
  refetch: () => Promise<undefined>,
  errorUpdatedAt = 0,
) {
  return {
    data,
    isPending: false,
    isError: errorUpdatedAt > dataUpdatedAt,
    isFetching: false,
    error: null,
    dataUpdatedAt,
    errorUpdatedAt,
    refetch,
  };
}

function rerender(): void {
  act(() => {
    root.render(
      <MemoryRouter
        initialEntries={[`/workshops/${WS}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/workshops/:wsId" element={<WorkshopPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function mount(view: WorkshopPublicView, registrations: MyRegistrationListView): void {
  server = { view, list: registrations, listUpdatedAt: 1, listErrorUpdatedAt: 0 };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  rerender();
}

/** The workshop view changed (a poll or a refetch came back). */
function respondWorkshop(view: WorkshopPublicView): void {
  server.view = view;
  rerender();
}

/** A `/me/registrations` response arrived (possibly unchanged: still behind). */
function respondList(registrations: MyRegistrationListView = server.list): void {
  server.list = registrations;
  server.listUpdatedAt += 1;
  rerender();
}

/** A `/me/registrations` refetch failed (after its retry): the data stays, the error is new. */
function failList(): void {
  server.listErrorUpdatedAt = server.listUpdatedAt + server.listErrorUpdatedAt + 1;
  rerender();
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const text = () => container.textContent ?? '';
const hasForm = () => container.querySelector('#register-heading') !== null;

const queued = summary({ seq: 3 });
const offered: RegistrationSummary = summary({
  status: 'OFFERED',
  seq: 3,
  queuePosition: undefined,
  currentOffer: { id: 'o3', sessionId: S2, expiresAt: '2026-11-03T06:20:00.000Z' },
});
const liveEntry = (registration: RegistrationSummary) =>
  listed(registration, '2026-11-03T06:05:00.000Z', '2026-11-03T06:05:00.000Z');
const expiredEntry = () => {
  const entry = listed(
    summary({
      status: 'ENDED',
      seq: 3,
      queuePosition: undefined,
      acceptable: [],
      endReason: 'NO_ACCEPTABLE_SESSION',
    }),
    '2026-11-03T06:20:00.000Z',
    '2026-11-03T06:05:00.000Z',
  );
  entry.registration.ending = {
    offer: {
      id: 'o3',
      sessionId: S2,
      status: 'EXPIRED',
      expiresAt: '2026-11-03T06:20:00.000Z',
      settledAt: '2026-11-03T06:20:00.000Z',
    },
  };
  return entry;
};

describe('WorkshopPage effects (DOM)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXTURE_NOW);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no layout: "Register again" scrolls the form into view.
    Element.prototype.scrollIntoView = vi.fn();
    refetchList.mockClear();
    refetchWorkshop.mockClear();
    vi.mocked(useWorkshop).mockImplementation(
      () =>
        queryResult(server.view, 1, refetchWorkshop) as unknown as ReturnType<typeof useWorkshop>,
    );
    vi.mocked(useMyRegistrations).mockImplementation(
      () =>
        queryResult(
          server.list,
          server.listUpdatedAt,
          refetchList,
          server.listErrorUpdatedAt,
        ) as unknown as ReturnType<typeof useMyRegistrations>,
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('a change of my live registration refetches the list once, straight away', () => {
    mount(workshopView(queued), list(liveEntry(queued)));
    expect(refetchList).not.toHaveBeenCalled();

    respondWorkshop(workshopView(offered)); // QUEUED → OFFERED
    expect(refetchList).toHaveBeenCalledTimes(1);
    // The same state again (another poll) does not refetch.
    respondWorkshop(workshopView(offered));
    expect(refetchList).toHaveBeenCalledTimes(1);
  });

  it('list behind after the hold expired: placeholder, at most 4 refetches 1.5 s apart, then the card', () => {
    mount(workshopView(offered), list(liveEntry(offered)));
    respondWorkshop(workshopView()); // the tick expired the hold: `me` is gone
    expect(refetchList).toHaveBeenCalledTimes(1); // the change of `me`
    expect(hasForm()).toBe(false);
    expect(text()).toContain('Checking your registrations…');

    // The list comes back still listing the registration as OFFERED (index lag).
    respondList();
    advance(LIST_CATCH_UP_DELAY_MS - 1);
    expect(refetchList).toHaveBeenCalledTimes(1);
    advance(1);
    expect(refetchList).toHaveBeenCalledTimes(2);
    expect(refetchWorkshop).toHaveBeenCalledTimes(1);
    expect(hasForm()).toBe(false);

    // Caught up on the next answer: the ended card, no form, no more refetches.
    respondList(list(expiredEntry()));
    expect(text()).toContain('Your hold for Session 2 expired');
    expect(text()).not.toContain('Checking your registrations…');
    expect(hasForm()).toBe(false);
    advance(10 * LIST_CATCH_UP_DELAY_MS);
    expect(refetchList).toHaveBeenCalledTimes(2);
  });

  it('a list that never catches up: exactly 4 catch-up refetches, then the page stops waiting', () => {
    mount(workshopView(offered), list(liveEntry(offered)));
    respondWorkshop(workshopView());
    const afterMeChange = refetchList.mock.calls.length;
    for (let attempt = 1; attempt <= LIST_CATCH_UP_ATTEMPTS; attempt += 1) {
      respondList(); // still behind
      expect(text()).toContain('Checking your registrations…');
      advance(LIST_CATCH_UP_DELAY_MS);
      expect(refetchList).toHaveBeenCalledTimes(afterMeChange + attempt);
    }
    respondList(); // the 4th catch-up answer: still behind
    advance(10 * LIST_CATCH_UP_DELAY_MS);
    expect(refetchList).toHaveBeenCalledTimes(afterMeChange + LIST_CATCH_UP_ATTEMPTS);
    expect(refetchWorkshop).toHaveBeenCalledTimes(LIST_CATCH_UP_ATTEMPTS);
    // No placeholder forever: the page shows what it can (here the form).
    expect(text()).not.toContain('Checking your registrations…');
    expect(hasForm()).toBe(true);

    // The counter resets once the list agrees again (registered again, then ended again).
    respondWorkshop(workshopView(summary({ seq: 4 })));
    respondList(list(liveEntry(summary({ seq: 4 }))));
    const beforeSecondEnding = refetchList.mock.calls.length;
    respondWorkshop(workshopView());
    respondList();
    expect(text()).toContain('Checking your registrations…');
    advance(LIST_CATCH_UP_DELAY_MS);
    expect(refetchList.mock.calls.length).toBeGreaterThan(beforeSecondEnding + 1);
  });

  it('failed catch-up refetches still count: 4 attempts, then the page stops waiting', () => {
    mount(workshopView(offered), list(liveEntry(offered)));
    respondWorkshop(workshopView()); // `me` is gone; the immediate refetch of the list fails
    expect(refetchList).toHaveBeenCalledTimes(1);
    failList();
    for (let attempt = 1; attempt <= LIST_CATCH_UP_ATTEMPTS; attempt += 1) {
      expect(text()).toContain('Checking your registrations…');
      advance(LIST_CATCH_UP_DELAY_MS);
      expect(refetchList).toHaveBeenCalledTimes(1 + attempt);
      failList(); // 5xx, network drop: `data` and `dataUpdatedAt` stay as they were
    }
    advance(10 * LIST_CATCH_UP_DELAY_MS);
    expect(refetchList).toHaveBeenCalledTimes(1 + LIST_CATCH_UP_ATTEMPTS);
    // No placeholder forever: the page shows what it can (here the form).
    expect(text()).not.toContain('Checking your registrations…');
    expect(hasForm()).toBe(true);
  });

  it('a list that has dropped the registration (index between delete and put): no older ending, no form, until it is listed as ended', () => {
    const olderEnding = listed(
      { ...cancelled, seq: 1 },
      '2026-11-03T05:00:00.000Z',
      '2026-11-03T04:00:00.000Z',
    );
    olderEnding.registration.ending = {};
    mount(workshopView(offered), list(liveEntry(offered), olderEnding));
    respondWorkshop(workshopView()); // the hold expired: `me` (seq 3) is gone
    expect(refetchList).toHaveBeenCalledTimes(1);

    // The answer lists neither copy of seq 3, only last week's cancellation.
    respondList(list(olderEnding));
    expect(text()).toContain('Checking your registrations…');
    expect(text()).not.toContain('You cancelled your registration');
    expect(hasForm()).toBe(false);
    advance(LIST_CATCH_UP_DELAY_MS);
    expect(refetchList).toHaveBeenCalledTimes(2);

    // Listed as ended: its own ending is explained, not the older one.
    respondList(list(expiredEntry(), olderEnding));
    expect(text()).toContain('Your hold for Session 2 expired');
    expect(text()).not.toContain('You cancelled your registration');
    expect(text()).not.toContain('Checking your registrations…');
    advance(10 * LIST_CATCH_UP_DELAY_MS);
    expect(refetchList).toHaveBeenCalledTimes(2);
  });

  it('"Register again" shows the form with the first choice focused and hides the button', () => {
    mount(workshopView(), list(expiredEntry()));
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Register again',
    );
    expect(button).toBeDefined();
    expect(hasForm()).toBe(false);

    act(() => {
      button?.click();
    });
    expect(hasForm()).toBe(true);
    expect(text()).not.toContain('Register again');
    // The ended card stays above the form as the explanation.
    expect(text()).toContain('Your hold for Session 2 expired');
    expect(document.activeElement).toBe(container.querySelector('form input'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
