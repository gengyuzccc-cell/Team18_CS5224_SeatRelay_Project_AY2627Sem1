import type { User, UserManager } from 'oidc-client-ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from 'react-oidc-context';

/**
 * oidc-client-ts arms its "expiring" timer (and so `automaticSilentRenew`) only for a token that
 * is still valid when the page loads, and react-oidc-context reports a stored user whose ID token
 * has expired as signed out. A participant who comes back after more than 60 min, for example
 * from an offer e-mail while the hold is ticking, would see "Sign in" although a refresh token
 * (Cognito: 30 days) is stored. This provider:
 *  - uses that refresh token once at start-up and reports the session as loading meanwhile, so
 *    no signed-out UI flashes;
 *  - gives the API client one deduplicated `renew()`;
 *  - handles a 401 for a token we sent: renew once, and if that is not possible or does not
 *    help, forget the dead session so the UI offers a new sign-in instead of failing silently.
 */

/** A second 401 this soon after a successful renew means the new token is not accepted either. */
export const RENEW_RETRY_WINDOW_MS = 60_000;

type StoredUser = Pick<User, 'expired' | 'refresh_token'>;

export function needsStartupRenew(user: StoredUser | null | undefined): boolean {
  return (
    user !== null &&
    user !== undefined &&
    user.expired === true &&
    typeof user.refresh_token === 'string' &&
    user.refresh_token.length > 0
  );
}

export type UnauthorizedAction = 'ignore' | 'renew' | 'sign-out';

/** What to do about a 401 the server returned for `sentToken`. Pure, for tests. */
export function unauthorizedAction(
  current: (StoredUser & Pick<User, 'id_token'>) | null | undefined,
  sentToken: string | undefined,
  lastRenewAt: number | undefined,
  now: number,
): UnauthorizedAction {
  if (current === null || current === undefined || sentToken === undefined) {
    return 'ignore';
  }
  if (current.id_token !== sentToken) {
    // The session was renewed (or replaced) after that request left: nothing to fix.
    return 'ignore';
  }
  const renewedRecently = lastRenewAt !== undefined && now - lastRenewAt < RENEW_RETRY_WINDOW_MS;
  const canRenew = typeof current.refresh_token === 'string' && current.refresh_token.length > 0;
  return canRenew && !renewedRecently ? 'renew' : 'sign-out';
}

export interface SessionRenewal {
  /** The start-up refresh is running (or about to): treat the session as loading. */
  pending: boolean;
  /** Refresh-token grant, one at a time; resolves to the renewed user or null. */
  renew(): Promise<User | null>;
  /** The API answered 401 for `sentToken`. */
  recoverUnauthorized(sentToken: string | undefined): Promise<void>;
}

const NO_RENEWAL: SessionRenewal = {
  pending: false,
  renew: async () => null,
  recoverUnauthorized: async () => undefined,
};

const SessionRenewalContext = createContext<SessionRenewal>(NO_RENEWAL);

export function SessionRenewalProvider({
  userManager,
  children,
}: {
  userManager: UserManager;
  children: ReactNode;
}) {
  const auth = useAuth();
  const [startup, setStartup] = useState<'idle' | 'running' | 'done'>('idle');
  const inflight = useRef<Promise<User | null> | undefined>(undefined);
  const lastRenewAt = useRef<number | undefined>(undefined);

  const renew = useCallback((): Promise<User | null> => {
    if (inflight.current === undefined) {
      inflight.current = userManager
        .signinSilent()
        .then((user) => {
          lastRenewAt.current = Date.now();
          return user;
        })
        .catch(() => null)
        .finally(() => {
          inflight.current = undefined;
        });
    }
    return inflight.current;
  }, [userManager]);

  const recoverUnauthorized = useCallback(
    async (sentToken: string | undefined) => {
      const current = await userManager.getUser();
      const action = unauthorizedAction(current, sentToken, lastRenewAt.current, Date.now());
      if (action === 'ignore') {
        return;
      }
      if (action === 'renew' && (await renew()) !== null) {
        return;
      }
      await userManager.removeUser();
    },
    [renew, userManager],
  );

  const needsRenew = !auth.isLoading && startup === 'idle' && needsStartupRenew(auth.user);
  useEffect(() => {
    if (!needsRenew) {
      return;
    }
    setStartup('running');
    void renew().finally(() => setStartup('done'));
  }, [needsRenew, renew]);

  const pending = startup === 'running' || needsRenew;
  const value = useMemo(
    () => ({ pending, renew, recoverUnauthorized }),
    [pending, recoverUnauthorized, renew],
  );
  return <SessionRenewalContext.Provider value={value}>{children}</SessionRenewalContext.Provider>;
}

export function useSessionRenewal(): SessionRenewal {
  return useContext(SessionRenewalContext);
}
