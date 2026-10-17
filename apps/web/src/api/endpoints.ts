import {
  AttendanceSchema,
  CommandAcceptedViewSchema,
  CommandResultViewSchema,
  DashboardViewSchema,
  HealthViewSchema,
  MeViewSchema,
  MyRegistrationListViewSchema,
  NotificationListViewSchema,
  NotificationViewSchema,
  OrganizationViewSchema,
  VerifyViewSchema,
  WorkshopListViewSchema,
  WorkshopPublicSchema,
  WorkshopPublicViewSchema,
  type AddMemberBody,
  type Attendance,
  type AttendanceBody,
  type CommandAcceptedView,
  type CommandBody,
  type CommandResultView,
  type CreateOrgBody,
  type CreateWorkshopInput,
  type DashboardView,
  type HealthView,
  type MeView,
  type MyRegistrationListView,
  type NotificationListView,
  type NotificationView,
  type OrganizationView,
  type PatchWorkshopBody,
  type VerifyView,
  type WorkshopListView,
  type WorkshopPublic,
  type WorkshopPublicView,
} from '@seatrelay/contracts';
import type { ApiClient } from './client';

/** Every route of plan §2.5 as a typed function; responses are validated with the contracts. */
export interface Endpoints {
  health(): Promise<HealthView>;
  me(): Promise<MeView>;
  myRegistrations(): Promise<MyRegistrationListView>;
  myNotifications(): Promise<NotificationListView>;
  markNotificationRead(notificationId: string): Promise<NotificationView>;
  createOrg(body: CreateOrgBody): Promise<OrganizationView>;
  addMember(orgId: string, body: AddMemberBody): Promise<OrganizationView>;
  listWorkshops(orgId: string): Promise<WorkshopListView>;
  createWorkshop(orgId: string, body: CreateWorkshopInput): Promise<WorkshopPublicView>;
  /** Signed in: `/workshops/{id}` (includes `me`); anonymous: `/public/workshops/{id}`. */
  getWorkshop(
    wsId: string,
    authenticated: boolean,
    signal?: AbortSignal,
  ): Promise<WorkshopPublicView>;
  patchWorkshop(wsId: string, body: PatchWorkshopBody): Promise<WorkshopPublic>;
  postCommand(wsId: string, body: CommandBody, signal?: AbortSignal): Promise<CommandAcceptedView>;
  getCommand(commandId: string, signal?: AbortSignal): Promise<CommandResultView>;
  dashboard(orgId: string, wsId: string, signal?: AbortSignal): Promise<DashboardView>;
  putAttendance(
    orgId: string,
    wsId: string,
    userId: string,
    body: AttendanceBody,
  ): Promise<Attendance>;
  exportCsv(orgId: string, wsId: string): Promise<string>;
  verify(orgId: string, wsId: string): Promise<VerifyView>;
}

const enc = encodeURIComponent;

export function createEndpoints(client: ApiClient): Endpoints {
  return {
    health: async () =>
      (await client.request('GET', '/health', { schema: HealthViewSchema, auth: 'none' })).data,
    me: async () => (await client.request('GET', '/me', { schema: MeViewSchema })).data,
    myRegistrations: async () =>
      (await client.request('GET', '/me/registrations', { schema: MyRegistrationListViewSchema }))
        .data,
    myNotifications: async () =>
      (await client.request('GET', '/me/notifications', { schema: NotificationListViewSchema }))
        .data,
    markNotificationRead: async (notificationId) =>
      (
        await client.request('POST', `/me/notifications/${enc(notificationId)}/read`, {
          schema: NotificationViewSchema,
        })
      ).data,
    createOrg: async (body) =>
      (await client.request('POST', '/orgs', { schema: OrganizationViewSchema, body })).data,
    addMember: async (orgId, body) =>
      (
        await client.request('POST', `/orgs/${enc(orgId)}/members`, {
          schema: OrganizationViewSchema,
          body,
        })
      ).data,
    listWorkshops: async (orgId) =>
      (
        await client.request('GET', `/orgs/${enc(orgId)}/workshops`, {
          schema: WorkshopListViewSchema,
        })
      ).data,
    createWorkshop: async (orgId, body) =>
      (
        await client.request('POST', `/orgs/${enc(orgId)}/workshops`, {
          schema: WorkshopPublicViewSchema,
          body,
        })
      ).data,
    getWorkshop: async (wsId, authenticated, signal) =>
      (
        await client.request(
          'GET',
          authenticated ? `/workshops/${enc(wsId)}` : `/public/workshops/${enc(wsId)}`,
          { schema: WorkshopPublicViewSchema, auth: authenticated ? 'required' : 'none', signal },
        )
      ).data,
    patchWorkshop: async (wsId, body) =>
      (
        await client.request('PATCH', `/workshops/${enc(wsId)}`, {
          schema: WorkshopPublicSchema,
          body,
        })
      ).data,
    postCommand: async (wsId, body, signal) =>
      (
        await client.request('POST', `/workshops/${enc(wsId)}/commands`, {
          schema: CommandAcceptedViewSchema,
          body,
          signal,
        })
      ).data,
    getCommand: async (commandId, signal) =>
      (
        await client.request('GET', `/commands/${enc(commandId)}`, {
          schema: CommandResultViewSchema,
          signal,
        })
      ).data,
    dashboard: async (orgId, wsId, signal) =>
      (
        await client.request('GET', `/orgs/${enc(orgId)}/workshops/${enc(wsId)}/dashboard`, {
          schema: DashboardViewSchema,
          signal,
        })
      ).data,
    putAttendance: async (orgId, wsId, userId, body) =>
      (
        await client.request(
          'PUT',
          `/orgs/${enc(orgId)}/workshops/${enc(wsId)}/attendance/${enc(userId)}`,
          { schema: AttendanceSchema, body },
        )
      ).data,
    exportCsv: (orgId, wsId) =>
      client.text(`/orgs/${enc(orgId)}/workshops/${enc(wsId)}/export.csv`),
    verify: async (orgId, wsId) =>
      (
        await client.request('GET', `/orgs/${enc(orgId)}/workshops/${enc(wsId)}/verify`, {
          schema: VerifyViewSchema,
        })
      ).data,
  };
}
