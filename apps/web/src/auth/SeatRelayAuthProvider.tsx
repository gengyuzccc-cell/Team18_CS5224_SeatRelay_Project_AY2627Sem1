import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { useState, type ReactNode } from 'react';
import { AuthProvider } from 'react-oidc-context';
import type { SeatRelayEnv } from '../env';
import { buildOidcSettings, CALLBACK_PATH, RETURN_TO_KEY, returnToFromState } from './authAdapter';
import { SessionRenewalProvider } from './sessionRenewal';

interface Props {
  env: SeatRelayEnv;
  children: ReactNode;
}

function rememberReturnTo(user: User | undefined): void {
  const returnTo = returnToFromState(user?.state);
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, returnTo);
  } catch {
    // Private mode or blocked storage: the callback page falls back to "/".
  }
  // Drop `code`/`state` from the address bar; the /callback page then navigates to returnTo.
  window.history.replaceState({}, document.title, CALLBACK_PATH);
}

/**
 * One `UserManager` for the app, shared by react-oidc-context and the session renewal (which
 * calls it directly so that a failed start-up refresh is not reported as a sign-in error).
 */
export function SeatRelayAuthProvider({ env, children }: Props) {
  const [userManager] = useState(
    () =>
      new UserManager(
        buildOidcSettings(
          env,
          window.location.origin,
          new WebStorageStateStore({ store: window.localStorage }),
        ),
      ),
  );
  return (
    <AuthProvider userManager={userManager} onSigninCallback={rememberReturnTo}>
      <SessionRenewalProvider userManager={userManager}>{children}</SessionRenewalProvider>
    </AuthProvider>
  );
}
