import { describe, expect, test } from 'vitest';
import {
  DUE_GSI_PK,
  attendanceKey,
  commandKey,
  dueGsi,
  dueGsiUpperBound,
  dueMarkerKey,
  historyBackfillKey,
  historyOfferKey,
  historyRegistrationKey,
  liveOfferKey,
  liveRegistrationKey,
  notificationKey,
  orgKey,
  orgMemberKey,
  orgMembershipGsi,
  padSeq,
  pendingBackfillKey,
  registrationGsi,
  sessionKey,
  uniqueMarkerKey,
  workshopGsi,
  workshopKey,
} from '../src/adapters/dynamo/keys';

describe('key builders (plan §2.3)', () => {
  test('partition and sort keys follow the table exactly', () => {
    expect(orgKey('o1')).toEqual({ PK: 'ORG#o1', SK: 'META' });
    expect(orgMemberKey('o1', 'u1')).toEqual({ PK: 'ORG#o1', SK: 'M#u1' });
    expect(workshopKey('w1')).toEqual({ PK: 'WS#w1', SK: 'L#META' });
    expect(dueMarkerKey('w1')).toEqual({ PK: 'WS#w1', SK: 'L#DUE' });
    expect(sessionKey('w1', 's1')).toEqual({ PK: 'WS#w1', SK: 'L#S#s1' });
    expect(liveRegistrationKey('w1', 7)).toEqual({ PK: 'WS#w1', SK: 'L#R#00000007' });
    expect(historyRegistrationKey('w1', 7)).toEqual({ PK: 'WS#w1', SK: 'H#R#00000007' });
    expect(uniqueMarkerKey('w1', 'u1')).toEqual({ PK: 'WS#w1', SK: 'L#U#u1' });
    expect(uniqueMarkerKey('w1', 'u1#s1')).toEqual({ PK: 'WS#w1', SK: 'L#U#u1#s1' });
    expect(liveOfferKey('w1', 'of1')).toEqual({ PK: 'WS#w1', SK: 'L#O#of1' });
    expect(historyOfferKey('w1', 'of1')).toEqual({ PK: 'WS#w1', SK: 'H#O#of1' });
    expect(pendingBackfillKey('w1', '2026-11-03T06:00:00.000Z', 'b1')).toEqual({
      PK: 'WS#w1',
      SK: 'L#BF#2026-11-03T06:00:00.000Z#b1',
    });
    expect(historyBackfillKey('w1', '2026-11-03T06:00:00.000Z', 'b1')).toEqual({
      PK: 'WS#w1',
      SK: 'H#BF#2026-11-03T06:00:00.000Z#b1',
    });
    expect(attendanceKey('w1', 'u1')).toEqual({ PK: 'WS#w1', SK: 'H#A#u1' });
    expect(commandKey('c1')).toEqual({ PK: 'CMD#c1', SK: 'META' });
    expect(notificationKey('u1', '2026-11-03T06:00:00.000Z', 'n1')).toEqual({
      PK: 'U#u1',
      SK: 'N#2026-11-03T06:00:00.000Z#n1',
    });
  });

  test('live and history prefixes separate the snapshot from settled data', () => {
    const live = [
      workshopKey('w').SK,
      dueMarkerKey('w').SK,
      sessionKey('w', 's').SK,
      liveRegistrationKey('w', 1).SK,
      uniqueMarkerKey('w', 'u').SK,
      liveOfferKey('w', 'o').SK,
      pendingBackfillKey('w', 't', 'b').SK,
    ];
    const history = [
      historyRegistrationKey('w', 1).SK,
      historyOfferKey('w', 'o').SK,
      historyBackfillKey('w', 't', 'b').SK,
      attendanceKey('w', 'u').SK,
    ];
    for (const sk of live) expect(sk.startsWith('L#')).toBe(true);
    for (const sk of history) expect(sk.startsWith('H#')).toBe(true);
  });

  test('seq is zero-padded to 8 digits so keys sort numerically', () => {
    expect(padSeq(0)).toBe('00000000');
    expect(padSeq(123)).toBe('00000123');
    expect(padSeq(99_999_999)).toBe('99999999');
    expect(() => padSeq(100_000_000)).toThrow(/out of range/);
    expect(() => padSeq(-1)).toThrow(/out of range/);
    expect(() => padSeq(1.5)).toThrow(/out of range/);
    const keys = [10, 9, 100, 1].map((seq) => liveRegistrationKey('w', seq).SK).sort();
    expect(keys).toEqual(['L#R#00000001', 'L#R#00000009', 'L#R#00000010', 'L#R#00000100']);
  });

  test('GSI1 keys', () => {
    expect(orgMembershipGsi('o1', 'u1')).toEqual({ GSI1PK: 'U#u1', GSI1SK: 'ORG#o1' });
    expect(workshopGsi('o1', '2026-11-03T06:00:00.000Z')).toEqual({
      GSI1PK: 'ORG#o1',
      GSI1SK: 'WS#2026-11-03T06:00:00.000Z',
    });
    expect(registrationGsi('u1', 'w1')).toEqual({ GSI1PK: 'U#u1', GSI1SK: 'WS#w1' });
    expect(dueGsi('2026-11-03T06:00:00.000Z', 'w1')).toEqual({
      GSI1PK: DUE_GSI_PK,
      GSI1SK: '2026-11-03T06:00:00.000Z#w1',
    });
  });

  test('DUE upper bound covers every workshop due at or before now', () => {
    const now = '2026-11-03T06:00:00.000Z';
    const bound = dueGsiUpperBound(now);
    expect(dueGsi('2026-11-03T05:59:59.999Z', 'zzz').GSI1SK <= bound).toBe(true);
    expect(dueGsi(now, '0000-ws').GSI1SK <= bound).toBe(true);
    expect(dueGsi(now, 'ffffffff-ffff').GSI1SK <= bound).toBe(true);
    expect(dueGsi('2026-11-03T06:00:00.001Z', 'a').GSI1SK <= bound).toBe(false);
  });
});
