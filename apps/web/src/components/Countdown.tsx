import { useEffect, useRef, useState } from 'react';
import { formatCountdown, msUntil } from '../util/time';

interface Props {
  expiresAt: string;
  /** Fired once when the countdown reaches zero. */
  onExpire?: () => void;
  /**
   * The workshop's hold length: when given, a hold meter (decorative, `aria-hidden`) drains
   * next to the digits and the "urgent" colour starts at {@link urgentThresholdMs}.
   */
  holdSeconds?: number;
}

/**
 * When the countdown turns red: a quarter of the hold, between 10 s and 60 s (15 s of the demo's
 * 60 s hold, 60 s of a 15-minute hold). Without a hold length, the last minute. Visual only.
 */
export function urgentThresholdMs(holdMs?: number): number {
  return holdMs === undefined ? 60_000 : Math.min(60_000, Math.max(10_000, holdMs / 4));
}

/**
 * Live `mm:ss` until `expiresAt` on the server's clock (`msUntil` → `serverNow()`), ticking
 * every second; shows "expired" at zero. It never disables anything: the server decides whether
 * an ACCEPT still counts (tick-first). `role="timer"` with `aria-live="off"` keeps screen readers
 * from announcing every tick inside the status card's polite live region; instead, a static
 * visually hidden sentence appears once when the hold turns urgent, so that region announces it
 * a single time.
 */
export function Countdown({ expiresAt, onExpire, holdSeconds }: Props) {
  const [remaining, setRemaining] = useState(() => msUntil(expiresAt));
  const fired = useRef(false);

  useEffect(() => {
    fired.current = false;
    setRemaining(msUntil(expiresAt));
    const timer = setInterval(() => setRemaining(msUntil(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (remaining <= 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [onExpire, remaining]);

  const holdMs = holdSeconds === undefined ? undefined : holdSeconds * 1000;
  const urgent =
    holdMs === undefined
      ? remaining > 0 && remaining < 60_000
      : remaining > 0 && remaining <= urgentThresholdMs(holdMs);
  const time = (
    <time
      dateTime={expiresAt}
      className={`countdown${urgent ? ' countdown-urgent' : ''}${remaining <= 0 ? ' countdown-expired' : ''}`}
      role="timer"
      aria-live="off"
    >
      {remaining <= 0 ? 'expired' : formatCountdown(remaining)}
    </time>
  );
  const warning = urgent ? (
    <span className="sr-only">
      Less than {Math.round(urgentThresholdMs(holdMs) / 1000)} seconds left on this hold.
    </span>
  ) : null;
  if (holdMs === undefined || holdMs <= 0) {
    return (
      <>
        {time}
        {warning}
      </>
    );
  }
  const fraction = Math.min(1, Math.max(0, remaining / holdMs));
  return (
    <>
      {time}
      <span
        className={`hold-meter${urgent ? ' hold-meter-urgent' : ''}${remaining <= 0 ? ' hold-meter-expired' : ''}`}
        aria-hidden="true"
      >
        <span className="hold-meter-fill" style={{ transform: `scaleX(${fraction.toFixed(4)})` }} />
      </span>
      {warning}
    </>
  );
}
