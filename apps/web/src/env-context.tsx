import { createContext, useContext, type ReactNode } from 'react';
import type { SeatRelayEnv } from './env';

const EnvContext = createContext<SeatRelayEnv | undefined>(undefined);

export function EnvProvider({ env, children }: { env: SeatRelayEnv; children: ReactNode }) {
  return <EnvContext.Provider value={env}>{children}</EnvContext.Provider>;
}

export function useEnv(): SeatRelayEnv {
  const env = useContext(EnvContext);
  if (env === undefined) {
    throw new Error('useEnv must be used inside <EnvProvider>');
  }
  return env;
}
