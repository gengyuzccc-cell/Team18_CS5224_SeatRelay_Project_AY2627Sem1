// @vitest-environment jsdom
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { User, UserManager } from 'oidc-client-ts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refetchUnauthorizedQueries } from '../src/api/ApiProvider';
import { ApiError } from '../src/api/client';
import {
  SessionRenewalProvider,
  useSessionRenewal,
  type SessionRenewal,
} from '../src/auth/sessionRenewal';

/**
 * Web audit (30 Oct): a 401 for a token that is not expired locally renewed the session but
 * left the queries that failed in their error state ("Your session has expired … Retry") until a
 * manual Retry. The renewal now reports its outcome and the provider refetches what failed.
 */

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ isLoading: false, user: null }),
}));

describe('refetchUnauthorizedQueries', () => {
  it('repeats only the active queries whose error is a 401', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const unauthorized = vi.fn(async (): Promise<string> => {
      throw new ApiError(401, 'UNAUTHORIZED', 'Unauthorized');
    });
    const failed = vi.fn(async () => {
      throw new ApiError(500, 'INTERNAL', 'boom');
    });
    const observers = [
      new QueryObserver(queryClient, { queryKey: ['me'], queryFn: unauthorized }),
      new QueryObserver(queryClient, { queryKey: ['other'], queryFn: failed }),
    ];
    const unsubscribe = observers.map((observer) => observer.subscribe(() => undefined));
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(['me'])?.status).toBe('error');
      expect(queryClient.getQueryState(['other'])?.status).toBe('error');
    });
    unauthorized.mockImplementation(async () => 'ok');
    await refetchUnauthorizedQueries(queryClient);
    expect(unauthorized).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['me'])).toBe('ok');
    unsubscribe.forEach((stop) => stop());
  });
});

describe('recoverUnauthorized reports what it did', () => {
  let root: Root;
  let container: HTMLDivElement;
  let renewal: SessionRenewal | undefined;

  function Probe() {
    renewal = useSessionRenewal();
    return null;
  }

  function fakeUserManager(stored: Partial<User> | null, renewed: Partial<User> | null) {
    const manager = {
      getUser: vi.fn(async () => stored as User | null),
      signinSilent: vi.fn(async () => {
        if (renewed === null) {
          throw new Error('refresh refused');
        }
        return renewed as User;
      }),
      removeUser: vi.fn(async () => undefined),
    };
    act(() => {
      root.render(
        <SessionRenewalProvider userManager={manager as unknown as UserManager}>
          <Probe />
        </SessionRenewalProvider>,
      );
    });
    return manager;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    renewal = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('"renewed" after a successful refresh-token grant, without dropping the session', async () => {
    const manager = fakeUserManager(
      { id_token: 't1', refresh_token: 'rt', expired: false },
      { id_token: 't2', refresh_token: 'rt', expired: false },
    );
    await expect(renewal?.recoverUnauthorized('t1')).resolves.toBe('renewed');
    expect(manager.signinSilent).toHaveBeenCalledTimes(1);
    expect(manager.removeUser).not.toHaveBeenCalled();
  });

  it('"renewed" when another request already replaced the rejected token', async () => {
    const manager = fakeUserManager({ id_token: 't2', refresh_token: 'rt', expired: false }, null);
    await expect(renewal?.recoverUnauthorized('t1')).resolves.toBe('renewed');
    expect(manager.signinSilent).not.toHaveBeenCalled();
    expect(manager.removeUser).not.toHaveBeenCalled();
  });

  it('"signed-out" when the refresh is refused, "ignored" when nothing is stored', async () => {
    const manager = fakeUserManager({ id_token: 't1', refresh_token: 'rt', expired: false }, null);
    await expect(renewal?.recoverUnauthorized('t1')).resolves.toBe('signed-out');
    expect(manager.removeUser).toHaveBeenCalledTimes(1);
    const none = fakeUserManager(null, null);
    await expect(renewal?.recoverUnauthorized('t1')).resolves.toBe('ignored');
    expect(none.removeUser).not.toHaveBeenCalled();
  });
});
