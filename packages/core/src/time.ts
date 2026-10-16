/**
 * Time helpers. The engine never reads the wall clock; callers pass `now` (ISO UTC string).
 */

export function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO timestamp: ${iso}`);
  }
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function addMs(iso: string, ms: number): string {
  return toIso(parseIso(iso) + ms);
}

export function addSeconds(iso: string, seconds: number): string {
  return addMs(iso, seconds * 1000);
}

export function addMinutes(iso: string, minutes: number): string {
  return addMs(iso, minutes * 60_000);
}

/** Negative when `a` is earlier than `b`, zero when equal, positive when later. */
export function compareIso(a: string, b: string): number {
  return parseIso(a) - parseIso(b);
}

export function minIso(a: string, b: string): string {
  return compareIso(a, b) <= 0 ? a : b;
}

export function maxIso(a: string, b: string): string {
  return compareIso(a, b) >= 0 ? a : b;
}

export function isBefore(a: string, b: string): boolean {
  return compareIso(a, b) < 0;
}

export function isAtOrAfter(a: string, b: string): boolean {
  return compareIso(a, b) >= 0;
}

/** `later − earlier` in milliseconds. */
export function diffMs(later: string, earlier: string): number {
  return parseIso(later) - parseIso(earlier);
}
