import type { MyRegistrationView } from '@seatrelay/contracts';
import { describe, expect, it } from 'vitest';
import {
  describeEnding,
  describeRegistration,
  describeSettled,
  END_REASON_TEXT,
  endReasonText,
  pastStatusText,
} from '../src/commands/copy';
import { formatMoment } from '../src/util/time';
import { S1, S2, sessions, settledView, summary } from './fixtures';

type Listed = MyRegistrationView['registration'];

const ENDED_AT = '2026-11-03T06:05:00.000Z';
/** Same day as ENDED_AT, a few minutes later (the "now" of the page). */
const NOW = Date.parse('2026-11-03T06:09:00.000Z');

function past(overrides: Partial<Listed>): Listed {
  return {
    status: 'ENDED',
    seq: 4,
    acceptable: [],
    createdAt: '2026-11-03T05:00:00.000Z',
    updatedAt: ENDED_AT,
    ...overrides,
  };
}

const offer = (status: 'EXPIRED' | 'DECLINED' | 'REVOKED', sessionId = S2) => ({
  id: 'o1',
  sessionId,
  status,
  expiresAt: '2026-11-03T06:04:30.000Z',
  settledAt: ENDED_AT,
});

/** Raw enum values must never reach the participant. */
const RAW = /NO_ACCEPTABLE_SESSION|CUTOFF|WORKSHOP_CANCELLED|EXPIRED|DECLINED|REVOKED|_/;

describe('formatMoment', () => {
  it('"at <time>" on the same day, "on <date, time>" otherwise', () => {
    expect(formatMoment(ENDED_AT, NOW)).toMatch(/^at \S/);
    expect(formatMoment(ENDED_AT, NOW + 3 * 86_400_000)).toMatch(/^on \S/);
    expect(formatMoment('not a date', NOW)).toBe('at not a date');
  });
});

describe('end-reason copy states what happened', () => {
  it('NO_ACCEPTABLE_SESSION names the participant’s own decline/expiry and the organiser', () => {
    expect(END_REASON_TEXT.NO_ACCEPTABLE_SESSION).not.toContain('could still be joined');
    expect(END_REASON_TEXT.NO_ACCEPTABLE_SESSION).toMatch(/declined or let expire/);
    expect(END_REASON_TEXT.NO_ACCEPTABLE_SESSION).toMatch(/organiser cancelled/);
    expect(END_REASON_TEXT.CUTOFF).toMatch(/cut-off \(30 minutes before the start\) passed/);
    expect(END_REASON_TEXT.WORKSHOP_CANCELLED).toBe('the organiser cancelled the workshop');
  });

  it('a decline that ended the registration says so in the toast', () => {
    const ended = summary({
      status: 'ENDED',
      queuePosition: undefined,
      acceptable: [],
      endReason: 'NO_ACCEPTABLE_SESSION',
    });
    // Not "that was the last session": an organiser cancellation drained in the same decision
    // can have removed the last one after the decline put the participant back in the queue.
    expect(describeRegistration(ended, sessions, NOW, 'DECLINE_OFFER')).toBe(
      'You declined the seat. No session you had chosen is left, so your registration has ended.',
    );
    expect(
      describeSettled(settledView('APPLIED', ended, { type: 'DECLINE_OFFER' }), sessions, NOW)
        .message,
    ).toContain('You declined the seat.');
    // without the command (e.g. an old toast) the generic reason is still plain words
    expect(describeRegistration(ended, sessions, NOW)).toBe(
      `Your registration has ended: ${END_REASON_TEXT.NO_ACCEPTABLE_SESSION}.`,
    );
    // The result does not say what was held: no claim that a seat was released, or to whom.
    expect(
      describeRegistration(summary({ status: 'CANCELLED', queuePosition: undefined }), sessions),
    ).toBe(
      'Your registration is cancelled. If you held or had a confirmed seat, it is free again for the next person waiting.',
    );
  });
});

describe('describeEnding (ended status card and the Past list)', () => {
  it('hold expired on the last chosen session', () => {
    const copy = describeEnding(
      past({ endReason: 'NO_ACCEPTABLE_SESSION', ending: { offer: offer('EXPIRED') } }),
      sessions,
      NOW,
    );
    expect(copy.summary).toBe('ended: your hold on Session 2 expired');
    expect(copy.detail).toMatch(
      /^Your hold for Session 2 expired at .+ without being accepted — the seat is free again for the next person waiting, if there is one\. That was the last session you had chosen, so your registration has ended\.$/,
    );
  });

  it('declined the last chosen session; declined with the rest past cut-off', () => {
    const declined = describeEnding(
      past({ endReason: 'NO_ACCEPTABLE_SESSION', ending: { offer: offer('DECLINED') } }),
      sessions,
      NOW,
    );
    expect(declined.summary).toBe('ended: you declined Session 2');
    expect(declined.detail).toMatch(/^You declined the seat held for you in Session 2 at /);
    const cutoff = describeEnding(
      past({ endReason: 'CUTOFF', acceptable: [S1], ending: { offer: offer('DECLINED') } }),
      sessions,
      NOW,
    );
    expect(cutoff.detail).toMatch(
      /The other sessions you had chosen are past the registration cut-off \(30 minutes before the start\), so your registration has ended\.$/,
    );
  });

  it('session cancelled by the organiser, with or without a held seat', () => {
    expect(
      describeEnding(
        past({ endReason: 'NO_ACCEPTABLE_SESSION', ending: { offer: offer('REVOKED') } }),
        sessions,
        NOW,
      ),
    ).toMatchObject({
      summary: 'ended: the organiser cancelled Session 2',
      detail: expect.stringMatching(
        /^The organiser cancelled Session 2 at .+ while a seat in it was held for you\./,
      ),
    });
    expect(
      describeEnding(past({ endReason: 'NO_ACCEPTABLE_SESSION', ending: {} }), sessions, NOW),
    ).toMatchObject({ summary: 'ended: the organiser cancelled your last session' });
  });

  it('a session cancellation that left only past-cut-off sessions is not "the cut-off before a seat became free"', () => {
    // bob had a confirmed seat in Session 2; the organiser cancelled it when Session 1 was past
    // its cut-off (the server names the cancelled session and the seat it took).
    const confirmedLost = describeEnding(
      past({
        endReason: 'CUTOFF',
        acceptable: [S1],
        ending: { cancelledSessionId: S2, confirmedSessionId: S2 },
      }),
      sessions,
      NOW,
    );
    expect(confirmedLost.summary).toBe(
      'ended: the organiser cancelled Session 2, where your seat was confirmed',
    );
    expect(confirmedLost.detail).toMatch(
      /^The organiser cancelled Session 2 at .+, so you lost your confirmed seat in it\. The other sessions you had chosen are past the registration cut-off \(30 minutes before the start\), so your registration has ended\.$/,
    );
    // carol was queued for both
    const queued = describeEnding(
      past({ endReason: 'CUTOFF', acceptable: [S1], ending: { cancelledSessionId: S2 } }),
      sessions,
      NOW,
    );
    expect(queued.summary).toBe('ended: the organiser cancelled Session 2');
    expect(queued.detail).toMatch(/^The organiser cancelled Session 2 at .+\. The other sessions/);
    for (const copy of [confirmedLost, queued]) {
      expect(`${copy.summary} ${copy.detail}`).not.toContain('before a seat became free');
    }
    // the last session, with a confirmed seat in it
    expect(
      describeEnding(
        past({
          endReason: 'NO_ACCEPTABLE_SESSION',
          ending: { cancelledSessionId: S1, confirmedSessionId: S1 },
        }),
        sessions,
        NOW,
      ).detail,
    ).toMatch(
      /^The organiser cancelled Session 1 at .+, so you lost your confirmed seat in it\. That was the last session you had chosen, so your registration has ended\.$/,
    );
  });

  it('PER_SESSION: about this session’s registration only, never "the last session you had chosen"', () => {
    const perSession = (overrides: Partial<Listed>) =>
      describeEnding(
        past({ endReason: 'NO_ACCEPTABLE_SESSION', ...overrides }),
        sessions,
        NOW,
        'PER_SESSION',
      );
    const expired = perSession({ ending: { offer: offer('EXPIRED') } });
    expect(expired.summary).toBe('ended: your hold on Session 2 expired');
    expect(expired.detail).toMatch(
      /without being accepted — the seat is free again for the next person waiting, if there is one\. Your registration for this session has ended\.$/,
    );
    expect(perSession({ ending: {} })).toEqual({
      summary: 'ended: the organiser cancelled your session',
      detail: expect.stringMatching(
        /^The organiser cancelled the session you had registered for at .+\. Your registration for this session has ended\.$/,
      ),
    });
    expect(
      perSession({ ending: { cancelledSessionId: S1, confirmedSessionId: S1 } }).detail,
    ).toMatch(
      /so you lost your confirmed seat in it\. Your registration for this session has ended\.$/,
    );
    expect(perSession({}).detail).toMatch(
      /^Your registration has ended at .+: you declined or let expire the seat held for you in this session, or the organiser cancelled it\.$/,
    );
    const ended = summary({
      status: 'ENDED',
      queuePosition: undefined,
      acceptable: [],
      endReason: 'NO_ACCEPTABLE_SESSION',
    });
    expect(describeRegistration(ended, sessions, NOW, 'DECLINE_OFFER', 'PER_SESSION')).toBe(
      'You declined the seat. Your registration for this session has ended.',
    );
    expect(
      describeSettled(
        settledView('APPLIED', ended, { type: 'DECLINE_OFFER' }),
        sessions,
        NOW,
        'PER_SESSION',
      ).message,
    ).toBe('You declined the seat. Your registration for this session has ended.');
    expect(endReasonText('CUTOFF', 'PER_SESSION')).toMatch(/passed for this session before/);
    expect(endReasonText('NO_ACCEPTABLE_SESSION')).toBe(END_REASON_TEXT.NO_ACCEPTABLE_SESSION);
    for (const reason of ['CUTOFF', 'NO_ACCEPTABLE_SESSION'] as const) {
      const all = [
        endReasonText(reason, 'PER_SESSION'),
        perSession({ endReason: reason, ending: { offer: offer('DECLINED') } }).detail,
        perSession({ endReason: reason, ending: { offer: offer('REVOKED') } }).detail,
      ].join(' ');
      expect(all).not.toMatch(/last session|every session|other sessions/);
    }
  });

  it('cut-off reached while queued names the sessions', () => {
    const copy = describeEnding(
      past({ endReason: 'CUTOFF', acceptable: [S1, S2], ending: {} }),
      sessions,
      NOW,
    );
    expect(copy.summary).toBe('ended: the registration cut-off passed before a seat became free');
    expect(copy.detail).toMatch(
      /^The registration cut-off \(30 minutes before the start\) passed for Session 1, Session 2 before a seat became free for you/,
    );
  });

  it('workshop cancelled', () => {
    expect(
      describeEnding(
        past({ endReason: 'WORKSHOP_CANCELLED', ending: { confirmedSessionId: S1 } }),
        sessions,
        NOW,
      ).detail,
    ).toMatch(
      /^The organiser cancelled this workshop at .+, so your registration has ended\. Your confirmed seat in Session 1 was released\.$/,
    );
  });

  it('cancelled by the participant: confirmed seat, held seat, queue, unknown', () => {
    const cancelled = (ending?: Listed['ending']) =>
      describeEnding(
        past({ status: 'CANCELLED', ...(ending !== undefined ? { ending } : {}) }),
        sessions,
        NOW,
      );
    expect(cancelled({ confirmedSessionId: S1 }).detail).toMatch(
      /^You gave up your confirmed seat in Session 1 at .+; it is free again for the next person waiting, if there is one\.$/,
    );
    expect(cancelled({ offer: offer('REVOKED') }).summary).toBe(
      'cancelled: you gave up the seat held for you in Session 2',
    );
    expect(cancelled({ offer: offer('REVOKED') }).detail).toMatch(
      /^You cancelled your registration at .+ while a seat in Session 2 was held for you; the seat is free again for the next person waiting, if there is one\.$/,
    );
    expect(cancelled({}).summary).toBe('cancelled: you left the queue');
    // a poll result shown before the list caught up: no claim about what was held
    expect(cancelled().summary).toBe('cancelled by you');
    expect(cancelled().detail).toMatch(
      /^You cancelled your registration at .+\. If you held or had a confirmed seat, it is free again for the next person waiting\.$/,
    );
  });

  it('cancelled after the hold had expired in the same decision (tick-first): not "held for you"', () => {
    // The cancel arrived after expiresAt but before the timer tick: the decision expires the
    // offer first (the participant is back in the queue), then applies the cancel.
    const copy = describeEnding(
      past({ status: 'CANCELLED', acceptable: [S1], ending: { offer: offer('EXPIRED') } }),
      sessions,
      NOW,
    );
    expect(copy.summary).toBe('cancelled: you left the queue after your hold on Session 2 expired');
    expect(copy.detail).toBe(
      `Your hold for Session 2 expired ${formatMoment(offer('EXPIRED').expiresAt, NOW)} without being accepted; you then cancelled your registration ${formatMoment(ENDED_AT, NOW)} and left the queue.`,
    );
    expect(`${copy.summary} ${copy.detail}`).not.toContain('held for you');
  });

  it('workshop cancelled: a withdrawn hold, or a hold that had already expired', () => {
    const workshopCancelled = (status: 'EXPIRED' | 'REVOKED') =>
      describeEnding(
        past({ endReason: 'WORKSHOP_CANCELLED', ending: { offer: offer(status) } }),
        sessions,
        NOW,
      ).detail;
    expect(workshopCancelled('REVOKED')).toMatch(
      /so your registration has ended\. The seat held for you in Session 2 was withdrawn\.$/,
    );
    const expired = workshopCancelled('EXPIRED');
    expect(expired).toMatch(
      /so your registration has ended\. Your hold for Session 2 had already expired at .+\.$/,
    );
    expect(expired).not.toContain('withdrawn');
  });

  it('never shows a raw enum, in every combination', () => {
    const endings: (Listed['ending'] | undefined)[] = [
      undefined,
      {},
      { offer: offer('EXPIRED') },
      { offer: offer('DECLINED') },
      { offer: offer('REVOKED') },
      { confirmedSessionId: S1 },
      { cancelledSessionId: S2 },
      { cancelledSessionId: S1, confirmedSessionId: S1 },
    ];
    for (const status of ['ENDED', 'CANCELLED'] as const) {
      for (const endReason of [
        undefined,
        'CUTOFF',
        'NO_ACCEPTABLE_SESSION',
        'WORKSHOP_CANCELLED',
      ] as const) {
        for (const ending of endings) {
          for (const mode of ['UNIFIED', 'PER_SESSION'] as const) {
            const registration = past({
              status,
              acceptable: [S1],
              ...(endReason !== undefined ? { endReason } : {}),
              ...(ending !== undefined ? { ending } : {}),
            });
            const copy = describeEnding(registration, sessions, NOW, mode);
            expect(copy.detail.length).toBeGreaterThan(0);
            expect(`${copy.summary} ${copy.detail}`).not.toMatch(RAW);
            expect(pastStatusText(registration, sessions, mode)).toBe(copy.summary);
          }
        }
      }
    }
  });
});
