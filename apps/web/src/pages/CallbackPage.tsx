import { useEffect, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from 'react-router-dom';
import { RETURN_TO_KEY, sanitizeReturnTo } from '../auth/authAdapter';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

function storedReturnTo(): string {
  try {
    const value = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    return sanitizeReturnTo(value);
  } catch {
    return '/';
  }
}

/** `/callback`: react-oidc-context has already exchanged the code; go back where we came from. */
export function CallbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (auth.isLoading || auth.activeNavigator !== undefined) {
      return;
    }
    if (auth.error !== undefined) {
      setFailed(auth.error);
      return;
    }
    navigate(storedReturnTo(), { replace: true });
  }, [auth.activeNavigator, auth.error, auth.isLoading, navigate]);

  if (failed !== undefined) {
    return (
      <div className="stack">
        <ErrorBanner
          error={failed}
          title="Sign-in did not complete"
          onRetry={() => void auth.signinRedirect()}
          retryLabel="Try again"
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => navigate('/', { replace: true })}
        >
          Back to home
        </button>
      </div>
    );
  }
  return <Loading label="Signing you in…" />;
}
