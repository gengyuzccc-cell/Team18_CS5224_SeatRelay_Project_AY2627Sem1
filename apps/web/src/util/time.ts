import { serverNow } from './serverClock';

/** All timestamps are ISO-8601 UTC (CONVENTIONS §3); rendered in the browser's locale. */

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export function formatDateTime(iso: string | undefined): string {
  if (iso === undefined) {
    return '—';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : dateTimeFormat.format(ms);
}

export function formatTime(iso: string | undefined): string {
  if (iso === undefined) {
    return '—';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : timeFormat.format(ms);
}

/** Milliseconds until `iso` on the server's clock (`serverClock.ts`, plan §1.4). */
export function msUntil(iso: string, now: number = serverNow()): number {
  return Date.parse(iso) - now;
}

/** `mm:ss` (or `h:mm:ss`), clamped at 00:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** `900` → `15 min`, `45` → `45 s`, `3600` → `1 h`. */
export function formatSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  if (seconds > 60) {
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }
  return `${seconds} s`;
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) {
    return '—';
  }
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** `datetime-local` input value (local time, no seconds) → ISO UTC with milliseconds. */
export function localInputToIso(value: string): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Default `startsAt` for a new session: the next full hour at least `offsetHours` ahead. */
export function defaultLocalInput(offsetHours: number, now: number = Date.now()): string {
  const date = new Date(now + offsetHours * 3_600_000);
  date.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
