import type { CSSProperties } from 'react';

function pct(part: number, whole: number): string {
  if (!(whole > 0)) {
    return '0%';
  }
  return `${Math.min(100, Math.max(0, (part / whole) * 100)).toFixed(1)}%`;
}

/**
 * Custom properties for the capacity cell's seat bar: confirmed seats (NUS blue), then held
 * seats (orange), then free. Decorative; the cell's text stays the bare capacity number.
 */
export function seatBarStyle(session: {
  capacity: number;
  confirmed: number;
  held: number;
}): CSSProperties {
  return {
    '--seat-c': pct(session.confirmed, session.capacity),
    '--seat-h': pct(session.confirmed + session.held, session.capacity),
  } as CSSProperties;
}
