import { describe, expect, it } from 'vitest';
import { checkInvariants, type WorkshopSnapshot } from '../src/index';
import { at, cmd, makeSnapshot, offerOf, registerMany, run } from './helpers';

type Mutation = (snapshot: WorkshopSnapshot) => void;

function fixture(): WorkshopSnapshot {
  const s0 = makeSnapshot({ sessions: [{ id: 'A', capacity: 2 }, { id: 'B' }] });
  let s = registerMany(s0, [1, 2], ['A', 'B'], at(0)); // u1, u2 hold A
  s = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1)).snapshot; // u1 confirmed
  s = registerMany(s, [3], ['A'], at(2)); // u3 queued (A full, B not acceptable)
  return s;
}

const cases: [string, Mutation][] = [
  ['SESSION_DUPLICATE_ID', (s) => s.sessions.push({ ...s.sessions[0]! })],
  ['SESSION_WORKSHOP_MISMATCH', (s) => (s.sessions[1]!.workshopId = 'other')],
  ['SEQ_DUPLICATE', (s) => (s.registrations[2]!.seq = 1)],
  ['SEQ_ABOVE_WORKSHOP', (s) => (s.workshop.seq = 1)],
  ['REGISTRATION_WORKSHOP_MISMATCH', (s) => (s.registrations[2]!.workshopId = 'other')],
  ['REGISTRATION_NOT_LIVE', (s) => (s.registrations[2]!.status = 'CANCELLED')],
  ['REGISTRATION_NO_ACCEPTABLE', (s) => (s.registrations[2]!.acceptable = [])],
  ['REGISTRATION_UNKNOWN_SESSION', (s) => (s.registrations[2]!.acceptable = ['Z'])],
  [
    'REGISTRATION_CANCELLED_SESSION',
    (s) => {
      s.sessions[1]!.status = 'CANCELLED';
      s.registrations[1]!.acceptable = ['A', 'B'];
    },
  ],
  [
    'REGISTRATION_PER_SESSION_SHAPE',
    (s) => {
      s.workshop.mode = 'PER_SESSION';
    },
  ],
  ['REGISTRATION_OFFER_MISSING', (s) => (s.registrations[1]!.currentOfferId = 'ghost')],
  ['REGISTRATION_OFFER_MISSING', (s) => delete s.registrations[1]!.currentOfferId],
  ['REGISTRATION_STRAY_OFFER_REF', (s) => (s.registrations[2]!.currentOfferId = 'ghost')],
  ['REGISTRATION_CONFIRMED_SESSION_INVALID', (s) => (s.registrations[0]!.confirmedSessionId = 'Z')],
  ['REGISTRATION_CONFIRMED_SESSION_INVALID', (s) => delete s.registrations[0]!.confirmedSessionId],
  ['REGISTRATION_CONFIRMED_SESSION_INVALID', (s) => (s.registrations[0]!.acceptable = ['B'])],
  ['REGISTRATION_STRAY_CONFIRMED_SESSION', (s) => (s.registrations[2]!.confirmedSessionId = 'A')],
  ['OFFER_DUPLICATE_ID', (s) => s.offers.push({ ...s.offers[0]! })],
  ['OFFER_WORKSHOP_MISMATCH', (s) => (s.offers[0]!.workshopId = 'other')],
  ['OFFER_NOT_LIVE', (s) => (s.offers[0]!.status = 'DECLINED')],
  ['OFFER_SESSION_INVALID', (s) => (s.offers[0]!.sessionId = 'Z')],
  ['OFFER_REGISTRATION_MISSING', (s) => (s.offers[0]!.registrationSeq = 99)],
  ['OFFER_REGISTRATION_MISMATCH', (s) => (s.offers[0]!.userId = 'u9')],
  ['OFFER_REGISTRATION_MISMATCH', (s) => (s.offers[0]!.registrationSeq = 3)],
  ['OFFER_SESSION_NOT_ACCEPTABLE', (s) => (s.registrations[1]!.acceptable = ['B'])],
  ['R1_DUPLICATE_REGISTRATION', (s) => (s.registrations[2]!.userId = 'u1')],
  [
    'C2_DUPLICATE_HOLD',
    (s) => {
      s.registrations[2]!.userId = 'u1';
      s.registrations[2]!.status = 'CONFIRMED';
      s.registrations[2]!.confirmedSessionId = 'A';
    },
  ],
  ['C1_OVER_CAPACITY', (s) => (s.sessions[0]!.capacity = 1)],
  ['C1_HELD_MISMATCH', (s) => (s.sessions[0]!.held = 0)],
  ['C1_CONFIRMED_MISMATCH', (s) => (s.sessions[0]!.confirmed = 0)],
  ['NO_STARVATION', (s) => (s.sessions[0]!.capacity = 3)],
  ['WORKSHOP_CANCELLED_LIVE_ITEMS', (s) => (s.workshop.status = 'CANCELLED')],
];

describe('checkInvariants', () => {
  it('accepts a consistent snapshot', () => {
    expect(checkInvariants(fixture(), at(3))).toEqual({ ok: true, violations: [] });
    expect(checkInvariants(makeSnapshot(), at(0)).ok).toBe(true);
  });

  it.each(cases)('flags %s', (code, mutate) => {
    const snapshot = fixture();
    mutate(snapshot);
    const report = checkInvariants(snapshot, at(3));
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.code)).toContain(code);
  });

  it('attaches sessionId / userId where known', () => {
    const snapshot = fixture();
    snapshot.sessions[0]!.held = 5;
    const report = checkInvariants(snapshot, at(3));
    expect(report.violations).toEqual([
      expect.objectContaining({ code: 'C1_OVER_CAPACITY', sessionId: 'A' }),
      expect.objectContaining({ code: 'C1_HELD_MISMATCH', sessionId: 'A' }),
    ]);
  });

  it('does not treat a past cut-off or a due offer as starvation', () => {
    const snapshot = fixture();
    expect(checkInvariants(snapshot, at(60 * 24)).ok).toBe(true);
  });
});
