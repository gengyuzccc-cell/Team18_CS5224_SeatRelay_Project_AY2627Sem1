import type {
  MyRegistrationListView,
  MyRegistrationView,
  RegistrationSummary,
  WorkshopMode,
} from '@seatrelay/contracts';
import { compareListed, isFinalStatus } from './settledRegistrations';

/**
 * The workshop page's `me` is the caller's *live* registration, so it disappears when the
 * registration ends (hold expired, declined, cancelled, cut-off, organiser cancellation). The page
 * then explains what happened with the most recent CANCELLED/ENDED registration of this workshop
 * from `GET /me/registrations` (which lists history), until the participant registers again.
 */

function entriesOf(
  list: MyRegistrationListView | undefined,
  workshopId: string,
): MyRegistrationView[] {
  return (list?.registrations ?? []).filter((entry) => entry.workshop.id === workshopId);
}

/**
 * The ended registration to explain on the workshop page, if any: the most recently updated
 * CANCELLED/ENDED one, unless a live registration was created after it ended (the participant
 * registered again). In UNIFIED mode a live `me` always wins (one live registration per person,
 * R1); in PER_SESSION mode it can be shown next to the live one of another session.
 */
export function latestEndedRegistration(
  list: MyRegistrationListView | undefined,
  workshopId: string,
  me: RegistrationSummary | undefined,
  mode: WorkshopMode,
): MyRegistrationView | undefined {
  if (mode === 'UNIFIED' && me !== undefined) {
    return undefined;
  }
  const entries = entriesOf(list, workshopId);
  const ended = entries
    .filter((entry) => isFinalStatus(entry.registration.status))
    .sort(compareListed)[0];
  if (ended === undefined) {
    return undefined;
  }
  const endedAt = Date.parse(ended.registration.updatedAt);
  const registeredAgain = entries.some(
    (entry) =>
      !isFinalStatus(entry.registration.status) &&
      Date.parse(entry.registration.createdAt) >= endedAt,
  );
  return registeredAgain ? undefined : ended;
}

/**
 * `GET /me/registrations` is an eventually consistent read on AWS (GSI): right after a
 * registration ended it can still be listed as live, or, while the index applies the delete of
 * the live item and the put of the archived one separately, not be listed at all. In UNIFIED
 * mode, while the (consistent) workshop view has no `me`, the list is behind and should be
 * fetched again shortly when it has a live entry for this workshop, or when it does not yet list
 * as CANCELLED/ENDED the registration `awaitedSeq` that this page last saw live.
 */
export function listBehindWorkshopView(
  list: MyRegistrationListView | undefined,
  workshopId: string,
  me: RegistrationSummary | undefined,
  mode: WorkshopMode,
  awaitedSeq?: number,
): boolean {
  if (list === undefined || mode !== 'UNIFIED' || me !== undefined) {
    return false;
  }
  const entries = entriesOf(list, workshopId);
  return (
    entries.some((entry) => !isFinalStatus(entry.registration.status)) ||
    (awaitedSeq !== undefined &&
      !entries.some(
        (entry) =>
          entry.registration.seq === awaitedSeq && isFinalStatus(entry.registration.status),
      ))
  );
}

/**
 * The list should be fetched again shortly: it is behind the workshop view, or the ended
 * registration shown is still the poll result (no `ending` yet), so the card can only say
 * "you cancelled" / "your registration has ended" and not what exactly was released.
 */
export function needsCatchUp(
  list: MyRegistrationListView | undefined,
  workshopId: string,
  me: RegistrationSummary | undefined,
  mode: WorkshopMode,
  awaitedSeq?: number,
): boolean {
  if (listBehindWorkshopView(list, workshopId, me, mode, awaitedSeq)) {
    return true;
  }
  const ended = latestEndedRegistration(list, workshopId, me, mode);
  return ended !== undefined && ended.registration.ending === undefined;
}
