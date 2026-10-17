import { Link } from 'react-router-dom';
import {
  CONFIRMED_REFRESH_MS,
  isLiveStatus,
  LIVE_REFRESH_MS,
  myRegistrationsRefetchInterval,
  useMyRegistrations,
} from '../api/queries';
import { RequireAuth } from '../auth/RequireAuth';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusCard } from '../components/StatusCard';
import { pastStatusText } from '../commands/copy';
import { formatDateTime } from '../util/time';

function RegistrationsList() {
  const query = useMyRegistrations();
  if (query.isPending) {
    return <Loading label="Loading your registrations…" />;
  }
  if (query.isError) {
    return (
      <ErrorBanner
        error={query.error}
        title="Could not load your registrations"
        onRetry={() => void query.refetch()}
      />
    );
  }
  const entries = query.data.registrations;
  const current = entries.filter(
    (entry) => isLiveStatus(entry.registration.status) || entry.registration.status === 'CONFIRMED',
  );
  const past = entries.filter((entry) => !current.includes(entry));
  const refetch = () => void query.refetch();
  return (
    <div className="stack">
      <section aria-labelledby="current-heading" className="stack">
        <h2 id="current-heading">Current</h2>
        {current.length === 0 ? (
          <p className="muted">Nothing active. Open a workshop link to join a queue.</p>
        ) : (
          current.map((entry) => (
            <div key={`${entry.workshop.id}-${entry.registration.seq}`} className="stack-tight">
              <StatusCard
                workshop={entry.workshop}
                sessions={entry.sessions}
                registration={entry.registration}
                onChanged={refetch}
                compact
              />
              <p className="muted small">
                <Link to={`/workshops/${encodeURIComponent(entry.workshop.id)}`}>
                  Open workshop page
                </Link>{' '}
                · registered {formatDateTime(entry.registration.createdAt)}
              </p>
            </div>
          ))
        )}
        {myRegistrationsRefetchInterval(query.data) === LIVE_REFRESH_MS && (
          <p className="muted small">
            Refreshing every {LIVE_REFRESH_MS / 1000} s while a registration is queued or offered
            (paused when hidden).
          </p>
        )}
        {myRegistrationsRefetchInterval(query.data) === CONFIRMED_REFRESH_MS && (
          <p className="muted small">
            Refreshing every {CONFIRMED_REFRESH_MS / 1000} s while a seat is confirmed (paused when
            hidden).
          </p>
        )}
      </section>
      {past.length > 0 && (
        <section aria-labelledby="past-heading" className="stack">
          <h2 id="past-heading">Past</h2>
          <ul className="list">
            {past.map((entry) => (
              <li key={`${entry.workshop.id}-${entry.registration.seq}`} className="list-row muted">
                <Link to={`/workshops/${encodeURIComponent(entry.workshop.id)}`}>
                  {entry.workshop.title}
                </Link>
                <span>
                  {pastStatusText(entry.registration, entry.sessions, entry.workshop.mode)} ·{' '}
                  {formatDateTime(entry.registration.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function MyRegistrationsPage() {
  return (
    <div className="stack">
      <h1>My registrations</h1>
      <RequireAuth purpose="Sign in to see your registrations.">
        <RegistrationsList />
      </RequireAuth>
    </div>
  );
}
