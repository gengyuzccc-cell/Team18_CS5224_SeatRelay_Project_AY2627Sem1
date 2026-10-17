import type {
  DashboardView,
  MyRegistrationListView,
  RegistrationStatus,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSession } from '../auth/useSession';
import { useApi } from './ApiProvider';
import { ApiError } from './client';
import { queryKeys } from './queryKeys';
import { settledRegistrationsFor } from './settledRegistrations';

export { queryKeys };

/**
 * Status page refresh while QUEUED/OFFERED (plan §1.3), and the organiser dashboard's refresh.
 * "Paused when the tab is hidden" is `refetchIntervalInBackground: false`: the interval keeps
 * ticking but query-core skips the fetch while `document.visibilityState` is hidden. The
 * interval itself must stay a plain number: an interval function that answers `false` while
 * hidden is only re-evaluated when the query updates, so a fetch that finished in a hidden tab
 * would switch the refresh off for good.
 */
export const LIVE_REFRESH_MS = 10_000;
export const NOTIFICATIONS_REFRESH_MS = 30_000;
const LIVE_STATUSES: readonly RegistrationStatus[] = ['QUEUED', 'OFFERED'];

export function isLiveStatus(status: RegistrationStatus | undefined): boolean {
  return status !== undefined && LIVE_STATUSES.includes(status);
}

/** `GET /workshops/{id}` refresh: only while my registration is QUEUED/OFFERED. */
export function workshopRefetchInterval(view: WorkshopPublicView | undefined): number | false {
  return isLiveStatus(view?.me?.status) ? LIVE_REFRESH_MS : false;
}

/** `GET /me/registrations` refresh: while any registration is QUEUED/OFFERED. */
export function myRegistrationsRefetchInterval(
  list: MyRegistrationListView | undefined,
): number | false {
  return (list?.registrations ?? []).some((entry) => isLiveStatus(entry.registration.status))
    ? LIVE_REFRESH_MS
    : false;
}

/** 404/403/401 are final answers; everything else gets one retry. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) {
    return false;
  }
  return failureCount < 1;
}

export function useMe() {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.me(),
    enabled: session.isAuthenticated,
    staleTime: 30_000,
    retry: shouldRetry,
  });
}

export function useWorkshop(wsId: string | undefined) {
  const api = useApi();
  const session = useSession();
  const authenticated = session.isAuthenticated;
  return useQuery({
    queryKey: queryKeys.workshop(wsId ?? '', authenticated),
    queryFn: ({ signal }) => api.getWorkshop(wsId ?? '', authenticated, signal),
    enabled: wsId !== undefined && wsId.length > 0 && !session.isLoading,
    retry: shouldRetry,
    refetchInterval: (query) => workshopRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/**
 * `GET /me/registrations` is an eventually consistent read on AWS (GSI): every response is merged
 * with the registrations that settled commands reported, until the server reflects them
 * (`settledRegistrations.ts`, plan §1.3).
 */
export function useMyRegistrations() {
  const api = useApi();
  const session = useSession();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.myRegistrations,
    queryFn: async () => settledRegistrationsFor(queryClient).apply(await api.myRegistrations()),
    enabled: session.isAuthenticated,
    retry: shouldRetry,
    refetchInterval: (query) => myRegistrationsRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

export function useNotifications() {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api.myNotifications(),
    enabled: session.isAuthenticated,
    retry: shouldRetry,
    refetchInterval: NOTIFICATIONS_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

export function useMarkNotificationRead() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) => api.markNotificationRead(notificationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
}

export function useCreateOrg() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createOrg({ name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

export function useAddMember(orgId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (member: { userId?: string; email?: string }) => api.addMember(orgId, member),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

export function useOrgWorkshops(orgId: string | undefined) {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: queryKeys.orgWorkshops(orgId ?? ''),
    queryFn: () => api.listWorkshops(orgId ?? ''),
    enabled: session.isAuthenticated && orgId !== undefined,
    retry: shouldRetry,
  });
}

export function useDashboard(orgId: string | undefined, wsId: string | undefined) {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: queryKeys.dashboard(orgId ?? '', wsId ?? ''),
    queryFn: ({ signal }) => api.dashboard(orgId ?? '', wsId ?? '', signal),
    enabled: session.isAuthenticated && orgId !== undefined && wsId !== undefined,
    retry: shouldRetry,
    refetchInterval: LIVE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * Refetch everything that a settled command may have changed for this workshop. The workshop and
 * dashboard views are consistent reads; `/me/registrations` responses are merged with the poll
 * results (see `useMyRegistrations`), so refetching it straight away cannot bring back a stale
 * state.
 */
export function useInvalidateWorkshop() {
  const queryClient = useQueryClient();
  return useCallback(
    (wsId: string) =>
      Promise.all([
        queryClient.invalidateQueries({
          predicate: (query) => {
            const key: QueryKey = query.queryKey;
            return (key[0] === 'workshop' && key[1] === wsId) || key[0] === 'dashboard';
          },
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.myRegistrations }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
      ]),
    [queryClient],
  );
}

/** After `PATCH /workshops/{id}` (title/description): every view that shows them. */
export function useInvalidateWorkshopInfo() {
  const queryClient = useQueryClient();
  return useCallback(
    (orgId: string, wsId: string) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(orgId, wsId) }),
        queryClient.invalidateQueries({ queryKey: ['workshop', wsId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgWorkshops(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.myRegistrations }),
      ]),
    [queryClient],
  );
}

export type { DashboardView, MyRegistrationListView, WorkshopPublicView };
