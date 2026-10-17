import type { MyRegistrationListView, WorkshopPublicView } from '@seatrelay/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { Route, Routes } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Queries from '../src/api/queries';
import { useMyRegistrations, useWorkshop } from '../src/api/queries';
import { WorkshopPage } from '../src/pages/WorkshopPage';
import {
  cancelled,
  confirmed,
  FIXTURE_NOW,
  list,
  listed,
  S2,
  summary,
  workshop,
  workshopView,
  WS,
} from './fixtures';

/**
 * The workshop page as a signed-in participant sees it, rendered from given query results (no
 * network, no auth provider): which of status card / ended card / registration form appear.
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

function query<T>(data: T | undefined, pending = false) {
  return {
    data,
    isPending: pending,
    isError: false,
    isFetching: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: vi.fn(async () => undefined),
  };
}

function render(view: WorkshopPublicView, registrations: MyRegistrationListView | undefined) {
  vi.mocked(useWorkshop).mockReturnValue(query(view) as unknown as ReturnType<typeof useWorkshop>);
  vi.mocked(useMyRegistrations).mockReturnValue(
    query(registrations, registrations === undefined) as unknown as ReturnType<
      typeof useMyRegistrations
    >,
  );
  return renderToStaticMarkup(
    <StaticRouter location={`/workshops/${WS}`}>
      <Routes>
        <Route path="/workshops/:wsId" element={<WorkshopPage />} />
      </Routes>
    </StaticRouter>,
  );
}

/** "Now" is pinned to FIXTURE_NOW (the fixtures' day), a week before the sessions' cut-off. */
const expiredEntry = listed(
  summary({
    status: 'ENDED',
    seq: 2,
    queuePosition: undefined,
    acceptable: [],
    endReason: 'NO_ACCEPTABLE_SESSION',
  }),
  '2026-11-03T06:05:00.000Z',
  '2026-11-03T06:00:00.000Z',
);
expiredEntry.registration.ending = {
  offer: {
    id: 'o1',
    sessionId: S2,
    status: 'EXPIRED',
    expiresAt: '2026-11-03T06:04:30.000Z',
    settledAt: '2026-11-03T06:05:00.000Z',
  },
};

describe('WorkshopPage for a signed-in participant', () => {
  beforeEach(() => {
    // Only the clock is faked: whether "Register again" is offered depends on the cut-offs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    vi.stubGlobal('window', { location: { origin: 'https://seatrelay.test' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('after the hold expired: a persistent ended card with "Register again", not a silent empty form', () => {
    const html = render(workshopView(), list(expiredEntry));
    expect(html).toContain('status-card status-ended');
    expect(html).toContain('Your hold for Session 2 expired');
    expect(html).toContain('You can register again; you will join the end of the queue.');
    expect(html).toMatch(/<button[^>]*>Register again<\/button>/);
    expect(html).not.toContain('id="register-heading"');
  });

  it('after a cancellation by the participant: the cancelled card', () => {
    const html = render(workshopView(), list(listed(cancelled, '2026-11-03T06:05:00.000Z')));
    expect(html).toContain('status-card status-cancelled');
    expect(html).toContain('You cancelled your registration');
    expect(html).not.toContain('id="register-heading"');
  });

  it('never registered here: the registration form, no status card', () => {
    const html = render(workshopView(), list());
    expect(html).toContain('id="register-heading"');
    expect(html).not.toContain('status-card');
  });

  it('while the history loads, neither the form nor a card flashes up', () => {
    const html = render(workshopView(), undefined);
    expect(html).toContain('Checking your registrations…');
    expect(html).not.toContain('id="register-heading"');
  });

  it('my registration ended elsewhere (tick, expiry, organiser) and the list still has it live: no empty form', () => {
    // `me` is gone from the (consistent) workshop view, but the list fetched before still shows
    // the registration as OFFERED: nothing explains the ending yet, so the page waits for the
    // list instead of showing the empty form.
    const stillOffered = listed(
      summary({
        status: 'OFFERED',
        seq: 3,
        queuePosition: undefined,
        currentOffer: { id: 'o3', sessionId: S2, expiresAt: '2026-11-03T06:20:00.000Z' },
      }),
      '2026-11-03T06:05:00.000Z',
      '2026-11-03T06:05:00.000Z',
    );
    const html = render(workshopView(), list(stillOffered));
    expect(html).toContain('Checking your registrations…');
    expect(html).not.toContain('id="register-heading"');
    expect(html).not.toContain('status-card');

    // An older ending of this workshop is not shown in its place either (the live entry is newer).
    const withOlder = render(workshopView(), list(stillOffered, expiredEntry));
    expect(withOlder).toContain('Checking your registrations…');
    expect(withOlder).not.toContain('id="register-heading"');
    expect(withOlder).not.toContain('status-ended');
  });

  it('registration closed: the ended card stays, without "Register again"', () => {
    const view = { ...workshopView(), workshop: { ...workshop, status: 'CLOSED' as const } };
    const html = render(view, list(expiredEntry));
    expect(html).toContain('Your hold for Session 2 expired');
    expect(html).not.toContain('Register again');
    expect(html).toContain('Registration is closed by the organiser.');
  });

  it('a live registration hides the old ending; the refresh note follows the status', () => {
    const queued = render(workshopView(summary({ seq: 3 })), list(expiredEntry));
    expect(queued).not.toContain('status-ended');
    expect(queued).toContain('status-card status-queued');
    expect(queued).toContain('This page refreshes every 10 s while you are queued or offered');

    const seated = render(workshopView({ ...confirmed, seq: 3 }), list(expiredEntry));
    expect(seated).toContain('status-card status-confirmed');
    expect(seated).toContain(
      'This page refreshes every 30 s while your seat is confirmed (paused when the tab is hidden).',
    );
  });
});
