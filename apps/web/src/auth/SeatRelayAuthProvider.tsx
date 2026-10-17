import { WebStorageStateStore, type User } from 'oidc-client-ts';
import { useMemo, type ReactNode } from 'react';
import { AuthProvider } from 'react-oidc-context';
import type { SeatRelayEnv } from '../env';
import { buildOidcSettings, CALLBACK_PATH, RETURN_TO_KEY, returnToFromState } from './authAdapter';

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

export function SeatRelayAuthProvider({ env, children }: Props) {
  const settings = useMemo(
    () =>
      buildOidcSettings(
        env,
        window.location.origin,
        new WebStorageStateStore({ store: window.localStorage }),
      ),
    [env],
  );
  return (
    <AuthProvider {...settings} onSigninCallback={rememberReturnTo}>
      {children}
    </AuthProvider>
  );
}
