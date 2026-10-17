import type { CommandAcceptedView, CommandBody, CommandResultView } from '@seatrelay/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import {
  CommandRunner,
  isRetryableSubmitError,
  type CommandPhase,
  type CommandRunnerDeps,
  type CommandRunnerOptions,
} from '../src/commands/commandRunner';
import { PollAbortedError } from '../src/commands/pollCommand';
import type { ToastInput } from '../src/components/Toasts';
import { at, cancelled, sessions, settledView, WS } from './fixtures';

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function accepted(commandId: string): CommandAcceptedView {
  return {
    commandId,
    type: 'CANCEL_REGISTRATION',
    workshopId: WS,
    status: 'ACCEPTED',
    acceptedAt: at(100),
    href: `/commands/${commandId}`,
    pollAfterMs: 300,
  };
}

/** Toast region double: the toasts currently on screen, by id. */
function toastRegion() {
  const shown = new Map<string, ToastInput>();
  let counter = 0;
  return {
    shown,
    push: vi.fn((toast: ToastInput) => {
      counter += 1;
      const id = toast.id ?? `toast-${counter}`;
      shown.set(id, { ...toast, id });
      return id;
    }),
    dismiss: vi.fn((id: string) => {
      shown.delete(id);
    }),
    sticky: () => [...shown.values()].filter((toast) => toast.sticky === true),
  };
}

interface Harness {
  runner: CommandRunner;
  deps: CommandRunnerDeps;
  toasts: ReturnType<typeof toastRegion>;
  states: CommandPhase[];
  events: string[];
  posted: CommandBody[];
  options: CommandRunnerOptions;
  /** The detach timer callback, if one is armed. */
  detachTimer: () => (() => void) | undefined;
}

function harness(
  overrides: Partial<CommandRunnerDeps> & {
    answers?: Array<CommandResultView | Error>;
    postErrors?: Error[];
  } = {},
): Harness {
  const toasts = toastRegion();
  const states: CommandPhase[] = [];
  const events: string[] = [];
  const posted: CommandBody[] = [];
  const ids = [...IDS];
  const answers = overrides.answers ?? [settledView('APPLIED', cancelled)];
  const postErrors = overrides.postErrors ?? [];
  let armed: (() => void) | undefined;
  let now = 0;
  const deps: CommandRunnerDeps = {
    postCommand: vi.fn(async (_wsId: string, body: CommandBody) => {
      posted.push(body);
      const failure = postErrors.shift();
      if (failure !== undefined) {
        throw failure;
      }
      return accepted(body.commandId);
    }),
    getCommand: vi.fn(async (commandId: string) => {
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next instanceof Error) {
        throw next;
      }
      return { ...(next ?? settledView('APPLIED', cancelled)), commandId };
    }),
    toasts,
    applyResult: vi.fn(() => {
      events.push('applyResult');
    }),
    invalidate: vi.fn(async () => {
      events.push('invalidate');
    }),
    newCommandId: () => ids.shift() ?? 'exhausted',
    poll: {
      now: () => now,
      // Virtual time, but yield a macrotask so that a never-settling poll cannot starve timers.
      sleep: async (ms: number, signal?: AbortSignal) => {
        now += ms;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) {
          throw new PollAbortedError();
        }
      },
    },
    setTimer: (callback) => {
      armed = callback;
      return () => {
        armed = undefined;
      };
    },
    ...overrides,
  };
  const options: CommandRunnerOptions = {
    sessions,
    onSettled: () => {
      events.push('onSettled');
    },
  };
  const runner = new CommandRunner(
    () => deps,
    () => options,
    (state) => states.push(state),
  );
  return { runner, deps, toasts, states, events, posted, options, detachTimer: () => armed };
}

describe('CommandRunner settle (plan §1.3)', () => {
  it('writes the poll result into the cache before onSettled and the refetch', async () => {
    const h = harness();
    await h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    expect(h.events).toEqual(['applyResult', 'onSettled', 'invalidate']);
    expect(h.runner.state.phase).toBe('applied');
    expect(h.states.map((state) => state.phase)).toEqual([
      'submitting',
      'processing',
      'processing',
      'applied',
    ]);
  });

  it('turns one toast from "Sending…" into "Request received" into the outcome', async () => {
    const h = harness();
    await h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    const titles = h.toasts.push.mock.calls.map(([toast]) => toast.title);
    expect(titles).toEqual(['Sending…', 'Request received', 'Cancellation applied']);
    expect(new Set(h.toasts.push.mock.results.map((result) => result.value))).toHaveProperty(
      'size',
      1,
    );
    expect(h.toasts.sticky()).toEqual([]);
  });
});

describe('CommandRunner after the page is left (unmount)', () => {
  it('keeps polling and reports the outcome in the toast, without touching the unmounted view', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = harness({
      getCommand: vi.fn(async (commandId: string) => {
        calls += 1;
        if (calls === 1) {
          await gate;
        }
        return { ...settledView('APPLIED', cancelled), commandId };
      }),
    });
    const running = h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    await vi.waitFor(() => expect(calls).toBe(1));
    h.runner.detach();
    const statesBefore = h.states.length;
    release();
    await running;
    expect(h.events).toEqual(['applyResult', 'invalidate']);
    expect(h.states.length).toBe(statesBefore);
    expect([...h.toasts.shown.values()].map((toast) => toast.title)).toEqual([
      'Cancellation applied',
    ]);
    expect(h.toasts.sticky()).toEqual([]);
    expect(h.detachTimer()).toBeUndefined();
  });

  it('gives up after the detached budget with a non-sticky hint instead of a stuck toast', async () => {
    const h = harness({ answers: [{ ...settledView('APPLIED'), status: 'ACCEPTED' }] });
    const running = h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    await vi.waitFor(() => expect(h.deps.getCommand).toHaveBeenCalled());
    h.runner.detach();
    const fire = h.detachTimer();
    expect(fire).toBeDefined();
    fire?.();
    await running;
    const remaining = [...h.toasts.shown.values()];
    expect(remaining.map((toast) => toast.title)).toEqual(['Still processing']);
    expect(h.toasts.sticky()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('keeps a rejection toast on screen when the page that would show it inline is gone', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      getCommand: vi.fn(async (commandId: string) => {
        await gate;
        return { ...settledView('REJECTED'), commandId };
      }),
    });
    const running = h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    await vi.waitFor(() => expect(h.deps.getCommand).toHaveBeenCalled());
    h.runner.detach();
    release();
    await running;
    expect(h.toasts.sticky().map((toast) => toast.message)).toEqual([
      'You have no registration to act on.',
    ]);
  });

  it('re-attaching (StrictMode remount) cancels the budget and delivers the current state', async () => {
    const h = harness();
    h.runner.detach();
    h.runner.attach();
    expect(h.detachTimer()).toBeUndefined();
    await h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    expect(h.events).toContain('onSettled');
  });
});

describe('CommandRunner errors and retries', () => {
  it('re-sends the same commandId and body after a retryable failure (5xx / network / 429)', async () => {
    const h = harness({
      postErrors: [new ApiError(503, 'QUEUE_UNAVAILABLE', 'queue down')],
    });
    await h.runner.run(WS, { type: 'REGISTER', acceptable: ['sess-1'] });
    expect(h.runner.state).toMatchObject({ phase: 'error', stage: 'submit', retryable: true });
    await h.runner.retry();
    expect(h.posted).toHaveLength(2);
    expect(h.posted[1]).toEqual(h.posted[0]);
    expect(h.runner.state.phase).toBe('applied');
    // The error toast was updated in place, not duplicated.
    expect(new Set(h.toasts.push.mock.results.map((result) => result.value)).size).toBe(1);
  });

  it('treats a 4xx as definitive: retry() does nothing and the next run gets a fresh id', async () => {
    const h = harness({
      postErrors: [new ApiError(400, 'VALIDATION_ERROR', 'acceptable: too many')],
    });
    await h.runner.run(WS, { type: 'REGISTER', acceptable: ['sess-1'] });
    expect(h.runner.state).toMatchObject({ phase: 'error', retryable: false });
    expect(h.toasts.sticky()).toEqual([]);
    await h.runner.retry();
    expect(h.posted).toHaveLength(1);
    await h.runner.run(WS, { type: 'REGISTER', acceptable: ['sess-2'] });
    expect(h.posted.map((body) => body.commandId)).toEqual([IDS[0], IDS[1]]);
    expect(h.posted[1]).toMatchObject({ acceptable: ['sess-2'] });
  });

  it('reset() ("Discard and edit") drops the request and its sticky toast', async () => {
    const h = harness({ postErrors: [new ApiError(0, 'NETWORK', 'offline')] });
    await h.runner.run(WS, { type: 'REGISTER', acceptable: ['sess-1'] });
    expect(h.toasts.sticky()).toHaveLength(1);
    h.runner.reset();
    expect(h.toasts.shown.size).toBe(0);
    expect(h.runner.state.phase).toBe('idle');
    await h.runner.retry();
    expect(h.posted).toHaveLength(1);
    await h.runner.run(WS, { type: 'REGISTER', acceptable: ['sess-2'] });
    expect(h.posted[1]?.commandId).toBe(IDS[1]);
  });

  it('resumes polling the same command after the poll gave up', async () => {
    const lost = new ApiError(0, 'NETWORK', 'offline');
    const h = harness({
      answers: [lost, lost, lost, lost, lost, settledView('APPLIED', cancelled)],
    });
    await h.runner.run(WS, { type: 'CANCEL_REGISTRATION' });
    expect(h.runner.state).toMatchObject({ phase: 'error', stage: 'poll', retryable: true });
    await h.runner.retry();
    expect(h.posted).toHaveLength(1);
    expect(h.runner.state.phase).toBe('applied');
  });

  it('classifies submit errors', () => {
    expect(isRetryableSubmitError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableSubmitError(new ApiError(0, 'NETWORK', ''))).toBe(true);
    expect(isRetryableSubmitError(new ApiError(429, 'TOO_MANY_REQUESTS', ''))).toBe(true);
    expect(isRetryableSubmitError(new ApiError(503, 'QUEUE_UNAVAILABLE', ''))).toBe(true);
    for (const status of [400, 401, 403, 404, 409]) {
      expect(isRetryableSubmitError(new ApiError(status, 'X', ''))).toBe(false);
    }
  });
});
