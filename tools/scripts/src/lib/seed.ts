import type { Organization, RegistrationSummary, Workshop } from '@seatrelay/contracts';
import { expectApplied, type ApiClient, type SettledCommand } from './api';

/**
 * API-level seeding primitives shared by `seed-demo` and `seed-study`: everything goes
 * through the public routes and the command queue, exactly like the browser does, so the
 * seeded state is produced by the engine (seq, offers, queue positions) and never written
 * directly.
 */

export class SeedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedStateError';
  }
}

export interface SeedLogger {
  (message: string, fields?: Record<string, unknown>): void;
}

const quiet: SeedLogger = () => undefined;

/** The caller's organisation with that name (case-insensitive), created when missing. */
export async function findOrCreateOrg(
  client: ApiClient,
  name: string,
  log: SeedLogger = quiet,
): Promise<{ organization: Organization; created: boolean }> {
  const me = await client.me();
  const wanted = name.trim().toLowerCase();
  const existing = me.organizations.find((org) => org.name.trim().toLowerCase() === wanted);
  if (existing !== undefined) {
    log('organisation reused', { orgId: existing.id, name: existing.name });
    return { organization: existing, created: false };
  }
  const organization = await client.createOrg(name);
  log('organisation created', { orgId: organization.id, name: organization.name });
  return { organization, created: true };
}

export interface CancelWorkshopsOptions {
  /** Return true to leave a workshop alone. */
  keep?: (workshop: Workshop) => boolean;
  log?: SeedLogger;
}

/** CANCEL_WORKSHOP for every OPEN/CLOSED workshop of the organisation (the reset of a seed). */
export async function cancelOrgWorkshops(
  client: ApiClient,
  orgId: string,
  options: CancelWorkshopsOptions = {},
): Promise<Workshop[]> {
  const log = options.log ?? quiet;
  const { workshops } = await client.listWorkshops(orgId);
  const cancelled: Workshop[] = [];
  for (const workshop of workshops) {
    if (workshop.status !== 'OPEN' && workshop.status !== 'CLOSED') {
      continue;
    }
    if (options.keep?.(workshop) === true) {
      continue;
    }
    const settled = await client.sendCommand(workshop.id, { type: 'CANCEL_WORKSHOP' });
    if (settled.record.status === 'REJECTED') {
      // Already cancelling/cancelled between the list and the command: nothing to do.
      log('cancel skipped', { workshopId: workshop.id, reason: settled.record.reason });
      continue;
    }
    log('workshop cancelled', { workshopId: workshop.id, title: workshop.title });
    cancelled.push(workshop);
  }
  return cancelled;
}

function registrationOf(settled: SettledCommand, who: string): RegistrationSummary {
  const registration = settled.record.result?.registration;
  if (registration === undefined) {
    throw new SeedStateError(`${who}: command ${settled.commandId} settled without a registration`);
  }
  return registration;
}

/** REGISTER with any preference list; returns whatever state the engine produced. */
export async function registerAny(
  client: ApiClient,
  wsId: string,
  acceptable: readonly string[],
  who: string,
): Promise<{ registration: RegistrationSummary; settled: SettledCommand }> {
  const settled = expectApplied(
    await client.sendCommand(wsId, { type: 'REGISTER', acceptable: [...acceptable] }),
    `${who} REGISTER`,
  );
  return { registration: registrationOf(settled, who), settled };
}

/**
 * Seeds a CONFIRMED seat: REGISTER with that single session as acceptable (a free seat must
 * exist, so the engine offers it at once) and ACCEPT_OFFER.
 */
export async function confirmSeat(
  client: ApiClient,
  wsId: string,
  sessionId: string,
  who: string,
): Promise<{ seq: number; offerId: string }> {
  const { registration } = await registerAny(client, wsId, [sessionId], who);
  if (registration.status !== 'OFFERED' || registration.currentOffer === undefined) {
    throw new SeedStateError(
      `${who}: expected an immediate offer on ${sessionId}, got ${registration.status} (is the session already full?)`,
    );
  }
  if (registration.currentOffer.sessionId !== sessionId) {
    throw new SeedStateError(
      `${who}: offered ${registration.currentOffer.sessionId} instead of ${sessionId}`,
    );
  }
  const offerId = registration.currentOffer.id;
  const accepted = expectApplied(
    await client.sendCommand(wsId, { type: 'ACCEPT_OFFER', offerId }),
    `${who} ACCEPT_OFFER`,
  );
  const confirmed = registrationOf(accepted, who);
  if (confirmed.status !== 'CONFIRMED' || confirmed.confirmedSessionId !== sessionId) {
    throw new SeedStateError(`${who}: expected CONFIRMED on ${sessionId}, got ${confirmed.status}`);
  }
  return { seq: confirmed.seq, offerId };
}

/** Seeds a QUEUED registration (every acceptable session must be full). */
export async function joinQueue(
  client: ApiClient,
  wsId: string,
  acceptable: readonly string[],
  who: string,
): Promise<{ seq: number; queuePosition: number }> {
  const { registration } = await registerAny(client, wsId, acceptable, who);
  if (registration.status !== 'QUEUED' || registration.queuePosition === undefined) {
    throw new SeedStateError(
      `${who}: expected QUEUED, got ${registration.status}${
        registration.currentOffer === undefined
          ? ''
          : ` (offered ${registration.currentOffer.sessionId})`
      }`,
    );
  }
  return { seq: registration.seq, queuePosition: registration.queuePosition };
}
