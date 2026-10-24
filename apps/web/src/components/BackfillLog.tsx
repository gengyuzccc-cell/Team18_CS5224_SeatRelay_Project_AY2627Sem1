import type { DashboardBackfillEntry, SessionView } from '@seatrelay/contracts';
import { BACKFILL_CAUSE_TEXT, sessionTitle } from '../commands/copy';
import { participantLabel } from '../util/people';
import { useArrivals } from '../util/useArrivals';
import { EmptyState } from './EmptyState';
import { Participant } from './Participant';
import { formatLatency, formatTime, percentile } from '../util/time';

/**
 * Who received a released seat, named like the queue/offered/confirmed tables (display name and
 * e-mail from the dashboard view). A server without those fields still shows the user id.
 */
export function newHolderLabel(record: DashboardBackfillEntry): string | undefined {
  if (record.newHolderEmail !== undefined) {
    return participantLabel({
      email: record.newHolderEmail,
      ...(record.newHolderDisplayName !== undefined
        ? { displayName: record.newHolderDisplayName }
        : {}),
    });
  }
  return record.newUserId === undefined ? undefined : `${record.newUserId.slice(0, 8)}…`;
}

/** Dashboard backfill log: every released seat, newest first, with relay latency and taker. */
export function BackfillLog({
  backfills,
  sessions,
}: {
  backfills: readonly DashboardBackfillEntry[];
  sessions: readonly SessionView[];
}) {
  const latencies = backfills.flatMap((record) =>
    record.latencyMs === undefined ? [] : [record.latencyMs],
  );
  const rows = [...backfills].reverse();
  const arrivals = useArrivals(backfills.map((record) => record.id));
  return (
    <section className="card" aria-labelledby="backfill-heading">
      <header className="card-header">
        <h2 id="backfill-heading">Backfill log</h2>
        <span className="muted small backfill-summary">
          {latencies.length}/{backfills.length} reallocated
          {latencies.length > 0 &&
            ` · p50 ${formatLatency(percentile(latencies, 50))} · p95 ${formatLatency(percentile(latencies, 95))} · max ${formatLatency(Math.max(...latencies))}`}
        </span>
      </header>
      {rows.length === 0 ? (
        <EmptyState>No seat has been released yet.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="backfill-table">
            <thead>
              <tr>
                <th scope="col">Released</th>
                <th scope="col">Session</th>
                <th scope="col">Cause</th>
                <th scope="col">Reallocated</th>
                <th scope="col" className="num">
                  Latency
                </th>
                <th scope="col">New holder</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => {
                const holder = newHolderLabel(record);
                return (
                  <tr key={record.id} className={arrivals.has(record.id) ? 'row-new' : undefined}>
                    <td className="nowrap">{formatTime(record.releasedAt)}</td>
                    <td className="nowrap">{sessionTitle(sessions, record.sessionId)}</td>
                    <td className="cause-cell">{BACKFILL_CAUSE_TEXT[record.cause]}</td>
                    <td
                      className={
                        record.reallocatedAt === undefined ? undefined : 'nowrap is-reallocated'
                      }
                    >
                      {record.reallocatedAt === undefined ? (
                        <span className="muted">waiting for a taker</span>
                      ) : (
                        formatTime(record.reallocatedAt)
                      )}
                    </td>
                    <td className="num">{formatLatency(record.latencyMs)}</td>
                    <td title={record.newUserId}>
                      {record.newHolderEmail !== undefined ? (
                        <Participant
                          email={record.newHolderEmail}
                          {...(record.newHolderDisplayName !== undefined
                            ? { displayName: record.newHolderDisplayName }
                            : {})}
                        />
                      ) : (
                        (holder ?? '—')
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
