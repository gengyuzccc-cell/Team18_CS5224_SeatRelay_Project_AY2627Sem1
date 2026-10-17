import { randomUUID } from 'node:crypto';
import { setTimeout as sleepMs } from 'node:timers/promises';
import type {
  CommandAcceptedView,
  CommandBody,
  CommandResultView,
  CreateWorkshopInput,
  DashboardView,
  ErrorBody,
  HealthView,
  MeView,
  MyRegistrationListView,
  NotificationListView,
  Organization,
  VerifyView,
  WorkshopListView,
  WorkshopPublicView,
} from '@seatrelay/contracts';

/**
 * Small typed HTTP client for the SeatRelay API (plan §2.5), shared by the seed scripts, the
 * smoke test and the experiments. `fetch` is injectable so that tests can route requests into
 * the in-memory `createApiApp` without a network.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Plan §1.3 polling backoff: 300 → 500 → 1000 → 2000 ms (capped); after 30 s every 5 s. */
export const POLL_BACKOFF_MS = [300, 500, 1000, 2000] as const;
export const POLL_BUDGET_MS = 30_000;
export const BACKGROUND_POLL_MS = 5_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;

/** Delay before poll number `pollIndex` (0-based) given the time elapsed since the POST. */
export function pollDelayMs(pollIndex: number, elapsedMs: number): number {
  if (elapsedMs >= POLL_BUDGET_MS) {
    return BACKGROUND_POLL_MS;
  }
  const index = Math.min(Math.max(pollIndex, 0), POLL_BACKOFF_MS.length - 1);
  return POLL_BACKOFF_MS[index] as number;
}

export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    const error = isErrorBody(body) ? body : undefined;
    super(
      `${method} ${path} → ${status}${error === undefined ? '' : ` ${error.code}: ${error.message}`}`,
    );
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = error?.code ?? 'HTTP_ERROR';
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ErrorBody).code === 'string' &&
    typeof (value as ErrorBody).message === 'string'
  );
}

/** The request never got an HTTP answer (connection refused, DNS, TLS, reset). */
export class ApiNetworkError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, cause: unknown) {
    super(`${method} ${url}: the API is not reachable (${networkCause(cause)})`, { cause });
    this.name = 'ApiNetworkError';
    this.method = method;
    this.url = url;
  }
}

/** `fetch failed` hides the useful part in `cause` (e.g. ECONNREFUSED 127.0.0.1:3000). */
export function networkCause(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' && !cause.message.includes(code)
      ? `${code}: ${cause.message}`
      : cause.message;
  }
  return error.message;
}

export class CommandTimeoutError extends Error {
  readonly commandId: string;

  constructor(commandId: string, timeoutMs: number) {
    super(`command ${commandId} did not settle within ${timeoutMs} ms`);
    this.name = 'CommandTimeoutError';
    this.commandId = commandId;
  }
}

export class CommandRejectedError extends Error {
  readonly record: CommandResultView;

  constructor(record: CommandResultView, context: string) {
    super(
      `${context}: command ${record.commandId} (${record.type}) was REJECTED (${record.reason ?? 'no reason'})`,
    );
    this.name = 'CommandRejectedError';
    this.record = record;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command body whose `commandId` the client may leave to `sendCommand()`. */
export type CommandInput = DistributiveOmit<CommandBody, 'commandId'> & { commandId?: string };

export interface SettledCommand {
  commandId: string;
  /** The 202 body. */
  accepted: CommandAcceptedView;
  /** The terminal record (APPLIED or REJECTED). */
  record: CommandResultView;
  /** Client-observed settle latency: from the POST start to the poll that saw the terminal state. */
  settleMs: number;
  /** Latency of the 202 itself. */
  acceptMs: number;
  /** Server-side settle latency `settledAt − acceptedAt` (plan §1.3), when both are present. */
  serverSettleMs: number | undefined;
  polls: number;
}

export interface SendCommandOptions {
  /** Give up after this long (default 120 s). */
  timeoutMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token (ID token). Omit for anonymous calls such as GET /health. */
  token?: string;
  fetch?: FetchLike;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Defaults for `sendCommand()` (tests inject a no-op `sleep`). */
  commandOptions?: SendCommandOptions;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Record<string, string>;
  private readonly commandDefaults: SendCommandOptions;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.extraHeaders = options.headers ?? {};
    this.commandDefaults = options.commandOptions ?? {};
  }

  /** The same endpoint with another identity. */
  withToken(token: string): ApiClient {
    return new ApiClient({
      baseUrl: this.baseUrl,
      token,
      fetch: this.fetchImpl,
      headers: this.extraHeaders,
      commandOptions: this.commandDefaults,
    });
  }

  /** Performs a request; non-2xx responses throw `ApiHttpError` with the `{ code, message }` body. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new ApiHttpError(method, path, response.status, payload);
    }
    return payload as T;
  }

  /** Performs a request and returns the raw response (status checks left to the caller). */
  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.extraHeaders };
    if (this.token !== undefined) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const url = `${this.baseUrl}${path}`;
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw new ApiNetworkError(method, url, error);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /* ---------- routes (plan §2.5) ---------- */

  health(): Promise<HealthView> {
    return this.get<HealthView>('/health');
  }

  me(): Promise<MeView> {
    return this.get<MeView>('/me');
  }

  createOrg(name: string): Promise<Organization> {
    return this.post<Organization>('/orgs', { name });
  }

  addMember(orgId: string, member: { userId?: string; email?: string }): Promise<Organization> {
    return this.post<Organization>(`/orgs/${encodeURIComponent(orgId)}/members`, member);
  }

  listWorkshops(orgId: string): Promise<WorkshopListView> {
    return this.get<WorkshopListView>(`/orgs/${encodeURIComponent(orgId)}/workshops`);
  }

  createWorkshop(orgId: string, body: CreateWorkshopInput): Promise<WorkshopPublicView> {
    return this.post<WorkshopPublicView>(`/orgs/${encodeURIComponent(orgId)}/workshops`, body);
  }

  getWorkshop(wsId: string): Promise<WorkshopPublicView> {
    return this.get<WorkshopPublicView>(`/workshops/${encodeURIComponent(wsId)}`);
  }

  dashboard(orgId: string, wsId: string): Promise<DashboardView> {
    return this.get<DashboardView>(
      `/orgs/${encodeURIComponent(orgId)}/workshops/${encodeURIComponent(wsId)}/dashboard`,
    );
  }

  verify(orgId: string, wsId: string): Promise<VerifyView> {
    return this.get<VerifyView>(
      `/orgs/${encodeURIComponent(orgId)}/workshops/${encodeURIComponent(wsId)}/verify`,
    );
  }

  myRegistrations(): Promise<MyRegistrationListView> {
    return this.get<MyRegistrationListView>('/me/registrations');
  }

  myNotifications(): Promise<NotificationListView> {
    return this.get<NotificationListView>('/me/notifications');
  }

  postCommand(wsId: string, body: CommandBody): Promise<CommandAcceptedView> {
    return this.post<CommandAcceptedView>(`/workshops/${encodeURIComponent(wsId)}/commands`, body);
  }

  getCommand(commandId: string): Promise<CommandResultView> {
    return this.get<CommandResultView>(`/commands/${encodeURIComponent(commandId)}`);
  }

  /**
   * POST a command and poll `GET /commands/{id}` with the plan §1.3 backoff until it is
   * APPLIED or REJECTED. The `commandId` is generated here (UUID v4) unless given.
   */
  async sendCommand(
    wsId: string,
    input: CommandInput,
    overrides: SendCommandOptions = {},
  ): Promise<SettledCommand> {
    const options: SendCommandOptions = { ...this.commandDefaults, ...overrides };
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const commandId = input.commandId ?? randomUUID();
    const body = { ...input, commandId } as CommandBody;

    const started = now();
    const accepted = await this.postCommand(wsId, body);
    const acceptMs = now() - started;
    if (isTerminal(accepted.status)) {
      // Idempotent re-POST of an already settled command (C3).
      return {
        commandId,
        accepted,
        record: accepted,
        settleMs: acceptMs,
        acceptMs,
        serverSettleMs: serverLatency(accepted),
        polls: 0,
      };
    }

    let polls = 0;
    let delay = accepted.pollAfterMs > 0 ? accepted.pollAfterMs : pollDelayMs(0, 0);
    for (;;) {
      const elapsed = now() - started;
      if (elapsed >= timeoutMs) {
        throw new CommandTimeoutError(commandId, timeoutMs);
      }
      await sleep(Math.min(delay, Math.max(0, timeoutMs - elapsed)));
      const record = await this.getCommand(commandId);
      polls += 1;
      if (isTerminal(record.status)) {
        return {
          commandId,
          accepted,
          record,
          settleMs: now() - started,
          acceptMs,
          serverSettleMs: serverLatency(record),
          polls,
        };
      }
      delay = pollDelayMs(polls, now() - started);
    }
  }
}

function isTerminal(status: CommandResultView['status']): boolean {
  return status === 'APPLIED' || status === 'REJECTED';
}

function serverLatency(record: CommandResultView): number | undefined {
  if (record.settledAt === undefined) {
    return undefined;
  }
  return Math.max(0, Date.parse(record.settledAt) - Date.parse(record.acceptedAt));
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** Throws `CommandRejectedError` unless the command was APPLIED. */
export function expectApplied(settled: SettledCommand, context: string): SettledCommand {
  if (settled.record.status !== 'APPLIED') {
    throw new CommandRejectedError(settled.record, context);
  }
  return settled;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
