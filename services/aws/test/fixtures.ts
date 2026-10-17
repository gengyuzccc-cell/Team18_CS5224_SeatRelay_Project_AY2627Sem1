import type {
  BackfillRecord,
  CommandResult,
  Notification,
  Offer,
  Organization,
  Registration,
} from '@seatrelay/contracts';
import { addMinutes, newSession, newWorkshop } from '@seatrelay/core';

export const T0 = '2026-11-03T06:00:00.000Z';
export const WS = 'ws-1';
export const ORG = 'org-1';
export const CMD_ID = '6f1d8c2e-2a0b-4c1e-9c2d-8b5e1f3a7c90';

export const organization: Organization = {
  id: ORG,
  name: 'Team 18',
  ownerUserId: 'alice',
  members: ['alice'],
  createdAt: T0,
};

export const workshop = newWorkshop({
  id: WS,
  orgId: ORG,
  title: 'Intro to Git',
  description: 'hands-on',
  holdSeconds: 60,
  createdAt: T0,
});

export const session1 = newSession({
  id: 's1',
  workshopId: WS,
  title: 'Morning',
  startsAt: addMinutes(T0, 24 * 60),
  capacity: 2,
});
export const session2 = newSession({
  id: 's2',
  workshopId: WS,
  title: 'Afternoon',
  startsAt: addMinutes(T0, 26 * 60),
  capacity: 1,
});

export function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    workshopId: WS,
    userId: 'bob',
    email: 'bob@example.com',
    displayName: 'Bob',
    seq: 1,
    acceptable: ['s1', 's2'],
    status: 'QUEUED',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-1',
    workshopId: WS,
    sessionId: 's1',
    userId: 'bob',
    registrationSeq: 1,
    status: 'OFFERED',
    createdAt: T0,
    expiresAt: addMinutes(T0, 1),
    ...overrides,
  };
}

export function backfill(overrides: Partial<BackfillRecord> = {}): BackfillRecord {
  return {
    id: 'bf-1',
    workshopId: WS,
    sessionId: 's1',
    releasedAt: T0,
    cause: 'EXPIRED',
    ...overrides,
  };
}

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    commandId: CMD_ID,
    type: 'REGISTER',
    actorUserId: 'bob',
    workshopId: WS,
    status: 'ACCEPTED',
    acceptedAt: T0,
    ttl: 1_000_000,
    ...overrides,
  };
}

export function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    userId: 'bob',
    email: 'bob@example.com',
    workshopId: WS,
    kind: 'OFFER',
    offerId: 'offer-1',
    title: 'Seat offered',
    body: 'A seat in Morning is held for you.',
    status: 'PENDING',
    attempts: 0,
    createdAt: T0,
    ttl: 2_000_000,
    ...overrides,
  };
}
