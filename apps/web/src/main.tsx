import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ApiProvider } from './api/ApiProvider';
import { SeatRelayAuthProvider } from './auth/SeatRelayAuthProvider';
import { ToastProvider } from './components/Toasts';
import { EnvProvider } from './env-context';
import { readEnv, type SeatRelayEnv } from './env';
import { router } from './router';
import './styles.css';

function ConfigError({ error }: { error: unknown }) {
  return (
    <main className="content">
      <div className="banner banner-error" role="alert">
        <div>
          <strong>SeatRelay is not configured</strong>
          <p>{error instanceof Error ? error.message : String(error)}</p>
          <p className="small">
            <code>/env.js</code> must define <code>window.__SEATRELAY_ENV__</code> (provider,
            authority, clientId, hostedUiDomain, apiBaseUrl, stage).
          </p>
        </div>
      </div>
    </main>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

function App({ env }: { env: SeatRelayEnv }) {
  return (
    <EnvProvider env={env}>
      <SeatRelayAuthProvider env={env}>
        <QueryClientProvider client={queryClient}>
          <ApiProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ApiProvider>
        </QueryClientProvider>
      </SeatRelayAuthProvider>
    </EnvProvider>
  );
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}
const root = createRoot(container);
try {
  const env = readEnv();
  root.render(
    <StrictMode>
      <App env={env} />
    </StrictMode>,
  );
} catch (error) {
  root.render(<ConfigError error={error} />);
}
