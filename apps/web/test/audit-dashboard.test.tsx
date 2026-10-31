// @vitest-environment jsdom
import { MAX_CAPACITY, type CommandResultView, type DashboardView } from '@seatrelay/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type * as Queries from '../src/api/queries';
import { useDashboard } from '../src/api/queries';
import type { CommandBodyInput, CommandPhase } from '../src/commands/commandRunner';
import { CopyLink } from '../src/components/CopyLink';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { DashboardPage } from '../src/pages/DashboardPage';
import { at, S1, S2, sessions, workshop, WS } from './fixtures';

/**
 * Web audit (30 Oct), organiser dashboard: the action copy and the capacity field after a
 * command settled or the view was refetched. Rendered in jsdom from a given dashboard view; the
 * command hook is replaced by one that settles each `run()` with a test-chosen outcome.
 */

let settle: (body: CommandBodyInput) => CommandPhase = () => ({ phase: 'idle' });
vi.mock('../src/commands/useCommand', async () => {
  const { useState } = await import('react');
  return {
    useCommand: () => {
      const [state, setState] = useState<CommandPhase>({ phase: 'idle' });
      return {
        state,
        busy: state.phase === 'submitting' || state.phase === 'processing',
        canRetry: false,
        run: async (body: CommandBodyInput) => setState(settle(body)),
        retry: async () => undefined,
        reset: () => setState({ phase: 'idle' }),
      };
    },
  };
});
vi.mock('../src/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof Queries>()),
  useDashboard: vi.fn(),
  useInvalidateWorkshopInfo: () => async () => undefined,
}));
vi.mock('../src/api/ApiProvider', () => ({ useApi: () => ({}) }));
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

function dashboard(overrides: Partial<DashboardView> = {}): DashboardView {
  const full = { ...sessions[0]!, capacity: 2, confirmed: 2, free: 0 };
  return {
    workshop: { ...workshop, seq: 3, version: 7 },
    sessions: [full, sessions[1]!],
    queue: [],
    offered: [],
    confirmed: [
      {
        seq: 1,
        userId: 'u1',
        email: 'a@example.com',
        status: 'CONFIRMED',
        sessionId: S1,
        confirmedAt: at(10),
      },
      {
        seq: 2,
        userId: 'u1',
        email: 'a@example.com',
        status: 'CONFIRMED',
        sessionId: S2,
        confirmedAt: at(11),
      },
    ],
    backfills: [],
    distinctParticipantsServed: 1,
    attendance: [],
    counts: {
      queued: 0,
      offered: 0,
      confirmed: 2,
      backfills: 0,
      backfillsReallocated: 0,
      attended: 0,
    },
    ...overrides,
  };
}

function applied(type: CommandResultView['type']): CommandPhase {
  return {
    phase: 'applied',
    commandId: 'c1',
    view: {
      commandId: 'c1',
      workshopId: WS,
      type,
      status: 'APPLIED',
      acceptedAt: at(100),
      settledAt: at(101),
      result: { offersCreated: 0 },
    },
  };
}

let root: Root;
let container: HTMLDivElement;
const queryClient = new QueryClient();

function render(view: DashboardView): void {
  vi.mocked(useDashboard).mockReturnValue({
    data: view,
    isPending: false,
    isError: false,
    error: null,
    refetch: async () => undefined,
  } as unknown as ReturnType<typeof useDashboard>);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/org/org-1/workshops/${WS}`]}>
          <Routes>
            <Route path="/org/:orgId/workshops/:wsId" element={<DashboardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) {
    throw new Error(`no button "${label}"`);
  }
  return found;
}

/** The workshop toggle sits in the first action group. */
function toggleButton(): HTMLButtonElement {
  return container.querySelector('.action-group .actions button') as HTMLButtonElement;
}

const describe_ = (element: HTMLElement) =>
  `${element.textContent?.trim()}[${element.dataset.state}]`;

/** Types into a React-controlled input (value setter + input event). */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function capacityRow(sessionId: string) {
  const input = container.querySelector(`#cap-${sessionId}`) as HTMLInputElement;
  const cell = input.closest('td') as HTMLTableCellElement;
  const set = Array.from(cell.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Set',
  ) as HTMLButtonElement;
  const alert = cell.querySelector('[role="alert"]');
  return { input, set, alert: alert?.textContent?.trim() };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: Date.parse('2026-11-03T06:09:00.000Z'), toFake: ['Date'] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  settle = () => ({ phase: 'idle' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('web-01: the open/close toggle after it settled', () => {
  it('names the command that ran, then offers the next action once the status reflects it', () => {
    settle = (body) =>
      body.type === 'CLOSE_REGISTRATION' ? applied('CLOSE_REGISTRATION') : { phase: 'idle' };
    render(dashboard());
    expect(describe_(toggleButton())).toBe('Close registration[idle]');
    act(() => {
      button('Close registration').click();
    });
    // Settled, the view not yet refetched: the button says what it did.
    expect(describe_(toggleButton())).toBe('Closed[done]');
    // The refetch flips the status: the button offers the opposite action, never "Opened".
    render(dashboard({ workshop: { ...workshop, status: 'CLOSED', seq: 3, version: 8 } }));
    expect(container.querySelector('.page-header .badge')?.textContent?.trim()).toBe('Closed');
    expect(describe_(toggleButton())).toBe('Open registration[idle]');
    // Reopened from elsewhere (another organiser or tab): the old "Closed" never comes back.
    render(dashboard({ workshop: { ...workshop, status: 'OPEN', seq: 4, version: 9 } }));
    expect(container.querySelector('.page-header .badge')?.textContent?.trim()).toBe('Open');
    expect(describe_(toggleButton())).toBe('Close registration[idle]');
  });

  it('the same for "Open registration" on a closed workshop', () => {
    settle = (body) =>
      body.type === 'OPEN_REGISTRATION' ? applied('OPEN_REGISTRATION') : { phase: 'idle' };
    render(dashboard({ workshop: { ...workshop, status: 'CLOSED', seq: 3, version: 7 } }));
    act(() => {
      button('Open registration').click();
    });
    expect(describe_(toggleButton())).toBe('Opened[done]');
    render(dashboard({ workshop: { ...workshop, status: 'OPEN', seq: 3, version: 8 } }));
    expect(describe_(toggleButton())).toBe('Close registration[idle]');
  });
});

describe('web-03: capacity input validation before anything is sent', () => {
  it('explains 0, blank, negative, fractional and over-limit values and keeps Set disabled', () => {
    render(dashboard());
    const low = 'Capacity must be a whole number of at least 1.';
    for (const [value, message] of [
      ['0', low],
      ['', low],
      ['-1', low],
      ['2.5', low],
      [String(MAX_CAPACITY + 1), `Capacity cannot exceed ${MAX_CAPACITY}.`],
      ['20000', `Capacity cannot exceed ${MAX_CAPACITY}.`],
    ] as const) {
      type(capacityRow(S2).input, value);
      const row = capacityRow(S2);
      expect(row.alert, value).toBe(message);
      expect(row.set.disabled, value).toBe(true);
      expect(row.input.getAttribute('aria-invalid'), value).toBe('true');
    }
    type(capacityRow(S2).input, String(MAX_CAPACITY));
    expect(capacityRow(S2).alert).toBeUndefined();
    expect(capacityRow(S2).set.disabled).toBe(false);
    expect(capacityRow(S2).input.getAttribute('max')).toBe(String(MAX_CAPACITY));
  });
});

describe('web-05: the capacity draft follows the server value', () => {
  it('shows the real capacity again after a rejected decrease', () => {
    settle = (body) =>
      body.type === 'SET_CAPACITY'
        ? {
            phase: 'rejected',
            commandId: 'c2',
            view: {
              commandId: 'c2',
              workshopId: WS,
              type: 'SET_CAPACITY',
              status: 'REJECTED',
              acceptedAt: at(100),
              settledAt: at(101),
              reason: 'CAPACITY_BELOW_USAGE',
            },
          }
        : { phase: 'idle' };
    render(dashboard());
    type(capacityRow(S1).input, '1');
    expect(capacityRow(S1).set.disabled).toBe(false);
    act(() => {
      capacityRow(S1).set.click();
    });
    expect(capacityRow(S1).alert).toContain('Rejected: Capacity cannot go below');
    expect(capacityRow(S1).input.value).toBe('2');
    expect(capacityRow(S1).set.disabled).toBe(true);
  });

  it('follows a capacity changed elsewhere (refetch)', () => {
    render(dashboard());
    expect(capacityRow(S2).input.value).toBe('10');
    const view = dashboard();
    view.sessions[1] = { ...view.sessions[1]!, capacity: 12, free: 12 };
    render(view);
    expect(capacityRow(S2).input.value).toBe('12');
  });
});

describe('web-09: attendance checkbox ids', () => {
  it('gives one participant confirmed in two sessions two distinct, matching checkbox ids', () => {
    render(dashboard());
    const cells = Array.from(container.querySelectorAll('.attendance'));
    expect(cells).toHaveLength(2);
    const ids = cells.map((cell) => cell.querySelector('input')?.id);
    expect(new Set(ids).size).toBe(2);
    for (const cell of cells) {
      expect(cell.querySelector('label')?.htmlFor).toBe(cell.querySelector('input')?.id);
    }
  });
});

describe('web-07: the not-found banner', () => {
  it('does not say "Workshop not found" twice', () => {
    const error = new ApiError(404, 'NOT_FOUND', 'Workshop not found');
    act(() => {
      root.render(<ErrorBanner error={error} title="Workshop not found" />);
    });
    expect(container.textContent).toBe('Workshop not foundWorkshop not found');
    act(() => {
      root.render(
        <ErrorBanner
          error={error}
          title="Workshop not found"
          description="There is no workshop with this id; check the link you were given."
        />,
      );
    });
    expect(container.textContent).not.toContain('Not found:');
    expect(container.textContent).toBe(
      'Workshop not foundThere is no workshop with this id; check the link you were given.',
    );
  });
});

describe('web-08: CopyLink input id', () => {
  it('is a valid id (no whitespace) and is what the label points at', () => {
    act(() => {
      root.render(<CopyLink url="https://x.test/w/1" label="Share link (public page)" />);
    });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.id).not.toMatch(/[\s()]/);
    expect(container.querySelector('label')?.htmlFor).toBe(input.id);
  });
});
