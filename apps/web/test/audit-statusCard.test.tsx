// @vitest-environment jsdom
import type { CommandResultView, RegistrationSummary } from '@seatrelay/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandPhase } from '../src/commands/commandRunner';
import { StatusCard } from '../src/components/StatusCard';
import { S1, S2, sessions, summary, workshop, WS } from './fixtures';

/**
 * Web audit (30 Oct): the action buttons' "done" copy outlives the state the command produced.
 * After a DECLINE_OFFER that puts the participant straight into the next offer (R5 + relay in
 * the same decision), the card shows the new offer with the Decline button still reading
 * "Declined" (data-state="done"), observed on the dev stage. Fixed the same day: StatusCard
 * resets its "done" state when the registration (seq, status, offer id) it was produced for
 * changes; this test keeps it that way.
 */

let phase: CommandPhase = { phase: 'idle' };
let runSpy: (body: unknown) => Promise<void>;
vi.mock('../src/commands/useCommand', () => ({
  useCommand: () => ({
    state: phase,
    busy: phase.phase === 'submitting' || phase.phase === 'processing',
    canRetry: false,
    run: (body: unknown) => runSpy(body),
    retry: async () => undefined,
    reset: () => undefined,
  }),
}));

let root: Root;
let container: HTMLDivElement;

function render(registration: RegistrationSummary): void {
  act(() => {
    root.render(<StatusCard workshop={workshop} sessions={sessions} registration={registration} />);
  });
}

const offerOf = (id: string, sessionId: string): RegistrationSummary =>
  summary({
    status: 'OFFERED',
    seq: 3,
    queuePosition: undefined,
    acceptable: sessionId === S1 ? [S1] : [S2, S1],
    currentOffer: { id, sessionId, expiresAt: '2026-11-03T06:20:00.000Z' },
  });

function buttons(): string[] {
  return Array.from(container.querySelectorAll('.actions button')).map(
    (button) => `${button.textContent?.trim()}[${(button as HTMLElement).dataset.state}]`,
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: Date.parse('2026-11-03T06:09:00.000Z') });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  phase = { phase: 'idle' };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('StatusCard action copy after a settled command', () => {
  it('a decline that leads to the next offer shows "Decline" again, not "Declined"', () => {
    const applied: CommandResultView = {
      commandId: 'c1',
      workshopId: WS,
      type: 'DECLINE_OFFER',
      status: 'APPLIED',
      acceptedAt: '2026-11-03T06:09:00.000Z',
      settledAt: '2026-11-03T06:09:01.000Z',
      result: { offersCreated: 1, registration: offerOf('o2', S1) },
    };
    runSpy = async () => {
      phase = { phase: 'applied', commandId: 'c1', view: applied };
    };
    render(offerOf('o1', S2));
    expect(buttons()).toEqual(['Accept seat[idle]', 'Decline[idle]', 'Cancel registration[idle]']);
    const decline = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Decline',
    ) as HTMLButtonElement;
    act(() => {
      decline.click();
    });
    // The poll result: the next preference is offered at once (new offer id).
    render(offerOf('o2', S1));
    expect(container.textContent).toContain('A seat in Session 1');
    // The offer that was never declined must not carry a "Declined" (done) button.
    expect(buttons()).toEqual(['Accept seat[idle]', 'Decline[idle]', 'Cancel registration[idle]']);
  });
});
