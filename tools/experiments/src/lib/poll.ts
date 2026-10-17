import { setTimeout as sleepMs } from 'node:timers/promises';
import type { CommandAcceptedView, CommandBody, CommandResultView } from '@seatrelay/contracts';
import {
  CommandTimeoutError,
  DEFAULT_SETTLE_TIMEOUT_MS,
  pollDelayMs,
  type ApiClient,
  type CommandInput,
} from '@seatrelay/scripts';

/**
 * Polling primitives for the experiments that cannot use `ApiClient.sendCommand()` as a
 * single call: the idempotency probe POSTs one commandId several times concurrently and then
 * polls once, the failure-recovery runs poll a command whose first delivery crashed. The
 * schedule is the plan §1.3 browser backoff (300 → 500 → 1000 → 2000 ms, every 5 s after 30 s)
 * shared with `sendCommand()` through `pollDelayMs`.
 */

export type CommandStatus = CommandResultView['status'];

export function isSettled(status: CommandStatus): boolean {
  return status === 'APPLIED' || status === 'REJECTED';
}

/** Server-side settle latency `settledAt − acceptedAt` (plan §1.3), when settled. */
export function serverSettleMs(record: Pick<CommandResultView, 'acceptedAt' | 'settledAt'>): number | undefined {
  if (record.settledAt === undefined) {
    return undefined;
  }
  return Math.max(0, Date.parse(record.settledAt) - Date.parse(record.acceptedAt));
}

export interface PollOptions {
  /** Give up after this long (default 120 s), measured from `startedAt`. */
  timeoutMs?: number;
  /** Delay before the first GET (the 202's `pollAfterMs`; default 300). */
  firstDelayMs?: number;
  /** Epoch ms the command was POSTed (default: now); elapsed time and the timeout count from it. */
  startedAt?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PolledCommand {
  record: CommandResultView;
  /** GET /commands/{id} calls made. */
  polls: number;
  /** From `startedAt` to the poll that saw the terminal state (client-observed settle latency). */
  elapsedMs: number;
  serverSettleMs: number | undefined;
}

/** Polls `GET /commands/{id}` with the plan §1.3 backoff until APPLIED or REJECTED. */
export async function pollCommand(
  client: Pick<ApiClient, 'getCommand'>,
  commandId: string,
  options: PollOptions = {},
): Promise<PolledCommand> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));
  const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const startedAt = options.startedAt ?? now();
  let delay = options.firstDelayMs ?? pollDelayMs(0, 0);
  let polls = 0;
  for (;;) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new CommandTimeoutError(commandId, timeoutMs);
    }
    await sleep(Math.min(delay, Math.max(0, timeoutMs - elapsed)));
    const record = await client.getCommand(commandId);
    polls += 1;
    if (isSettled(record.status)) {
      return { record, polls, elapsedMs: now() - startedAt, serverSettleMs: serverSettleMs(record) };
    }
    delay = pollDelayMs(polls, now() - startedAt);
  }
}

/** A command body with an explicit (or fresh) commandId. */
export function commandBody(input: CommandInput, commandId: string): CommandBody {
  return { ...input, commandId } as CommandBody;
}

export type PostOutcome =
  | { ok: true; view: CommandAcceptedView; ms: number }
  | { ok: false; error: unknown; ms: number };

/**
 * POSTs the same body `copies` times at once (the "same commandId submitted 5× concurrently"
 * probe of plan §4 Repeat execution). Every outcome is returned, failures included.
 */
export async function postConcurrently(
  client: Pick<ApiClient, 'postCommand'>,
  wsId: string,
  body: CommandBody,
  copies: number,
  now: () => number = () => Date.now(),
): Promise<PostOutcome[]> {
  return Promise.all(
    Array.from({ length: copies }, async (): Promise<PostOutcome> => {
      const started = now();
      try {
        const view = await client.postCommand(wsId, body);
        return { ok: true, view, ms: now() - started };
      } catch (error) {
        return { ok: false, error, ms: now() - started };
      }
    }),
  );
}

/** JSON with object keys sorted recursively (storage adapters may return maps in any order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return inner;
  });
}

/**
 * The part of a command record that must be identical on every read once it has settled
 * (status, reason, result, acceptedAt, settledAt), as a canonical JSON string.
 */
export function settledFingerprint(record: CommandResultView): string {
  return canonicalJson({
    commandId: record.commandId,
    type: record.type,
    status: record.status,
    reason: record.reason ?? null,
    result: record.result ?? null,
    acceptedAt: record.acceptedAt,
    settledAt: record.settledAt ?? null,
  });
}
