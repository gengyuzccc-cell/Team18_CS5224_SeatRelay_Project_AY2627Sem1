import type {
  CommandAcceptedView,
  CommandBody,
  CommandResultView,
  SessionView,
  WorkshopMode,
} from '@seatrelay/contracts';
import { ApiError } from '../api/client';
import type { ToastApi, ToastInput } from '../components/Toasts';
import { describeError } from '../util/errors';
import { describeSettled } from './copy';
import { isTerminal, PollAbortedError, pollCommand, type PollOptions } from './pollCommand';

/**
 * The 202 command flow (plan §1.3) as a state machine, independent of React:
 *   idle → submitting (POST) → processing (polling) → applied | rejected
 *                     ↘ error (POST failed / polling gave up)
 * The client-generated `commandId` is kept until the command settles, so `retry()` after a
 * network failure, a 5xx or a 429 re-sends the same request (C3). A definitive 4xx means the
 * server did not take the request: the error is not retryable and the next `run()` starts over
 * with a fresh id.
 *
 * The toasts live above the router, so the outcome is reported even after the page that sent the
 * command is left: `detach()` (unmount) keeps polling for `detachedBudgetMs`, then replaces the
 * pending toast with a "check My registrations" hint instead of leaving it stuck.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A command body without `commandId` (the runner generates and keeps it). */
export type CommandBodyInput = DistributiveOmit<CommandBody, 'commandId'>;

export type CommandPhase =
  | { phase: 'idle' }
  | { phase: 'submitting'; commandId: string }
  | { phase: 'processing'; commandId: string; slow: boolean; attempts: number }
  | { phase: 'applied'; commandId: string; view: CommandResultView }
  | { phase: 'rejected'; commandId: string; view: CommandResultView }
  | {
      phase: 'error';
      commandId: string;
      error: unknown;
      stage: 'submit' | 'poll';
      /** `retry()` re-sends the same request (submit) or resumes polling (poll). */
      retryable: boolean;
    };

export interface CommandRunnerOptions {
  /** Session titles for the settlement toast. */
  sessions?: readonly SessionView[];
  /** The workshop's mode for the settlement toast (PER_SESSION endings are per session). */
  mode?: WorkshopMode;
  /** Called once the command settled (not after the component unmounted). */
  onSettled?: (view: CommandResultView) => void;
  /** Suppress the toasts (the caller renders its own copy). */
  silent?: boolean;
}

export interface CommandRunnerDeps {
  postCommand(wsId: string, body: CommandBody, signal?: AbortSignal): Promise<CommandAcceptedView>;
  getCommand(commandId: string, signal?: AbortSignal): Promise<CommandResultView>;
  toasts: Pick<ToastApi, 'push' | 'dismiss'>;
  /** Writes the poll result into the cached views before anything is refetched (plan §1.3). */
  applyResult(view: CommandResultView): void;
  /** Refetches what the settled command may have changed. */
  invalidate(wsId: string): Promise<unknown>;
  newCommandId?: () => string;
  /** pollCommand overrides (tests). */
  poll?: Pick<PollOptions, 'sleep' | 'now' | 'maxConsecutiveErrors'>;
  /** How long a command keeps being polled after its component unmounted. */
  detachedBudgetMs?: number;
  setTimer?: (callback: () => void, ms: number) => () => void;
}

/** Polling continues this long after the page that sent the command was left. */
export const DETACHED_POLL_BUDGET_MS = 120_000;

const ABORT_SUPERSEDED = 'superseded';
const ABORT_RESET = 'reset';
const ABORT_DETACHED = 'detached-timeout';

/** Network failure, 429 and 5xx: the server may or may not have the request → same commandId. */
export function isRetryableSubmitError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

interface Attempt {
  commandId: string;
  wsId: string;
  body: CommandBodyInput;
  toastId: string | undefined;
}

function defaultSetTimer(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

export class CommandRunner {
  #state: CommandPhase = { phase: 'idle' };
  /** The last state handed to `onState` (nothing is delivered while detached). */
  #delivered: CommandPhase = this.#state;
  /** The request `retry()` would repeat; cleared once it settles or fails definitively. */
  #last: Attempt | undefined;
  #controller: AbortController | undefined;
  #attached = true;
  #cancelDetachTimer: (() => void) | undefined;
  readonly #deps: () => CommandRunnerDeps;
  readonly #options: () => CommandRunnerOptions;
  readonly #onState: (state: CommandPhase) => void;

  constructor(
    deps: () => CommandRunnerDeps,
    options: () => CommandRunnerOptions,
    onState: (state: CommandPhase) => void,
  ) {
    this.#deps = deps;
    this.#options = options;
    this.#onState = onState;
  }

  get state(): CommandPhase {
    return this.#state;
  }

  get busy(): boolean {
    return this.#state.phase === 'submitting' || this.#state.phase === 'processing';
  }

  get attached(): boolean {
    return this.#attached;
  }

  async run(wsId: string, body: CommandBodyInput): Promise<void> {
    const previous = this.#last;
    this.#abort(ABORT_SUPERSEDED);
    this.#dismiss(previous);
    const commandId = this.#deps().newCommandId?.() ?? crypto.randomUUID();
    const attempt: Attempt = { commandId, wsId, body, toastId: undefined };
    this.#last = attempt;
    await this.#submit(attempt);
  }

  /** Re-POST (same commandId) after a submit error, or resume polling after a poll error. */
  async retry(): Promise<void> {
    const attempt = this.#last;
    const state = this.#state;
    if (attempt === undefined || state.phase !== 'error' || !state.retryable) {
      return;
    }
    if (state.stage === 'poll') {
      const controller = this.#newController();
      this.#toast(attempt, { kind: 'info', title: 'Checking the outcome…', sticky: true });
      await this.#poll(controller, attempt, 0);
      return;
    }
    await this.#submit(attempt);
  }

  /** Forget the current request ("Discard and edit"): the next `run()` gets a fresh commandId. */
  reset(): void {
    const attempt = this.#last;
    this.#abort(ABORT_RESET);
    this.#dismiss(attempt);
    this.#last = undefined;
    this.#setState({ phase: 'idle' });
  }

  /** The component unmounted: keep polling for a while; the toasts report the outcome. */
  detach(): void {
    this.#attached = false;
    this.#clearDetachTimer();
    if (!this.busy) {
      return;
    }
    const deps = this.#deps();
    const controller = this.#controller;
    this.#cancelDetachTimer = (deps.setTimer ?? defaultSetTimer)(() => {
      this.#cancelDetachTimer = undefined;
      if (controller !== undefined && controller === this.#controller) {
        this.#abort(ABORT_DETACHED);
      }
    }, deps.detachedBudgetMs ?? DETACHED_POLL_BUDGET_MS);
  }

  /** (Re)mounted, e.g. React StrictMode's second mount. */
  attach(): void {
    this.#attached = true;
    this.#clearDetachTimer();
    if (this.#delivered !== this.#state) {
      this.#delivered = this.#state;
      this.#onState(this.#state);
    }
  }

  #setState(state: CommandPhase): void {
    this.#state = state;
    if (this.#attached) {
      this.#delivered = state;
      this.#onState(state);
    }
  }

  #newController(): AbortController {
    this.#abort(ABORT_SUPERSEDED);
    const controller = new AbortController();
    this.#controller = controller;
    return controller;
  }

  #abort(reason: string): void {
    const controller = this.#controller;
    this.#controller = undefined;
    controller?.abort(reason);
  }

  #clearDetachTimer(): void {
    this.#cancelDetachTimer?.();
    this.#cancelDetachTimer = undefined;
  }

  #toast(attempt: Attempt, toast: Omit<ToastInput, 'id'>): void {
    if (this.#options().silent) {
      return;
    }
    attempt.toastId = this.#deps().toasts.push({ ...toast, id: attempt.toastId });
  }

  #dismiss(attempt: Attempt | undefined): void {
    if (attempt?.toastId !== undefined) {
      this.#deps().toasts.dismiss(attempt.toastId);
      attempt.toastId = undefined;
    }
  }

  async #submit(attempt: Attempt): Promise<void> {
    const controller = this.#newController();
    const { commandId } = attempt;
    this.#setState({ phase: 'submitting', commandId });
    this.#toast(attempt, { kind: 'info', title: 'Sending…', sticky: true });
    let accepted: CommandAcceptedView;
    try {
      accepted = await this.#deps().postCommand(
        attempt.wsId,
        { ...attempt.body, commandId } as CommandBody,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        this.#aborted(controller, attempt);
        return;
      }
      const retryable = isRetryableSubmitError(error);
      if (!retryable && this.#last === attempt) {
        this.#last = undefined;
      }
      this.#releaseController(controller);
      this.#setState({ phase: 'error', commandId, error, stage: 'submit', retryable });
      const advice = !retryable
        ? ''
        : this.#attached
          ? ' You can retry; the same request id is reused.'
          : ' Open the page again to send it.';
      this.#toast(attempt, {
        kind: 'error',
        title: 'Request not sent',
        message: `${describeError(error)}${advice}`,
        sticky: retryable || !this.#attached,
      });
      return;
    }
    if (controller.signal.aborted) {
      this.#aborted(controller, attempt);
      return;
    }
    if (isTerminal(accepted)) {
      // Idempotent re-POST of a command that already settled: the 202 carries the outcome.
      this.#releaseController(controller);
      await this.#settle(attempt, accepted);
      return;
    }
    this.#toast(attempt, {
      kind: 'info',
      title: 'Request received',
      message: 'Processing… the result will appear here.',
      sticky: true,
    });
    await this.#poll(controller, attempt, accepted.pollAfterMs);
  }

  async #poll(controller: AbortController, attempt: Attempt, initialDelayMs: number) {
    const { commandId } = attempt;
    this.#setState({ phase: 'processing', commandId, slow: false, attempts: 0 });
    let view: CommandResultView;
    try {
      const deps = this.#deps();
      view = await pollCommand((id, signal) => deps.getCommand(id, signal), commandId, {
        ...deps.poll,
        signal: controller.signal,
        initialDelayMs,
        onSlow: () => {
          const current = this.#state;
          if (current.phase === 'processing' && current.commandId === commandId) {
            this.#setState({ ...current, slow: true });
          }
          this.#toast(attempt, {
            kind: 'info',
            title: 'Still processing…',
            message: 'The server has your request; this is taking longer than usual.',
            sticky: true,
          });
        },
        onAttempt: (attempts) => {
          const current = this.#state;
          if (current.phase === 'processing' && current.commandId === commandId) {
            this.#setState({ ...current, attempts });
          }
        },
      });
    } catch (error) {
      if (error instanceof PollAbortedError || controller.signal.aborted) {
        this.#aborted(controller, attempt);
        return;
      }
      this.#releaseController(controller);
      this.#setState({ phase: 'error', commandId, error, stage: 'poll', retryable: true });
      this.#toast(attempt, {
        kind: 'error',
        title: 'Outcome unknown',
        message: `${describeError(error)} Your request was received; ${
          this.#attached
            ? 'retry to check its outcome.'
            : 'open My registrations to see its outcome.'
        }`,
        sticky: true,
      });
      return;
    }
    this.#releaseController(controller);
    await this.#settle(attempt, view);
  }

  /** The flow of `controller` ended; the detach timer only guards the flow in flight. */
  #releaseController(controller: AbortController): void {
    if (this.#controller === controller) {
      this.#controller = undefined;
      this.#clearDetachTimer();
    }
  }

  /** Aborted by a newer request, by `reset()`, or after the detached budget ran out. */
  #aborted(controller: AbortController, attempt: Attempt): void {
    const reason: unknown = controller.signal.reason;
    if (reason === ABORT_DETACHED) {
      this.#clearDetachTimer();
      this.#setState({ phase: 'idle' });
      if (this.#last === attempt) {
        this.#last = undefined;
      }
      this.#toast(attempt, {
        kind: 'info',
        title: 'Still processing',
        message:
          'We stopped checking from this page. The outcome will appear under My registrations and in your notifications.',
        sticky: false,
      });
      return;
    }
    if (reason === ABORT_SUPERSEDED || reason === ABORT_RESET) {
      this.#dismiss(attempt);
    }
  }

  async #settle(attempt: Attempt, view: CommandResultView): Promise<void> {
    if (this.#last === attempt) {
      this.#last = undefined;
    }
    this.#clearDetachTimer();
    const deps = this.#deps();
    const { sessions = [], mode, onSettled } = this.#options();
    // Plan §1.3: the UI updates from the poll response; refetches come after.
    deps.applyResult(view);
    const copy = describeSettled(view, sessions, undefined, mode);
    this.#toast(attempt, {
      kind: copy.kind,
      title: copy.title,
      message: copy.message,
      // A rejection is also shown inline next to the button; once the page is gone the toast
      // is the only place that explains it.
      sticky: copy.kind === 'error' && !this.#attached,
    });
    this.#setState(
      view.status === 'APPLIED'
        ? { phase: 'applied', commandId: attempt.commandId, view }
        : { phase: 'rejected', commandId: attempt.commandId, view },
    );
    if (this.#attached) {
      onSettled?.(view);
    }
    await deps.invalidate(attempt.wsId);
  }
}
