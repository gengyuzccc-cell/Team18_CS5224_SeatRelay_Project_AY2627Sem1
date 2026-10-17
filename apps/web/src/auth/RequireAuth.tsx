import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Loading } from '../components/Loading';
import { useSession } from './useSession';

interface Props {
  children: ReactNode;
  /** What the page needs the account for, shown on the sign-in panel. */
  purpose?: string;
}

/** Renders children when signed in; otherwise a sign-in panel that returns to this page. */
export function RequireAuth({ children, purpose }: Props) {
  const session = useSession();
  const location = useLocation();
  if (session.isLoading) {
    return <Loading label="Checking your session…" />;
  }
  if (!session.isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <section className="card panel-center" aria-labelledby="signin-heading">
        <h2 id="signin-heading">Sign in required</h2>
        <p className="muted">{purpose ?? 'Sign in to continue.'}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void session.signIn(returnTo)}
        >
          Sign in
        </button>
      </section>
    );
  }
  return <>{children}</>;
}
