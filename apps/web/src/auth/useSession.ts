import { useCallback, useMemo } from 'react';
import { useAuth } from 'react-oidc-context';
import { useEnv } from '../env-context';
import {
  bearerToken,
  profileOf,
  sanitizeReturnTo,
  signOut,
  type SessionProfile,
} from './authAdapter';
import { useSessionRenewal } from './sessionRenewal';

export interface Session {
  /** The OIDC library is loading or navigating, or a stored session is being refreshed. */
  isLoading: boolean;
  isAuthenticated: boolean;
  profile: SessionProfile | undefined;
  /** Sign-in / renew error from the OIDC library, if any. */
  error: Error | undefined;
  signIn(returnTo?: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Thin view over react-oidc-context: identity + sign-in/out bound to the provider in env.js. */
export function useSession(): Session {
  const auth = useAuth();
  const env = useEnv();
  const renewal = useSessionRenewal();
  const token = bearerToken(auth.user);
  const profile = useMemo(() => profileOf(auth.user), [auth.user]);

  const signIn = useCallback(
    async (returnTo?: string) => {
      const target = sanitizeReturnTo(
        returnTo ?? `${window.location.pathname}${window.location.search}`,
      );
      await auth.signinRedirect({ state: { returnTo: target } });
    },
    [auth],
  );

  const doSignOut = useCallback(async () => {
    await signOut(auth, env, window.location.origin, (url) => window.location.assign(url));
  }, [auth, env]);

  return {
    isLoading: auth.isLoading || renewal.pending,
    isAuthenticated: auth.isAuthenticated && token !== undefined,
    profile,
    error: auth.error,
    signIn,
    signOut: doSignOut,
  };
}
