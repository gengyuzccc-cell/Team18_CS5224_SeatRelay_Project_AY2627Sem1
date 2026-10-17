import type { InvariantViolation, Offer, Registration, Session } from '@seatrelay/contracts';
import { holdScopeKey, registrationScopeKey } from './perSession';
import { isAllocatable, isLiveRegistrationStatus, type WorkshopSnapshot } from './snapshot';
import { parseIso } from './time';

export type { InvariantViolation } from '@seatrelay/contracts';

export interface InvariantReport {
  ok: boolean;
  violations: InvariantViolation[];
}

export const INVARIANT_CODES = [
  'SESSION_DUPLICATE_ID',
  'SESSION_WORKSHOP_MISMATCH',
  'SEQ_DUPLICATE',
  'SEQ_ABOVE_WORKSHOP',
  'REGISTRATION_WORKSHOP_MISMATCH',
  'REGISTRATION_NOT_LIVE',
  'REGISTRATION_NO_ACCEPTABLE',
  'REGISTRATION_UNKNOWN_SESSION',
  'REGISTRATION_CANCELLED_SESSION',
  'REGISTRATION_PER_SESSION_SHAPE',
  'REGISTRATION_OFFER_MISSING',
  'REGISTRATION_OFFER_MISMATCH',
  'REGISTRATION_STRAY_OFFER_REF',
  'REGISTRATION_CONFIRMED_SESSION_INVALID',
  'REGISTRATION_STRAY_CONFIRMED_SESSION',
  'OFFER_DUPLICATE_ID',
  'OFFER_WORKSHOP_MISMATCH',
  'OFFER_NOT_LIVE',
  'OFFER_SESSION_INVALID',
  'OFFER_AFTER_CUTOFF',
  'OFFER_REGISTRATION_MISSING',
  'OFFER_REGISTRATION_MISMATCH',
  'OFFER_SESSION_NOT_ACCEPTABLE',
  'R1_DUPLICATE_REGISTRATION',
  'C2_DUPLICATE_HOLD',
  'C1_OVER_CAPACITY',
  'C1_HELD_MISMATCH',
  'C1_CONFIRMED_MISMATCH',
  'NO_STARVATION',
  'WORKSHOP_CANCELLED_LIVE_ITEMS',
] as const;
export type InvariantCode = (typeof INVARIANT_CODES)[number];

/**
 * Structural and domain invariants of a live snapshot (plan §2.2, used by tests, experiments
 * and the organiser `verify` endpoint):
 *
 *  - C1: `confirmed + held <= capacity`, `held` == live OFFERED offers of the session,
 *        `confirmed` == CONFIRMED registrations of the session;
 *  - C2: at most one OFFERED/CONFIRMED hold per user (per workshop in UNIFIED mode, per session
 *        in PER_SESSION mode), and R1: at most one live registration per scope;
 *  - offer <-> registration consistency (`currentOfferId`, user, acceptable session) and
 *        R4: no live offer outlives its session's cut-off;
 *  - no-starvation: no QUEUED registration has an acceptable OPEN session with a free seat
 *        before its cut-off at `now`;
 *  - a CANCELLED workshop has no live items. A session or workshop in CANCELLING state is
 *        being drained in budget-sized steps: references to it are tolerated meanwhile, and
 *        it is never offered.
 */
export function checkInvariants(snapshot: WorkshopSnapshot, now: string): InvariantReport {
  const nowMs = parseIso(now);
  const violations: InvariantViolation[] = [];
  const flag = (
    code: InvariantCode,
    message: string,
    where: { sessionId?: string; userId?: string } = {},
  ) => {
    violations.push({ code, message, ...where });
  };
  const { workshop, sessions, registrations, offers } = snapshot;
  const mode = workshop.mode;

  const sessionById = new Map<string, Session>();
  for (const session of sessions) {
    if (sessionById.has(session.id)) {
      flag('SESSION_DUPLICATE_ID', `session ${session.id} appears twice`, {
        sessionId: session.id,
      });
    }
    sessionById.set(session.id, session);
    if (session.workshopId !== workshop.id) {
      flag('SESSION_WORKSHOP_MISMATCH', `session ${session.id} belongs to ${session.workshopId}`, {
        sessionId: session.id,
      });
    }
  }

  const registrationBySeq = new Map<number, Registration>();
  for (const registration of registrations) {
    if (registrationBySeq.has(registration.seq)) {
      flag('SEQ_DUPLICATE', `seq ${registration.seq} appears twice`, {
        userId: registration.userId,
      });
    }
    registrationBySeq.set(registration.seq, registration);
    if (registration.seq > workshop.seq) {
      flag('SEQ_ABOVE_WORKSHOP', `seq ${registration.seq} > workshop.seq ${workshop.seq}`, {
        userId: registration.userId,
      });
    }
    if (registration.workshopId !== workshop.id) {
      flag(
        'REGISTRATION_WORKSHOP_MISMATCH',
        `registration ${registration.seq} belongs to another workshop`,
        {
          userId: registration.userId,
        },
      );
    }
  }

  const offerById = new Map<string, Offer>();
  for (const offer of offers) {
    if (offerById.has(offer.id)) {
      flag('OFFER_DUPLICATE_ID', `offer ${offer.id} appears twice`, { userId: offer.userId });
    }
    offerById.set(offer.id, offer);
    if (offer.workshopId !== workshop.id) {
      flag('OFFER_WORKSHOP_MISMATCH', `offer ${offer.id} belongs to another workshop`, {
        userId: offer.userId,
      });
    }
  }

  const heldCount = new Map<string, number>();
  const confirmedCount = new Map<string, number>();
  const bump = (counter: Map<string, number>, key: string) =>
    counter.set(key, (counter.get(key) ?? 0) + 1);

  for (const offer of offers) {
    if (offer.status !== 'OFFERED') {
      flag('OFFER_NOT_LIVE', `offer ${offer.id} is ${offer.status} but still live`, {
        userId: offer.userId,
      });
      continue;
    }
    bump(heldCount, offer.sessionId);
    const session = sessionById.get(offer.sessionId);
    if (session === undefined || session.status === 'CANCELLED') {
      flag('OFFER_SESSION_INVALID', `offer ${offer.id} targets a missing or cancelled session`, {
        sessionId: offer.sessionId,
        userId: offer.userId,
      });
    } else if (parseIso(offer.expiresAt) > parseIso(session.cutoffAt)) {
      flag('OFFER_AFTER_CUTOFF', `offer ${offer.id} expires after the session cut-off (R4)`, {
        sessionId: offer.sessionId,
        userId: offer.userId,
      });
    }
    const registration = registrationBySeq.get(offer.registrationSeq);
    if (registration === undefined) {
      flag('OFFER_REGISTRATION_MISSING', `offer ${offer.id} has no live registration`, {
        userId: offer.userId,
      });
    } else if (
      registration.status !== 'OFFERED' ||
      registration.currentOfferId !== offer.id ||
      registration.userId !== offer.userId
    ) {
      flag(
        'OFFER_REGISTRATION_MISMATCH',
        `offer ${offer.id} and registration ${registration.seq} disagree`,
        {
          userId: offer.userId,
        },
      );
    } else if (!registration.acceptable.includes(offer.sessionId)) {
      flag(
        'OFFER_SESSION_NOT_ACCEPTABLE',
        `offer ${offer.id} is for a session the user did not accept`,
        {
          sessionId: offer.sessionId,
          userId: offer.userId,
        },
      );
    }
  }

  const registrationsPerScope = new Map<string, number>();
  const holdsPerScope = new Map<string, number>();
  for (const registration of registrations) {
    const where = { userId: registration.userId };
    if (!isLiveRegistrationStatus(registration.status)) {
      flag(
        'REGISTRATION_NOT_LIVE',
        `registration ${registration.seq} is ${registration.status} but still live`,
        where,
      );
      continue;
    }
    if (registration.acceptable.length === 0) {
      flag(
        'REGISTRATION_NO_ACCEPTABLE',
        `registration ${registration.seq} has no acceptable session`,
        where,
      );
    }
    if (mode === 'PER_SESSION' && registration.acceptable.length !== 1) {
      flag(
        'REGISTRATION_PER_SESSION_SHAPE',
        `registration ${registration.seq} must bind exactly one session`,
        where,
      );
    }
    for (const sessionId of registration.acceptable) {
      const session = sessionById.get(sessionId);
      if (session === undefined) {
        flag(
          'REGISTRATION_UNKNOWN_SESSION',
          `registration ${registration.seq} lists unknown session ${sessionId}`,
          { ...where, sessionId },
        );
      } else if (session.status === 'CANCELLED') {
        flag(
          'REGISTRATION_CANCELLED_SESSION',
          `registration ${registration.seq} still lists cancelled session ${sessionId}`,
          { ...where, sessionId },
        );
      }
    }

    let holdSessionId: string | undefined;
    if (registration.status === 'OFFERED') {
      const offer =
        registration.currentOfferId === undefined
          ? undefined
          : offerById.get(registration.currentOfferId);
      if (offer === undefined) {
        flag(
          'REGISTRATION_OFFER_MISSING',
          `OFFERED registration ${registration.seq} has no live offer`,
          where,
        );
      } else if (
        offer.registrationSeq !== registration.seq ||
        offer.userId !== registration.userId
      ) {
        flag(
          'REGISTRATION_OFFER_MISMATCH',
          `OFFERED registration ${registration.seq} references offer ${offer.id} of someone else`,
          where,
        );
      } else {
        holdSessionId = offer.sessionId;
      }
    } else if (registration.currentOfferId !== undefined) {
      flag(
        'REGISTRATION_STRAY_OFFER_REF',
        `${registration.status} registration ${registration.seq} references an offer`,
        where,
      );
    }

    if (registration.status === 'CONFIRMED') {
      const session =
        registration.confirmedSessionId === undefined
          ? undefined
          : sessionById.get(registration.confirmedSessionId);
      if (
        session === undefined ||
        session.status === 'CANCELLED' ||
        !registration.acceptable.includes(session.id)
      ) {
        flag(
          'REGISTRATION_CONFIRMED_SESSION_INVALID',
          `CONFIRMED registration ${registration.seq} has an invalid session`,
          where,
        );
      } else {
        bump(confirmedCount, session.id);
        holdSessionId = session.id;
      }
    } else if (registration.confirmedSessionId !== undefined) {
      flag(
        'REGISTRATION_STRAY_CONFIRMED_SESSION',
        `${registration.status} registration ${registration.seq} has confirmedSessionId`,
        where,
      );
    }

    bump(registrationsPerScope, registrationScopeKey(mode, registration));
    if (holdSessionId !== undefined) {
      bump(holdsPerScope, holdScopeKey(mode, registration.userId, holdSessionId));
    }
  }
  for (const [scope, count] of registrationsPerScope) {
    if (count > 1) {
      flag('R1_DUPLICATE_REGISTRATION', `${count} live registrations in scope ${scope}`, {
        userId: scope.split('#')[0],
      });
    }
  }
  for (const [scope, count] of holdsPerScope) {
    if (count > 1) {
      flag('C2_DUPLICATE_HOLD', `${count} OFFERED/CONFIRMED holds in scope ${scope}`, {
        userId: scope.split('#')[0],
      });
    }
  }

  for (const session of sessions) {
    const where = { sessionId: session.id };
    if (session.confirmed + session.held > session.capacity) {
      flag(
        'C1_OVER_CAPACITY',
        `session ${session.id}: ${session.confirmed} + ${session.held} > ${session.capacity}`,
        where,
      );
    }
    const held = heldCount.get(session.id) ?? 0;
    if (session.held !== held) {
      flag(
        'C1_HELD_MISMATCH',
        `session ${session.id}: held=${session.held} but ${held} live offers`,
        where,
      );
    }
    const confirmed = confirmedCount.get(session.id) ?? 0;
    if (session.confirmed !== confirmed) {
      flag(
        'C1_CONFIRMED_MISMATCH',
        `session ${session.id}: confirmed=${session.confirmed} but ${confirmed} confirmed registrations`,
        where,
      );
    }
  }

  for (const registration of registrations) {
    // Nothing is allocated while the workshop is being cancelled: free seats are no starvation.
    if (registration.status !== 'QUEUED' || workshop.status === 'CANCELLING') {
      continue;
    }
    const starvedBy = registration.acceptable.find((sessionId) => {
      const session = sessionById.get(sessionId);
      return session !== undefined && isAllocatable(session, nowMs);
    });
    if (starvedBy !== undefined) {
      flag(
        'NO_STARVATION',
        `registration ${registration.seq} is QUEUED while session ${starvedBy} has a free seat`,
        {
          sessionId: starvedBy,
          userId: registration.userId,
        },
      );
    }
  }

  if (workshop.status === 'CANCELLED' && (registrations.length > 0 || offers.length > 0)) {
    flag(
      'WORKSHOP_CANCELLED_LIVE_ITEMS',
      'cancelled workshop still has live registrations or offers',
    );
  }

  return { ok: violations.length === 0, violations };
}
