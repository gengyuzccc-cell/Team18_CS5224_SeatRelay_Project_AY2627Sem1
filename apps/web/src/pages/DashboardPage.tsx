import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  type ConfirmedEntry,
  type DashboardView,
  type PatchWorkshopBody,
  type SessionView,
  type VerifyView,
  type WorkshopPublic,
} from '@seatrelay/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/ApiProvider';
import { useDashboard, useInvalidateWorkshopInfo } from '../api/queries';
import { RequireAuth } from '../auth/RequireAuth';
import { rejectReasonText, sessionTitle } from '../commands/copy';
import { useCommand, type CommandHandle } from '../commands/useCommand';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { BackfillLog } from '../components/BackfillLog';
import { CopyLink } from '../components/CopyLink';
import { Countdown } from '../components/Countdown';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { isCancelledLike, StatusBadge } from '../components/StatusBadge';
import { describeError } from '../util/errors';
import { participantLabel } from '../util/people';
import { formatDateTime, formatSeconds, formatTime } from '../util/time';
import { buildWorkshopPatch } from '../util/workshopPatch';

/** A definitive (4xx) failure is not retried: the button offers the action again (fresh id). */
function commandState(command: CommandHandle): AsyncState {
  switch (command.state.phase) {
    case 'submitting':
    case 'processing':
      return 'pending';
    case 'applied':
      return 'done';
    case 'error':
      return command.canRetry ? 'error' : 'idle';
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
        Rejected: {rejectReasonText(state.view.reason)}
      </span>
    );
  }
  return null;
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
    if (capacity.canRetry) {
      // The input is locked meanwhile, so the retried capacity is the one on screen.
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
                disabled={capacity.busy || capacity.canRetry}
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
                disabled={
                  capacity.busy || (!capacity.canRetry && Number(value) === session.capacity)
                }
              />
              {capacity.canRetry && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => capacity.reset()}
                >
                  Discard
                </button>
              )}
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
                onClick={() => (cancel.canRetry ? void cancel.retry() : setConfirm(true))}
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

/** "Edit details": title and description through the synchronous `PATCH /workshops/{wsId}`. */
function WorkshopDetailsEditor({ orgId, workshop }: { orgId: string; workshop: WorkshopPublic }) {
  const api = useApi();
  const invalidateInfo = useInvalidateWorkshopInfo();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: workshop.title, description: workshop.description });
  const [issues, setIssues] = useState<string[]>([]);
  const [state, setState] = useState<AsyncState>('idle');
  const save = useMutation({
    mutationFn: (body: PatchWorkshopBody) => api.patchWorkshop(workshop.id, body),
  });

  const start = () => {
    setDraft({ title: workshop.title, description: workshop.description });
    setIssues([]);
    setState('idle');
    save.reset();
    setOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const patch = buildWorkshopPatch(workshop, draft);
    if (patch.kind === 'unchanged') {
      setOpen(false);
      return;
    }
    if (patch.kind === 'invalid') {
      setIssues(patch.issues);
      return;
    }
    setIssues([]);
    setState('pending');
    try {
      await save.mutateAsync(patch.body);
      setState('done');
      await invalidateInfo(orgId, workshop.id);
      setOpen(false);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-small" onClick={start}>
        Edit details
      </button>
    );
  }
  return (
    <form className="card stack-tight" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label className="field-label" htmlFor="edit-title">
          Title
        </label>
        <input
          id="edit-title"
          type="text"
          maxLength={MAX_TITLE_LENGTH}
          required
          value={draft.title}
          disabled={state === 'pending'}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="edit-description">
          Description
        </label>
        <textarea
          id="edit-description"
          rows={3}
          maxLength={MAX_DESCRIPTION_LENGTH}
          value={draft.description}
          disabled={state === 'pending'}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
      {issues.length > 0 && (
        <ul className="error-list" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <AsyncButton
          type="submit"
          state={state}
          idle="Save details"
          pending="Saving…"
          done="Saved"
          error="Retry save"
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setOpen(false)}
          disabled={state === 'pending'}
        >
          Cancel
        </button>
        {state === 'error' && (
          <span className="error-text small" role="alert">
            {describeError(save.error)}
          </span>
        )}
      </div>
    </form>
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
          toggle.canRetry
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
          onClick={() => (cancel.canRetry ? void cancel.retry() : setConfirm(true))}
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
      {workshop.description.length > 0 && <p className="description">{workshop.description}</p>}
      <WorkshopDetailsEditor key={workshop.id} orgId={orgId} workshop={workshop} />

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
