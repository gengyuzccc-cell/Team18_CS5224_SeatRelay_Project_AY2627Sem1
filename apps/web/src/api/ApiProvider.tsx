import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { bearerToken } from '../auth/authAdapter';
import { useEnv } from '../env-context';
import { createApiClient } from './client';
import { createEndpoints, type Endpoints } from './endpoints';

const ApiContext = createContext<Endpoints | undefined>(undefined);

/**
 * Builds one API client for the app. The token getter reads the latest OIDC user through a
 * ref (never a stale closure) and, when the token has expired and a refresh token exists,
 * asks the library for a silent renew before the request goes out.
 */
export function ApiProvider({ children }: { children: ReactNode }) {
  const env = useEnv();
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  const endpoints = useMemo(() => {
    const client = createApiClient({
      baseUrl: env.apiBaseUrl,
      getToken: async () => {
        const current = authRef.current;
        const user = current.user;
        if (user === null || user === undefined) {
          return undefined;
        }
        if (user.expired === true && user.refresh_token !== undefined) {
          try {
            const renewed = await current.signinSilent();
            return bearerToken(renewed);
          } catch {
            return bearerToken(user);
          }
        }
        return bearerToken(user);
      },
    });
    return createEndpoints(client);
  }, [env.apiBaseUrl]);

  return <ApiContext.Provider value={endpoints}>{children}</ApiContext.Provider>;
}

export function useApi(): Endpoints {
  const api = useContext(ApiContext);
  if (api === undefined) {
    throw new Error('useApi must be used inside <ApiProvider>');
  }
  return api;
}
