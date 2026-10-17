import type { CommandBody, CommandResultView, SessionView } from '@seatrelay/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../api/ApiProvider';
import { ApiError } from '../api/client';
import { useInvalidateWorkshop } from '../api/queries';
import { useToasts } from '../components/Toasts';
import { describeError } from '../util/errors';
import { describeSettled } from './copy';
import { isTerminal, PollAbortedError, pollCommand } from './pollCommand';

/**
 * The 202 command flow (plan §1.3) as a state machine:
 *   idle → submitting (POST) → processing (polling) → applied | rejected
 *                     ↘ error (POST failed / polling gave up) → retry() reuses the commandId
 * The client-generated `commandId` (crypto.randomUUID) is kept until the command settles, so
 * a retry after a network failure or 503 is idempotent (C3).
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A command body without `commandId` (the hook generates and keeps it). */
export type CommandBodyInput = DistributiveOmit<CommandBody, 'commandId'>;

export type CommandPhase =
  | { phase: 'idle' }
  | { phase: 'submitting'; commandId: string }
  | { phase: 'processing'; commandId: string; slow: boolean; attempts: number }
  | { phase: 'applied'; commandId: string; view: CommandResultView }
  | { phase: 'rejected'; commandId: string; view: CommandResultView }
  | { phase: 'error'; commandId: string; error: unknown; stage: 'submit' | 'poll' };

export interface UseCommandOptions {
  /** Session titles for the settlement toast. */
  sessions?: readonly SessionView[];
  onSettled?: (view: CommandResultView) => void;
  /** Suppress the toasts (the caller renders its own copy). */
  silent?: boolean;
}

export interface CommandHandle {
  state: CommandPhase;
  /** Submitting or polling. */
  busy: boolean;
  run(body: CommandBodyInput): Promise<void>;
  /** Re-POST (same commandId) after a submit error, or resume polling after a poll error. */
  retry(): Promise<void>;
  reset(): void;
}

function newCommandId(): string {
  return crypto.randomUUID();
}

export function useCommand(wsId: string, options: UseCommandOptions = {}): CommandHandle {
  const api = useApi();
  const toasts = useToasts();
  const invalidate = useInvalidateWorkshop();
  const [state, setState] = useState<CommandPhase>({ phase: 'idle' });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastRef = useRef<{ commandId: string; body: CommandBodyInput } | undefined>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => () => abortRef.current?.abort(), []);

  const settle = useCallback(
    async (commandId: string, view: CommandResultView, toastId: string | undefined) => {
      const { sessions = [], onSettled, silent } = optionsRef.current;
      const copy = describeSettled(view, sessions);
      if (!silent) {
        toasts.push({ id: toastId, kind: copy.kind, title: copy.title, message: copy.message });
      }
      setState(
        view.status === 'APPLIED'
          ? { phase: 'applied', commandId, view }
          : { phase: 'rejected', commandId, view },
      );
      lastRef.current = undefined;
      onSettled?.(view);
      await invalidate(wsId);
    },
    [invalidate, toasts, wsId],
  );

  const poll = useCallback(
    async (commandId: string, initialDelayMs: number, toastId: string | undefined) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ phase: 'processing', commandId, slow: false, attempts: 0 });
      try {
        const view = await pollCommand((id, signal) => api.getCommand(id, signal), commandId, {
          signal: controller.signal,
          initialDelayMs,
          onSlow: () => {
            setState((current) =>
              current.phase === 'processing' && current.commandId === commandId
                ? { ...current, slow: true }
                : current,
            );
            if (!optionsRef.current.silent) {
              toasts.push({
                id: toastId,
                kind: 'info',
                title: 'Still processing…',
                message: 'The server has your request; this is taking longer than usual.',
                sticky: true,
              });
            }
          },
          onAttempt: (attempts) => {
            setState((current) =>
              current.phase === 'processing' && current.commandId === commandId
                ? { ...current, attempts }
                : current,
            );
          },
        });
        await settle(commandId, view, toastId);
      } catch (error) {
        if (error instanceof PollAbortedError || controller.signal.aborted) {
          return;
        }
        setState({ phase: 'error', commandId, error, stage: 'poll' });
        if (!optionsRef.current.silent) {
          toasts.push({
            id: toastId,
            kind: 'error',
            title: 'Outcome unknown',
            message: `${describeError(error)} Your request was received; retry to check its outcome.`,
            sticky: true,
          });
        }
      }
    },
    [api, settle, toasts],
  );

  const submit = useCallback(
    async (commandId: string, body: CommandBodyInput) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ phase: 'submitting', commandId });
      const toastId = optionsRef.current.silent
        ? undefined
        : toasts.push({ kind: 'info', title: 'Sending…', sticky: true });
      try {
        const accepted = await api.postCommand(
          wsId,
          { ...body, commandId } as CommandBody,
          controller.signal,
        );
        if (isTerminal(accepted)) {
          // Idempotent re-POST of a command that already settled: the 202 carries the outcome.
          await settle(commandId, accepted, toastId);
          return;
        }
        if (!optionsRef.current.silent) {
          toasts.push({
            id: toastId,
            kind: 'info',
            title: 'Request received',
            message: 'Processing… the result will appear here.',
            sticky: true,
          });
        }
        await poll(commandId, accepted.pollAfterMs, toastId);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setState({ phase: 'error', commandId, error, stage: 'submit' });
        if (!optionsRef.current.silent) {
          const retryable =
            !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
          toasts.push({
            id: toastId,
            kind: 'error',
            title: 'Request not sent',
            message: `${describeError(error)}${retryable ? ' You can retry; the same request id is reused.' : ''}`,
            sticky: retryable,
          });
        }
      }
    },
    [api, poll, settle, toasts, wsId],
  );

  const run = useCallback(
    async (body: CommandBodyInput) => {
      const commandId = newCommandId();
      lastRef.current = { commandId, body };
      await submit(commandId, body);
    },
    [submit],
  );

  const retry = useCallback(async () => {
    const last = lastRef.current;
    if (last === undefined) {
      return;
    }
    if (state.phase === 'error' && state.stage === 'poll') {
      await poll(last.commandId, 0, undefined);
      return;
    }
    await submit(last.commandId, last.body);
  }, [poll, state, submit]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    lastRef.current = undefined;
    setState({ phase: 'idle' });
  }, []);

  const busy = state.phase === 'submitting' || state.phase === 'processing';
  return useMemo(() => ({ state, busy, run, retry, reset }), [busy, reset, retry, run, state]);
}
