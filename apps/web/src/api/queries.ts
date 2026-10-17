import type {
  DashboardView,
  MyRegistrationListView,
  RegistrationStatus,
  WorkshopPublicView,
} from '@seatrelay/contracts';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useSession } from '../auth/useSession';
import { useApi } from './ApiProvider';
import { ApiError } from './client';

/** Status page refresh while QUEUED/OFFERED (plan §1.3); paused when the tab is hidden. */
export const LIVE_REFRESH_MS = 10_000;
const LIVE_STATUSES: readonly RegistrationStatus[] = ['QUEUED', 'OFFERED'];

export function isLiveStatus(status: RegistrationStatus | undefined): boolean {
  return status !== undefined && LIVE_STATUSES.includes(status);
}

export const queryKeys = {
  me: ['me'] as const,
  workshop: (wsId: string, authenticated: boolean) => ['workshop', wsId, authenticated] as const,
  myRegistrations: ['myRegistrations'] as const,
  notifications: ['notifications'] as const,
  orgWorkshops: (orgId: string) => ['orgWorkshops', orgId] as const,
  dashboard: (orgId: string, wsId: string) => ['dashboard', orgId, wsId] as const,
};

function visibleInterval(ms: number): number | false {
  return typeof document !== 'undefined' && document.hidden ? false : ms;
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
    refetchInterval: (query) =>
      isLiveStatus(query.state.data?.me?.status) ? visibleInterval(LIVE_REFRESH_MS) : false,
    refetchIntervalInBackground: false,
  });
}

export function useMyRegistrations() {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: queryKeys.myRegistrations,
    queryFn: () => api.myRegistrations(),
    enabled: session.isAuthenticated,
    retry: shouldRetry,
    refetchInterval: (query) =>
      (query.state.data?.registrations ?? []).some((entry) =>
        isLiveStatus(entry.registration.status),
      )
        ? visibleInterval(LIVE_REFRESH_MS)
        : false,
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
    refetchInterval: () => visibleInterval(30_000),
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
    refetchInterval: () => visibleInterval(LIVE_REFRESH_MS),
    refetchIntervalInBackground: false,
  });
}

/** Refetch everything that a settled command may have changed for this workshop. */
export function useInvalidateWorkshop() {
  const queryClient = useQueryClient();
  return (wsId: string) =>
    Promise.all([
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key: QueryKey = query.queryKey;
          return (key[0] === 'workshop' && key[1] === wsId) || key[0] === 'dashboard';
        },
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.myRegistrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
    ]);
}

export type { DashboardView, MyRegistrationListView, WorkshopPublicView };
