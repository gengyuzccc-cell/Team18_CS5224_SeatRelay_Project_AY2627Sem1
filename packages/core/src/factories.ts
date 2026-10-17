import {
  CUTOFF_BEFORE_START_SECONDS,
  DEFAULT_HOLD_SECONDS,
  type Session,
  type Workshop,
  type WorkshopMode,
} from '@seatrelay/contracts';
import type { WorkshopSnapshot } from './snapshot';
import { addSeconds } from './time';

/** `cutoffAt = startsAt − 30 min` (R4), fixed when the session is created. */
export function cutoffFor(startsAt: string): string {
  return addSeconds(startsAt, -CUTOFF_BEFORE_START_SECONDS);
}

export interface NewSessionInput {
  id: string;
  workshopId: string;
  title: string;
  startsAt: string;
  capacity: number;
}

export function newSession(input: NewSessionInput): Session {
  return {
    id: input.id,
    workshopId: input.workshopId,
    title: input.title,
    startsAt: input.startsAt,
    cutoffAt: cutoffFor(input.startsAt),
    capacity: input.capacity,
    confirmed: 0,
    held: 0,
    status: 'OPEN',
  };
}

export interface NewWorkshopInput {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  mode?: WorkshopMode;
  holdSeconds?: number;
  createdAt: string;
}

export function newWorkshop(input: NewWorkshopInput): Workshop {
  return {
    id: input.id,
    orgId: input.orgId,
    title: input.title,
    description: input.description ?? '',
    status: 'OPEN',
    mode: input.mode ?? 'UNIFIED',
    holdSeconds: input.holdSeconds ?? DEFAULT_HOLD_SECONDS,
    seq: 0,
    version: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** A fresh snapshot for a just-created workshop (no registrations, no offers). */
export function newSnapshot(workshop: Workshop, sessions: Session[]): WorkshopSnapshot {
  return { workshop, sessions, registrations: [], offers: [], pendingBackfills: [] };
}
