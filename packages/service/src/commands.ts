import {
  COMMAND_RESULT_TTL_SECONDS,
  NOTIFICATION_TTL_SECONDS,
  isUserCommand,
  type Command,
  type CommandResult,
  type Notification,
  type TickCommand,
  type UserCommand,
} from '@seatrelay/contracts';
import { parseIso, type NotificationDraft, type OfferTimer } from '@seatrelay/core';

/** Epoch seconds of an ISO timestamp (DynamoDB TTL attribute). */
export function epochSeconds(iso: string): number {
  return Math.floor(parseIso(iso) / 1000);
}

/** The ACCEPTED record the API writes before enqueueing a user command (plan §1.3). */
export function acceptedCommandResult(command: UserCommand, acceptedAt: string): CommandResult {
  return {
    commandId: command.commandId,
    type: command.type,
    actorUserId: command.actorUserId,
    workshopId: command.workshopId,
    status: 'ACCEPTED',
    acceptedAt,
    ttl: epochSeconds(acceptedAt) + COMMAND_RESULT_TTL_SECONDS,
  };
}

/** Turns an engine notification draft into the stored entity (status PENDING, 90-day TTL). */
export function materializeNotification(
  draft: NotificationDraft,
  id: string,
  createdAt: string,
): Notification {
  const notification: Notification = {
    id,
    userId: draft.userId,
    email: draft.email,
    workshopId: draft.workshopId,
    kind: draft.kind,
    title: draft.title,
    body: draft.body,
    status: 'PENDING',
    attempts: 0,
    createdAt,
    ttl: epochSeconds(createdAt) + NOTIFICATION_TTL_SECONDS,
  };
  if (draft.offerId !== undefined) {
    notification.offerId = draft.offerId;
  }
  return notification;
}

/** FIFO message group: one ordered path per workshop. */
export function commandGroupId(command: Command): string {
  return command.workshopId;
}

/**
 * FIFO deduplication id (CONVENTIONS §5): the client `commandId` for user commands,
 * `tick#offerId#expiresAt` for timer ticks; undefined when the message has no natural key
 * (sweep ticks, REALLOCATE continuations), in which case the adapter uses a fresh UUID.
 */
export function commandDedupId(command: Command): string | undefined {
  if (isUserCommand(command)) {
    return command.commandId;
  }
  if (command.type === 'TICK' && command.offerId !== undefined && command.expiresAt !== undefined) {
    return `tick#${command.offerId}#${command.expiresAt}`;
  }
  return undefined;
}

/** The TICK the expiry forwarder enqueues when an offer timer fires (plan §1.2). */
export function tickForTimer(wsId: string, timer: OfferTimer): TickCommand {
  return {
    type: 'TICK',
    workshopId: wsId,
    source: 'TIMER',
    offerId: timer.offerId,
    expiresAt: timer.expiresAt,
  };
}

/** The TICK the sweep enqueues for a workshop whose `nextDueAt` has passed. */
export function sweepTick(wsId: string): TickCommand {
  return { type: 'TICK', workshopId: wsId, source: 'SWEEP' };
}
