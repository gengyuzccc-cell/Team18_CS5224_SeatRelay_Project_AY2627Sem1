import { parseIso } from './time';

/**
 * Times in text written for people: notification titles and bodies, which are also the e-mail
 * text. Machine fields (`expiresAt`, `startsAt`, …) stay ISO-8601 UTC (CONVENTIONS §3); only
 * prose is rendered here. The zone and locale are fixed constants, never the host's settings, so
 * the engine stays deterministic: the same `now` and snapshot give the same text on every machine.
 */

/** IANA time zone of the deployment's audience. Change it here to move every notification. */
export const DISPLAY_TIME_ZONE = 'Asia/Singapore';

/** Locale for weekday/month names and the zone abbreviation (`en-SG` names Asia/Singapore `SGT`). */
export const DISPLAY_LOCALE = 'en-SG';

const displayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** `2026-10-21T02:00:00.000Z` → `Wed 21 Oct 2026, 10:00 SGT` (in `DISPLAY_TIME_ZONE`). */
export function formatDisplayTime(iso: string): string {
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of displayFormat.formatToParts(parseIso(iso))) {
    part[type] = value;
  }
  return `${part.weekday} ${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute} ${part.timeZoneName}`;
}
