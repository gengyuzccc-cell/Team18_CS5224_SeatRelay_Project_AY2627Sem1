#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  type BackfillRecord,
  type CreateWorkshopInput,
  type DashboardView,
  type NotificationKind,
  type NotificationStatus,
} from '@seatrelay/contracts';
import {
  CliError,
  DAY_MS,
  STACKS,
  assertAwsCredentials,
  awsRegion,
  decodeJwtPayload,
  getStackOutputs,
  intOption,
  stringOption,
  type CommandInput,
  type SettledCommand,
} from '@seatrelay/scripts';
import type { Account } from './lib/accounts';
import { getMetricData, metricId, seatRelayQueries, type MetricQuery, type MetricsResult } from './lib/cloudwatch';
import type { DeadLetterReport } from './lib/ops';
import {
  SUMMARY_HEADERS,
  formatNumber,
  markdownTable,
  summarize,
  summaryRow,
  type CsvRow,
} from './lib/results';
import { runExperiment, type ExperimentContext } from './lib/run';
import {
  ensureOrganisation,
  invariantSnapshot,
  seededRandom,
  shuffle,
  sleep,
  type CreatedWorkshop,
} from './lib/scenario';
import { describeRegistration, errorText, sessionLabeller, trySend } from './lib/steps';

/**
 * Staged pilot rehearsal (Prelim §5: "rehearsed events staged to exercise the flow are logged
 * separately"). One workshop on the PILOT stack is driven through the whole live-pilot flow by
 * synthetic accounts, strictly sequentially and at human pace (1–3 s between actions), so the
 * account's small Lambda concurrency quota is never stressed:
 *
 *   register (≈ 40 % S1 only, 30 % S2 only, 30 % both in either order) → answer the offers
 *   (most accept, a few decline, two let the hold expire) → wait for the timer-driven expiry
 *   backfill → organiser raises S2 capacity by one → three confirmed participants cancel
 *   (cancellation-driven backfill) → organiser marks attendance → CSV export → final checks.
 *
 * Invariants (verify + over-capacity + double holds) are read after every phase. Recorded:
 * every command's client- and server-side settle latency, every backfill record (cause,
 * latency), the notification outcome per kind and status (in-app `GET /me/notifications` for
 * every account and, on AWS, the Notification items in DynamoDB with attempts and last error),
 * DLQ depths before/after, CloudWatch alarm states and transitions, Lambda concurrency in the
 * window, and the dashboard's distinct participants served.
 *
 * This is operational evidence about the system only. It is never user evidence: every account
 * is synthetic and every action is scripted.
 */
const USAGE = `
pilot-rehearsal — staged rehearsal of the live-pilot flow on the pilot stack (Prelim §5:
"rehearsed events staged to exercise the flow are logged separately"). Synthetic accounts only;
operational evidence, never user evidence.

  pnpm --filter @seatrelay/experiments pilot-rehearsal -- --target pilot
       [--participants 20] [--capacities 6,6] [--hold 120] [--seed 1]
       [--declines 3] [--expiries 2] [--cancellations 3] [--attendance 5] [--capacity-up 1]
       [--mailbox simulator|example] [--pace-ms 1000-3000] [--expiry-wait 420] [--notify-wait 240]

--participants N     synthetic participants (default 20): 40 % S1 only, 30 % S2 only, 30 % both
                     (half S1 first, half S2 first), assigned in a seeded random order
--capacities A,B     session capacities (default 6,6); the sessions start 2 and 3 days ahead
--declines N         offers declined (default 3; preferably by people who accept both sessions,
                     who then stay queued for the other one)
--expiries N         offers left unanswered until the hold expires (default 2; people with one
                     acceptable session, so their registration ends)
--cancellations N    confirmed participants who cancel afterwards (default 3)
--capacity-up N      seats the organiser adds to S2 (default 1; 0 skips the step)
--attendance N       confirmed participants the organiser marks as attended (default 5)
--mailbox MODE       simulator (default): success+rehearsal-NN@simulator.amazonses.com, the SES
                     mailbox simulator (SES accepts the e-mail, no real inbox; allowed in the SES
                     sandbox). example: rehearsal-NN@example.com (the sandbox rejects these:
                     notifications end FAILED while the in-app status must stay correct, C6).
                     If Cognito refuses the simulator address the script falls back to example
                     and records why.
--pace-ms A-B        random pause between actions (default 1000-3000 ms)
--expiry-wait S      how long after the last unanswered offer's expiry to wait for its backfill
                     (default 420: long enough to see a sweep-caught expiry instead of missing it)
--notify-wait S      how long to wait for every notification to leave PENDING (default 240)
Organiser: rehearsal-organiser@example.com (--organiser). Accounts are created with admin
credentials (e-mail suppressed) and cached in tools/loadtest/.token-cache.<target>.json.
`;

const ORG_NAME = 'Staged rehearsal (synthetic accounts)';
const WORKSHOP_TITLE = 'Staged rehearsal — Intro to AWS (2 sessions)';
const BANNER = 'Staged rehearsal with synthetic accounts — operational evidence only, not user evidence (Prelim §5)';
const DEFAULT_ORGANISER = 'rehearsal-organiser@example.com';
/** Table 3 backfill target (expiry-driven): p95 ≤ 120 s. */
const BACKFILL_TARGET_MS = 120_000;

type Mailbox = 'simulator' | 'example';
type Group = 'S1 only' | 'S2 only' | 'S1>S2' | 'S2>S1';

interface Participant {
  no: number;
  label: string;
  email: string;
  name: string;
  account: Account;
  group: Group;
  /** Session ids in preference order. */
  prefs: string[];
  history: string[];
  silent: boolean;
  declined: boolean;
  cancelled: boolean;
}

interface Actor {
  label: string;
  account: Account;
}

interface ActionRow extends CsvRow {
  n: number;
  phase: string;
  kind: 'command' | 'http' | 'event';
  actor: string;
  action: string;
  type: string;
  commandId: string;
  status: string;
  reason: string;
  offersCreated: number | undefined;
  outcome: string;
  expected: string;
  ok: boolean;
  acceptMs: number | undefined;
  settleMs: number | undefined;
  serverSettleMs: number | undefined;
  polls: number | undefined;
  httpStatus: number | undefined;
  httpMs: number | undefined;
  startedAt: string;
  acceptedAt: string;
  settledAt: string;
  error: string;
}

interface InvariantRow extends CsvRow {
  phase: string;
  at: string;
  verifyOk: boolean;
  overCapacity: number;
  doubleHolds: number;
  violations: string;
  S1: string;
  S2: string;
  queued: number;
  offered: number;
  confirmed: number;
  backfills: number;
  distinctServed: number;
}

interface OfferSeen {
  offerId: string;
  participant: string;
  session: string;
  expiresAt: string;
  phase: string;
  response: 'accept' | 'decline' | 'silent';
}

interface Expectation {
  status: 'APPLIED' | 'REJECTED';
  reason?: string;
  /** Registration of the result, as `describeRegistration` prints it. */
  registration?: string | ((actual: string) => boolean);
  registrationText?: string;
  offersCreated?: number;
}

interface NotificationRow extends CsvRow {
  participant: string;
  kind: string;
  inAppStatus: string;
  storedStatus: string;
  attempts: number | undefined;
  lastError: string;
  createdAt: string;
  offerId: string;
  notificationId: string;
}

interface StoredNotification {
  id: string;
  userId: string;
  kind: NotificationKind;
  status: NotificationStatus;
  attempts: number | undefined;
  lastError: string;
  createdAt: string;
  offerId: string;
}

interface AwsSide {
  available: boolean;
  reason: string;
  tableName?: string;
  doc?: DynamoDBDocumentClient;
  cw?: CloudWatchClient;
}

interface AlarmState {
  name: string;
  state: string;
}

interface AlarmTransition {
  at: string;
  name: string;
  summary: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function emailFor(mailbox: Mailbox, no: number): string {
  return mailbox === 'simulator'
    ? `success+rehearsal-${pad2(no)}@simulator.amazonses.com`
    : `rehearsal-${pad2(no)}@example.com`;
}

function parseRange(text: string, flag: string): [number, number] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (match === null) {
    throw new CliError(`${flag} must be MS or MIN-MAX (got ${text})`);
  }
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  if (high < low) {
    throw new CliError(`${flag}: MAX must be ≥ MIN (got ${text})`);
  }
  return [low, high];
}

function parseCapacities(text: string): [number, number] {
  const parts = text.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new CliError(`--capacities must be two positive integers A,B (got ${text})`);
  }
  return [parts[0] as number, parts[1] as number];
}

/** Minimal RFC 4180 reader for the organiser export (quoted cells, CRLF, BOM). */
export function parseCsv(text: string): Record<string, string>[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') {
        i += 1;
      }
      row.push(cell);
      cell = '';
      if (row.some((value) => value.length > 0)) {
        records.push(row);
      }
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  const [header, ...rest] = records;
  if (header === undefined) {
    return [];
  }
  return rest.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

async function awsSide(ctx: ExperimentContext): Promise<AwsSide> {
  if (ctx.ops.kind !== 'aws') {
    return { available: false, reason: 'local target: no DynamoDB table / CloudWatch alarms to read' };
  }
  const region = awsRegion();
  try {
    const ddb = new DynamoDBClient({ region });
    await assertAwsCredentials(ddb);
    const outputs = await getStackOutputs(STACKS.app(ctx.target.stage));
    const tableName = outputs.TableName;
    if (tableName === undefined) {
      return { available: false, reason: `${STACKS.app(ctx.target.stage)} has no TableName output` };
    }
    return {
      available: true,
      reason: `table ${tableName}, region ${region}`,
      tableName,
      doc: DynamoDBDocumentClient.from(ddb),
      cw: new CloudWatchClient({ region }),
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function alarmStates(cw: CloudWatchClient, prefix: string): Promise<AlarmState[]> {
  const states: AlarmState[] = [];
  let nextToken: string | undefined;
  do {
    const output = await cw.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: prefix,
        AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
        MaxRecords: 100,
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
    );
    for (const alarm of [...(output.MetricAlarms ?? []), ...(output.CompositeAlarms ?? [])]) {
      states.push({ name: alarm.AlarmName ?? '?', state: alarm.StateValue ?? '?' });
    }
    nextToken = output.NextToken;
  } while (nextToken !== undefined);
  return states.sort((a, b) => a.name.localeCompare(b.name));
}

async function alarmTransitions(cw: CloudWatchClient, prefix: string, start: Date, end: Date): Promise<AlarmTransition[]> {
  const transitions: AlarmTransition[] = [];
  let nextToken: string | undefined;
  do {
    const output = await cw.send(
      new DescribeAlarmHistoryCommand({
        HistoryItemType: 'StateUpdate',
        StartDate: start,
        EndDate: end,
        MaxRecords: 100,
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
    );
    for (const item of output.AlarmHistoryItems ?? []) {
      if ((item.AlarmName ?? '').startsWith(prefix)) {
        transitions.push({
          at: item.Timestamp instanceof Date ? item.Timestamp.toISOString() : String(item.Timestamp ?? ''),
          name: item.AlarmName ?? '?',
          summary: item.HistorySummary ?? '',
        });
      }
    }
    nextToken = output.NextToken;
  } while (nextToken !== undefined);
  return transitions.sort((a, b) => a.at.localeCompare(b.at));
}

async function storedNotifications(aws: AwsSide, userId: string, wsId: string): Promise<StoredNotification[]> {
  const items: StoredNotification[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const output = await aws.doc!.send(
      new QueryCommand({
        TableName: aws.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: 'workshopId = :ws',
        ExpressionAttributeValues: { ':pk': `U#${userId}`, ':sk': 'N#', ':ws': wsId },
        ConsistentRead: true,
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    for (const item of output.Items ?? []) {
      items.push({
        id: String(item.id ?? ''),
        userId,
        kind: item.kind as NotificationKind,
        status: item.status as NotificationStatus,
        attempts: typeof item.attempts === 'number' ? item.attempts : undefined,
        lastError: typeof item.lastError === 'string' ? item.lastError : '',
        createdAt: String(item.createdAt ?? ''),
        offerId: typeof item.offerId === 'string' ? item.offerId : '',
      });
    }
    startKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey !== undefined);
  return items;
}

/** Lambda/SQS/SeatRelay metrics of the run window (pilot functions, account concurrency, dev activity). */
function windowQueries(stage: string): MetricQuery[] {
  const queries: MetricQuery[] = seatRelayQueries(
    ['CommandSettledLatency', 'BackfillLatency', 'OffersCreated', 'OffersExpired', 'SweepLateExpiries', 'NotificationFailures'],
    ['Sum', 'SampleCount', 'Maximum'],
    // The deployed functions emit `service` + `stage`; `service` alone is a different, empty series.
    { stage },
  );
  queries.push({
    id: 'lambda_account_concurrent_max',
    namespace: 'AWS/Lambda',
    metricName: 'ConcurrentExecutions',
    stat: 'Maximum',
    label: 'account ConcurrentExecutions (max)',
  });
  for (const fn of ['api', 'worker', 'expiry-forwarder', 'sweep', 'notifier']) {
    const name = `seatrelay-${stage}-${fn}`;
    for (const [metric, stat] of [['Invocations', 'Sum'], ['Errors', 'Sum'], ['Throttles', 'Sum'], ['ConcurrentExecutions', 'Maximum']] as const) {
      queries.push({
        id: metricId('fn', fn, metric, stat),
        namespace: 'AWS/Lambda',
        metricName: metric,
        dimensions: { FunctionName: name },
        stat,
        label: `${name} ${metric} (${stat})`,
      });
    }
  }
  for (const other of ['dev', 'pilot'].filter((s) => s !== stage)) {
    for (const fn of ['api', 'worker']) {
      queries.push({
        id: metricId('other', other, fn, 'invocations'),
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensions: { FunctionName: `seatrelay-${other}-${fn}` },
        stat: 'Sum',
        label: `seatrelay-${other}-${fn} Invocations (Sum)`,
      });
    }
  }
  return queries;
}

function seriesTotal(result: MetricsResult, id: string): number | undefined {
  if (!result.available) {
    return undefined;
  }
  const series = result.series.find((candidate) => candidate.id === id);
  return series === undefined || series.empty ? 0 : series.total;
}

function seriesMax(result: MetricsResult, id: string): number | undefined {
  if (!result.available) {
    return undefined;
  }
  const series = result.series.find((candidate) => candidate.id === id);
  return series === undefined || series.empty ? 0 : series.max;
}

class Rehearsal {
  readonly rows: ActionRow[] = [];
  readonly invariants: InvariantRow[] = [];
  readonly phases: { phase: string; startedAt: string; finishedAt: string; actions: number; error: string }[] = [];
  readonly offers = new Map<string, OfferSeen>();
  readonly byUser = new Map<string, Participant>();
  readonly label: (sessionId: string | undefined) => string;
  readonly budget: { silent: number; decline: number };
  readonly used = { silent: 0, decline: 0 };
  /** Offers answered in the "respond" phase, in order (drives the decline/silent schedule). */
  private respondIndex = 0;
  private n = 0;
  lastActionAt = Date.now();

  constructor(
    readonly ctx: ExperimentContext,
    readonly organiser: Actor,
    readonly orgId: string,
    readonly ws: CreatedWorkshop,
    readonly participants: Participant[],
    readonly random: () => number,
    readonly paceMs: [number, number],
    budget: { silent: number; decline: number },
  ) {
    this.label = sessionLabeller(ws);
    this.budget = budget;
    for (const participant of participants) {
      this.byUser.set(participant.account.userId, participant);
    }
  }

  get wsId(): string {
    return this.ws.wsId;
  }

  async pace(): Promise<void> {
    const [low, high] = this.paceMs;
    await sleep(low + Math.floor(this.random() * (high - low + 1)));
  }

  dashboard(): Promise<DashboardView> {
    return this.organiser.account.client.dashboard(this.orgId, this.wsId);
  }

  private nextN(): number {
    this.n += 1;
    return this.n;
  }

  /** One recorded action row without latency (an unanswered offer, a wait). */
  event(phase: string, actor: string, action: string, outcome: string): void {
    this.rows.push(this.baseRow(phase, 'event', actor, action, { outcome, ok: true }));
  }

  private baseRow(phase: string, kind: ActionRow['kind'], actor: string, action: string, extra: Partial<ActionRow>): ActionRow {
    return {
      n: this.nextN(),
      phase,
      kind,
      actor,
      action,
      type: '',
      commandId: '',
      status: '',
      reason: '',
      offersCreated: undefined,
      outcome: '',
      expected: '',
      ok: true,
      acceptMs: undefined,
      settleMs: undefined,
      serverSettleMs: undefined,
      polls: undefined,
      httpStatus: undefined,
      httpMs: undefined,
      startedAt: new Date().toISOString(),
      acceptedAt: '',
      settledAt: '',
      error: '',
      ...extra,
    };
  }

  /** Sends a command as the browser does (POST 202 + polling), records latency and asserts the outcome. */
  async command(phase: string, actor: Actor, action: string, input: CommandInput, expect: Expectation): Promise<SettledCommand | undefined> {
    const row = this.baseRow(phase, 'command', actor.label, action, { type: input.type });
    const expectedText = [
      expect.status + (expect.reason === undefined ? '' : `(${expect.reason})`),
      expect.registrationText ?? (typeof expect.registration === 'string' ? expect.registration : undefined),
      expect.offersCreated === undefined ? undefined : `offersCreated=${expect.offersCreated}`,
    ]
      .filter((part) => part !== undefined)
      .join(' ');
    row.expected = expectedText;
    const step = `${String(row.n).padStart(3, '0')} ${actor.label} ${action}`;
    const outcome = await trySend(actor.account, this.wsId, input, this.ctx.options.settleTimeoutMs);
    this.lastActionAt = Date.now();
    if (!outcome.ok) {
      row.ok = false;
      row.error = errorText(outcome.error);
      this.rows.push(row);
      this.ctx.check({ scenario: phase, step, ok: false, expected: expectedText, actual: row.error });
      return undefined;
    }
    const { settled } = outcome;
    const { record } = settled;
    const registration = describeRegistration(record.result?.registration, this.label);
    const registrationOk =
      expect.registration === undefined ||
      (typeof expect.registration === 'string' ? registration === expect.registration : expect.registration(registration));
    const ok =
      record.status === expect.status &&
      (expect.reason === undefined || record.reason === expect.reason) &&
      registrationOk &&
      (expect.offersCreated === undefined || record.result?.offersCreated === expect.offersCreated);
    Object.assign(row, {
      commandId: settled.commandId,
      status: record.status,
      reason: record.reason ?? '',
      offersCreated: record.result?.offersCreated,
      outcome: record.result?.registration === undefined ? '' : registration,
      ok,
      acceptMs: settled.acceptMs,
      settleMs: settled.settleMs,
      serverSettleMs: settled.serverSettleMs,
      polls: settled.polls,
      acceptedAt: record.acceptedAt,
      settledAt: record.settledAt ?? '',
    });
    this.rows.push(row);
    this.ctx.check({
      scenario: phase,
      step,
      ok,
      expected: expectedText,
      actual: `${record.status}${record.reason === undefined ? '' : `(${record.reason})`}${record.result?.registration === undefined ? '' : ` ${registration}`} offersCreated=${record.result?.offersCreated ?? '-'}`,
      ms: settled.settleMs,
    });
    return settled;
  }

  /** An organiser HTTP call that is not a command (attendance, export), timed. */
  async http(phase: string, action: string, method: string, route: string, body?: unknown): Promise<{ status: number; text: string; contentType: string; ms: number } | undefined> {
    const row = this.baseRow(phase, 'http', this.organiser.label, action, { type: `${method} ${route.replace(/\/[0-9a-f-]{20,}/g, '/:id')}` });
    const started = Date.now();
    try {
      const response = await this.organiser.account.client.raw(method, route, body);
      const text = await response.text();
      const ms = Date.now() - started;
      this.lastActionAt = Date.now();
      Object.assign(row, { httpStatus: response.status, httpMs: ms, ok: response.ok, status: String(response.status) });
      this.rows.push(row);
      return { status: response.status, text, contentType: response.headers.get('content-type') ?? '', ms };
    } catch (error) {
      Object.assign(row, { ok: false, error: errorText(error), httpMs: Date.now() - started });
      this.rows.push(row);
      return undefined;
    }
  }

  /** verify + client-side counters after a phase: one check row and one invariants.csv row. */
  async verifyPhase(phase: string): Promise<boolean> {
    try {
      const snapshot = await invariantSnapshot(this.organiser.account, this.orgId, this.wsId);
      const { dashboard } = snapshot;
      const cell = (index: number): string => {
        const session = dashboard.sessions.find((candidate) => candidate.id === this.ws.sessionIds[index]);
        return session === undefined ? '-' : `${session.confirmed}+${session.held}/${session.capacity} q${session.queueLength}`;
      };
      const violations = snapshot.verify.violations.map((violation) => violation.code).join(' ');
      this.invariants.push({
        phase,
        at: new Date().toISOString(),
        verifyOk: snapshot.verify.ok,
        overCapacity: snapshot.overCapacity,
        doubleHolds: snapshot.doubleHolds,
        violations,
        S1: cell(0),
        S2: cell(1),
        queued: dashboard.counts.queued,
        offered: dashboard.counts.offered,
        confirmed: dashboard.counts.confirmed,
        backfills: dashboard.counts.backfills,
        distinctServed: dashboard.distinctParticipantsServed,
      });
      this.ctx.check({
        scenario: phase,
        step: 'invariants after the phase (verify, over-capacity, double holds)',
        ok: snapshot.ok,
        expected: 'verify ok, overCapacity 0, doubleHolds 0',
        actual: `verify ${snapshot.verify.ok ? 'ok' : 'FAILED'}, overCapacity ${snapshot.overCapacity}, doubleHolds ${snapshot.doubleHolds}${violations.length === 0 ? '' : `, violations ${violations}`}`,
      });
      return snapshot.ok;
    } catch (error) {
      this.ctx.fail(phase, 'invariants after the phase', error);
      return false;
    }
  }

  /** What the participant does with a newly seen offer in the first response round. */
  private respondPolicy(participant: Participant): OfferSeen['response'] {
    const index = this.respondIndex;
    this.respondIndex += 1;
    // Behaviour slots: the 2nd, 5th, 8th … offer answered is meant to be left unanswered, the
    // 3rd, 6th, 9th … declined; a slot whose participant does not fit carries over to the next.
    const due = (offset: number, budget: number): number =>
      Math.min(budget, Array.from({ length: budget }, (_, k) => 3 * k + offset).filter((slot) => slot <= index).length);
    const silentDue = due(1, this.budget.silent) - this.used.silent;
    const declineDue = due(2, this.budget.decline) - this.used.decline;
    if (silentDue > 0 && participant.prefs.length === 1 && !participant.silent && !participant.declined) {
      return 'silent';
    }
    if (declineDue > 0 && participant.prefs.length >= 2 && !participant.declined && !participant.silent) {
      return 'decline';
    }
    return 'accept';
  }

  /**
   * Answers every offer not seen before (oldest first), re-reading the dashboard after each
   * action, until only unanswered (silent) offers remain. `scripted` = the first response
   * round (declines and unanswered holds happen here); later rounds accept everything.
   */
  async respond(phase: string, scripted: boolean): Promise<void> {
    for (let guard = 0; guard < 200; guard += 1) {
      const dash = await this.dashboard();
      const fresh = dash.offered
        .filter((entry) => !this.offers.has(entry.offer.id))
        .sort((a, b) => a.offer.expiresAt.localeCompare(b.offer.expiresAt) || a.seq - b.seq);
      const entry = fresh[0];
      if (entry === undefined) {
        return;
      }
      const participant = this.byUser.get(entry.userId);
      const session = this.label(entry.offer.sessionId);
      if (participant === undefined) {
        // Not one of ours: never touch it, but record it.
        this.offers.set(entry.offer.id, {
          offerId: entry.offer.id,
          participant: `?${entry.userId.slice(0, 8)}`,
          session,
          expiresAt: entry.offer.expiresAt,
          phase,
          response: 'silent',
        });
        this.ctx.check({ scenario: phase, step: `offer ${entry.offer.id.slice(0, 8)} belongs to a rehearsal account`, ok: false, actual: entry.userId });
        continue;
      }
      const response = scripted ? this.respondPolicy(participant) : 'accept';
      this.offers.set(entry.offer.id, {
        offerId: entry.offer.id,
        participant: participant.label,
        session,
        expiresAt: entry.offer.expiresAt,
        phase,
        response,
      });
      if (response === 'silent') {
        this.used.silent += 1;
        participant.silent = true;
        participant.history.push(`left ${session} unanswered`);
        this.event(phase, participant.label, `does not answer the offer for ${session}`, `offer expires ${entry.offer.expiresAt}`);
        continue;
      }
      await this.pace();
      if (response === 'decline') {
        this.used.decline += 1;
        participant.declined = true;
        participant.history.push(`declined ${session}`);
        const remaining = participant.prefs.filter((id) => id !== entry.offer.sessionId).map((id) => this.label(id));
        await this.command(
          phase,
          participant,
          `DECLINE_OFFER ${session}`,
          { type: 'DECLINE_OFFER', offerId: entry.offer.id },
          {
            status: 'APPLIED',
            registration: (actual) =>
              remaining.length === 0
                ? actual === 'ENDED(NO_ACCEPTABLE_SESSION)'
                : /^QUEUED#\d+$/.test(actual) || remaining.some((label) => actual === `OFFERED@${label}`),
            registrationText: remaining.length === 0 ? 'ENDED(NO_ACCEPTABLE_SESSION)' : `QUEUED or OFFERED@${remaining.join('/')}`,
          },
        );
      } else {
        participant.history.push(`accepted ${session}`);
        await this.command(
          phase,
          participant,
          `ACCEPT_OFFER ${session}`,
          { type: 'ACCEPT_OFFER', offerId: entry.offer.id },
          { status: 'APPLIED', registration: `CONFIRMED@${session}` },
        );
      }
    }
    this.ctx.check({ scenario: phase, step: 'offer loop terminated', ok: false, detail: 'more than 200 offers answered in one phase' });
  }
}

interface RunState {
  rehearsal?: Rehearsal;
  mailbox: Mailbox;
  mailboxFallback?: string;
  cognitoAccepted?: boolean;
  aws?: AwsSide;
  deadBefore?: DeadLetterReport;
  deadAfter?: DeadLetterReport;
  alarmsBefore?: AlarmState[];
  alarmsAfter?: AlarmState[];
  transitions?: AlarmTransition[];
  metrics?: MetricsResult;
  expiryWaitS?: number;
  exportRows?: Record<string, string>[];
  notifications: NotificationRow[];
  finalDash?: DashboardView;
  finalOk?: boolean;
  inAppStates: { participant: string; expected: string; actual: string; ok: boolean }[];
}

async function setupParticipants(ctx: ExperimentContext, count: number, mailbox: Mailbox, state: RunState): Promise<{ email: string; name: string; account: Account }[]> {
  const nameFor = (no: number): string => `Rehearsal participant ${pad2(no)} (synthetic)`;
  const accounts: { email: string; name: string; account: Account }[] = [];
  let mode = mailbox;
  try {
    const email = emailFor(mode, 1);
    accounts.push({ email, name: nameFor(1), account: await ctx.accounts.get(email, nameFor(1)) });
  } catch (error) {
    if (mode !== 'simulator') {
      throw error;
    }
    state.mailboxFallback = `Cognito did not accept ${emailFor('simulator', 1)}: ${errorText(error)}`;
    ctx.log(`falling back to example.com participants: ${state.mailboxFallback}`);
    mode = 'example';
    const email = emailFor(mode, 1);
    accounts.push({ email, name: nameFor(1), account: await ctx.accounts.get(email, nameFor(1)) });
  }
  for (let no = 2; no <= count; no += 1) {
    const email = emailFor(mode, no);
    accounts.push({ email, name: nameFor(no), account: await ctx.accounts.get(email, nameFor(no)) });
  }
  state.mailbox = mode;
  // meta.json `accounts` is written from the pool's naming: record the addresses actually used.
  ctx.accounts.naming.prefix = mode === 'simulator' ? 'success+rehearsal' : 'rehearsal';
  ctx.accounts.naming.domain = mode === 'simulator' ? 'simulator.amazonses.com' : 'example.com';
  return accounts;
}

function participantGroups(count: number, random: () => number): Group[] {
  const s1 = Math.round(count * 0.4);
  const s2 = Math.round(count * 0.3);
  const both = Math.max(0, count - s1 - s2);
  const s1First = Math.ceil(both / 2);
  const groups: Group[] = [
    ...Array<Group>(s1).fill('S1 only'),
    ...Array<Group>(s2).fill('S2 only'),
    ...Array<Group>(s1First).fill('S1>S2'),
    ...Array<Group>(both - s1First).fill('S2>S1'),
  ];
  return shuffle(groups, random);
}

function prefsOf(group: Group, s1: string, s2: string): string[] {
  switch (group) {
    case 'S1 only':
      return [s1];
    case 'S2 only':
      return [s2];
    case 'S1>S2':
      return [s1, s2];
    default:
      return [s2, s1];
  }
}

async function phase(rehearsal: Rehearsal, name: string, body: () => Promise<void>): Promise<void> {
  const startedAt = new Date().toISOString();
  const before = rehearsal.rows.length;
  rehearsal.ctx.log(`=== phase ${name}`);
  let error = '';
  try {
    await body();
  } catch (caught) {
    error = errorText(caught);
    rehearsal.ctx.fail(name, 'phase aborted', caught);
  }
  rehearsal.phases.push({ phase: name, startedAt, finishedAt: new Date().toISOString(), actions: rehearsal.rows.length - before, error });
  await rehearsal.verifyPhase(name);
}

runExperiment({
  name: 'pilot-rehearsal',
  tableRow: 'Staged pilot rehearsal on the pilot stack (Prelim §5, logged separately from the live pilot)',
  criterion:
    'every scripted command settles with the expected outcome; verify ok, 0 over-capacity and 0 double holds after every phase; every released seat (decline, timer-driven expiry, capacity increase, cancellation) relayed while someone acceptable was queued; every notification leaves PENDING (SES simulator: SENT) and the in-app status matches the registration (C6); DLQs unchanged; no alarm entered ALARM',
  banner: BANNER,
  usage: USAGE,
  defaultHoldSeconds: 120,
  options: {
    participants: { type: 'string' },
    capacities: { type: 'string' },
    seed: { type: 'string' },
    declines: { type: 'string' },
    expiries: { type: 'string' },
    cancellations: { type: 'string' },
    'capacity-up': { type: 'string' },
    attendance: { type: 'string' },
    mailbox: { type: 'string' },
    'pace-ms': { type: 'string' },
    'expiry-wait': { type: 'string' },
    'notify-wait': { type: 'string' },
  },
  async run(ctx) {
    const count = intOption(ctx.values, 'participants', 20);
    const capacities = parseCapacities(stringOption(ctx.values, 'capacities', '6,6') as string);
    const seed = intOption(ctx.values, 'seed', 1);
    const declines = intOption(ctx.values, 'declines', 3);
    const expiries = intOption(ctx.values, 'expiries', 2);
    const cancellations = intOption(ctx.values, 'cancellations', 3);
    const capacityUp = intOption(ctx.values, 'capacity-up', 1);
    const attendanceCount = intOption(ctx.values, 'attendance', 5);
    const mailboxFlag = stringOption(ctx.values, 'mailbox', 'simulator') as string;
    if (mailboxFlag !== 'simulator' && mailboxFlag !== 'example') {
      throw new CliError(`--mailbox must be simulator|example (got ${mailboxFlag})`);
    }
    const paceMs = parseRange(stringOption(ctx.values, 'pace-ms', '1000-3000') as string, '--pace-ms');
    const expiryWaitS = intOption(ctx.values, 'expiry-wait', 420);
    const notifyWaitS = intOption(ctx.values, 'notify-wait', 240);
    const organiserEmail = stringOption(ctx.values, 'organiser', DEFAULT_ORGANISER) as string;
    if (count < 4) {
      throw new CliError('--participants must be at least 4');
    }
    for (const [key, value] of Object.entries({ participants: count, capacities, seed, declines, expiries, cancellations, capacityUp, attendance: attendanceCount, mailbox: mailboxFlag, paceMs, expiryWaitS, notifyWaitS, organiser: organiserEmail, holdSeconds: ctx.options.holdSeconds })) {
      ctx.param(key, value);
    }
    if (ctx.target.name !== 'pilot') {
      ctx.log(`note: target ${ctx.target.name}; the rehearsal is meant for the pilot stack (--target pilot)`);
    }
    const random = seededRandom(seed);
    const state: RunState = { mailbox: mailboxFlag, notifications: [], inAppStates: [] };

    // ---------- setup: accounts, organisation, workshop, baselines
    ctx.accounts.naming.organiserEmail = organiserEmail;
    const organiserAccount = await ctx.accounts.get(organiserEmail, 'Rehearsal organiser (synthetic)');
    const organiser: Actor = { label: 'organiser', account: organiserAccount };
    const accounts = await setupParticipants(ctx, count, mailboxFlag, state);
    ctx.param('mailboxUsed', state.mailbox);
    // Cognito accepted the address as username and the API sees it as the account's e-mail.
    const first = accounts[0];
    if (first !== undefined) {
      const claims = decodeJwtPayload(await first.account.token());
      const me = await first.account.client.me();
      state.cognitoAccepted = String(claims.email).toLowerCase() === first.email.toLowerCase() && me.email.toLowerCase() === first.email.toLowerCase();
      ctx.check({
        scenario: 'setup',
        step: `${state.mailbox === 'simulator' ? 'SES mailbox-simulator' : 'example.com'} address accepted as Cognito username and seen by the API`,
        ok: state.cognitoAccepted,
        expected: first.email,
        actual: `token email ${String(claims.email)}, GET /me email ${me.email}`,
      });
    }
    if (state.mailboxFallback !== undefined) {
      ctx.check({ scenario: 'setup', step: 'participants use the SES mailbox simulator', ok: false, expected: 'simulator addresses', actual: state.mailboxFallback });
    }

    const aws = await awsSide(ctx);
    state.aws = aws;
    const alarmPrefix = `seatrelay-${ctx.target.stage}-`;
    state.deadBefore = await ctx.ops.deadLetters();
    if (aws.available && aws.cw !== undefined) {
      try {
        state.alarmsBefore = await alarmStates(aws.cw, alarmPrefix);
      } catch (error) {
        ctx.skip('setup', 'alarm states before', errorText(error));
      }
    } else {
      ctx.skip('setup', 'alarm states, Notification items, CloudWatch metrics', aws.reason);
    }
    if (!state.deadBefore.available) {
      ctx.skip('setup', 'DLQ depths', state.deadBefore.detail);
    }

    const org = await ensureOrganisation(organiserAccount, ORG_NAME);
    ctx.param('orgId', org.id);
    const now = Date.now();
    const input: CreateWorkshopInput = {
      title: WORKSHOP_TITLE,
      description:
        'Staged rehearsal with synthetic accounts (Prelim §5): rehearsed events staged to exercise the flow, logged separately. Not a real event and not user evidence.',
      mode: 'UNIFIED',
      holdSeconds: ctx.options.holdSeconds,
      sessions: [
        { title: 'Intro to AWS — session 1 (staged)', startsAt: new Date(now + 2 * DAY_MS).toISOString(), capacity: capacities[0] },
        { title: 'Intro to AWS — session 2 (staged)', startsAt: new Date(now + 3 * DAY_MS).toISOString(), capacity: capacities[1] },
      ],
    };
    const view = await organiserAccount.client.createWorkshop(org.id, input);
    const sessions = [...view.sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const ws: CreatedWorkshop = {
      orgId: org.id,
      wsId: view.workshop.id,
      sessions,
      sessionIds: sessions.map((session) => session.id),
      holdSeconds: view.workshop.holdSeconds,
      view,
    };
    const [s1, s2] = ws.sessionIds;
    if (s1 === undefined || s2 === undefined) {
      throw new Error('workshop has fewer than two sessions');
    }
    ctx.param('workshopId', ws.wsId);
    ctx.param('sessions', sessions.map((session, index) => ({ label: `S${index + 1}`, id: session.id, title: session.title, startsAt: session.startsAt, cutoffAt: session.cutoffAt, capacity: session.capacity })));
    ctx.check({
      scenario: 'setup',
      step: 'workshop created (UNIFIED, 2 sessions)',
      ok: view.workshop.mode === 'UNIFIED' && view.workshop.holdSeconds === ctx.options.holdSeconds && sessions.length === 2,
      expected: `UNIFIED, hold ${ctx.options.holdSeconds}, capacities ${capacities.join('/')}`,
      actual: `${view.workshop.mode}, hold ${view.workshop.holdSeconds}, capacities ${sessions.map((session) => session.capacity).join('/')}`,
      detail: `workshop ${ws.wsId}`,
    });

    const groups = participantGroups(count, random);
    const participants: Participant[] = accounts.map((entry, index) => {
      const group = groups[index] as Group;
      return {
        no: index + 1,
        label: `P${pad2(index + 1)}`,
        email: entry.email,
        name: entry.name,
        account: entry.account,
        group,
        prefs: prefsOf(group, s1, s2),
        history: [],
        silent: false,
        declined: false,
        cancelled: false,
      };
    });
    const rehearsal = new Rehearsal(ctx, organiser, org.id, ws, participants, random, paceMs, { silent: expiries, decline: declines });
    state.rehearsal = rehearsal;
    const label = rehearsal.label;

    // ---------- 1. registration: arrival order P01 … PNN, each with their preference list
    await phase(rehearsal, '1 register', async () => {
      const free = [capacities[0], capacities[1]];
      let queued = 0;
      for (const participant of participants) {
        await rehearsal.pace();
        const target = participant.prefs.findIndex((id) => (free[ws.sessionIds.indexOf(id)] ?? 0) > 0);
        let expected: string;
        if (target === -1) {
          queued += 1;
          expected = `QUEUED#${queued}`;
        } else {
          const index = ws.sessionIds.indexOf(participant.prefs[target] as string);
          free[index] = (free[index] ?? 0) - 1;
          expected = `OFFERED@S${index + 1}`;
        }
        participant.history.push(`registered ${participant.prefs.map((id) => label(id)).join('>')}`);
        await rehearsal.command('1 register', participant, `REGISTER ${participant.prefs.map((id) => label(id)).join('>')}`, { type: 'REGISTER', acceptable: participant.prefs }, { status: 'APPLIED', registration: expected });
      }
    });

    // ---------- 2. first responses: most accept, a few decline, some leave the offer unanswered
    await phase(rehearsal, '2 respond', async () => {
      await rehearsal.respond('2 respond', true);
      ctx.check({
        scenario: '2 respond',
        step: 'scripted behaviour reached (declines, unanswered holds)',
        ok: rehearsal.used.decline === declines && rehearsal.used.silent === expiries,
        expected: `${declines} declines, ${expiries} unanswered`,
        actual: `${rehearsal.used.decline} declines, ${rehearsal.used.silent} unanswered`,
      });
    });

    // ---------- 3. holds expire: the timer path relays the seats; the next people accept
    await phase(rehearsal, '3 expiry', async () => {
      const silent = [...rehearsal.offers.values()].filter((offer) => offer.response === 'silent');
      if (silent.length === 0) {
        ctx.skip('3 expiry', 'timer-driven backfill', 'no offer was left unanswered');
        return;
      }
      const lastExpiry = Math.max(...silent.map((offer) => Date.parse(offer.expiresAt)));
      const deadline = lastExpiry + expiryWaitS * 1000;
      const waitStarted = Date.now();
      ctx.log(`waiting for ${silent.length} unanswered offer(s) to expire (last at ${new Date(lastExpiry).toISOString()}) and be relayed`);
      const relayed = (dash: DashboardView): boolean =>
        silent.every((offer) => {
          const record = dash.backfills.find((candidate) => candidate.cause === 'EXPIRED' && candidate.releasedAt === offer.expiresAt && label(candidate.sessionId) === offer.session);
          if (record === undefined) {
            return false;
          }
          if (record.reallocatedAt !== undefined) {
            return true;
          }
          // Released with nobody acceptable queued: nothing to relay (verify's NO_STARVATION covers it).
          return !dash.queue.some((entry) => entry.acceptable.some((id) => label(id) === offer.session));
        });
      let dash = await rehearsal.dashboard();
      while (!relayed(dash) && Date.now() < deadline) {
        await sleep(5000);
        dash = await rehearsal.dashboard();
      }
      state.expiryWaitS = Math.round((Date.now() - waitStarted) / 1000);
      const records = dash.backfills.filter((record) => record.cause === 'EXPIRED');
      ctx.check({
        scenario: '3 expiry',
        step: 'every unanswered offer expired and its seat was relayed',
        ok: relayed(dash),
        expected: `${silent.length} EXPIRED backfill records, reallocated`,
        actual: records.map((record) => `${label(record.sessionId)} ${record.reallocatedAt === undefined ? 'pending' : `${record.latencyMs} ms`}`).join(', ') || 'none',
        detail: `waited ${state.expiryWaitS} s`,
      });
      rehearsal.event('3 expiry', 'system', `${silent.length} hold(s) expired; timer-driven backfill observed`, records.map((record) => `${label(record.sessionId)} latencyMs ${record.latencyMs ?? 'pending'}`).join('; '));
      for (const offer of silent) {
        const participant = participants.find((candidate) => candidate.label === offer.participant);
        if (participant === undefined) {
          continue;
        }
        const mine = await participant.account.client.myRegistrations();
        const entry = mine.registrations.find((candidate) => candidate.workshop.id === ws.wsId);
        const actual = describeRegistration(entry?.registration, label);
        ctx.expectEqual('3 expiry', `${participant.label} sees the expiry in "my registrations"`, 'ENDED(NO_ACCEPTABLE_SESSION)', actual);
      }
      await rehearsal.respond('3 expiry', false);
    });

    // ---------- 4. capacity: the organiser adds a seat to S2
    if (capacityUp > 0) {
      await phase(rehearsal, '4 capacity', async () => {
        const dash = await rehearsal.dashboard();
        const session = dash.sessions.find((candidate) => candidate.id === s2);
        const capacity = session?.capacity ?? capacities[1];
        const waiting = dash.queue.filter((entry) => entry.acceptable.includes(s2)).length;
        await rehearsal.pace();
        await rehearsal.command(
          '4 capacity',
          organiser,
          `SET_CAPACITY S2 ${capacity}→${capacity + capacityUp}`,
          { type: 'SET_CAPACITY', sessionId: s2, capacity: capacity + capacityUp },
          { status: 'APPLIED', offersCreated: Math.min(waiting, capacityUp) },
        );
        await rehearsal.respond('4 capacity', false);
      });
    }

    // ---------- 5. cancellations after confirming: cancellation-driven backfill
    await phase(rehearsal, '5 cancel', async () => {
      for (let i = 0; i < cancellations; i += 1) {
        const dash = await rehearsal.dashboard();
        const confirmed = dash.confirmed
          .map((entry) => ({ entry, participant: rehearsal.byUser.get(entry.userId) }))
          .filter((item): item is { entry: (typeof dash.confirmed)[number]; participant: Participant } => item.participant !== undefined && !item.participant.cancelled);
        const relaying = confirmed.filter((item) => dash.queue.some((queued) => queued.acceptable.includes(item.entry.sessionId)));
        const pool = relaying.length > 0 ? relaying : confirmed;
        const chosen = pool[Math.floor(random() * pool.length)];
        if (chosen === undefined) {
          ctx.check({ scenario: '5 cancel', step: `cancellation ${i + 1}`, ok: false, detail: 'no confirmed participant left to cancel' });
          return;
        }
        const session = label(chosen.entry.sessionId);
        chosen.participant.cancelled = true;
        chosen.participant.history.push(`cancelled confirmed ${session}`);
        await rehearsal.pace();
        await rehearsal.command(
          '5 cancel',
          chosen.participant,
          `CANCEL_REGISTRATION (confirmed ${session})`,
          { type: 'CANCEL_REGISTRATION' },
          { status: 'APPLIED', registration: 'CANCELLED', offersCreated: relaying.includes(chosen) ? 1 : 0 },
        );
        await rehearsal.respond('5 cancel', false);
      }
    });

    // ---------- 6. attendance: the organiser marks confirmed participants as attended
    await phase(rehearsal, '6 attendance', async () => {
      const dash = await rehearsal.dashboard();
      const chosen = shuffle(dash.confirmed, random).slice(0, attendanceCount);
      for (const entry of chosen) {
        const participant = rehearsal.byUser.get(entry.userId);
        await rehearsal.pace();
        const response = await rehearsal.http(
          '6 attendance',
          `mark ${participant?.label ?? entry.userId} attended (confirmed ${label(entry.sessionId)})`,
          'PUT',
          `/orgs/${encodeURIComponent(org.id)}/workshops/${encodeURIComponent(ws.wsId)}/attendance/${encodeURIComponent(entry.userId)}`,
          { attended: true },
        );
        participant?.history.push('marked attended');
        let attended: unknown;
        try {
          attended = (JSON.parse(response?.text || '{}') as { attended?: unknown }).attended;
        } catch {
          attended = undefined;
        }
        ctx.check({
          scenario: '6 attendance',
          step: `PUT attendance ${participant?.label ?? entry.userId}`,
          ok: response?.status === 200 && attended === true,
          expected: '200 attended=true',
          actual: response === undefined ? 'request failed' : `${response.status} ${response.text.slice(0, 80)}`,
          ...(response === undefined ? {} : { ms: response.ms }),
        });
      }
      const after = await rehearsal.dashboard();
      ctx.expectEqual('6 attendance', 'dashboard counts.attended', Math.min(attendanceCount, dash.confirmed.length), after.counts.attended);
    });

    // ---------- 7. CSV export
    await phase(rehearsal, '7 export', async () => {
      await rehearsal.pace();
      const response = await rehearsal.http('7 export', 'export registrations CSV', 'GET', `/orgs/${encodeURIComponent(org.id)}/workshops/${encodeURIComponent(ws.wsId)}/export.csv`);
      if (response === undefined || response.status !== 200) {
        ctx.check({ scenario: '7 export', step: 'GET export.csv', ok: false, expected: '200 text/csv', actual: response === undefined ? 'request failed' : String(response.status) });
        return;
      }
      fs.writeFileSync(path.join(ctx.dir, 'export.csv'), response.text);
      const rows = parseCsv(response.text);
      state.exportRows = rows;
      const dash = await rehearsal.dashboard();
      const confirmedRows = rows.filter((row) => row.status === 'CONFIRMED').length;
      const attendedRows = rows.filter((row) => row.attended === 'yes').length;
      const ours = rows.filter((row) => participants.some((participant) => participant.email.toLowerCase() === (row.email ?? '').toLowerCase())).length;
      ctx.check({ scenario: '7 export', step: 'GET export.csv', ok: response.contentType.includes('text/csv'), expected: 'text/csv', actual: response.contentType, ms: response.ms });
      ctx.expectEqual('7 export', 'one row per registration (every participant registered once)', count, rows.length);
      ctx.expectEqual('7 export', 'every row is a rehearsal account', rows.length, ours);
      ctx.expectEqual('7 export', 'CONFIRMED rows = dashboard confirmed', dash.counts.confirmed, confirmedRows);
      ctx.expectEqual('7 export', 'attended rows = dashboard attended', dash.counts.attended, attendedRows);
    });

    // ---------- 8. final state, notifications, operations
    await phase(rehearsal, '8 final', async () => {
      const dash = await rehearsal.dashboard();
      state.finalDash = dash;
      // In-app status of every participant ("my registrations") = the organiser's view (C6).
      for (const participant of participants) {
        const confirmed = dash.confirmed.find((entry) => entry.userId === participant.account.userId);
        const offered = dash.offered.find((entry) => entry.userId === participant.account.userId);
        const queued = dash.queue.find((entry) => entry.userId === participant.account.userId);
        const expected = confirmed !== undefined
          ? `CONFIRMED@${label(confirmed.sessionId)}`
          : offered !== undefined
            ? `OFFERED@${label(offered.offer.sessionId)}`
            : queued !== undefined
              ? `QUEUED#${queued.queuePosition}`
              : participant.cancelled
                ? 'CANCELLED'
                : 'ENDED(NO_ACCEPTABLE_SESSION)';
        const mine = await participant.account.client.myRegistrations();
        const entry = mine.registrations.find((candidate) => candidate.workshop.id === ws.wsId);
        const actual = describeRegistration(entry?.registration, label);
        state.inAppStates.push({ participant: participant.label, expected, actual, ok: expected === actual });
      }
      const mismatched = state.inAppStates.filter((item) => !item.ok);
      ctx.check({
        scenario: '8 final',
        step: 'every participant\'s in-app registration status matches the organiser dashboard (C6)',
        ok: mismatched.length === 0,
        expected: `${participants.length} matches`,
        actual: mismatched.length === 0 ? `${participants.length} matches` : mismatched.map((item) => `${item.participant}: ${item.actual} vs ${item.expected}`).join('; '),
      });

      // Backfills: counts by cause, same-settlement relays, Table 3 expiry target.
      const byCause = countBy(dash.backfills, (record) => record.cause);
      const made = rehearsal.rows.filter((row) => row.kind === 'command' && row.status === 'APPLIED');
      const declinesApplied = made.filter((row) => row.type === 'DECLINE_OFFER').length;
      const cancelsApplied = made.filter((row) => row.type === 'CANCEL_REGISTRATION').length;
      ctx.expectEqual('8 final', 'DECLINED backfill records = declines applied', declinesApplied, byCause.DECLINED ?? 0);
      ctx.expectEqual('8 final', 'EXPIRED backfill records = unanswered offers', rehearsal.used.silent, byCause.EXPIRED ?? 0);
      ctx.expectEqual('8 final', 'CANCELLED_CONFIRMED backfill records = cancellations applied', cancelsApplied, byCause.CANCELLED_CONFIRMED ?? 0);
      const sameSettlement = dash.backfills.filter((record) => record.cause !== 'EXPIRED' && record.reallocatedAt !== undefined);
      ctx.check({
        scenario: '8 final',
        step: 'decline / cancellation / capacity backfills relayed in the same settlement (latencyMs 0)',
        ok: sameSettlement.every((record) => record.latencyMs === 0),
        expected: 'latencyMs 0',
        actual: sameSettlement.map((record) => `${record.cause} ${record.latencyMs}`).join(', ') || 'none relayed',
      });
      const expired = dash.backfills.filter((record) => record.cause === 'EXPIRED' && record.latencyMs !== undefined);
      ctx.check({
        scenario: '8 final',
        step: 'expiry-driven backfill within the Table 3 target (≤ 120 s)',
        ok: expired.length > 0 && expired.every((record) => (record.latencyMs ?? Infinity) <= BACKFILL_TARGET_MS),
        expected: '≤ 120000 ms each',
        actual: expired.map((record) => `${record.latencyMs} ms`).join(', ') || 'no relayed expiry',
      });
      const unrelayed = dash.backfills.filter((record) => record.reallocatedAt === undefined);
      ctx.check({
        scenario: '8 final',
        step: 'no released seat left unrelayed while someone acceptable is queued',
        ok: unrelayed.every((record) => !dash.queue.some((entry) => entry.acceptable.includes(record.sessionId))),
        expected: 'pending backfills only where nobody acceptable is queued',
        actual: unrelayed.length === 0 ? 'none pending' : unrelayed.map((record) => `${record.cause}@${label(record.sessionId)}`).join(', '),
      });
      ctx.check({
        scenario: '8 final',
        step: 'no offer left open at the end of the rehearsal',
        ok: dash.offered.length === 0,
        expected: '0 OFFERED',
        actual: `${dash.offered.length} OFFERED`,
      });

      // Notifications: wait until none is PENDING (DynamoDB on AWS, in-app otherwise), then compare.
      const deadline = Date.now() + notifyWaitS * 1000;
      const stored = new Map<string, StoredNotification[]>();
      const readStored = async (): Promise<number> => {
        let pending = 0;
        for (const participant of participants) {
          const items = await storedNotifications(aws, participant.account.userId, ws.wsId);
          stored.set(participant.label, items);
          pending += items.filter((item) => item.status === 'PENDING').length;
        }
        return pending;
      };
      const inApp = new Map<string, Awaited<ReturnType<Account['client']['myNotifications']>>['notifications']>();
      const readInApp = async (): Promise<number> => {
        let pending = 0;
        for (const participant of participants) {
          const { notifications } = await participant.account.client.myNotifications();
          const mine = notifications.filter((notification) => notification.workshopId === ws.wsId);
          inApp.set(participant.label, mine);
          pending += mine.filter((notification) => notification.status === 'PENDING').length;
        }
        return pending;
      };
      let pending = aws.available ? await readStored() : await readInApp();
      while (pending > 0 && Date.now() < deadline) {
        ctx.log(`${pending} notification(s) still PENDING; waiting`);
        await sleep(aws.available ? 5000 : 2000);
        pending = aws.available ? await readStored() : await readInApp();
      }
      if (aws.available) {
        await readInApp();
      }
      for (const participant of participants) {
        const appList = inApp.get(participant.label) ?? [];
        const dbList = stored.get(participant.label);
        const ids = new Set([...appList.map((item) => item.id), ...(dbList ?? []).map((item) => item.id)]);
        for (const id of ids) {
          const app = appList.find((item) => item.id === id);
          const db = dbList?.find((item) => item.id === id);
          state.notifications.push({
            participant: participant.label,
            kind: app?.kind ?? db?.kind ?? '',
            inAppStatus: app?.status ?? '',
            storedStatus: db?.status ?? (dbList === undefined ? 'n/a' : ''),
            attempts: db?.attempts,
            lastError: db?.lastError ?? '',
            createdAt: app?.createdAt ?? db?.createdAt ?? '',
            offerId: app?.offerId ?? db?.offerId ?? '',
            notificationId: id,
          });
        }
      }
      state.notifications.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.participant.localeCompare(b.participant));
      const statusOf = (row: NotificationRow): string => (aws.available ? row.storedStatus : row.inAppStatus);
      const kinds = countBy(state.notifications, (row) => row.kind);
      const accepted = made.filter((row) => row.type === 'ACCEPT_OFFER').length;
      ctx.check({
        scenario: '8 final',
        step: 'notifications by kind match the events (OFFER = offers made, CONFIRMED = accepts, DECLINED = declines, EXPIRED = expiries)',
        ok: (kinds.OFFER ?? 0) === rehearsal.offers.size && (kinds.CONFIRMED ?? 0) === accepted && (kinds.DECLINED ?? 0) === declinesApplied && (kinds.EXPIRED ?? 0) === rehearsal.used.silent && Object.keys(kinds).every((kind) => ['OFFER', 'CONFIRMED', 'DECLINED', 'EXPIRED'].includes(kind)),
        expected: `OFFER ${rehearsal.offers.size}, CONFIRMED ${accepted}, DECLINED ${declinesApplied}, EXPIRED ${rehearsal.used.silent}`,
        actual: Object.entries(kinds).map(([kind, n]) => `${kind} ${n}`).join(', '),
      });
      const stillPending = state.notifications.filter((row) => statusOf(row) === 'PENDING').length;
      ctx.check({
        scenario: '8 final',
        step: `every notification left PENDING within ${notifyWaitS} s (${aws.available ? 'DynamoDB Notification items' : 'in-app list'})`,
        ok: stillPending === 0,
        expected: '0 PENDING',
        actual: `${stillPending} PENDING of ${state.notifications.length}`,
      });
      const statuses = countBy(state.notifications, statusOf);
      if (ctx.target.name !== 'local') {
        if (state.mailbox === 'simulator') {
          ctx.check({
            scenario: '8 final',
            step: 'SES accepted every e-mail to the mailbox simulator (SENT)',
            ok: (statuses.SENT ?? 0) === state.notifications.length,
            expected: `SENT ${state.notifications.length}`,
            actual: Object.entries(statuses).map(([status, n]) => `${status} ${n}`).join(', '),
          });
        } else {
          ctx.check({
            scenario: '8 final',
            step: 'e-mails rejected by the SES sandbox are recorded FAILED, none PENDING (C6)',
            ok: (statuses.PENDING ?? 0) === 0 && ((statuses.FAILED ?? 0) + (statuses.SENT ?? 0) + (statuses.SKIPPED ?? 0)) === state.notifications.length,
            expected: 'FAILED (or SENT/SKIPPED), never PENDING',
            actual: Object.entries(statuses).map(([status, n]) => `${status} ${n}`).join(', '),
          });
        }
      }
      if (aws.available) {
        const mismatch = state.notifications.filter((row) => row.inAppStatus !== row.storedStatus);
        ctx.check({
          scenario: '8 final',
          step: 'in-app notification list (GET /me/notifications) = stored Notification items, same status (C6 readable)',
          ok: mismatch.length === 0,
          expected: `${state.notifications.length} identical`,
          actual: mismatch.length === 0 ? `${state.notifications.length} identical` : mismatch.slice(0, 5).map((row) => `${row.participant} ${row.kind} app=${row.inAppStatus} db=${row.storedStatus}`).join('; '),
        });
      }

      // Operations: DLQs, alarms, metrics of the window.
      state.deadAfter = await ctx.ops.deadLetters();
      if (state.deadBefore?.available && state.deadAfter.available) {
        ctx.check({
          scenario: '8 final',
          step: 'dead-letter queues unchanged',
          ok: state.deadAfter.total === state.deadBefore.total,
          expected: `total ${state.deadBefore.total}`,
          actual: `total ${state.deadAfter.total} ${JSON.stringify(state.deadAfter.counts)}`,
        });
      }
      if (aws.available && aws.cw !== undefined) {
        try {
          state.alarmsAfter = await alarmStates(aws.cw, alarmPrefix);
          state.transitions = await alarmTransitions(aws.cw, alarmPrefix, ctx.startedAt, new Date());
          const alarming = state.alarmsAfter.filter((alarm) => alarm.state === 'ALARM');
          const toAlarm = state.transitions.filter((item) => /to ALARM/.test(item.summary));
          ctx.check({
            scenario: '8 final',
            step: `no ${alarmPrefix}* alarm in ALARM, none entered ALARM during the run`,
            ok: alarming.length === 0 && toAlarm.length === 0,
            expected: '0 in ALARM, 0 transitions to ALARM',
            actual: `${alarming.length} in ALARM (${state.alarmsAfter.length} alarms), ${toAlarm.length} transitions to ALARM`,
          });
        } catch (error) {
          ctx.skip('8 final', 'alarm states after', errorText(error));
        }
        const waitMs = ctx.options.metricsWaitMs - (Date.now() - rehearsal.lastActionAt);
        if (waitMs > 0) {
          ctx.log(`waiting ${Math.round(waitMs / 1000)} s for CloudWatch to ingest the run's metrics`);
          await sleep(waitMs);
        }
        state.metrics = await getMetricData(windowQueries(ctx.target.stage), {
          start: new Date(ctx.startedAt.getTime() - 60_000),
          end: new Date(Date.now() + 60_000),
          periodSeconds: 60,
        });
        if (state.metrics.available) {
          const metricsRead = state.metrics;
          const total = (name: string, stat: string): number => seriesTotal(metricsRead, metricId(name, stat)) ?? 0;
          // The custom series must hold this run's commands; an empty series means the query
          // addresses the wrong dimensions, and then "0 late expiries" would prove nothing.
          const relayedBackfills = dash.backfills.filter((record) => record.latencyMs !== undefined).length;
          const settledCommands = made.length + rehearsal.rows.filter((row) => row.kind === 'command' && row.status === 'REJECTED').length;
          const observed = {
            CommandSettledLatency: total('CommandSettledLatency', 'SampleCount'),
            OffersCreated: total('OffersCreated', 'Sum'),
            OffersExpired: total('OffersExpired', 'Sum'),
            BackfillLatency: total('BackfillLatency', 'SampleCount'),
          };
          const wanted = { CommandSettledLatency: settledCommands, OffersCreated: rehearsal.offers.size, OffersExpired: rehearsal.used.silent, BackfillLatency: relayedBackfills };
          ctx.check({
            scenario: '8 final',
            step: `CloudWatch custom metrics (service + stage=${ctx.target.stage}) agree with the API record of the run`,
            ok: (Object.keys(wanted) as (keyof typeof wanted)[]).every((key) => observed[key] === wanted[key]),
            expected: Object.entries(wanted).map(([key, value]) => `${key} ${value}`).join(', '),
            actual: Object.entries(observed).map(([key, value]) => `${key} ${value}`).join(', '),
          });
          const sweepLate = total('SweepLateExpiries', 'Sum');
          ctx.check({
            scenario: '8 final',
            step: 'SweepLateExpiries = 0 in the window (the timer path relayed every expiry; series readable)',
            ok: observed.CommandSettledLatency > 0 && sweepLate === 0,
            expected: '0 (with CommandSettledLatency samples > 0)',
            actual: `${sweepLate} (CommandSettledLatency samples ${observed.CommandSettledLatency})`,
          });
          const throttles = ['api', 'worker', 'expiry-forwarder', 'sweep', 'notifier'].reduce((acc, fn) => acc + (seriesTotal(state.metrics as MetricsResult, metricId('fn', fn, 'Throttles', 'Sum')) ?? 0), 0);
          const errors = ['api', 'worker', 'expiry-forwarder', 'sweep', 'notifier'].reduce((acc, fn) => acc + (seriesTotal(state.metrics as MetricsResult, metricId('fn', fn, 'Errors', 'Sum')) ?? 0), 0);
          ctx.check({ scenario: '8 final', step: `no Lambda errors or throttles on seatrelay-${ctx.target.stage}-*`, ok: throttles === 0 && errors === 0, expected: '0 errors, 0 throttles', actual: `${errors} errors, ${throttles} throttles` });
        } else {
          ctx.skip('8 final', 'CloudWatch metrics of the window', state.metrics.reason);
        }
      }
    });

    return buildResult(ctx, state, { count, capacities, capacityUp, declines, expiries, cancellations, attendanceCount, notifyWaitS });
  },
});

interface Settings {
  count: number;
  capacities: [number, number];
  capacityUp: number;
  declines: number;
  expiries: number;
  cancellations: number;
  attendanceCount: number;
  notifyWaitS: number;
}

function latencyStats(values: readonly (number | undefined)[]) {
  return summarize(values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
}

function buildResult(ctx: ExperimentContext, state: RunState, settings: Settings) {
  const rehearsal = state.rehearsal;
  if (rehearsal === undefined) {
    return { summary: 'The rehearsal did not start (setup failed).', extra: { mailbox: state.mailbox } };
  }
  const label = rehearsal.label;
  const commands = rehearsal.rows.filter((row) => row.kind === 'command');
  const settled = commands.filter((row) => row.status === 'APPLIED' || row.status === 'REJECTED');
  const clientAll = latencyStats(settled.map((row) => row.settleMs));
  const serverAll = latencyStats(settled.map((row) => row.serverSettleMs));
  const acceptAll = latencyStats(settled.map((row) => row.acceptMs));
  const types = [...new Set(settled.map((row) => row.type))];
  const perType = Object.fromEntries(
    types.map((type) => {
      const rows = settled.filter((row) => row.type === type);
      return [type, { n: rows.length, client: latencyStats(rows.map((row) => row.settleMs)), server: latencyStats(rows.map((row) => row.serverSettleMs)) }];
    }),
  );
  const dash = state.finalDash;
  const backfills: BackfillRecord[] = dash?.backfills ?? [];
  const backfillRows: CsvRow[] = backfills
    .slice()
    .sort((a, b) => a.releasedAt.localeCompare(b.releasedAt))
    .map((record) => ({
      cause: record.cause,
      session: label(record.sessionId),
      releasedAt: record.releasedAt,
      reallocatedAt: record.reallocatedAt ?? '',
      latencyMs: record.latencyMs,
      recomputedMs: record.reallocatedAt === undefined ? undefined : Date.parse(record.reallocatedAt) - Date.parse(record.releasedAt),
      newParticipant: record.newUserId === undefined ? '' : rehearsal.byUser.get(record.newUserId)?.label ?? record.newUserId,
      backfillId: record.id,
    }));
  const causes = [...new Set(backfills.map((record) => record.cause))].sort();
  const byCause = Object.fromEntries(
    causes.map((cause) => {
      const records = backfills.filter((record) => record.cause === cause);
      const relayed = records.filter((record) => record.latencyMs !== undefined);
      const latencies = relayed.map((record) => record.latencyMs as number);
      return [cause, { n: records.length, relayed: relayed.length, latencyMs: latencies, stats: summarize(latencies) }];
    }),
  );
  const statusOf = (row: NotificationRow): string => (state.aws?.available ? row.storedStatus : row.inAppStatus);
  const notificationMatrix: Record<string, Record<string, number>> = {};
  for (const row of state.notifications) {
    const kindCounts = (notificationMatrix[row.kind] ??= {});
    kindCounts[statusOf(row)] = (kindCounts[statusOf(row)] ?? 0) + 1;
  }
  const notificationTotals = countBy(state.notifications, statusOf);
  const failedErrors = [...new Set(state.notifications.filter((row) => row.lastError.length > 0).map((row) => row.lastError.replace(/[\w.+-]+@[\w.-]+/g, '<address>')))];
  const invariantOk = rehearsal.invariants.length > 0 && rehearsal.invariants.every((row) => row.verifyOk && row.overCapacity === 0 && row.doubleHolds === 0);
  const metrics = state.metrics;
  const concurrencyMax = metrics === undefined ? undefined : seriesMax(metrics, 'lambda_account_concurrent_max');
  const fnStats = ['api', 'worker', 'expiry-forwarder', 'sweep', 'notifier'].map((fn) => ({
    fn,
    invocations: metrics === undefined ? undefined : seriesTotal(metrics, metricId('fn', fn, 'Invocations', 'Sum')),
    errors: metrics === undefined ? undefined : seriesTotal(metrics, metricId('fn', fn, 'Errors', 'Sum')),
    throttles: metrics === undefined ? undefined : seriesTotal(metrics, metricId('fn', fn, 'Throttles', 'Sum')),
    concurrentMax: metrics === undefined ? undefined : seriesMax(metrics, metricId('fn', fn, 'ConcurrentExecutions', 'Maximum')),
  }));
  const otherStage = ctx.target.stage === 'dev' ? 'pilot' : 'dev';
  const otherInvocations = metrics === undefined
    ? undefined
    : (seriesTotal(metrics, metricId('other', otherStage, 'worker', 'invocations')) ?? 0) + (seriesTotal(metrics, metricId('other', otherStage, 'api', 'invocations')) ?? 0);
  const custom = (name: string, stat: string): number | undefined => (metrics === undefined ? undefined : seriesTotal(metrics, metricId(name, stat)));
  const customMax = (name: string): number | undefined => (metrics === undefined ? undefined : seriesMax(metrics, metricId(name, 'Maximum')));

  const n = (value: number | undefined, digits = 0): string => (value === undefined ? 'n/a' : formatNumber(value, digits));
  const participants = [...rehearsal.byUser.values()].sort((a, b) => a.no - b.no);
  const groupCounts = countBy(participants, (p) => p.group);
  const lines: string[] = [];
  lines.push(
    '## What was staged',
    '',
    `- Organisation **${ORG_NAME}**, workshop **${WORKSHOP_TITLE}** (\`${rehearsal.wsId}\`), mode UNIFIED, holdSeconds ${ctx.options.holdSeconds}; sessions ${rehearsal.ws.sessions.map((session, index) => `S${index + 1} "${session.title}" starts ${session.startsAt} capacity ${session.capacity}`).join('; ')}.`,
    `- ${participants.length} synthetic participants (${Object.entries(groupCounts).map(([group, k]) => `${k} ${group}`).join(', ')}), registering in the order P01 … P${pad2(participants.length)}; every action sequential with a random ${(ctx.params.paceMs as number[] | undefined)?.join('–') ?? '1000–3000'} ms pause before it; organiser \`${(ctx.params.organiser as string) ?? DEFAULT_ORGANISER}\`.`,
    `- Participant addresses: ${state.mailbox === 'simulator' ? '`success+rehearsal-NN@simulator.amazonses.com` (SES mailbox simulator: the pilot\'s real SES path, delivery simulated, no real inbox)' : '`rehearsal-NN@example.com` (rejected by the SES sandbox: notifications end FAILED)'}${state.mailboxFallback === undefined ? '' : `; **fallback**: ${state.mailboxFallback}`}. The identity provider (Cognito on AWS) accepted the address as username and the API saw it as the account e-mail: ${state.cognitoAccepted === undefined ? 'n/a' : state.cognitoAccepted ? 'yes' : 'NO'}.`,
    `- Scripted behaviour: ${rehearsal.used.decline}/${settings.declines} declines, ${rehearsal.used.silent}/${settings.expiries} offers left to expire, ${commands.filter((row) => row.type === 'CANCEL_REGISTRATION').length}/${settings.cancellations} cancellations after confirming, capacity +${settings.capacityUp} on S2, attendance marked for ${rehearsal.rows.filter((row) => row.kind === 'http' && row.action.startsWith('mark ')).length}/${settings.attendanceCount} confirmed participants, CSV export (\`export.csv\`).`,
    '- Every account and every action is synthetic and scripted. Nothing here is user evidence; the live pilot (independent participants) is logged separately.',
    '',
    '## Timeline',
    '',
    markdownTable(
      ['phase', 'started', 'finished', 'actions', 'invariants after', 'error'],
      rehearsal.phases.map((item) => {
        const inv = rehearsal.invariants.find((row) => row.phase === item.phase);
        return [item.phase, item.startedAt, item.finishedAt, item.actions, inv === undefined ? 'n/a' : inv.verifyOk && inv.overCapacity === 0 && inv.doubleHolds === 0 ? 'ok' : 'VIOLATED', item.error];
      }),
    ),
    '',
    `Waited ${state.expiryWaitS ?? 'n/a'} s in phase 3 for the unanswered holds to expire and be relayed.`,
    '',
    '## Command settle latency',
    '',
    `${settled.length} commands settled (${commands.length} sent), every one sequential. Client-observed = POST → the poll that saw the terminal state (plan §1.3 backoff); server = \`settledAt − acceptedAt\`.`,
    '',
    markdownTable(SUMMARY_HEADERS, [
      summaryRow('202 response (POST)', acceptAll),
      summaryRow('settle, client-observed', clientAll),
      summaryRow('settle, server-side', serverAll),
      ...types.flatMap((type) => [summaryRow(`${type} client (n=${perType[type]?.n})`, perType[type]!.client), summaryRow(`${type} server`, perType[type]!.server)]),
    ]),
    '',
    '## Backfills',
    '',
    markdownTable(
      ['cause', 'records', 'relayed', 'latency ms (each)', 'p50 ms', 'max ms'],
      causes.map((cause) => [cause, byCause[cause]!.n, byCause[cause]!.relayed, byCause[cause]!.latencyMs.join(', '), n(byCause[cause]!.stats.p50), n(byCause[cause]!.stats.max)]),
    ),
    '',
    markdownTable(
      ['released', 'cause', 'session', 'reallocated', 'latency ms', 'to'],
      backfillRows.map((row) => [row.releasedAt, row.cause, row.session, row.reallocatedAt, row.latencyMs, row.newParticipant].map((cell) => cell ?? '')),
    ),
    '',
    'EXPIRED latency = `reallocatedAt − expiresAt` (timer-driven; Table 3 target ≤ 120 s). DECLINED / CANCELLED_CONFIRMED / CAPACITY_UP are relayed inside the same settlement (0 ms by construction).',
    '',
    '## Invariants after each phase',
    '',
    markdownTable(
      ['phase', 'verify', 'over-capacity', 'double holds', 'violations', 'S1 conf+held/cap', 'S2 conf+held/cap', 'queued', 'offered', 'confirmed', 'backfills', 'distinct served'],
      rehearsal.invariants.map((row) => [row.phase, row.verifyOk ? 'ok' : 'FAILED', row.overCapacity, row.doubleHolds, row.violations || '—', row.S1, row.S2, row.queued, row.offered, row.confirmed, row.backfills, row.distinctServed]),
    ),
    '',
    `Invariant result over all phases: **${invariantOk ? 'held' : 'VIOLATED'}**.`,
    '',
  );
  if (dash !== undefined) {
    lines.push(
      '## Final state (organiser dashboard)',
      '',
      markdownTable(
        ['session', 'capacity', 'confirmed', 'held', 'free', 'queue (acceptable)'],
        dash.sessions.map((session) => [label(session.id), session.capacity, session.confirmed, session.held, session.free, session.queueLength]),
      ),
      '',
      `- Counts: queued ${dash.counts.queued}, offered ${dash.counts.offered}, confirmed ${dash.counts.confirmed}, backfills ${dash.counts.backfills} (${dash.counts.backfillsReallocated} reallocated), attended ${dash.counts.attended}.`,
      `- **Distinct participants served** (dashboard \`distinctParticipantsServed\`): ${dash.distinctParticipantsServed} of ${participants.length} synthetic participants, for ${dash.sessions.reduce((acc, session) => acc + session.capacity, 0)} seats.`,
      `- Export: \`export.csv\` (${state.exportRows?.length ?? 'n/a'} rows, the organiser download as served).`,
      '',
    );
  }
  lines.push(
    '## Notifications',
    '',
    `Source: ${state.aws?.available ? `Notification items in DynamoDB (\`${state.aws.tableName}\`, status, attempts, last error) compared with every participant's in-app list (\`GET /me/notifications\`)` : 'every participant\'s in-app list (`GET /me/notifications`)'}; waited up to ${settings.notifyWaitS} s for PENDING to clear.`,
    '',
    markdownTable(
      ['kind', ...NOTIFICATION_STATUSES, 'total'],
      [...NOTIFICATION_KINDS.filter((kind) => notificationMatrix[kind] !== undefined).map((kind) => [kind, ...NOTIFICATION_STATUSES.map((status) => notificationMatrix[kind]?.[status] ?? 0), Object.values(notificationMatrix[kind] ?? {}).reduce((acc, k) => acc + k, 0)]),
        ['total', ...NOTIFICATION_STATUSES.map((status) => notificationTotals[status] ?? 0), state.notifications.length]],
    ),
    '',
    failedErrors.length === 0 ? 'No delivery error recorded.' : `Delivery errors recorded (addresses redacted): ${failedErrors.map((error) => `\`${error.slice(0, 200)}\``).join('; ')}`,
    '',
    `In-app status (C6): ${state.inAppStates.filter((item) => item.ok).length}/${state.inAppStates.length} participants' "my registrations" status equals the organiser dashboard.`,
    '',
    '## Operations',
    '',
    `- Dead-letter queues: before ${state.deadBefore?.available ? `${state.deadBefore.total} ${JSON.stringify(state.deadBefore.counts)}` : `not read (${state.deadBefore?.detail ?? 'n/a'})`}; after ${state.deadAfter?.available ? `${state.deadAfter.total} ${JSON.stringify(state.deadAfter.counts)}` : `not read (${state.deadAfter?.detail ?? 'n/a'})`}.`,
    `- Alarms (\`seatrelay-${ctx.target.stage}-*\`): before ${state.alarmsBefore === undefined ? 'n/a' : Object.entries(countBy(state.alarmsBefore, (alarm) => alarm.state)).map(([s, k]) => `${k} ${s}`).join(', ')}; after ${state.alarmsAfter === undefined ? 'n/a' : Object.entries(countBy(state.alarmsAfter, (alarm) => alarm.state)).map(([s, k]) => `${k} ${s}`).join(', ')}; state changes during the run: ${state.transitions === undefined ? 'n/a' : state.transitions.length === 0 ? 'none' : state.transitions.map((item) => `${item.at} ${item.name}: ${item.summary}`).join('; ')}.`,
  );
  if (state.alarmsAfter !== undefined) {
    lines.push('', markdownTable(['alarm', 'before', 'after'], state.alarmsAfter.map((alarm) => [alarm.name, state.alarmsBefore?.find((item) => item.name === alarm.name)?.state ?? 'n/a', alarm.state])));
  }
  if (metrics !== undefined) {
    if (metrics.available) {
      lines.push(
        '',
        `CloudWatch, ${metrics.window.start} → ${metrics.window.end} (60 s periods):`,
        '',
        `- Account Lambda ConcurrentExecutions, max of 1-min maxima: **${n(concurrencyMax)}** (account quota 10).`,
        `- SeatRelay custom metrics are read with dimensions \`service\` + \`stage=${ctx.target.stage}\` (what the deployed functions emit), so ${otherStage} activity is excluded; ${otherStage} api + worker invocations in the window: ${n(otherInvocations)}. Other ${ctx.target.stage} traffic in the window would be included (the check "CloudWatch custom metrics agree with the API record" shows whether there was any).`,
        '',
        markdownTable(['function', 'invocations', 'errors', 'throttles', 'concurrent max'], fnStats.map((row) => [`seatrelay-${ctx.target.stage}-${row.fn}`, n(row.invocations), n(row.errors), n(row.throttles), n(row.concurrentMax)])),
        '',
        markdownTable(
          ['SeatRelay metric', 'sum', 'samples', 'max'],
          ['CommandSettledLatency', 'BackfillLatency', 'OffersCreated', 'OffersExpired', 'SweepLateExpiries', 'NotificationFailures'].map((name) => [name, n(custom(name, 'Sum')), n(custom(name, 'SampleCount')), n(customMax(name))]),
        ),
      );
    } else {
      lines.push('', `CloudWatch metrics not fetched: ${metrics.reason}`);
    }
  }
  lines.push(
    '',
    '## Participants',
    '',
    markdownTable(
      ['participant', 'preferences', 'what they did', 'in-app status at the end'],
      participants.map((p) => [p.label, p.prefs.map((id) => label(id)).join('>'), p.history.join('; '), state.inAppStates.find((item) => item.participant === p.label)?.actual ?? 'n/a']),
    ),
    '',
    '## Caveats',
    '',
    '- Staged: synthetic accounts, scripted decisions, human-like pacing. It exercises the deployed pilot stack end to end (API Gateway, Lambda, SQS FIFO and delay timers, DynamoDB, the notifier and SES) but says nothing about how real people use the system.',
    '- Attendance was marked before the sessions start: it rehearses the organiser feature, not a real check-in.',
    `- The workshop stays OPEN with its final state for inspection. Participants still queued at a session's cut-off (start − 30 min) will be ended by the sweep then (ENDED notifications to simulator addresses, outside this run's window).`,
  );

  const extra = {
    banner: BANNER,
    evidence: 'staged-rehearsal-synthetic-accounts',
    workshopId: rehearsal.wsId,
    orgId: rehearsal.orgId,
    mailbox: state.mailbox,
    mailboxFallback: state.mailboxFallback ?? null,
    cognitoAcceptedSimulatorAddress: state.mailbox === 'simulator' ? state.cognitoAccepted ?? null : false,
    participants: participants.length,
    groups: groupCounts,
    commands: { sent: commands.length, settled: settled.length, applied: settled.filter((row) => row.status === 'APPLIED').length, rejected: settled.filter((row) => row.status === 'REJECTED').length, byType: countBy(settled, (row) => row.type) },
    httpActions: rehearsal.rows.filter((row) => row.kind === 'http').length,
    acceptMs: acceptAll,
    settleMs: clientAll,
    serverSettleMs: serverAll,
    settleByType: perType,
    scripted: { declines: rehearsal.used.decline, expiries: rehearsal.used.silent, cancellations: commands.filter((row) => row.type === 'CANCEL_REGISTRATION' && row.status === 'APPLIED').length, capacityUp: settings.capacityUp, attendanceMarked: rehearsal.rows.filter((row) => row.kind === 'http' && row.action.startsWith('mark ') && row.ok).length },
    offers: rehearsal.offers.size,
    expiryWaitSeconds: state.expiryWaitS ?? null,
    backfills: byCause,
    invariants: { ok: invariantOk, phases: rehearsal.invariants.length, verifyFailures: rehearsal.invariants.filter((row) => !row.verifyOk).length, overCapacity: rehearsal.invariants.reduce((acc, row) => acc + row.overCapacity, 0), doubleHolds: rehearsal.invariants.reduce((acc, row) => acc + row.doubleHolds, 0) },
    final: dash === undefined ? null : {
      counts: dash.counts,
      distinctParticipantsServed: dash.distinctParticipantsServed,
      sessions: dash.sessions.map((session) => ({ label: label(session.id), capacity: session.capacity, confirmed: session.confirmed, held: session.held, free: session.free, queueLength: session.queueLength })),
    },
    exportRows: state.exportRows?.length ?? null,
    notifications: { source: state.aws?.available ? 'dynamodb+in-app' : 'in-app', total: state.notifications.length, byStatus: notificationTotals, byKind: notificationMatrix, errors: failedErrors },
    inAppStatusMatches: state.inAppStates.filter((item) => item.ok).length,
    deadLetters: { before: state.deadBefore ?? null, after: state.deadAfter ?? null },
    alarms: { before: state.alarmsBefore ?? null, after: state.alarmsAfter ?? null, transitions: state.transitions ?? null },
    lambda: metrics === undefined || !metrics.available ? null : { accountConcurrentMax: concurrencyMax, functions: fnStats, otherStageInvocations: otherInvocations },
    customMetrics: metrics === undefined || !metrics.available ? null : Object.fromEntries(['CommandSettledLatency', 'BackfillLatency', 'OffersCreated', 'OffersExpired', 'SweepLateExpiries', 'NotificationFailures'].map((name) => [name, { sum: custom(name, 'Sum'), samples: custom(name, 'SampleCount'), max: customMax(name) }])),
  };
  return {
    summary: lines.join('\n'),
    rows: rehearsal.rows,
    extraFiles: {
      'backfills.csv': backfillRows,
      'notifications.csv': state.notifications,
      'invariants.csv': rehearsal.invariants,
    },
    extra,
  };
}
