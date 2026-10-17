import type {
  CommandResultView,
  MyRegistrationListView,
  MyRegistrationView,
  RegistrationSummary,
  SessionView,
  WorkshopPublic,
  WorkshopPublicView,
} from '@seatrelay/contracts';

export const WS = 'ws-1';
export const S1 = 'sess-1';
export const S2 = 'sess-2';
export const COMMAND_ID = '0f9a7d3e-5c4b-4a2e-9f1d-6b8c2e4a1d37';

export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 3, 6, 0, seconds)).toISOString();
}

export const workshop: WorkshopPublic = {
  id: WS,
  orgId: 'org-1',
  title: 'Intro to Git',
  description: '',
  status: 'OPEN',
  mode: 'UNIFIED',
  holdSeconds: 900,
  createdAt: at(0),
  updatedAt: at(0),
};

function session(id: string, title: string): SessionView {
  return {
    id,
    workshopId: WS,
    title,
    startsAt: '2026-11-10T06:00:00.000Z',
    cutoffAt: '2026-11-10T05:30:00.000Z',
    capacity: 10,
    confirmed: 0,
    held: 0,
    status: 'OPEN',
    free: 10,
    queueLength: 0,
  };
}

export const sessions: SessionView[] = [session(S1, 'Session 1'), session(S2, 'Session 2')];

/** A registration summary; an `undefined` override removes the field. */
export function summary(overrides: Partial<RegistrationSummary> = {}): RegistrationSummary {
  const result: RegistrationSummary = {
    status: 'QUEUED',
    seq: 1,
    queuePosition: 1,
    acceptable: [S1, S2],
    ...overrides,
  };
  const record = result as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return result;
}

export const confirmed = summary({
  status: 'CONFIRMED',
  queuePosition: undefined,
  confirmedSessionId: S1,
});
export const cancelled = summary({ status: 'CANCELLED', queuePosition: undefined });

export function listed(
  registration: RegistrationSummary,
  updatedAt: string,
  createdAt: string = at(1),
): MyRegistrationView {
  return { workshop, sessions, registration: { ...registration, createdAt, updatedAt } };
}

export function list(...entries: MyRegistrationView[]): MyRegistrationListView {
  return { registrations: entries };
}

export function workshopView(me?: RegistrationSummary): WorkshopPublicView {
  return { workshop, sessions, queueLength: 0, ...(me !== undefined ? { me } : {}) };
}

export function settledView(
  status: 'APPLIED' | 'REJECTED',
  registration?: RegistrationSummary,
  overrides: Partial<CommandResultView> = {},
): CommandResultView {
  return {
    commandId: COMMAND_ID,
    type: 'CANCEL_REGISTRATION',
    workshopId: WS,
    status,
    acceptedAt: at(100),
    settledAt: at(101),
    ...(status === 'APPLIED'
      ? { result: { offersCreated: 0, ...(registration !== undefined ? { registration } : {}) } }
      : { reason: 'NOT_REGISTERED' as const }),
    ...overrides,
  };
}
