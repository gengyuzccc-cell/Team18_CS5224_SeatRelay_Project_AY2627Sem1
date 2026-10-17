import { useEffect, useRef, useState } from 'react';
import { formatCountdown, msUntil } from '../util/time';

interface Props {
  expiresAt: string;
  /** Fired once when the countdown reaches zero. */
  onExpire?: () => void;
}

/** Live `mm:ss` until `expiresAt`, ticking every second; shows "expired" at zero. */
export function Countdown({ expiresAt, onExpire }: Props) {
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

  const urgent = remaining > 0 && remaining < 60_000;
  return (
    <time
      dateTime={expiresAt}
      className={`countdown${urgent ? ' countdown-urgent' : ''}${remaining <= 0 ? ' countdown-expired' : ''}`}
    >
      {remaining <= 0 ? 'expired' : formatCountdown(remaining)}
    </time>
  );
}
