import {
  COMMAND_RESULT_TTL_SECONDS,
  ORGANIZER_COMMAND_TYPES,
  isUserCommand,
  type Command,
  type CommandResult,
  type FaultFlag,
  type RejectReason,
  type UserCommand,
} from '@seatrelay/contracts';
import { decide, diffMs, parseIso, type Decision, type WorkshopSnapshot } from '@seatrelay/core';
import { epochSeconds, materializeNotification } from '../commands';
import type { IdGen, LogFields, MetricsSink, WorkerPorts, WorkshopStore } from '../ports';

/** In-process reloads of the snapshot after a VERSION conflict (plan §2.3). */
export const DEFAULT_MAX_VERSION_RETRIES = 3;

/** An expiry a sweep tick performs more than this late means the timer path failed. */
export const SWEEP_LATE_GRACE_MS = 60_000;

export interface ProcessCommandOptions {
  /** Reloads after a VERSION conflict before giving up (default 3). */
  maxVersionRetries?: number;
  /** Honour `_fault` flags on user commands (deployment setting ALLOW_FAULT_FLAGS). */
  faultInjection?: boolean;
  /**
   * 1-based delivery count of the message (SQS `ApproximateReceiveCount`). Injected faults
   * fire on the first delivery only, so the redelivery demonstrates the recovery path.
   */
  deliveryAttempt?: number;
}

export type ProcessOutcome = 'APPLIED' | 'REJECTED' | 'ALREADY_SETTLED' | 'NOOP';

export interface ProcessCommandResult {
  outcome: ProcessOutcome;
  /** Absent when the command was acknowledged without running the engine. */
  decision?: Decision;
  /** Snapshot loads performed (1 + VERSION retries). */
  attempts: number;
}

/** Thrown when a `_fault` flag fires; the message is redelivered like after a real crash. */
export class FaultInjectedError extends Error {
  readonly fault: FaultFlag;
  readonly commandId: string;

  constructor(fault: FaultFlag, commandId: string) {
    super(`injected fault ${fault} on command ${commandId}`);
    this.name = 'FaultInjectedError';
    this.fault = fault;
    this.commandId = commandId;
  }
}

/** Thrown when the optimistic lock keeps failing: an infrastructure problem, so let it redeliver. */
export class VersionConflictError extends Error {
  readonly workshopId: string;
  readonly attempts: number;

  constructor(workshopId: string, attempts: number) {
    super(`workshop ${workshopId}: version conflict after ${attempts} attempts`);
    this.name = 'VersionConflictError';
    this.workshopId = workshopId;
    this.attempts = attempts;
  }
}

/**
 * Worker orchestration (plan §2.3/§2.4, CONVENTIONS §5):
 *
 *   load snapshot → decide (server time from Clock) → schedule timers (before commit) →
 *   commit (writes + notifications + CommandResult) → enqueue continuation → emit metrics.
 *
 * - VERSION conflict: reload and retry up to `maxVersionRetries` times (MetaConflictRetries).
 * - COMMAND_ALREADY_SETTLED (or a record found settled before loading): a redelivery of a
 *   settled command; acknowledged (C3). Because the first delivery may have crashed after its
 *   commit but before enqueueing its REALLOCATE continuation, the redelivery runs one internal
 *   TICK pass on the workshop (a no-op when nothing is pending), so the workshop converges
 *   without waiting for the sweep.
 * - Deterministic rejections settle the command as REJECTED and never throw.
 * - TICK / REALLOCATE have no CommandResult; one that changes nothing is a NOOP (no commit).
 * - ACCEPT_OFFER / DECLINE_OFFER of an offer that is no longer live: the archived offer is read
 *   (one point read) and handed to the engine as `snapshot.settledOffers`, so the rejection
 *   reason is OFFER_EXPIRED / OFFER_NOT_ACTIVE whichever message was processed first.
 * - `_fault` flags (when `faultInjection` is on and this is the first delivery) throw at the
 *   named point: TIMER_SEND at the timer-scheduling point (whether or not the decision created
 *   timers), BEFORE_COMMIT before the commit, AFTER_COMMIT after it (the redelivery then hits
 *   COMMAND_ALREADY_SETTLED).
 */
export async function processCommand(
  ports: WorkerPorts,
  command: Command,
  options: ProcessCommandOptions = {},
): Promise<ProcessCommandResult> {
  const { store, queue, timers, clock, ids, logger, metrics } = ports;
  const maxRetries = options.maxVersionRetries ?? DEFAULT_MAX_VERSION_RETRIES;
  const user = isUserCommand(command) ? command : undefined;
  const fault = activeFault(user, options);
  const fields = {
    type: command.type,
    workshopId: command.workshopId,
    ...(user === undefined ? {} : { commandId: user.commandId }),
  };

  let accepted: CommandResult | undefined;
  if (user !== undefined) {
    accepted = await store.getCommandResult(user.commandId);
    if (accepted !== undefined && accepted.status !== 'ACCEPTED') {
      logger.info('command already settled; acknowledging redelivery', fields);
      await convergeAfterSettled(ports, command.workshopId, maxRetries, fields);
      return { outcome: 'ALREADY_SETTLED', attempts: 0 };
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await store.loadSnapshot(command.workshopId);
    if (snapshot === undefined) {
      logger.warn('workshop not found; command dropped', fields);
      return { outcome: 'NOOP', attempts: attempt };
    }
    await attachSettledOffer(store, snapshot, command);
    const now = clock.now();
    const decision = await decideAuthorised(store, ids, snapshot, command, now);

    if (user === undefined && decision.writes.length === 0) {
      emitSweepMetrics(metrics, command, decision, now);
      logger.info('internal command had nothing to do', fields);
      return { outcome: 'NOOP', decision, attempts: attempt };
    }

    if (fault === 'TIMER_SEND') {
      throw new FaultInjectedError(fault, user?.commandId ?? '');
    }
    if (decision.timers.length > 0) {
      await timers.schedule(command.workshopId, decision.timers);
    }
    if (fault === 'BEFORE_COMMIT') {
      throw new FaultInjectedError(fault, user?.commandId ?? '');
    }

    const settledAt = clock.now();
    const notifications = decision.notifications.map((draft) =>
      materializeNotification(draft, ids.newId(), settledAt),
    );
    const commandResult =
      user === undefined ? undefined : settledCommandResult(user, accepted, decision, settledAt);
    const committed = await store.commit({
      wsId: command.workshopId,
      expectedVersion: snapshot.workshop.version,
      writes: decision.writes,
      notifications,
      ...(commandResult === undefined ? {} : { commandResult }),
    });

    if (!committed.ok) {
      if (committed.conflict === 'COMMAND_ALREADY_SETTLED') {
        logger.info('command settled concurrently; acknowledging redelivery', fields);
        await convergeAfterSettled(ports, command.workshopId, maxRetries, fields);
        return { outcome: 'ALREADY_SETTLED', decision, attempts: attempt };
      }
      metrics.emit('MetaConflictRetries', 1, 'Count');
      if (attempt > maxRetries) {
        logger.error('version conflict retries exhausted', { ...fields, attempts: attempt });
        throw new VersionConflictError(command.workshopId, attempt);
      }
      logger.warn('version conflict; reloading snapshot', { ...fields, attempt });
      continue;
    }

    if (fault === 'AFTER_COMMIT') {
      throw new FaultInjectedError(fault, user?.commandId ?? '');
    }
    if (decision.continuation !== undefined) {
      await queue.enqueue(decision.continuation);
    }
    emitMetrics(metrics, command, decision, accepted, settledAt);
    logger.info('command settled', {
      ...fields,
      status: decision.status,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      attempt,
      offersCreated: decision.metrics.offersCreated,
      offersExpired: decision.metrics.offersExpired,
      continuation: decision.continuation !== undefined,
    });
    return { outcome: decision.status, decision, attempts: attempt };
  }
}

/**
 * The settled command's first delivery may have crashed between its commit and the enqueue of
 * its REALLOCATE continuation (an AFTER_COMMIT fault, a timeout, a failing enqueue). One
 * internal TICK pass finishes whatever that commit left pending; it is a NOOP otherwise.
 */
async function convergeAfterSettled(
  ports: WorkerPorts,
  workshopId: string,
  maxVersionRetries: number,
  fields: LogFields,
): Promise<void> {
  const result = await processCommand(ports, { type: 'TICK', workshopId }, { maxVersionRetries });
  ports.logger.info('convergence pass after a settled redelivery', {
    ...fields,
    outcome: result.outcome,
    continuation: result.decision?.continuation !== undefined,
  });
}

/** One point read of the archived offer an ACCEPT/DECLINE refers to when it is no longer live. */
async function attachSettledOffer(
  store: WorkshopStore,
  snapshot: WorkshopSnapshot,
  command: Command,
): Promise<void> {
  if (command.type !== 'ACCEPT_OFFER' && command.type !== 'DECLINE_OFFER') {
    return;
  }
  if (snapshot.offers.some((offer) => offer.id === command.offerId)) {
    return;
  }
  const archived = await store.getArchivedOffer(command.workshopId, command.offerId);
  if (archived !== undefined) {
    snapshot.settledOffers = [archived];
  }
}

function activeFault(
  user: UserCommand | undefined,
  options: ProcessCommandOptions,
): FaultFlag | undefined {
  if (!options.faultInjection || user?._fault === undefined) {
    return undefined;
  }
  return (options.deliveryAttempt ?? 1) <= 1 ? user._fault : undefined;
}

const ORGANIZER_TYPES: readonly string[] = ORGANIZER_COMMAND_TYPES;

export function isOrganizerCommandType(type: string): boolean {
  return ORGANIZER_TYPES.includes(type);
}

/**
 * Organiser commands are authorised by org membership (C7). The API already enforces it; the
 * worker re-checks so that a message injected behind the API settles as REJECTED(FORBIDDEN)
 * instead of mutating the workshop.
 */
async function decideAuthorised(
  store: WorkshopStore,
  ids: IdGen,
  snapshot: WorkshopSnapshot,
  command: Command,
  now: string,
): Promise<Decision> {
  if (isUserCommand(command) && isOrganizerCommandType(command.type)) {
    const organization = await store.getOrganization(snapshot.workshop.orgId);
    if (organization === undefined || !organization.members.includes(command.actorUserId)) {
      return rejectedDecision('FORBIDDEN');
    }
  }
  return decide(snapshot, command, { now, newId: () => ids.newId() });
}

export function rejectedDecision(reason: RejectReason): Decision {
  return {
    status: 'REJECTED',
    reason,
    writes: [],
    notifications: [],
    timers: [],
    backfills: [],
    metrics: { offersCreated: 0, offersExpired: 0, backfillLatenciesMs: [] },
  };
}

function settledCommandResult(
  command: UserCommand,
  accepted: CommandResult | undefined,
  decision: Decision,
  settledAt: string,
): CommandResult {
  const acceptedAt = accepted?.acceptedAt ?? settledAt;
  const record: CommandResult = {
    commandId: command.commandId,
    type: command.type,
    actorUserId: command.actorUserId,
    workshopId: command.workshopId,
    status: decision.status,
    acceptedAt,
    settledAt,
    ttl: accepted?.ttl ?? epochSeconds(acceptedAt) + COMMAND_RESULT_TTL_SECONDS,
  };
  if (decision.reason !== undefined) {
    record.reason = decision.reason;
  }
  if (decision.resultForCommand !== undefined) {
    record.result = decision.resultForCommand;
  }
  return record;
}

function emitMetrics(
  metrics: MetricsSink,
  command: Command,
  decision: Decision,
  accepted: CommandResult | undefined,
  settledAt: string,
): void {
  if (accepted !== undefined) {
    metrics.emit(
      'CommandSettledLatency',
      Math.max(0, diffMs(settledAt, accepted.acceptedAt)),
      'Milliseconds',
    );
  }
  metrics.emit('OffersCreated', decision.metrics.offersCreated, 'Count');
  metrics.emit('OffersExpired', decision.metrics.offersExpired, 'Count');
  for (const latencyMs of decision.metrics.backfillLatenciesMs) {
    metrics.emit('BackfillLatency', latencyMs, 'Milliseconds');
  }
  emitSweepMetrics(metrics, command, decision, settledAt);
}

/** `SweepLateExpiries` = offers a sweep-originated TICK expired more than 60 s after their `expiresAt`. */
function emitSweepMetrics(
  metrics: MetricsSink,
  command: Command,
  decision: Decision,
  now: string,
): void {
  if (command.type !== 'TICK' || command.source !== 'SWEEP') {
    return;
  }
  const nowMs = parseIso(now);
  let late = 0;
  for (const change of decision.writes) {
    if (
      change.kind === 'ARCHIVE_OFFER' &&
      change.offer.status === 'EXPIRED' &&
      nowMs - parseIso(change.offer.expiresAt) > SWEEP_LATE_GRACE_MS
    ) {
      late += 1;
    }
  }
  metrics.emit('SweepLateExpiries', late, 'Count');
}
