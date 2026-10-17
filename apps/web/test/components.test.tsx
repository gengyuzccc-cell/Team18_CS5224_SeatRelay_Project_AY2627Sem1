import type { DashboardBackfillEntry, MyRegistrationView } from '@seatrelay/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackfillLog, newHolderLabel } from '../src/components/BackfillLog';
import { EndedStatusCard } from '../src/components/EndedStatusCard';
import { S1, S2, sessions } from './fixtures';

type Listed = MyRegistrationView['registration'];

const ENDED_AT = '2026-11-03T06:05:00.000Z';
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

/** Text content of static markup (tags dropped, entities for quotes decoded). */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('EndedStatusCard', () => {
  const expired = past({
    endReason: 'NO_ACCEPTABLE_SESSION',
    ending: {
      offer: {
        id: 'o1',
        sessionId: S2,
        status: 'EXPIRED',
        expiresAt: '2026-11-03T06:04:30.000Z',
        settledAt: ENDED_AT,
      },
    },
  });

  it('says what happened, when, and offers "Register again" at the end of the queue', () => {
    const html = renderToStaticMarkup(
      <EndedStatusCard
        sessions={sessions}
        mode="UNIFIED"
        registration={expired}
        onRegisterAgain={() => undefined}
        now={NOW}
      />,
    );
    expect(html).toContain('class="card status-card status-ended"');
    const text = textOf(html);
    expect(text).toContain('My status');
    expect(text).toContain('Ended');
    expect(text).toMatch(
      /Your hold for Session 2 expired at .+ without being accepted — the seat is free again for the next person waiting, if there is one\. That was the last session you had chosen, so your registration has ended\./,
    );
    expect(text).toContain('You can register again; you will join the end of the queue.');
    expect(html).toMatch(/<button[^>]*>Register again<\/button>/);
  });

  it('without a way back in (workshop closed, cancelled, nothing joinable) there is no button', () => {
    const html = renderToStaticMarkup(
      <EndedStatusCard
        sessions={sessions}
        mode="UNIFIED"
        registration={past({ endReason: 'WORKSHOP_CANCELLED', ending: {} })}
        now={NOW}
      />,
    );
    expect(textOf(html)).toMatch(
      /The organiser cancelled this workshop at .+, so your registration has ended\./,
    );
    expect(html).not.toContain('Register again');
  });

  it('a cancellation by the participant reads as such, with the cancelled badge', () => {
    const html = renderToStaticMarkup(
      <EndedStatusCard
        sessions={sessions}
        mode="UNIFIED"
        registration={past({ status: 'CANCELLED', ending: { confirmedSessionId: S1 } })}
        title="Your last ended registration"
        now={NOW}
      />,
    );
    expect(html).toContain('status-cancelled');
    expect(textOf(html)).toMatch(
      /^Your last ended registration Cancelled You gave up your confirmed seat in Session 1 at .+; it is free again for the next person waiting, if there is one\.$/,
    );
  });
  it('a cancelled session that took a confirmed seat says so (not "the cut-off passed")', () => {
    const html = renderToStaticMarkup(
      <EndedStatusCard
        sessions={sessions}
        mode="UNIFIED"
        registration={past({
          endReason: 'CUTOFF',
          acceptable: [S2],
          ending: { cancelledSessionId: S1, confirmedSessionId: S1 },
        })}
        now={NOW}
      />,
    );
    const text = textOf(html);
    expect(text).toMatch(
      /The organiser cancelled Session 1 at .+, so you lost your confirmed seat in it\. The other sessions you had chosen are past the registration cut-off/,
    );
    expect(text).not.toContain('before a seat became free');
  });

  it('PER_SESSION: the ending is about this session’s registration only', () => {
    const html = renderToStaticMarkup(
      <EndedStatusCard sessions={sessions} mode="PER_SESSION" registration={expired} now={NOW} />,
    );
    const text = textOf(html);
    expect(text).toMatch(
      /Your hold for Session 2 expired at .+\. Your registration for this session has ended\./,
    );
    expect(text).not.toContain('last session');
  });
});

describe('BackfillLog (dashboard)', () => {
  const record: DashboardBackfillEntry = {
    id: 'b1',
    workshopId: 'ws-1',
    sessionId: S2,
    releasedAt: '2026-11-03T06:04:30.000Z',
    cause: 'EXPIRED',
    reallocatedAt: '2026-11-03T06:04:30.180Z',
    newOfferId: 'o2',
    newUserId: '6f1c2b9e-1111-4c2d-8e3f-123456789abc',
    latencyMs: 180,
    newHolderEmail: 'carol@example.com',
    newHolderDisplayName: 'Carol (staged)',
  };

  it('names the new holder like the other tables, never a truncated user id', () => {
    const html = renderToStaticMarkup(<BackfillLog backfills={[record]} sessions={sessions} />);
    const text = textOf(html);
    expect(text).toContain('Carol (staged) <carol@example.com>');
    expect(text).not.toContain('6f1c2b9e…');
    expect(html).toContain(`title="${record.newUserId}"`);
    expect(text).toContain('1/1 reallocated');
  });

  it('falls back to the e-mail, then to the id (older API), then to a dash', () => {
    const { newHolderDisplayName: _name, ...emailOnly } = record;
    expect(newHolderLabel(emailOnly)).toBe('carol@example.com');
    const { newHolderEmail: _email, ...idOnly } = emailOnly;
    expect(newHolderLabel(idOnly)).toBe('6f1c2b9e…');
    const {
      newUserId: _user,
      newOfferId: _offer,
      reallocatedAt: _at,
      latencyMs: _ms,
      ...waiting
    } = idOnly;
    expect(newHolderLabel(waiting)).toBeUndefined();
    const html = renderToStaticMarkup(<BackfillLog backfills={[waiting]} sessions={sessions} />);
    expect(textOf(html)).toContain('waiting for a taker');
  });
});
