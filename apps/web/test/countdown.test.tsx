import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Countdown, urgentThresholdMs } from '../src/components/Countdown';

const NOW = Date.parse('2026-11-03T06:00:00.000Z');
const TIME = /<time[^>]*class="countdown[^"]*"[^>]*>(\d+:\d\d|expired)<\/time>/;

function render(remainingMs: number, holdSeconds?: number): string {
  const expiresAt = new Date(NOW + remainingMs).toISOString();
  return renderToStaticMarkup(
    holdSeconds === undefined ? (
      <Countdown expiresAt={expiresAt} />
    ) : (
      <Countdown expiresAt={expiresAt} holdSeconds={holdSeconds} />
    ),
  );
}

describe('urgentThresholdMs', () => {
  it('is a quarter of the hold, between 10 s and 60 s; the last minute without a hold', () => {
    expect(urgentThresholdMs(60_000)).toBe(15_000);
    expect(urgentThresholdMs(900_000)).toBe(60_000);
    expect(urgentThresholdMs(30_000)).toBe(10_000);
    expect(urgentThresholdMs(undefined)).toBe(60_000);
  });
});

describe('Countdown with a hold meter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('58 s of a 60 s hold: not urgent yet, the meter is almost full', () => {
    const html = render(58_000, 60);
    expect(html).not.toContain('countdown-urgent');
    expect(html).toContain('scaleX(0.9667)');
    expect(html).toMatch(TIME);
    expect(html.match(/class="countdown/g)).toHaveLength(1);
    expect(html).toContain('role="timer"');
    expect(html).toContain('aria-live="off"');
    expect(html).toMatch(/<span class="hold-meter" aria-hidden="true">/);
  });

  it('14 s left: urgent (digits and meter)', () => {
    const html = render(14_000, 60);
    expect(html).toContain('countdown-urgent');
    expect(html).toContain('hold-meter-urgent');
    expect(html).toMatch(TIME);
    expect(html.match(/class="countdown/g)).toHaveLength(1);
  });

  it('urgent: a static visually hidden warning (announced once), outside the timer', () => {
    expect(render(58_000, 60)).not.toContain('seconds left');
    const html = render(14_000, 60);
    expect(html).toContain('<span class="sr-only">Less than 15 seconds left on this hold.</span>');
    expect(html).toMatch(/<\/time>[\s\S]*seconds left/);
    expect(render(-1_000, 60)).not.toContain('seconds left');
  });

  it('at zero it reads "expired" and the meter fades', () => {
    const html = render(-1_000, 60);
    expect(html).toMatch(/>expired<\/time>/);
    expect(html).toContain('hold-meter-expired');
    expect(html).toContain('scaleX(0.0000)');
  });

  it('without a hold length: no meter, urgent in the last minute', () => {
    expect(render(61_000)).not.toContain('countdown-urgent');
    const html = render(59_000);
    expect(html).toContain('countdown-urgent');
    expect(html).not.toContain('hold-meter');
    expect(html).toMatch(TIME);
  });
});
