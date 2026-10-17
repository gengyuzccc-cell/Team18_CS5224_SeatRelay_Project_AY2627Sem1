import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../api/ApiProvider';
import { useInvalidateWorkshop } from '../api/queries';
import { applyCommandResult } from '../api/settledRegistrations';
import { useToasts } from '../components/Toasts';
import {
  CommandRunner,
  type CommandBodyInput,
  type CommandPhase,
  type CommandRunnerDeps,
  type CommandRunnerOptions,
} from './commandRunner';

export type { CommandBodyInput, CommandPhase } from './commandRunner';
export type UseCommandOptions = CommandRunnerOptions;

export interface CommandHandle {
  state: CommandPhase;
  /** Submitting or polling. */
  busy: boolean;
  /**
   * The last request failed in a way that `retry()` can repeat (same commandId). While true the
   * caller keeps its inputs locked: what is re-sent is the previous body, not the form's content.
   */
  canRetry: boolean;
  run(body: CommandBodyInput): Promise<void>;
  /** Re-POST (same commandId) after a submit error, or resume polling after a poll error. */
  retry(): Promise<void>;
  /** Drop the failed request; the next `run()` gets a fresh commandId. */
  reset(): void;
}

/**
 * React binding of `CommandRunner` (plan §1.3). Settled poll results are written into the query
 * cache before anything is refetched (`applyCommandResult`). Unmounting does not cancel the
 * command: polling continues for a while and the toasts, which live above the router, report the
 * outcome.
 */
export function useCommand(wsId: string, options: UseCommandOptions = {}): CommandHandle {
  const api = useApi();
  const toasts = useToasts();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkshop();

  const deps: CommandRunnerDeps = {
    postCommand: api.postCommand,
    getCommand: api.getCommand,
    toasts,
    applyResult: (view) => applyCommandResult(queryClient, view),
    invalidate,
  };
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const wsIdRef = useRef(wsId);
  wsIdRef.current = wsId;
  const listener = useRef<(state: CommandPhase) => void>(() => undefined);

  const [runner] = useState(
    () =>
      new CommandRunner(
        () => depsRef.current,
        () => optionsRef.current,
        (state) => listener.current(state),
      ),
  );
  const [state, setState] = useState<CommandPhase>(() => runner.state);
  listener.current = setState;

  useEffect(() => {
    runner.attach();
    return () => runner.detach();
  }, [runner]);

  const run = useCallback((body: CommandBodyInput) => runner.run(wsIdRef.current, body), [runner]);
  const retry = useCallback(() => runner.retry(), [runner]);
  const reset = useCallback(() => runner.reset(), [runner]);

  const busy = state.phase === 'submitting' || state.phase === 'processing';
  const canRetry = state.phase === 'error' && state.retryable;
  return useMemo(
    () => ({ state, busy, canRetry, run, retry, reset }),
    [busy, canRetry, reset, retry, run, state],
  );
}
