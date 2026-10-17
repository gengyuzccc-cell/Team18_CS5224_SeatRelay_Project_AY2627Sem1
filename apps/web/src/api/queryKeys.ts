/** TanStack Query keys, shared by the query hooks and the cache patches of settled commands. */
export const queryKeys = {
  me: ['me'] as const,
  workshop: (wsId: string, authenticated: boolean) => ['workshop', wsId, authenticated] as const,
  myRegistrations: ['myRegistrations'] as const,
  notifications: ['notifications'] as const,
  orgWorkshops: (orgId: string) => ['orgWorkshops', orgId] as const,
  dashboard: (orgId: string, wsId: string) => ['dashboard', orgId, wsId] as const,
};
