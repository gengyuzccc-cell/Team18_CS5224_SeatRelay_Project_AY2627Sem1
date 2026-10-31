import { describe, expect, it } from 'vitest';
import {
  CreateSessionInputSchema,
  CreateWorkshopBodySchema,
  MAX_CAPACITY,
  RegisterBodySchema,
  SetCapacityBodySchema,
} from '../src/index';

/**
 * Audit of the input bounds (engine lens, 2026-10-30). Before the audit `capacity` had no upper
 * bound, so a value above `Number.MAX_SAFE_INTEGER` (2^53 − 1) passed validation although no
 * adapter can store it: the DynamoDB document client throws "Number ... is greater than
 * Number.MAX_SAFE_INTEGER" when marshalling the session item, and the Postgres
 * `sessions.capacity` column is `integer` (max 2 147 483 647). On the command path
 * (SET_CAPACITY) the throw happened in the worker's commit, so the message was redelivered
 * until the DLQ took it (3 receives × 120 s) and every later command of that workshop waited
 * behind it. `MAX_CAPACITY` now bounds the schemas (and the engine, apply.ts).
 */

const UUID = '8f0d2a7e-6f4b-4a7c-9c1e-2a3b4c5d6e7f';
const TOO_LARGE = 2 ** 53; // > Number.MAX_SAFE_INTEGER, still an integer for zod's .int()

describe('audit: numeric bounds', () => {
  it('SET_CAPACITY accepts MAX_CAPACITY and rejects anything above it', () => {
    const body = (capacity: number) =>
      SetCapacityBodySchema.safeParse({
        type: 'SET_CAPACITY',
        commandId: UUID,
        sessionId: 's1',
        capacity,
      });
    expect(body(MAX_CAPACITY).success).toBe(true);
    expect(body(MAX_CAPACITY + 1).success).toBe(false);
    expect(body(TOO_LARGE).success).toBe(false);
  });

  it('a new session accepts MAX_CAPACITY and rejects anything above it', () => {
    const input = (capacity: number) =>
      CreateSessionInputSchema.safeParse({
        title: 'Session',
        startsAt: '2026-12-01T02:00:00.000Z',
        capacity,
      });
    expect(input(MAX_CAPACITY).success).toBe(true);
    expect(input(MAX_CAPACITY + 1).success).toBe(false);
    expect(input(TOO_LARGE).success).toBe(false);
  });

  it('keeps the bounds that are enforced today', () => {
    expect(
      SetCapacityBodySchema.safeParse({
        type: 'SET_CAPACITY',
        commandId: UUID,
        sessionId: 's1',
        capacity: 2.5,
      }).success,
    ).toBe(false);
    expect(
      SetCapacityBodySchema.safeParse({
        type: 'SET_CAPACITY',
        commandId: UUID,
        sessionId: 's1',
        capacity: 0,
      }).success,
    ).toBe(true); // engine rejects INVALID_CAPACITY
    expect(
      RegisterBodySchema.safeParse({
        type: 'REGISTER',
        commandId: UUID,
        acceptable: ['a', 'b', 'c', 'd', 'e', 'f'],
      }).success,
    ).toBe(false);
    expect(
      RegisterBodySchema.safeParse({ type: 'REGISTER', commandId: UUID, acceptable: [] }).success,
    ).toBe(false);
    const sessions = [
      { title: 'A', startsAt: '2026-12-01T02:00:00.000Z', capacity: 1 },
      { title: 'B', startsAt: '2026-12-01T02:00:00+08:00', capacity: 1 },
    ];
    expect(
      CreateWorkshopBodySchema.safeParse({ title: 't', holdSeconds: 29, sessions }).success,
    ).toBe(false);
    expect(
      CreateWorkshopBodySchema.safeParse({ title: 't', holdSeconds: 86_401, sessions }).success,
    ).toBe(false);
    expect(
      CreateWorkshopBodySchema.safeParse({ title: 't', sessions: sessions.slice(0, 1) }).success,
    ).toBe(false);
    expect(CreateWorkshopBodySchema.safeParse({ title: ' '.repeat(3), sessions }).success).toBe(
      false,
    );
    expect(CreateWorkshopBodySchema.safeParse({ title: 'x'.repeat(201), sessions }).success).toBe(
      false,
    );
    const ok = CreateWorkshopBodySchema.safeParse({ title: 't', sessions });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.sessions[1]?.startsAt).toBe('2026-11-30T18:00:00.000Z'); // offset normalised to UTC
  });
});
