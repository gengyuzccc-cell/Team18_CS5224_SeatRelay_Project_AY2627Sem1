import type {
  NotificationView,
  RegistrationSummary,
  RejectReason,
} from '@seatrelay/contracts';
import { ApiHttpError, CommandTimeoutError, type CommandInput, type SettledCommand } from '@seatrelay/scripts';
import type { Account } from './accounts';
import type { ExperimentContext } from './run';
import {
  invariantSnapshot,
  latencySample,
  myRegistration,
  type CreatedWorkshop,
  type InvariantSnapshot,
  type LatencySample,
} from './scenario';

/**
 * A scripted scenario on one workshop (plan §4 "Core correctness"): every command is sent the
 * way the browser sends it (POST 202 + §1.3 polling), its outcome is asserted, and `verify` plus
 * the client-side counters (over-capacity, double holds) are read after every step. The
 * running totals feed the summary's "0 over-capacity, 0 double holds" line.
 */

export interface InvariantTotals {
  /** `verify` + dashboard reads performed. */
  verifications: number;
  /** Reads where `verify.ok` was false. */
  verifyFailures: number;
  /** Sum over reads of sessions with confirmed + held > capacity. */
  overCapacity: number;
  /** Sum over reads of users with more than one OFFERED/CONFIRMED seat. */
  doubleHolds: number;
  /** Violation codes seen, with counts. */
  violationCodes: Record<string, number>;
}

export function emptyTotals(): InvariantTotals {
  return { verifications: 0, verifyFailures: 0, overCapacity: 0, doubleHolds: 0, violationCodes: {} };
}

export function addInvariants(totals: InvariantTotals, snapshot: InvariantSnapshot): void {
  totals.verifications += 1;
  if (!snapshot.verify.ok) {
    totals.verifyFailures += 1;
  }
  totals.overCapacity += snapshot.overCapacity;
  totals.doubleHolds += snapshot.doubleHolds;
  for (const violation of snapshot.verify.violations) {
    totals.violationCodes[violation.code] = (totals.violationCodes[violation.code] ?? 0) + 1;
  }
}

/** `S1`, `S2`, … by creation order (the label used in every summary). */
export function sessionLabeller(ws: Pick<CreatedWorkshop, 'sessionIds'>): (sessionId: string | undefined) => string {
  return (sessionId) => {
    if (sessionId === undefined) {
      return '-';
    }
    const index = ws.sessionIds.indexOf(sessionId);
    return index === -1 ? `?${sessionId.slice(0, 8)}` : `S${index + 1}`;
  };
}

/** `OFFERED@S1`, `QUEUED#2`, `CONFIRMED@S2`, `ENDED(NO_ACCEPTABLE_SESSION)`, `none`. */
export function describeRegistration(
  registration: RegistrationSummary | undefined,
  label: (sessionId: string | undefined) => string,
): string {
  if (registration === undefined) {
    return 'none';
  }
  switch (registration.status) {
    case 'OFFERED':
      return `OFFERED@${label(registration.currentOffer?.sessionId)}`;
    case 'CONFIRMED':
      return `CONFIRMED@${label(registration.confirmedSessionId)}`;
    case 'QUEUED':
      return `QUEUED#${registration.queuePosition ?? '?'}`;
    default:
      return `${registration.status}${registration.endReason === undefined ? '' : `(${registration.endReason})`}`;
  }
}

/** Notifications of the account that belong to one workshop (newest first, as the API lists them). */
export async function notificationsIn(account: Account, wsId: string): Promise<NotificationView[]> {
  const { notifications } = await account.client.myNotifications();
  return notifications.filter((notification) => notification.workshopId === wsId);
}

export type SendOutcome = { ok: true; settled: SettledCommand } | { ok: false; error: unknown };

/** `sendCommand` that never throws (HTTP errors and settle timeouts become `{ ok: false }`). */
export async function trySend(
  account: Account,
  wsId: string,
  input: CommandInput,
  timeoutMs: number,
): Promise<SendOutcome> {
  try {
    return { ok: true, settled: await account.client.sendCommand(wsId, input, { timeoutMs }) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiHttpError) {
    return `HTTP ${error.status} ${error.code}`;
  }
  if (error instanceof CommandTimeoutError) {
    return `settle timeout (${error.message})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface ExpectedOutcome {
  status: 'APPLIED' | 'REJECTED';
  reason?: RejectReason;
}

export class ScenarioRun {
  readonly label: (sessionId: string | undefined) => string;
  private stepNo = 0;

  constructor(
    readonly ctx: ExperimentContext,
    readonly scenario: string,
    readonly organiser: Account,
    readonly orgId: string,
    readonly ws: CreatedWorkshop,
    readonly totals: InvariantTotals,
    readonly samples: LatencySample[],
  ) {
    this.label = sessionLabeller(ws);
  }

  get wsId(): string {
    return this.ws.wsId;
  }

  /** Session id of `S<n>` (1-based). */
  s(n: number): string {
    const id = this.ws.sessionIds[n - 1];
    if (id === undefined) {
      throw new Error(`${this.scenario}: workshop has no session S${n}`);
    }
    return id;
  }

  private nextStep(title: string): string {
    this.stepNo += 1;
    return `${String(this.stepNo).padStart(2, '0')} ${title}`;
  }

  /**
   * Sends a command as `who` and asserts its terminal status (and reason). Returns the settled
   * command, or undefined when it could not be sent/settled (recorded as a failed check).
   */
  async command(
    title: string,
    who: Account,
    input: CommandInput,
    expected: ExpectedOutcome,
  ): Promise<SettledCommand | undefined> {
    const step = this.nextStep(title);
    const outcome = await trySend(who, this.wsId, input, this.ctx.options.settleTimeoutMs);
    if (!outcome.ok) {
      this.ctx.check({
        scenario: this.scenario,
        step,
        ok: false,
        expected: expectedText(expected),
        actual: errorText(outcome.error),
      });
      return undefined;
    }
    const { settled } = outcome;
    this.samples.push(latencySample(this.ctx.currentRun, `${this.scenario}: ${title}`, settled, { scenario: this.scenario }));
    const ok =
      settled.record.status === expected.status &&
      (expected.reason === undefined || settled.record.reason === expected.reason);
    this.ctx.check({
      scenario: this.scenario,
      step,
      ok,
      expected: expectedText(expected),
      actual: `${settled.record.status}${settled.record.reason === undefined ? '' : `(${settled.record.reason})`} ${describeRegistration(settled.record.result?.registration, this.label)}`,
      ms: settled.settleMs,
    });
    return settled;
  }

  /** Asserts the registration a settled command reports (`result.registration`). */
  expectResult(title: string, settled: SettledCommand | undefined, expected: string): boolean {
    const actual = describeRegistration(settled?.record.result?.registration, this.label);
    return this.ctx.check({ scenario: this.scenario, step: this.nextStep(title), ok: actual === expected, expected, actual });
  }

  /** Asserts the caller's live registration as seen by `GET /workshops/{id}` (`me`). */
  async expectState(title: string, who: Account, expected: string): Promise<RegistrationSummary | undefined> {
    const step = this.nextStep(title);
    try {
      const me = await myRegistration(who, this.wsId);
      const actual = describeRegistration(me, this.label);
      this.ctx.check({ scenario: this.scenario, step, ok: actual === expected, expected, actual });
      return me;
    } catch (error) {
      this.ctx.fail(this.scenario, step, error);
      return undefined;
    }
  }

  /** A free-form assertion. */
  expect(title: string, ok: boolean, expected: string, actual: string): boolean {
    return this.ctx.check({ scenario: this.scenario, step: this.nextStep(title), ok, expected, actual });
  }

  /** `verify` + over-capacity / double-hold counters after a step; one check row. */
  async verify(after: string): Promise<InvariantSnapshot | undefined> {
    const step = this.nextStep(`verify after ${after}`);
    try {
      const snapshot = await invariantSnapshot(this.organiser, this.orgId, this.wsId);
      addInvariants(this.totals, snapshot);
      this.ctx.check({
        scenario: this.scenario,
        step,
        ok: snapshot.ok,
        expected: 'verify ok, overCapacity 0, doubleHolds 0',
        actual: `verify ${snapshot.verify.ok ? 'ok' : 'FAILED'}, overCapacity ${snapshot.overCapacity}, doubleHolds ${snapshot.doubleHolds}${
          snapshot.verify.violations.length === 0
            ? ''
            : ` violations ${snapshot.verify.violations.map((violation) => violation.code).join(',')}`
        }`,
      });
      return snapshot;
    } catch (error) {
      this.totals.verifications += 1;
      this.totals.verifyFailures += 1;
      this.ctx.fail(this.scenario, step, error);
      return undefined;
    }
  }

  /** Sends a command, asserts it, then verifies (the "verify after every step" rule). */
  async step(
    title: string,
    who: Account,
    input: CommandInput,
    expected: ExpectedOutcome,
    expectedRegistration?: string,
  ): Promise<SettledCommand | undefined> {
    const settled = await this.command(title, who, input, expected);
    if (settled !== undefined && expectedRegistration !== undefined) {
      this.expectResult(`${title}: result`, settled, expectedRegistration);
    }
    await this.verify(title);
    return settled;
  }
}

function expectedText(expected: ExpectedOutcome): string {
  return expected.reason === undefined ? expected.status : `${expected.status}(${expected.reason})`;
}

/** The current offer id of a settled REGISTER/DECLINE (empty string when none). */
export function offerIdOf(settled: SettledCommand | undefined): string {
  return settled?.record.result?.registration?.currentOffer?.id ?? '';
}
