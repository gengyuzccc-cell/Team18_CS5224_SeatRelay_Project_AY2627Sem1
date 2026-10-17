import { NavLink, Outlet } from 'react-router-dom';
import { useNotifications } from '../api/queries';
import { useSession } from '../auth/useSession';
import { useEnv } from '../env-context';

function UnreadCount() {
  const notifications = useNotifications();
  const unread = (notifications.data?.notifications ?? []).filter(
    (n) => n.readAt === undefined,
  ).length;
  if (unread === 0) {
    return null;
  }
  return (
    <span className="pill" aria-label={`${unread} unread`}>
      {unread}
    </span>
  );
}

export function Layout() {
  const env = useEnv();
  const session = useSession();
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            SeatRelay{' '}
            <span className="badge badge-stage" title={`Deployment stage: ${env.stage}`}>
              {env.stage}
            </span>
          </NavLink>
          <nav aria-label="Primary">
            <NavLink to="/">Home</NavLink>
            {session.isAuthenticated && (
              <>
                <NavLink to="/me/registrations">My registrations</NavLink>
                <NavLink to="/me/notifications">
                  Notifications <UnreadCount />
                </NavLink>
                <NavLink to="/org">Organiser</NavLink>
              </>
            )}
          </nav>
          <div className="topbar-auth">
            {session.isLoading ? (
              <span className="muted">…</span>
            ) : session.isAuthenticated ? (
              <>
                <span className="muted user-email" title={session.profile?.userId}>
                  {session.profile?.name ?? session.profile?.email}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => void session.signOut()}
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => void session.signIn()}
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="content">
        <Outlet />
      </main>
      <footer className="footer muted">
        SeatRelay · unified waitlist with timed seat holds · all times shown in your local time zone
      </footer>
    </div>
  );
}
