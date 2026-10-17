import type { SessionView, WorkshopPublicView } from '@seatrelay/contracts';
import { useEffect, useMemo, useReducer, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkshop } from '../api/queries';
import { useSession } from '../auth/useSession';
import { rejectReasonText } from '../commands/copy';
import { useCommand, type CommandPhase } from '../commands/useCommand';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { CopyLink } from '../components/CopyLink';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { isCancelledLike, StatusBadge } from '../components/StatusBadge';
import { StatusCard } from '../components/StatusCard';
import { preferenceRank, preferenceReducer } from '../preferences/reducer';
import { describeError, isNotFound } from '../util/errors';
import { serverNow } from '../util/serverClock';
import { formatDateTime, formatSeconds } from '../util/time';

function SessionsTable({ sessions }: { sessions: readonly SessionView[] }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Sessions, capacity and queue</caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Starts</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Capacity
            </th>
            <th scope="col" className="num">
              Free
            </th>
            <th scope="col" className="num">
              Waiting
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <th scope="row">{session.title}</th>
              <td>
                {formatDateTime(session.startsAt)}
                <div className="muted small">cut-off {formatDateTime(session.cutoffAt)}</div>
              </td>
              <td>
                <StatusBadge status={session.status} />
              </td>
              <td className="num">{session.capacity}</td>
              <td className="num">{isCancelledLike(session.status) ? '—' : session.free}</td>
              <td className="num">{session.queueLength}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stateOf(state: CommandPhase): AsyncState {
  switch (state.phase) {
    case 'submitting':
    case 'processing':
      return 'pending';
    case 'applied':
      return 'done';
    case 'error':
      return state.retryable ? 'error' : 'idle';
    default:
      return 'idle';
  }
}

/** Checkboxes of acceptable sessions + up/down to order preference (UNIFIED), radio (PER_SESSION). */
function RegistrationForm({
  view,
  onChanged,
}: {
  view: WorkshopPublicView;
  onChanged: () => void;
}) {
  const { workshop, sessions } = view;
  const perSession = workshop.mode === 'PER_SESSION';
  // Cut-offs are judged on the server's clock (plan §1.4), not the browser's.
  const joinable = useMemo(
    () =>
      sessions.filter(
        (session) => !isCancelledLike(session.status) && Date.parse(session.cutoffAt) > serverNow(),
      ),
    [sessions],
  );
  const [selected, dispatch] = useReducer(preferenceReducer, []);
  const command = useCommand(workshop.id, { sessions, onSettled: onChanged });
  const [validation, setValidation] = useState<string | undefined>(undefined);

  const joinableIds = useMemo(() => joinable.map((session) => session.id), [joinable]);
  useEffect(() => {
    dispatch({ type: 'prune', valid: joinableIds });
  }, [joinableIds]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      setValidation(
        perSession
          ? 'Choose the session you want to join.'
          : 'Tick at least one session you could attend.',
      );
      return;
    }
    setValidation(undefined);
    if (command.canRetry) {
      // The inputs are locked meanwhile: what is re-sent is exactly what is shown.
      void command.retry();
      return;
    }
    void command.run({ type: 'REGISTER', acceptable: [...selected] });
  };

  const { state } = command;
  const phase = state.phase;
  // A retryable failure keeps the previous request (same commandId) until it is retried or
  // discarded, so the choices stay locked instead of silently not being sent.
  const locked = command.busy || command.canRetry;

  return (
    <form className="card" onSubmit={submit} aria-labelledby="register-heading">
      <header className="card-header">
        <h3 id="register-heading">Register</h3>
      </header>
      <p className="muted">
        {perSession
          ? 'Per-session mode: pick exactly one session. You may register separately for other sessions.'
          : 'Tick every session you could attend, then order them by preference (1 = most preferred). You get one seat in the best available session; you never hold two.'}
      </p>
      {joinable.length === 0 ? (
        <p className="muted">
          No session can be joined any more (all cancelled or past their cut-off).
        </p>
      ) : (
        <fieldset className="fieldset" disabled={locked}>
          <legend>{perSession ? 'Session' : 'Acceptable sessions, in preference order'}</legend>
          <ol className="pref-list">
            {(perSession
              ? joinable
              : [...joinable].sort((a, b) => {
                  const ra = preferenceRank(selected, a.id) ?? Number.MAX_SAFE_INTEGER;
                  const rb = preferenceRank(selected, b.id) ?? Number.MAX_SAFE_INTEGER;
                  return ra - rb;
                })
            ).map((session) => {
              const rank = preferenceRank(selected, session.id);
              const checked = rank !== undefined;
              const inputId = `pref-${session.id}`;
              return (
                <li key={session.id} className={`pref-row${checked ? ' pref-selected' : ''}`}>
                  <input
                    id={inputId}
                    type={perSession ? 'radio' : 'checkbox'}
                    name="acceptable"
                    checked={checked}
                    onChange={() =>
                      dispatch(
                        perSession
                          ? { type: 'selectOnly', id: session.id }
                          : { type: 'toggle', id: session.id },
                      )
                    }
                  />
                  <label htmlFor={inputId}>
                    {checked && !perSession && (
                      <span className="rank" aria-label={`preference ${rank}`}>
                        {rank}
                      </span>
                    )}
                    <span className="pref-title">{session.title}</span>
                    <span className="muted small">
                      {formatDateTime(session.startsAt)} · {session.free} free of {session.capacity}{' '}
                      · {session.queueLength} waiting
                    </span>
                  </label>
                  {!perSession && checked && (
                    <span className="pref-controls">
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`Move ${session.title} up`}
                        disabled={rank === 1}
                        onClick={() => dispatch({ type: 'moveUp', id: session.id })}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`Move ${session.title} down`}
                        disabled={rank === selected.length}
                        onClick={() => dispatch({ type: 'moveDown', id: session.id })}
                      >
                        ▼
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </fieldset>
      )}
      {validation !== undefined && (
        <p className="error-text" role="alert">
          {validation}
        </p>
      )}
      <div className="actions">
        <AsyncButton
          type="submit"
          state={stateOf(state)}
          idle={
            perSession
              ? 'Join the queue'
              : `Register${selected.length > 0 ? ` (${selected.length} session${selected.length === 1 ? '' : 's'})` : ''}`
          }
          pending={phase === 'submitting' ? 'Sending…' : 'Processing…'}
          done="Registered"
          error={
            state.phase === 'error' && state.stage === 'poll'
              ? 'Check the outcome'
              : 'Retry previous request'
          }
          disabled={joinable.length === 0}
        />
        {command.canRetry && state.phase === 'error' && state.stage === 'submit' && (
          <button type="button" className="btn btn-secondary" onClick={() => command.reset()}>
            Discard and edit
          </button>
        )}
        {state.phase === 'processing' && (
          <span className="muted small" role="status">
            {state.slow
              ? 'Still processing — checking every 5 s.'
              : 'Request received, waiting for the outcome…'}
          </span>
        )}
        {state.phase === 'error' && (
          <span className="error-text small" role="alert">
            {describeError(state.error)}
            {state.retryable && state.stage === 'submit'
              ? ' Retrying sends the same choices again; discard to change them.'
              : ''}
          </span>
        )}
        {state.phase === 'rejected' && (
          <span className="error-text small" role="alert">
            Registration rejected: {rejectReasonText(state.view.reason)}
          </span>
        )}
      </div>
      <p className="muted small">
        Offers are held for {formatSeconds(workshop.holdSeconds)} (shorter near a session's cut-off,
        30 min before start).
      </p>
    </form>
  );
}

export function WorkshopPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const session = useSession();
  const query = useWorkshop(wsId);
  const refetch = () => void query.refetch();

  if (wsId === undefined) {
    return <ErrorBanner error={new Error('Missing workshop id')} />;
  }
  if (query.isPending) {
    return <Loading label="Loading workshop…" />;
  }
  if (query.isError) {
    return (
      <ErrorBanner
        error={query.error}
        title={isNotFound(query.error) ? 'Workshop not found' : 'Could not load the workshop'}
        onRetry={refetch}
      />
    );
  }
  const view = query.data;
  const { workshop, sessions } = view;
  const closed = isCancelledLike(workshop.status);
  const shareUrl = `${window.location.origin}/workshops/${encodeURIComponent(workshop.id)}`;

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h1>{workshop.title}</h1>
          <p className="muted">
            <StatusBadge status={workshop.status} /> ·{' '}
            {workshop.mode === 'UNIFIED' ? 'Unified queue' : 'Per-session queues'} · hold{' '}
            {formatSeconds(workshop.holdSeconds)} · {view.queueLength} waiting in total
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={refetch}
          disabled={query.isFetching}
        >
          {query.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      {workshop.description.length > 0 && <p className="description">{workshop.description}</p>}

      <SessionsTable sessions={sessions} />

      {session.isLoading ? (
        <Loading label="Checking your session…" />
      ) : !session.isAuthenticated ? (
        <section className="card panel-center">
          <h3>Want a seat?</h3>
          <p className="muted">Sign in to register; you will come straight back to this page.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void session.signIn(`/workshops/${encodeURIComponent(workshop.id)}`)}
          >
            Sign in to register
          </button>
        </section>
      ) : (
        <>
          {view.me !== undefined && (
            <StatusCard
              workshop={workshop}
              sessions={sessions}
              registration={view.me}
              onChanged={refetch}
            />
          )}
          {closed ? (
            <p className="banner banner-info">
              This workshop is {workshop.status === 'CANCELLING' ? 'being cancelled' : 'cancelled'};
              no further actions are possible.
            </p>
          ) : workshop.status === 'CLOSED' ? (
            <p className="banner banner-info">Registration is closed by the organiser.</p>
          ) : view.me === undefined || workshop.mode === 'PER_SESSION' ? (
            <RegistrationForm key={view.me?.seq ?? 'new'} view={view} onChanged={refetch} />
          ) : null}
          {view.me !== undefined &&
            (view.me.status === 'QUEUED' || view.me.status === 'OFFERED') && (
              <p className="muted small">
                This page refreshes every 10 s while you are queued or offered (paused when the tab
                is hidden).
              </p>
            )}
        </>
      )}

      <CopyLink url={shareUrl} />
    </div>
  );
}
