import type {
  BackfillRecord,
  ConfirmedEntry,
  DashboardView,
  SessionView,
  VerifyView,
} from '@seatrelay/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/ApiProvider';
import { useDashboard } from '../api/queries';
import { RequireAuth } from '../auth/RequireAuth';
import { BACKFILL_CAUSE_TEXT, sessionTitle } from '../commands/copy';
import { useCommand, type CommandHandle } from '../commands/useCommand';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { CopyLink } from '../components/CopyLink';
import { Countdown } from '../components/Countdown';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { isCancelledLike, StatusBadge } from '../components/StatusBadge';
import { describeError } from '../util/errors';
import { formatDateTime, formatLatency, formatSeconds, formatTime, percentile } from '../util/time';

function commandState(command: CommandHandle): AsyncState {
  switch (command.state.phase) {
    case 'submitting':
    case 'processing':
      return 'pending';
    case 'applied':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function CommandFeedback({ command }: { command: CommandHandle }) {
  const { state } = command;
  if (state.phase === 'processing') {
    return (
      <span className="muted small" role="status">
        {state.slow ? 'Still processing — checking every 5 s.' : 'Request received, waiting…'}
      </span>
    );
  }
  if (state.phase === 'error') {
    return (
      <span className="error-text small" role="alert">
        {describeError(state.error)}
      </span>
    );
  }
  if (state.phase === 'rejected') {
    return (
      <span className="error-text small" role="alert">
        Rejected ({state.view.reason ?? 'see notification'})
      </span>
    );
  }
  return null;
}

function participantLabel(entry: { displayName?: string; email: string }): string {
  return entry.displayName !== undefined ? `${entry.displayName} <${entry.email}>` : entry.email;
}

/** Per-session row: counters + SET_CAPACITY + CANCEL_SESSION, each with its own command flow. */
function SessionRow({
  session,
  sessions,
  wsId,
  workshopClosed,
  refetch,
}: {
  session: SessionView;
  sessions: readonly SessionView[];
  wsId: string;
  workshopClosed: boolean;
  refetch: () => void;
}) {
  const capacity = useCommand(wsId, { sessions, onSettled: refetch });
  const cancel = useCommand(wsId, { sessions, onSettled: refetch });
  const [value, setValue] = useState(String(session.capacity));
  const [confirm, setConfirm] = useState(false);
  const closed = workshopClosed || isCancelledLike(session.status);
  const apply = () => {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 1) {
      return;
    }
    if (capacity.state.phase === 'error') {
      void capacity.retry();
      return;
    }
    void capacity.run({ type: 'SET_CAPACITY', sessionId: session.id, capacity: next });
  };
  return (
    <tr className={isCancelledLike(session.status) ? 'row-muted' : undefined}>
      <th scope="row">
        {session.title}
        <div className="muted small">{formatDateTime(session.startsAt)}</div>
      </th>
      <td>
        <StatusBadge status={session.status} />
      </td>
      <td className="num">{session.capacity}</td>
      <td className="num">{session.confirmed}</td>
      <td className="num">{session.held}</td>
      <td className="num">{session.free}</td>
      <td className="num">{session.queueLength}</td>
      <td>
        {closed ? (
          <span className="muted small">—</span>
        ) : (
          <div className="stack-tight">
            <div className="copy-row">
              <label className="sr-only" htmlFor={`cap-${session.id}`}>
                New capacity for {session.title}
              </label>
              <input
                id={`cap-${session.id}`}
                type="number"
                min={1}
                step={1}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="input-small"
              />
              <AsyncButton
                className="btn-small"
                variant="secondary"
                state={commandState(capacity)}
                idle="Set"
                pending="Setting…"
                done="Set"
                error="Retry"
                onClick={apply}
                disabled={capacity.busy || Number(value) === session.capacity}
              />
            </div>
            <CommandFeedback command={capacity} />
            {!confirm ? (
              <AsyncButton
                className="btn-small"
                variant="danger"
                state={commandState(cancel)}
                idle="Cancel session"
                pending="Cancelling…"
                done="Cancelled"
                error="Retry"
                onClick={() =>
                  cancel.state.phase === 'error' ? void cancel.retry() : setConfirm(true)
                }
                disabled={cancel.busy}
              />
            ) : (
              <span className="confirm-inline small">
                Release every seat in {session.title}?{' '}
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() => {
                    setConfirm(false);
                    void cancel.run({ type: 'CANCEL_SESSION', sessionId: session.id });
                  }}
                >
                  Yes
                </button>{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => setConfirm(false)}
                >
                  No
                </button>
              </span>
            )}
            <CommandFeedback command={cancel} />
          </div>
        )}
      </td>
    </tr>
  );
}

/** Attendance checkbox (synchronous PUT) with idle / pending / done + error copy. */
function AttendanceCell({
  orgId,
  wsId,
  entry,
  attended,
  refetch,
}: {
  orgId: string;
  wsId: string;
  entry: ConfirmedEntry;
  attended: boolean | undefined;
  refetch: () => void;
}) {
  const api = useApi();
  const [state, setState] = useState<AsyncState>('idle');
  const [error, setError] = useState<unknown>(undefined);
  const put = useMutation({
    mutationFn: (value: boolean) =>
      api.putAttendance(orgId, wsId, entry.userId, { attended: value }),
  });
  const toggle = async (value: boolean) => {
    setState('pending');
    try {
      await put.mutateAsync(value);
      setState('done');
      refetch();
      setTimeout(() => setState('idle'), 1500);
    } catch (failure) {
      setError(failure);
      setState('error');
    }
  };
  const id = `att-${entry.userId}`;
  return (
    <div className="attendance">
      <input
        id={id}
        type="checkbox"
        checked={attended === true}
        disabled={state === 'pending'}
        onChange={(event) => void toggle(event.target.checked)}
      />
      <label htmlFor={id} className="small">
        {state === 'pending'
          ? 'Saving…'
          : state === 'done'
            ? 'Saved'
            : state === 'error'
              ? 'Failed'
              : attended === true
                ? 'Attended'
                : attended === false
                  ? 'Absent'
                  : 'Not marked'}
      </label>
      {state === 'error' && (
        <span className="error-text small" role="alert">
          {describeError(error)}
        </span>
      )}
    </div>
  );
}

function BackfillLog({
  backfills,
  sessions,
}: {
  backfills: readonly BackfillRecord[];
  sessions: readonly SessionView[];
}) {
  const latencies = backfills.flatMap((record) =>
    record.latencyMs === undefined ? [] : [record.latencyMs],
  );
  const rows = [...backfills].reverse();
  return (
    <section className="card" aria-labelledby="backfill-heading">
      <header className="card-header">
        <h2 id="backfill-heading">Backfill log</h2>
        <span className="muted small">
          {latencies.length}/{backfills.length} reallocated
          {latencies.length > 0 &&
            ` · p50 ${formatLatency(percentile(latencies, 50))} · p95 ${formatLatency(percentile(latencies, 95))} · max ${formatLatency(Math.max(...latencies))}`}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="muted">No seat has been released yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
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
              {rows.map((record) => (
                <tr key={record.id}>
                  <td>{formatTime(record.releasedAt)}</td>
                  <td>{sessionTitle(sessions, record.sessionId)}</td>
                  <td>{BACKFILL_CAUSE_TEXT[record.cause]}</td>
                  <td>
                    {record.reallocatedAt === undefined ? (
                      <span className="muted">waiting for a taker</span>
                    ) : (
                      formatTime(record.reallocatedAt)
                    )}
                  </td>
                  <td className="num">{formatLatency(record.latencyMs)}</td>
                  <td className="small">
                    {record.newUserId === undefined ? (
                      '—'
                    ) : (
                      <code title={record.newUserId}>{record.newUserId.slice(0, 8)}…</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function VerifyPanel({ orgId, wsId }: { orgId: string; wsId: string }) {
  const api = useApi();
  const verify = useMutation({ mutationFn: () => api.verify(orgId, wsId) });
  const [result, setResult] = useState<VerifyView | undefined>(undefined);
  const state: AsyncState = verify.isPending
    ? 'pending'
    : verify.isError
      ? 'error'
      : result !== undefined
        ? 'done'
        : 'idle';
  const run = async () => {
    try {
      setResult(await verify.mutateAsync());
    } catch {
      // surfaced below through verify.error
    }
  };
  return (
    <div className="stack-tight">
      <div className="actions">
        <AsyncButton
          variant="secondary"
          state={state}
          idle="Verify invariants"
          pending="Checking…"
          done={result?.ok ? 'OK — verify again' : 'Violations — verify again'}
          error="Retry verify"
          onClick={() => void run()}
        />
        {verify.isError && (
          <span className="error-text small" role="alert">
            {describeError(verify.error)}
          </span>
        )}
      </div>
      {result !== undefined && (
        <div className={`banner ${result.ok ? 'banner-success' : 'banner-error'}`} role="status">
          <div>
            <strong>
              {result.ok
                ? 'All invariants hold'
                : `${result.violations.length} violation${result.violations.length === 1 ? '' : 's'}`}
            </strong>
            <p className="small">
              checked {formatDateTime(result.checkedAt)} — C1 no over-capacity, C2 no double holds,
              and the other engine invariants.
            </p>
            {!result.ok && (
              <ul className="error-list">
                {result.violations.map((violation, index) => (
                  <li key={`${violation.code}-${index}`}>
                    <code>{violation.code}</code> {violation.message}
                    {violation.sessionId !== undefined && ` (session ${violation.sessionId})`}
                    {violation.userId !== undefined && ` (user ${violation.userId})`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ExportButton({ orgId, wsId }: { orgId: string; wsId: string }) {
  const api = useApi();
  const [state, setState] = useState<AsyncState>('idle');
  const [error, setError] = useState<unknown>(undefined);
  const download = async () => {
    setState('pending');
    try {
      const csv = await api.exportCsv(orgId, wsId);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `seatrelay-${wsId}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState('done');
      setTimeout(() => setState('idle'), 2000);
    } catch (failure) {
      setError(failure);
      setState('error');
    }
  };
  return (
    <>
      <AsyncButton
        variant="secondary"
        state={state}
        idle="Export CSV"
        pending="Preparing…"
        done="Downloaded"
        error="Retry export"
        onClick={() => void download()}
      />
      {state === 'error' && (
        <span className="error-text small" role="alert">
          {describeError(error)}
        </span>
      )}
    </>
  );
}

function WorkshopActions({ view, refetch }: { view: DashboardView; refetch: () => void }) {
  const { workshop, sessions } = view;
  const toggle = useCommand(workshop.id, { sessions, onSettled: refetch });
  const cancel = useCommand(workshop.id, { sessions, onSettled: refetch });
  const [confirm, setConfirm] = useState(false);
  if (isCancelledLike(workshop.status)) {
    return (
      <p className="banner banner-info">
        This workshop is{' '}
        {workshop.status === 'CANCELLING'
          ? 'being cancelled: seats and queue places are being released in the background'
          : 'cancelled'}
        . No further commands are possible.
      </p>
    );
  }
  return (
    <div className="actions">
      <AsyncButton
        variant="secondary"
        state={commandState(toggle)}
        idle={workshop.status === 'OPEN' ? 'Close registration' : 'Open registration'}
        pending={workshop.status === 'OPEN' ? 'Closing…' : 'Opening…'}
        done={workshop.status === 'OPEN' ? 'Closed' : 'Opened'}
        error="Retry"
        onClick={() =>
          toggle.state.phase === 'error'
            ? void toggle.retry()
            : void toggle.run({
                type: workshop.status === 'OPEN' ? 'CLOSE_REGISTRATION' : 'OPEN_REGISTRATION',
              })
        }
        disabled={toggle.busy}
      />
      <CommandFeedback command={toggle} />
      {!confirm ? (
        <AsyncButton
          variant="danger"
          state={commandState(cancel)}
          idle="Cancel workshop"
          pending="Cancelling…"
          done="Cancelled"
          error="Retry"
          onClick={() => (cancel.state.phase === 'error' ? void cancel.retry() : setConfirm(true))}
          disabled={cancel.busy}
        />
      ) : (
        <span className="confirm-inline">
          Cancel the whole workshop and release every seat?{' '}
          <button
            type="button"
            className="btn btn-danger btn-small"
            onClick={() => {
              setConfirm(false);
              void cancel.run({ type: 'CANCEL_WORKSHOP' });
            }}
          >
            Yes, cancel it
          </button>{' '}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setConfirm(false)}
          >
            Keep it
          </button>
        </span>
      )}
      <CommandFeedback command={cancel} />
    </div>
  );
}

function Dashboard({ orgId, wsId }: { orgId: string; wsId: string }) {
  const query = useDashboard(orgId, wsId);
  const refetch = () => void query.refetch();
  if (query.isPending) {
    return <Loading label="Loading dashboard…" />;
  }
  if (query.isError) {
    return (
      <ErrorBanner error={query.error} title="Could not load the dashboard" onRetry={refetch} />
    );
  }
  const view = query.data;
  const { workshop, sessions, counts } = view;
  const workshopClosed = isCancelledLike(workshop.status);
  const attendanceByUser = new Map(
    view.attendance.map((record) => [record.userId, record.attended]),
  );
  const publicUrl = `${window.location.origin}/workshops/${encodeURIComponent(workshop.id)}`;

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h1>{workshop.title}</h1>
          <p className="muted">
            <StatusBadge status={workshop.status} /> · {workshop.mode} · hold{' '}
            {formatSeconds(workshop.holdSeconds)} · version {workshop.version}
            {workshop.nextDueAt !== undefined && ` · next due ${formatTime(workshop.nextDueAt)}`}
          </p>
        </div>
        <div className="actions">
          <Link
            to={`/workshops/${encodeURIComponent(workshop.id)}`}
            className="btn btn-secondary btn-small"
          >
            Public page
          </Link>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={refetch}
            disabled={query.isFetching}
          >
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <dl className="stats">
        <div>
          <dt>Queued</dt>
          <dd>{counts.queued}</dd>
        </div>
        <div>
          <dt>Offered</dt>
          <dd>{counts.offered}</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>{counts.confirmed}</dd>
        </div>
        <div>
          <dt>Distinct served</dt>
          <dd>{view.distinctParticipantsServed}</dd>
        </div>
        <div>
          <dt>Backfills</dt>
          <dd>
            {counts.backfillsReallocated}/{counts.backfills}
          </dd>
        </div>
        <div>
          <dt>Attended</dt>
          <dd>{counts.attended}</dd>
        </div>
      </dl>

      <section className="card" aria-labelledby="actions-heading">
        <header className="card-header">
          <h2 id="actions-heading">Actions</h2>
        </header>
        <WorkshopActions view={view} refetch={refetch} />
        <div className="actions">
          <ExportButton orgId={orgId} wsId={wsId} />
        </div>
        <VerifyPanel orgId={orgId} wsId={wsId} />
        <CopyLink url={publicUrl} label="Share link (public page)" />
      </section>

      <section className="card" aria-labelledby="sessions-heading">
        <header className="card-header">
          <h2 id="sessions-heading">Sessions</h2>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Capacity
                </th>
                <th scope="col" className="num">
                  Confirmed
                </th>
                <th scope="col" className="num">
                  Held
                </th>
                <th scope="col" className="num">
                  Free
                </th>
                <th scope="col" className="num">
                  Waiting
                </th>
                <th scope="col">Manage</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  sessions={sessions}
                  wsId={wsId}
                  workshopClosed={workshopClosed}
                  refetch={refetch}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="queue-heading">
        <header className="card-header">
          <h2 id="queue-heading">Queue ({view.queue.length})</h2>
        </header>
        {view.queue.length === 0 ? (
          <p className="muted">Nobody is waiting.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Position
                  </th>
                  <th scope="col" className="num">
                    Seq
                  </th>
                  <th scope="col">Participant</th>
                  <th scope="col">Acceptable (in order)</th>
                </tr>
              </thead>
              <tbody>
                {view.queue.map((entry) => (
                  <tr key={entry.seq}>
                    <td className="num">{entry.queuePosition}</td>
                    <td className="num">{entry.seq}</td>
                    <td>{participantLabel(entry)}</td>
                    <td className="small">
                      {entry.acceptable.map((id) => sessionTitle(sessions, id)).join(' › ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="offered-heading">
        <header className="card-header">
          <h2 id="offered-heading">Offered ({view.offered.length})</h2>
        </header>
        {view.offered.length === 0 ? (
          <p className="muted">No seat is currently held.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Seq
                  </th>
                  <th scope="col">Participant</th>
                  <th scope="col">Session</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {view.offered.map((entry) => (
                  <tr key={entry.seq}>
                    <td className="num">{entry.seq}</td>
                    <td>{participantLabel(entry)}</td>
                    <td>{sessionTitle(sessions, entry.offer.sessionId)}</td>
                    <td>
                      <Countdown expiresAt={entry.offer.expiresAt} onExpire={refetch} />{' '}
                      <span className="muted small">({formatTime(entry.offer.expiresAt)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="confirmed-heading">
        <header className="card-header">
          <h2 id="confirmed-heading">Confirmed ({view.confirmed.length})</h2>
        </header>
        {view.confirmed.length === 0 ? (
          <p className="muted">No confirmed seat yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Seq
                  </th>
                  <th scope="col">Participant</th>
                  <th scope="col">Session</th>
                  <th scope="col">Confirmed at</th>
                  <th scope="col">Attendance</th>
                </tr>
              </thead>
              <tbody>
                {view.confirmed.map((entry) => (
                  <tr key={`${entry.seq}-${entry.sessionId}`}>
                    <td className="num">{entry.seq}</td>
                    <td>{participantLabel(entry)}</td>
                    <td>{sessionTitle(sessions, entry.sessionId)}</td>
                    <td>{formatDateTime(entry.confirmedAt)}</td>
                    <td>
                      <AttendanceCell
                        orgId={orgId}
                        wsId={wsId}
                        entry={entry}
                        attended={attendanceByUser.get(entry.userId)}
                        refetch={refetch}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <BackfillLog backfills={view.backfills} sessions={sessions} />
      <p className="muted small">Dashboard refreshes every 10 s while this tab is visible.</p>
    </div>
  );
}

export function DashboardPage() {
  const { orgId, wsId } = useParams<{ orgId: string; wsId: string }>();
  if (orgId === undefined || wsId === undefined) {
    return <ErrorBanner error={new Error('Missing organisation or workshop id')} />;
  }
  return (
    <div className="stack">
      <p className="muted small">
        <Link to={`/org/${encodeURIComponent(orgId)}/workshops`}>← Workshops</Link>
      </p>
      <RequireAuth purpose="Sign in as an organiser to open the dashboard.">
        <Dashboard orgId={orgId} wsId={wsId} />
      </RequireAuth>
    </div>
  );
}
