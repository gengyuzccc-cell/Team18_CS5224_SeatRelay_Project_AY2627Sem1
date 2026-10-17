import { describe, expect, it } from 'vitest';
import type { NotificationDraft } from '../src/index';
import {
  DISPLAY_LOCALE,
  DISPLAY_TIME_ZONE,
  formatDisplayTime,
  sessionCancelledTitle,
} from '../src/index';
import { at, cmd, makeSnapshot, offerOf, registerMany, run } from './helpers';

/** An ISO-8601 timestamp anywhere in a text meant for people. */
const ISO_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** Raw enum values that must never reach a person. */
const ENUM_IN_TEXT = /NO_ACCEPTABLE_SESSION|CUTOFF|WORKSHOP_CANCELLED|EXPIRED|DECLINED|REVOKED/;

function expectReadable(notifications: readonly NotificationDraft[]): void {
  expect(notifications.length).toBeGreaterThan(0);
  for (const { title, body } of notifications) {
    expect(`${title}\n${body}`).not.toMatch(ISO_IN_TEXT);
    expect(`${title}\n${body}`).not.toMatch(ENUM_IN_TEXT);
  }
}

describe('formatDisplayTime (times in notification text)', () => {
  it('renders ISO UTC in the audience time zone as "Wed 21 Oct 2026, 10:00 SGT"', () => {
    expect(DISPLAY_TIME_ZONE).toBe('Asia/Singapore');
    expect(DISPLAY_LOCALE).toBe('en-SG');
    expect(formatDisplayTime('2026-10-21T02:00:00.000Z')).toBe('Wed 21 Oct 2026, 10:00 SGT');
    expect(formatDisplayTime('2026-10-17T17:29:25.813Z')).toBe('Sun 18 Oct 2026, 01:29 SGT');
    // UTC+8 crosses midnight; 24-hour clock with a leading zero.
    expect(formatDisplayTime('2026-11-03T16:05:00.000Z')).toBe('Wed 4 Nov 2026, 00:05 SGT');
  });

  it('is deterministic and rejects invalid input like the other time helpers', () => {
    expect(formatDisplayTime(at(0))).toBe(formatDisplayTime(at(0)));
    expect(() => formatDisplayTime('soon')).toThrow(/Invalid ISO timestamp/);
  });
});

describe('notification text', () => {
  it('offer: session start and hold end are written for people, never as ISO strings', () => {
    const r = run(makeSnapshot(), cmd.register(1, ['A']), at(0));
    const [offer] = r.decision.notifications;
    expect(offer).toMatchObject({ kind: 'OFFER', title: 'Seat offered: Session A' });
    // T0 = 2026-11-03T06:00Z; sessions start one day later; hold 600 s.
    expect(offer?.body).toBe(
      'A seat in "Session A" (starts Wed 4 Nov 2026, 14:00 SGT) of "Intro to Git" is held for ' +
        'you until Tue 3 Nov 2026, 14:10 SGT. Accept it before then, or it will be released for ' +
        'the next person waiting, if there is one.',
    );
    expectReadable(r.decision.notifications);
  });

  it('confirmation', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const r = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1));
    expect(r.decision.notifications[0]?.body).toBe(
      'Your seat in "Session A" (starts Wed 4 Nov 2026, 14:00 SGT) of "Intro to Git" is confirmed.',
    );
    expectReadable(r.decision.notifications);
  });

  it('expiry of the last chosen session: when it expired, what happened, what is still possible', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A'], at(0));
    const r = run(s, cmd.tick('TIMER'), at(12));
    const expired = r.decision.notifications.find((n) => n.kind === 'EXPIRED');
    expect(expired?.body).toBe(
      'Your hold on a seat in "Session A" (starts Wed 4 Nov 2026, 14:00 SGT) of "Intro to Git" ' +
        'expired at Tue 3 Nov 2026, 14:10 SGT because it was not accepted in time, so the seat is ' +
        'free again for the next person waiting, if there is one. That was the last session you ' +
        'had chosen, so your registration has ended. If registration is still open you can ' +
        'register again on the workshop page; you will join the end of the queue.',
    );
    expectReadable(r.decision.notifications);
  });

  it('expiry with other sessions left keeps the place in the queue', () => {
    const s = registerMany(makeSnapshot(), [1, 2], ['A', 'B'], at(0));
    const r = run(s, cmd.tick(), at(10));
    expect(r.decision.notifications[0]?.body).toMatch(
      /You keep your place in the queue for the other sessions you chose\.$/,
    );
    expectReadable(r.decision.notifications);
  });

  it('decline of the last chosen session says the participant declined it (not "could not be joined")', () => {
    const s = registerMany(makeSnapshot(), [1], ['A'], at(0));
    const r = run(s, cmd.decline(1, offerOf(s, 1)!.id), at(1));
    const body = r.decision.notifications[0]?.body ?? '';
    expect(body).toMatch(/^You declined the seat held for you in "Session A"/);
    // Nobody else is queued here: the text must not claim that someone received the seat.
    expect(body).toContain('so it is free again for the next person waiting, if there is one.');
    expect(body).not.toContain('next person in the queue');
    expect(body).toContain('That was the last session you had chosen');
    expect(body).not.toContain('could still be joined');
    expectReadable(r.decision.notifications);
  });

  it('decline whose other sessions are past cut-off names the cut-off', () => {
    const s0 = makeSnapshot({
      holdSeconds: 1800,
      sessions: [{ id: 'A' }, { id: 'B', startsInMinutes: 40 }],
    });
    const s = registerMany(s0, [1], ['A', 'B'], at(0));
    const r = run(s, cmd.decline(1, offerOf(s, 1)!.id), at(15));
    expect(r.decision.notifications[0]?.body).toMatch(
      /The other sessions you chose are past the registration cut-off \(30 minutes before the start\), so your registration has ended\.$/,
    );
    expectReadable(r.decision.notifications);
  });

  it('cut-off reached while queued', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A', startsInMinutes: 40 }] });
    const s = registerMany(s0, [1, 2], ['A'], at(0)); // u2 queued; cut-off at +10
    const r = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1));
    const ended = run(r.snapshot, cmd.tick('SWEEP'), at(11)).decision.notifications;
    expect(ended).toEqual([
      expect.objectContaining({
        kind: 'ENDED',
        userId: 'u2',
        title: 'Registration ended: Intro to Git',
        body:
          'Your registration for "Intro to Git" has ended: the registration cut-off (30 minutes ' +
          'before the start) passed for every session you had chosen before a seat became free for you.',
      }),
    ]);
    expectReadable(ended);
  });

  it('PER_SESSION: an ending is about that session’s registration, never "the last session you had chosen"', () => {
    // u1 registers separately for A and B (one registration per session) and holds both seats.
    const s0 = makeSnapshot({ mode: 'PER_SESSION', sessions: [{ id: 'A' }, { id: 'B' }] });
    let s = run(s0, cmd.register(1, ['A']), at(0)).snapshot;
    s = run(s, cmd.register(1, ['B']), at(1)).snapshot;
    // A's hold expires first: the registration for A ends, the one for B stays live (OFFERED).
    const r = run(s, cmd.tick('TIMER'), at(10));
    const expired = r.decision.notifications.find((n) => n.kind === 'EXPIRED');
    expect(expired?.title).toBe('Offer expired: Session A');
    expect(expired?.body).toMatch(
      /so the seat is free again for the next person waiting, if there is one\. Your registration for this session has ended; any registrations you have for other sessions are not affected\. If registration is still open you can register for this session again on the workshop page; you will join the end of its queue\.$/,
    );
    expect(expired?.body).not.toContain('last session');
    expect(r.snapshot.registrations.map((reg) => [reg.acceptable, reg.status])).toEqual([
      [['B'], 'OFFERED'],
    ]);
    expectReadable(r.decision.notifications);

    // The organiser cancels B: the session notice says the same, and is titled for matching.
    const cancelled = run(r.snapshot, cmd.cancelSession('B'), at(10)).decision.notifications;
    expect(cancelled).toEqual([
      expect.objectContaining({
        kind: 'REVOKED',
        title: sessionCancelledTitle({ title: 'Session B' }),
        body: expect.stringContaining('Your registration for this session has ended;'),
      }),
    ]);
  });

  it('PER_SESSION: cut-off reached while queued names the session', () => {
    const s0 = makeSnapshot({ mode: 'PER_SESSION', sessions: [{ id: 'A', startsInMinutes: 40 }] });
    const s = registerMany(s0, [1, 2], ['A'], at(0)); // u2 queued; cut-off at +10
    const r = run(s, cmd.accept(1, offerOf(s, 1)!.id), at(1));
    const ended = run(r.snapshot, cmd.tick('SWEEP'), at(11)).decision.notifications;
    expect(ended).toEqual([
      expect.objectContaining({
        kind: 'ENDED',
        userId: 'u2',
        body:
          'Your registration for "Intro to Git" has ended: the registration cut-off (30 minutes ' +
          'before the start) passed for "Session A" (starts Tue 3 Nov 2026, 14:40 SGT) before a ' +
          'seat became free for you.',
      }),
    ]);
    expectReadable(ended);
  });

  it('session and workshop cancellations', () => {
    const s0 = makeSnapshot({ sessions: [{ id: 'A' }, { id: 'B' }] });
    let s = registerMany(s0, [1, 2], ['A'], at(0)); // u1 holds A, u2 queued for A only
    s = run(s, cmd.register(3, ['B']), at(0)).snapshot; // u3 holds B
    const session = run(s, cmd.cancelSession('A'), at(1));
    const byKind = Object.fromEntries(session.decision.notifications.map((n) => [n.kind, n.body]));
    expect(byKind.REVOKED).toMatch(
      /^The organiser cancelled "Session A" \(starts Wed 4 Nov 2026, 14:00 SGT\) of "Intro to Git", so the seat held for you there was withdrawn\. That was the last session/,
    );
    expect(byKind.SESSION_CANCELLED).toMatch(
      /^The organiser cancelled "Session A" .* That was the last session you had chosen/,
    );
    expect(
      session.decision.notifications.filter(
        (n) => n.title === sessionCancelledTitle({ title: 'Session A' }),
      ),
    ).toHaveLength(2);
    expectReadable(session.decision.notifications);

    const workshop = run(session.snapshot, cmd.cancelWorkshop(), at(2));
    expect(workshop.decision.notifications).toEqual([
      expect.objectContaining({
        kind: 'WORKSHOP_CANCELLED',
        userId: 'u3',
        body:
          'The organiser cancelled "Intro to Git". Your registration has ended, and any seat held ' +
          'or confirmed for you was released.',
      }),
    ]);
    expectReadable(workshop.decision.notifications);
  });
});
