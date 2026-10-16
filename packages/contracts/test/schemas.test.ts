import { describe, expect, it } from 'vitest';
import {
  AddMemberBodySchema,
  CommandBodySchema,
  CommandSchema,
  CreateWorkshopBodySchema,
  DashboardViewSchema,
  ErrorBodySchema,
  IsoTimestampSchema,
  OfferSchema,
  PatchWorkshopBodySchema,
  REJECT_REASONS,
  RegistrationSchema,
  RejectReasonSchema,
  SessionSchema,
  USER_COMMAND_TYPES,
  WorkshopPublicViewSchema,
  WorkshopSchema,
  buildCommand,
  isInternalCommand,
  isUserCommand,
} from '../src/index';

const T = '2026-11-03T06:00:00.000Z';
const UUID = '8f0d2a7e-6f4b-4a7c-9c1e-2a3b4c5d6e7f';

describe('primitives', () => {
  it('accepts ISO UTC timestamps with milliseconds and rejects other forms', () => {
    expect(IsoTimestampSchema.safeParse(T).success).toBe(true);
    expect(IsoTimestampSchema.safeParse('2026-11-03T06:00:00Z').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('2026-11-03T14:00:00.000+08:00').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('not a date').success).toBe(false);
  });
});

describe('entities', () => {
  it('validates a workshop and rejects holdSeconds outside [30, 86400]', () => {
    const base = {
      id: 'ws1',
      orgId: 'org1',
      title: 'Intro to Git',
      description: '',
      status: 'OPEN',
      mode: 'UNIFIED',
      holdSeconds: 900,
      seq: 0,
      version: 0,
      createdAt: T,
      updatedAt: T,
    };
    expect(WorkshopSchema.safeParse(base).success).toBe(true);
    expect(WorkshopSchema.safeParse({ ...base, holdSeconds: 10 }).success).toBe(false);
    expect(WorkshopSchema.safeParse({ ...base, holdSeconds: 100_000 }).success).toBe(false);
    expect(WorkshopSchema.safeParse({ ...base, status: 'PAUSED' }).success).toBe(false);
  });

  it('validates sessions, registrations and offers', () => {
    expect(
      SessionSchema.safeParse({
        id: 's1',
        workshopId: 'ws1',
        title: 'Session 1',
        startsAt: T,
        cutoffAt: '2026-11-03T05:30:00.000Z',
        capacity: 3,
        confirmed: 0,
        held: 0,
        status: 'OPEN',
      }).success,
    ).toBe(true);
    expect(
      SessionSchema.safeParse({
        id: 's1',
        workshopId: 'ws1',
        title: 'Session 1',
        startsAt: T,
        cutoffAt: T,
        capacity: 0,
        confirmed: 0,
        held: 0,
        status: 'OPEN',
      }).success,
    ).toBe(false);
    const registration = {
      workshopId: 'ws1',
      userId: 'u1',
      email: 'u1@example.com',
      seq: 1,
      acceptable: ['s1', 's2'],
      status: 'QUEUED',
      createdAt: T,
      updatedAt: T,
    };
    expect(RegistrationSchema.safeParse(registration).success).toBe(true);
    expect(RegistrationSchema.safeParse({ ...registration, seq: 0 }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...registration, email: 'nope' }).success).toBe(false);
    expect(
      OfferSchema.safeParse({
        id: 'o1',
        workshopId: 'ws1',
        sessionId: 's1',
        userId: 'u1',
        registrationSeq: 1,
        status: 'OFFERED',
        createdAt: T,
        expiresAt: T,
      }).success,
    ).toBe(true);
  });
});

describe('commands', () => {
  it('parses every user command body and rejects unknown types / bad ids', () => {
    expect(
      CommandBodySchema.safeParse({ type: 'REGISTER', commandId: UUID, acceptable: ['s1'] })
        .success,
    ).toBe(true);
    expect(
      CommandBodySchema.safeParse({ type: 'REGISTER', commandId: UUID, acceptable: [] }).success,
    ).toBe(false);
    expect(
      CommandBodySchema.safeParse({ type: 'REGISTER', commandId: 'not-uuid', acceptable: ['s1'] })
        .success,
    ).toBe(false);
    expect(
      CommandBodySchema.safeParse({ type: 'ACCEPT_OFFER', commandId: UUID, offerId: 'o1' }).success,
    ).toBe(true);
    expect(CommandBodySchema.safeParse({ type: 'ACCEPT_OFFER', commandId: UUID }).success).toBe(
      false,
    );
    expect(
      CommandBodySchema.safeParse({
        type: 'SET_CAPACITY',
        commandId: UUID,
        sessionId: 's1',
        capacity: 2.5,
      }).success,
    ).toBe(false);
    expect(CommandBodySchema.safeParse({ type: 'CANCEL_WORKSHOP', commandId: UUID }).success).toBe(
      true,
    );
    expect(CommandBodySchema.safeParse({ type: 'TICK', workshopId: 'ws1' }).success).toBe(false);
    expect(CommandBodySchema.safeParse({ type: 'NUKE', commandId: UUID }).success).toBe(false);
    expect(
      CommandBodySchema.safeParse({
        type: 'CANCEL_WORKSHOP',
        commandId: UUID,
        _fault: 'AFTER_COMMIT',
      }).success,
    ).toBe(true);
    expect(
      CommandBodySchema.safeParse({ type: 'CANCEL_WORKSHOP', commandId: UUID, _fault: 'BOOM' })
        .success,
    ).toBe(false);
  });

  it('builds a full command from a body and the JWT identity', () => {
    const body = CommandBodySchema.parse({ type: 'REGISTER', commandId: UUID, acceptable: ['s1'] });
    const command = buildCommand(body, 'ws1', {
      userId: 'u1',
      email: 'u1@example.com',
      name: 'U1',
    });
    expect(command).toEqual({
      type: 'REGISTER',
      commandId: UUID,
      acceptable: ['s1'],
      workshopId: 'ws1',
      actorUserId: 'u1',
      actorEmail: 'u1@example.com',
      actorDisplayName: 'U1',
    });
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(isUserCommand(command)).toBe(true);
    expect(isInternalCommand(command)).toBe(false);
    const noName = buildCommand(body, 'ws1', { userId: 'u1', email: 'u1@example.com' });
    expect('actorDisplayName' in noName).toBe(false);
  });

  it('parses internal commands and the full command union', () => {
    const tick = CommandSchema.parse({ type: 'TICK', workshopId: 'ws1', source: 'SWEEP' });
    expect(isInternalCommand(tick)).toBe(true);
    expect(CommandSchema.safeParse({ type: 'REALLOCATE', workshopId: 'ws1' }).success).toBe(true);
    expect(
      CommandSchema.safeParse({ type: 'REGISTER', commandId: UUID, acceptable: ['s1'] }).success,
    ).toBe(false);
  });

  it('exposes the reject reasons and command types as closed sets', () => {
    expect(REJECT_REASONS).toContain('OFFER_NOT_YOURS');
    expect(RejectReasonSchema.safeParse('SOMETHING_ELSE').success).toBe(false);
    expect(USER_COMMAND_TYPES).toHaveLength(9);
  });
});

describe('api bodies', () => {
  it('applies defaults and bounds on CreateWorkshopBody', () => {
    const parsed = CreateWorkshopBodySchema.parse({
      title: '  Intro to Git ',
      sessions: [
        { title: 'A', startsAt: '2026-11-03T14:00:00+08:00', capacity: 3 },
        { title: 'B', startsAt: '2026-11-04T06:00:00Z', capacity: 3 },
      ],
    });
    expect(parsed.title).toBe('Intro to Git');
    expect(parsed.holdSeconds).toBe(900);
    expect(parsed.mode).toBe('UNIFIED');
    expect(parsed.description).toBe('');
    expect(parsed.sessions[0]?.startsAt).toBe('2026-11-03T06:00:00.000Z');
    expect(parsed.sessions[1]?.startsAt).toBe('2026-11-04T06:00:00.000Z');

    const one = { title: 'X', sessions: [{ title: 'A', startsAt: T, capacity: 1 }] };
    expect(CreateWorkshopBodySchema.safeParse(one).success).toBe(false);
    const six = {
      title: 'X',
      sessions: Array.from({ length: 6 }, (_, i) => ({ title: `S${i}`, startsAt: T, capacity: 1 })),
    };
    expect(CreateWorkshopBodySchema.safeParse(six).success).toBe(false);
    expect(
      CreateWorkshopBodySchema.safeParse({
        title: 'X',
        holdSeconds: 5,
        sessions: [
          { title: 'A', startsAt: T, capacity: 1 },
          { title: 'B', startsAt: T, capacity: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      CreateWorkshopBodySchema.safeParse({
        title: 'X',
        sessions: [
          { title: 'A', startsAt: T, capacity: 0 },
          { title: 'B', startsAt: T, capacity: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires at least one field on patch / add-member bodies', () => {
    expect(PatchWorkshopBodySchema.safeParse({}).success).toBe(false);
    expect(PatchWorkshopBodySchema.safeParse({ title: 'New' }).success).toBe(true);
    expect(AddMemberBodySchema.safeParse({}).success).toBe(false);
    expect(AddMemberBodySchema.safeParse({ email: 'x@example.com' }).success).toBe(true);
  });

  it('validates response views and error bodies', () => {
    expect(ErrorBodySchema.safeParse({ code: 'NOT_FOUND', message: 'nope' }).success).toBe(true);
    expect(ErrorBodySchema.safeParse({ code: 'TEAPOT', message: 'nope' }).success).toBe(false);
    const view = {
      workshop: {
        id: 'ws1',
        orgId: 'org1',
        title: 'T',
        description: '',
        status: 'OPEN',
        mode: 'UNIFIED',
        holdSeconds: 900,
        createdAt: T,
        updatedAt: T,
      },
      sessions: [
        {
          id: 's1',
          workshopId: 'ws1',
          title: 'A',
          startsAt: T,
          cutoffAt: T,
          capacity: 2,
          confirmed: 1,
          held: 1,
          free: 0,
          queueLength: 3,
          status: 'OPEN',
        },
      ],
      queueLength: 3,
      me: { status: 'QUEUED', seq: 4, queuePosition: 3, acceptable: ['s1'] },
    };
    expect(WorkshopPublicViewSchema.safeParse(view).success).toBe(true);
    expect(
      WorkshopPublicViewSchema.safeParse({ ...view, workshop: { ...view.workshop, seq: 1 } })
        .success,
    ).toBe(true); // unknown keys are stripped, not rejected
    expect(
      DashboardViewSchema.safeParse({
        workshop: { ...view.workshop, seq: 4, version: 9 },
        sessions: view.sessions,
        queue: [],
        offered: [],
        confirmed: [],
        backfills: [],
        distinctParticipantsServed: 0,
        attendance: [],
        counts: {
          queued: 0,
          offered: 0,
          confirmed: 0,
          backfills: 0,
          backfillsReallocated: 0,
          attended: 0,
        },
      }).success,
    ).toBe(true);
  });
});
