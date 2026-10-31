import { useEffect, useState, type FormEvent } from 'react';
import { DATA_NOTICE_ID } from '../util/notice';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { isLiveStatus, useMyRegistrations } from '../api/queries';
import { useSession } from '../auth/useSession';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { Icon } from '../components/Icon';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { sessionTitle } from '../commands/copy';
import { useDocumentTitle } from '../util/useDocumentTitle';

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
    <form className="inline-form card open-workshop" onSubmit={submit}>
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
        <EmptyState>No active registration. Open a workshop link to join a queue.</EmptyState>
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

/**
 * Data notice (PDPA notification obligation for a pilot with participants outside the team):
 * what signing in gives SeatRelay, who sees it, how long it is kept and how to have it removed.
 * Content only; the retention periods are the stores' automatic expiry.
 */
function DataNotice() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === `#${DATA_NOTICE_ID}`) {
      document.getElementById(DATA_NOTICE_ID)?.scrollIntoView();
    }
  }, [hash]);
  return (
    <section className="card" id={DATA_NOTICE_ID} aria-labelledby="data-notice-heading">
      <header className="card-header">
        <h2 id="data-notice-heading">What we keep</h2>
      </header>
      <ul className="list small">
        <li>
          Signing in through SeatRelay's own sign-in service (an AWS Cognito user pool, independent
          of any university account) gives SeatRelay your e-mail address, display name and an
          account id.
        </li>
        <li>
          Your registrations, holds, confirmations and attendance are visible to the organisers of
          that workshop, including in their CSV export.
        </li>
        <li>
          In-app notifications are kept for 90 days and command records for 30 days, then expire
          automatically. The API access log keeps your IP address and browser user agent for 14
          days.
        </li>
        <li>Notification e-mails are sent from the team's sender address.</li>
        <li>
          SeatRelay is NUS CS5224 Team 18 coursework; this pilot is not a university service. To
          have your account and its data removed, ask a workshop organiser or reply to any SeatRelay
          e-mail.
        </li>
      </ul>
    </section>
  );
}

export function HomePage() {
  const session = useSession();
  useDocumentTitle();
  return (
    <div className="stack">
      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">Multi-session workshop waitlist</p>
          <h1>
            One queue, many sessions, <span className="accent">no double holds.</span>
          </h1>
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
        </div>
        <ol className="hero-steps" aria-label="How it works">
          <li>
            <span className="hero-step-n" aria-hidden="true">
              1
            </span>
            <span>
              <strong>Rank</strong> the sessions you can attend
            </span>
          </li>
          <li>
            <span className="hero-step-n" aria-hidden="true">
              2
            </span>
            <span>
              <strong>Wait</strong> in one queue for all of them
            </span>
          </li>
          <li className="hero-step-held">
            <span className="hero-step-n" aria-hidden="true">
              <Icon name="clock" />
            </span>
            <span>
              <strong>Accept</strong> the seat held for you before its timer ends
            </span>
          </li>
        </ol>
      </section>

      <GoToWorkshop />

      <div className="home-grid">
        {session.isAuthenticated && <MySummary />}

        <section className="card" aria-labelledby="org-heading">
          <header className="card-header">
            <h2 id="org-heading">Organisers</h2>
          </header>
          <p className="muted">
            Create an organisation, publish a workshop with 2–5 sessions, watch the queue, offers
            and backfills on the dashboard, change capacity, cancel sessions, mark attendance and
            export CSV.
          </p>
          <Link to="/org" className="btn btn-secondary link-arrow">
            Go to the organiser area
            <Icon name="arrow-right" />
          </Link>
        </section>
      </div>

      <DataNotice />
    </div>
  );
}
