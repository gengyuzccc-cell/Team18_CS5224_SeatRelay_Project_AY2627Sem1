import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isLiveStatus, useMyRegistrations } from '../api/queries';
import { useSession } from '../auth/useSession';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { sessionTitle } from '../commands/copy';

function GoToWorkshop() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    const match = /workshops\/([^/?#]+)/.exec(trimmed);
    const wsId = match?.[1] ?? trimmed;
    if (wsId.length > 0) {
      navigate(`/workshops/${encodeURIComponent(wsId)}`);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field-label" htmlFor="ws-id">
        Open a workshop by link or id
      </label>
      <div className="copy-row">
        <input
          id="ws-id"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://…/workshops/<id> or <id>"
        />
        <button type="submit" className="btn btn-secondary">
          Open
        </button>
      </div>
    </form>
  );
}

function MySummary() {
  const registrations = useMyRegistrations();
  if (registrations.isPending) {
    return <Loading label="Loading your registrations…" />;
  }
  if (registrations.isError) {
    return (
      <ErrorBanner
        error={registrations.error}
        title="Could not load your registrations"
        onRetry={() => void registrations.refetch()}
      />
    );
  }
  const entries = registrations.data.registrations;
  const live = entries.filter(
    (entry) => isLiveStatus(entry.registration.status) || entry.registration.status === 'CONFIRMED',
  );
  return (
    <section className="card" aria-labelledby="mine-heading">
      <header className="card-header">
        <h2 id="mine-heading">My registrations</h2>
        <Link to="/me/registrations" className="btn btn-secondary btn-small">
          See all ({entries.length})
        </Link>
      </header>
      {live.length === 0 ? (
        <p className="muted">No active registration. Open a workshop link to join a queue.</p>
      ) : (
        <ul className="list">
          {live.slice(0, 5).map((entry) => (
            <li key={`${entry.workshop.id}-${entry.registration.seq}`} className="list-row">
              <Link to={`/workshops/${encodeURIComponent(entry.workshop.id)}`}>
                {entry.workshop.title}
              </Link>
              <span className="muted">
                {entry.registration.status === 'QUEUED' &&
                  `position ${entry.registration.queuePosition ?? '?'}`}
                {entry.registration.status === 'OFFERED' &&
                  `offer: ${sessionTitle(entry.sessions, entry.registration.currentOffer?.sessionId)}`}
                {entry.registration.status === 'CONFIRMED' &&
                  sessionTitle(entry.sessions, entry.registration.confirmedSessionId)}
              </span>
              <StatusBadge status={entry.registration.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomePage() {
  const session = useSession();
  return (
    <div className="stack">
      <section className="hero">
        <h1>One queue, many sessions, no double holds.</h1>
        <p className="lead">
          SeatRelay lets you register once for a multi-session workshop, rank the sessions you can
          attend, and get a seat offered the moment one frees up — held for you for a short, fair
          window.
        </p>
        {session.isLoading ? (
          <Loading label="Checking your session…" />
        ) : session.isAuthenticated ? (
          <p className="muted">
            Signed in as <strong>{session.profile?.email}</strong>.
          </p>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void session.signIn('/')}
            >
              Sign in
            </button>
            <span className="muted">
              Sign in with your account to register, or open a workshop link to look first.
            </span>
          </div>
        )}
        {session.error !== undefined && (
          <ErrorBanner error={session.error} title="Sign-in problem" />
        )}
      </section>

      <GoToWorkshop />

      {session.isAuthenticated && <MySummary />}

      <section className="card" aria-labelledby="org-heading">
        <header className="card-header">
          <h2 id="org-heading">Organisers</h2>
        </header>
        <p className="muted">
          Create an organisation, publish a workshop with 2–5 sessions, watch the queue, offers and
          backfills on the dashboard, change capacity, cancel sessions, mark attendance and export
          CSV.
        </p>
        <Link to="/org" className="btn btn-secondary">
          Go to the organiser area
        </Link>
      </section>
    </div>
  );
}
