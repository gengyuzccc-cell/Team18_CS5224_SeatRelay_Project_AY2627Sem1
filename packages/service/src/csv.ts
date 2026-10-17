import type { Attendance, Registration, Session } from '@seatrelay/contracts';
import type { WorkshopSnapshot } from '@seatrelay/core';
import type { WorkshopHistory } from './ports';
import { sortedSessions } from './views';

/**
 * Organiser CSV export (plan §2.5): one row per registration, live and archived, by seq.
 * RFC 4180 quoting with CRLF line ends; cells that a spreadsheet would read as a formula are
 * prefixed with an apostrophe (display names and emails are participant input).
 */

export const CSV_COLUMNS = [
  'seq',
  'userId',
  'email',
  'displayName',
  'status',
  'endReason',
  'acceptable',
  'confirmedSessionId',
  'confirmedSessionTitle',
  'currentOfferId',
  'offerSessionId',
  'offerExpiresAt',
  'attended',
  'createdAt',
  'updatedAt',
] as const;

export function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  let textValue = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(textValue)) {
    textValue = `'${textValue}`;
  }
  if (/[",\r\n]/.test(textValue)) {
    return `"${textValue.replace(/"/g, '""')}"`;
  }
  return textValue;
}

export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function registrationsCsv(
  snapshot: WorkshopSnapshot,
  history: WorkshopHistory,
  attendance: readonly Attendance[],
): string {
  const sessionTitle = new Map<string, string>(
    sortedSessions(snapshot.sessions).map((session: Session) => [session.id, session.title]),
  );
  const attendedBy = new Map<string, boolean>(
    attendance.map((record) => [record.userId, record.attended]),
  );
  const rows: Registration[] = [...snapshot.registrations, ...history.registrations].sort(
    (a, b) => a.seq - b.seq,
  );
  const lines = [csvLine(CSV_COLUMNS)];
  for (const registration of rows) {
    const offer =
      registration.currentOfferId === undefined
        ? undefined
        : snapshot.offers.find((candidate) => candidate.id === registration.currentOfferId);
    const attended = attendedBy.get(registration.userId);
    lines.push(
      csvLine([
        registration.seq,
        registration.userId,
        registration.email,
        registration.displayName,
        registration.status,
        registration.endReason,
        registration.acceptable.join('|'),
        registration.confirmedSessionId,
        registration.confirmedSessionId === undefined
          ? undefined
          : sessionTitle.get(registration.confirmedSessionId),
        offer?.id,
        offer?.sessionId,
        offer?.expiresAt,
        attended === undefined ? '' : attended ? 'yes' : 'no',
        registration.createdAt,
        registration.updatedAt,
      ]),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
