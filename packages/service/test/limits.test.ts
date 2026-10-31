import type { Registration } from '@seatrelay/contracts';
import { describe, expect, test } from 'vitest';
import { MAX_MY_NOTIFICATIONS, MAX_MY_REGISTRATIONS, mostRecentRegistrations } from '../src/index';

const registration = (seq: number, updatedAt: string): Registration =>
  ({ seq, updatedAt, workshopId: 'ws', userId: 'u', status: 'QUEUED' }) as unknown as Registration;

describe('per-user list caps', () => {
  test('the caps are the documented 500 / 500', () => {
    expect(MAX_MY_REGISTRATIONS).toBe(500);
    expect(MAX_MY_NOTIFICATIONS).toBe(500);
  });

  test('mostRecentRegistrations keeps the newest `limit`, ties broken by seq, input untouched', () => {
    const input = [
      registration(1, '2026-11-01T00:00:00.000Z'),
      registration(2, '2026-11-03T00:00:00.000Z'),
      registration(3, '2026-11-02T00:00:00.000Z'),
      registration(4, '2026-11-03T00:00:00.000Z'),
    ];
    const copy = [...input];
    expect(mostRecentRegistrations(input, 3).map((r) => r.seq)).toEqual([4, 2, 3]);
    expect(input).toEqual(copy);
    expect(mostRecentRegistrations(input).map((r) => r.seq)).toEqual([4, 2, 3, 1]);
    expect(mostRecentRegistrations([], 3)).toEqual([]);
  });
});
