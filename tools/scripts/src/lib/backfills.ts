import type { DashboardView } from '@seatrelay/contracts';
import type { ApiClient } from './api';

/**
 * The dashboard's backfill log as a CSV file, in the columns `tools/experiments`
 * `pilot-rehearsal` writes to `backfills.csv`, so that `report/tools/report_numbers.py`
 * (`section_pilot`) reads both with the same code. Used by the `dashboard-backfills` command
 * for the real pilot (SUBMISSION-CHECKLIST row 1.4).
 */

export const BACKFILL_CSV_COLUMNS = [
  'cause',
  'session',
  'releasedAt',
  'reallocatedAt',
  'latencyMs',
  'recomputedMs',
  'newParticipant',
  'backfillId',
] as const;

export type BackfillCsvColumn = (typeof BACKFILL_CSV_COLUMNS)[number];
export type BackfillCsvRow = Record<BackfillCsvColumn, string | number>;

/**
 * One row per backfill record, oldest first. `session` is the session's position in the
 * dashboard (S1, S2, …, the label the rehearsal and the study tables use) and `newParticipant`
 * the new holder's opaque user id, never the e-mail, so the file can sit in `results/`.
 */
export function backfillRows(dashboard: DashboardView): BackfillCsvRow[] {
  const labels = new Map(dashboard.sessions.map((session, index) => [session.id, `S${index + 1}`]));
  return dashboard.backfills
    .slice()
    .sort((a, b) => a.releasedAt.localeCompare(b.releasedAt))
    .map((record) => ({
      cause: record.cause,
      session: labels.get(record.sessionId) ?? record.sessionId,
      releasedAt: record.releasedAt,
      reallocatedAt: record.reallocatedAt ?? '',
      latencyMs: record.latencyMs ?? '',
      recomputedMs:
        record.reallocatedAt === undefined
          ? ''
          : Date.parse(record.reallocatedAt) - Date.parse(record.releasedAt),
      newParticipant: record.newUserId ?? '',
      backfillId: record.id,
    }));
}

function csvCell(value: string | number): string {
  const text = typeof value === 'string' ? value : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 text of the rows, header first, `\n` line ends (same as the rehearsal's file). */
export function backfillsCsv(rows: readonly BackfillCsvRow[]): string {
  const lines = [BACKFILL_CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(BACKFILL_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** File name of a workshop's export inside `results/pilot/`. */
export function backfillsFileName(wsId: string): string {
  return `backfills-${wsId}.csv`;
}

export interface BackfillExport {
  wsId: string;
  title: string;
  rows: BackfillCsvRow[];
  csv: string;
}

/** Reads the organiser dashboard of one workshop and renders its backfill log. */
export async function exportBackfills(
  client: ApiClient,
  orgId: string,
  wsId: string,
): Promise<BackfillExport> {
  const dashboard = await client.dashboard(orgId, wsId);
  const rows = backfillRows(dashboard);
  return { wsId, title: dashboard.workshop.title, rows, csv: backfillsCsv(rows) };
}
