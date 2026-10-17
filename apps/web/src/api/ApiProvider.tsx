import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { bearerToken } from '../auth/authAdapter';
import { useSessionRenewal } from '../auth/sessionRenewal';
import { useEnv } from '../env-context';
import { syncServerClock } from '../util/serverClock';
import { createApiClient } from './client';
import { createEndpoints, type Endpoints } from './endpoints';

const ApiContext = createContext<Endpoints | undefined>(undefined);

/** How often `GET /health` re-estimates the server clock offset (plan §1.4). */
export const CLOCK_SYNC_INTERVAL_MS = 10 * 60_000;

/**
 * Builds one API client for the app. The token getter reads the latest OIDC user through a
 * ref (never a stale closure) and, when the token has expired and a refresh token exists,
 * renews it before the request goes out. A 401 for a token that was sent goes to the session
 * renewal (renew once, else sign out locally so the UI offers a new sign-in).
 */
export function ApiProvider({ children }: { children: ReactNode }) {
  const env = useEnv();
  const auth = useAuth();
  const renewal = useSessionRenewal();
  const authRef = useRef(auth);
  authRef.current = auth;
  const renewalRef = useRef(renewal);
  renewalRef.current = renewal;

  const endpoints = useMemo(() => {
    const client = createApiClient({
      baseUrl: env.apiBaseUrl,
      getToken: async () => {
        const user = authRef.current.user;
        if (user === null || user === undefined) {
          return undefined;
        }
        if (user.expired === true && user.refresh_token !== undefined) {
          const renewed = await renewalRef.current.renew();
          return bearerToken(renewed ?? user);
        }
        return bearerToken(user);
      },
      onUnauthorized: (sentToken) => {
        if (sentToken !== undefined) {
          void renewalRef.current.recoverUnauthorized(sentToken);
        }
      },
    });
    return createEndpoints(client);
  }, [env.apiBaseUrl]);

  useEffect(() => {
    const sync = () => {
      syncServerClock(async () => (await endpoints.health()).time).catch(() => {
        // Offline or the API is down: keep the previous estimate (or the local clock).
      });
    };
    sync();
    const timer = setInterval(sync, CLOCK_SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [endpoints]);

  return <ApiContext.Provider value={endpoints}>{children}</ApiContext.Provider>;
}

export function useApi(): Endpoints {
  const api = useContext(ApiContext);
  if (api === undefined) {
    throw new Error('useApi must be used inside <ApiProvider>');
  }
  return api;
}
