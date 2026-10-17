import { describe, expect, it } from 'vitest';
import { END_REASON_TEXT, pastStatusText } from '../src/commands/copy';

describe('pastStatusText (My registrations → Past)', () => {
  it('uses the human end-reason copy, not the enum', () => {
    expect(pastStatusText({ status: 'ENDED', endReason: 'NO_ACCEPTABLE_SESSION' })).toBe(
      'ended: none of your acceptable sessions could still be joined',
    );
    expect(pastStatusText({ status: 'ENDED', endReason: 'CUTOFF' })).toBe(
      `ended: ${END_REASON_TEXT.CUTOFF}`,
    );
    expect(pastStatusText({ status: 'ENDED', endReason: 'WORKSHOP_CANCELLED' })).not.toContain('_');
  });

  it('shows the bare status when there is no end reason', () => {
    expect(pastStatusText({ status: 'CANCELLED' })).toBe('cancelled');
    expect(pastStatusText({ status: 'ENDED' })).toBe('ended');
  });
});
