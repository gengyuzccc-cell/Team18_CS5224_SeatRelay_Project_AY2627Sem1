import type {
  BackfillCause,
  BackfillRecord,
  Command,
  OfferStatus,
  Session,
} from '@seatrelay/contracts';
import { parseIso, type Decision, type WorkshopSnapshot } from '@seatrelay/core';
import type { Scenario } from './generator';
import { mean, quantile } from './stats';

/**
 * Per-run metrics of the mechanism comparison (plan §4). Every value is computed from the
 * engine's own outputs (snapshots, writes, backfill records), never from the behaviour stream,
 * so both modes are measured by exactly the same code.
 *
 * - duplicate holds: moments where one user holds >= 2 OFFERED/CONFIRMED seats across sessions
 *   (`dup_hold_events`), the peak number of such users (`dup_hold_peak_users`) and the extra
 *   seats they tie up integrated over time (`dup_hold_seat_hours`). UNIFIED mode forbids this
 *   by construction (C2), so its values are 0 and double as an invariant check.
 * - distinct participants served: distinct users CONFIRMED when the last cut-off passes;
 *   `duplicate_confirmed` = confirmed seats − distinct users (the organiser's manual clean-up
 *   proxy: every one of those seats has to be chased and released by hand).
 * - seats wasted: Σ over sessions of `capacity − confirmed` at that session's cut-off.
 * - backfill relay latency: `reallocatedAt − releasedAt` of the engine's BackfillRecords. With
 *   the simulated clock every expiry TICK arrives exactly on time, so this is the pure engine
 *   latency (0 ms: the seat is relayed in the same decision) rather than infrastructure delay.
 * - seat refill time: for every released seat, minutes until the relay chain starting at that
 *   release ends in an ACCEPT by a participant who does not already hold a confirmed seat
 *   (released → offered → expired/declined → re-offered → … → confirmed). An acceptance by
 *   someone already confirmed elsewhere (a hoarded duplicate, PER_SESSION only) is followed to
 *   the later cancellation of that seat; chains that never reach a genuine confirmation
 *   (nobody waiting, offer still live, duplicate kept until the end) are counted as censored.
 */
export interface RunMetrics {
  participants: number;
  registrations: number;
  decisions: number;
  rejected: number;
  distinct_served: number;
  confirmed_seats: number;
  duplicate_confirmed: number;
  seats_wasted: number;
  fill_rate: number;
  dup_hold_events: number;
  dup_hold_peak_users: number;
  dup_hold_seat_hours: number;
  offers_created: number;
  offers_accepted: number;
  offers_declined: number;
  offers_expired: number;
  offers_revoked: number;
  cancellations: number;
  ended_cutoff: number;
  seat_releases: number;
  backfills_relayed: number;
  releases_unrelayed: number;
  backfill_relay_ms_mean: number;
  backfill_relay_ms_p50: number;
  backfill_relay_ms_p95: number;
  seat_refill_samples: number;
  seat_refill_censored: number;
  seat_refill_min_mean: number;
  seat_refill_min_p50: number;
  seat_refill_min_p95: number;
  invariant_violations: number;
}

/** Raw per-run samples kept beside the summary metrics for pooled statistics. */
export interface RunSamples {
  /** Seat refill times in minutes (one per release whose chain ended in a confirmation). */
  refillMin: number[];
  /** Engine relay latencies in ms (one per relayed backfill record). */
  relayMs: number[];
}

export const METRIC_KEYS: readonly (keyof RunMetrics)[] = [
  'participants',
  'registrations',
  'decisions',
  'rejected',
  'distinct_served',
  'confirmed_seats',
  'duplicate_confirmed',
  'seats_wasted',
  'fill_rate',
  'dup_hold_events',
  'dup_hold_peak_users',
  'dup_hold_seat_hours',
  'offers_created',
  'offers_accepted',
  'offers_declined',
  'offers_expired',
  'offers_revoked',
  'cancellations',
  'ended_cutoff',
  'seat_releases',
  'backfills_relayed',
  'releases_unrelayed',
  'backfill_relay_ms_mean',
  'backfill_relay_ms_p50',
  'backfill_relay_ms_p95',
  'seat_refill_samples',
  'seat_refill_censored',
  'seat_refill_min_mean',
  'seat_refill_min_p50',
  'seat_refill_min_p95',
  'invariant_violations',
];

/** Backfill causes that are a seat release by a participant (not organiser actions). */
const RELEASE_CAUSES: ReadonlySet<BackfillCause> = new Set<BackfillCause>([
  'EXPIRED',
  'DECLINED',
  'CANCELLED_OFFER',
  'CANCELLED_CONFIRMED',
]);

/** The backfill cause the engine records when an offer is settled with this status. */
const CAUSES_OF_FATE: Partial<Record<OfferStatus, readonly BackfillCause[]>> = {
  EXPIRED: ['EXPIRED'],
  DECLINED: ['DECLINED'],
  REVOKED: ['CANCELLED_OFFER', 'SESSION_CANCELLED'],
};

interface OfferFate {
  status: OfferStatus;
  settledAtMs: number;
  /** ACCEPTED by a participant who already held a confirmed seat in another session. */
  duplicate: boolean;
  /** The backfill record created when this seat was released again (expiry, decline, cancel). */
  nextRecordId?: string;
}

const HOUR_MS = 3_600_000;

export class MetricsCollector {
  private holdsByUser = new Map<string, number>();
  private extraSeats = 0;
  private extraSeatMs = 0;
  private lastObservedMs: number;
  private dupEvents = 0;
  private dupPeak = 0;
  private decisions = 0;
  private rejected = 0;
  private registrations = 0;
  private offersCreated = 0;
  private readonly settled: Record<OfferStatus, number> = {
    OFFERED: 0,
    ACCEPTED: 0,
    DECLINED: 0,
    EXPIRED: 0,
    REVOKED: 0,
  };
  private cancellations = 0;
  private endedCutoff = 0;
  private wastedAtCutoff = 0;
  private readonly cutoffsRecorded = new Set<string>();
  private readonly offerFates = new Map<string, OfferFate>();
  private readonly records = new Map<string, BackfillRecord>();
  /** `sessionId#userId` of hoarded (duplicate) confirmed seats → the accepted offer. */
  private readonly duplicateSeats = new Map<string, string>();
  private invariantViolations = 0;

  constructor(
    private readonly scenario: Scenario,
    startMs: number,
  ) {
    this.lastObservedMs = startMs;
  }

  addInvariantViolations(count: number): void {
    this.invariantViolations += count;
  }

  /** Called after every decision (continuations included) with the snapshot it produced. */
  observe(command: Command, decision: Decision, after: WorkshopSnapshot, nowMs: number): void {
    this.decisions += 1;
    if (decision.status === 'REJECTED') {
      this.rejected += 1;
    } else if (command.type === 'REGISTER') {
      this.registrations += 1;
    }

    this.extraSeatMs += this.extraSeats * (nowMs - this.lastObservedMs);
    this.lastObservedMs = nowMs;
    const holds = new Map<string, number>();
    for (const registration of after.registrations) {
      if (registration.status === 'OFFERED' || registration.status === 'CONFIRMED') {
        holds.set(registration.userId, (holds.get(registration.userId) ?? 0) + 1);
      }
    }
    let extra = 0;
    let duplicateUsers = 0;
    for (const [userId, count] of holds) {
      if (count >= 2) {
        duplicateUsers += 1;
        extra += count - 1;
        if ((this.holdsByUser.get(userId) ?? 0) < 2) {
          this.dupEvents += 1;
        }
      }
    }
    this.holdsByUser = holds;
    this.extraSeats = extra;
    this.dupPeak = Math.max(this.dupPeak, duplicateUsers);

    const archivedOffers: { id: string; sessionId: string; status: OfferStatus }[] = [];
    const releasedDuplicates: { sessionId: string; offerId: string }[] = [];
    for (const write of decision.writes) {
      switch (write.kind) {
        case 'PUT_OFFER':
          this.offersCreated += 1;
          break;
        case 'ARCHIVE_OFFER': {
          const { offer } = write;
          this.settled[offer.status] += 1;
          const duplicate =
            offer.status === 'ACCEPTED' &&
            after.registrations.some(
              (registration) =>
                registration.userId === offer.userId &&
                registration.status === 'CONFIRMED' &&
                registration.confirmedSessionId !== undefined &&
                registration.confirmedSessionId !== offer.sessionId,
            );
          this.offerFates.set(offer.id, {
            status: offer.status,
            settledAtMs: offer.settledAt === undefined ? nowMs : parseIso(offer.settledAt),
            duplicate,
          });
          if (duplicate) {
            this.duplicateSeats.set(`${offer.sessionId}#${offer.userId}`, offer.id);
          }
          archivedOffers.push({ id: offer.id, sessionId: offer.sessionId, status: offer.status });
          break;
        }
        case 'ARCHIVE_REGISTRATION': {
          const { registration } = write;
          if (registration.status === 'CANCELLED') {
            this.cancellations += 1;
            if (registration.confirmedSessionId !== undefined) {
              const key = `${registration.confirmedSessionId}#${registration.userId}`;
              const offerId = this.duplicateSeats.get(key);
              if (offerId !== undefined) {
                this.duplicateSeats.delete(key);
                releasedDuplicates.push({ sessionId: registration.confirmedSessionId, offerId });
              }
            }
          } else if (registration.endReason === 'CUTOFF') {
            this.endedCutoff += 1;
          }
          break;
        }
        default:
          break;
      }
    }

    // Backfill records: keep the latest version of each; link every settled offer to the
    // record its release created (same decision, same session, same cause, same order).
    const created = new Map<string, BackfillRecord[]>();
    for (const record of decision.backfills) {
      const isNew = !this.records.has(record.id);
      this.records.set(record.id, record);
      if (isNew) {
        const key = `${record.sessionId}#${record.cause}`;
        const list = created.get(key);
        if (list === undefined) {
          created.set(key, [record]);
        } else {
          list.push(record);
        }
      }
    }
    for (const offer of archivedOffers) {
      for (const cause of CAUSES_OF_FATE[offer.status] ?? []) {
        const record = created.get(`${offer.sessionId}#${cause}`)?.shift();
        if (record !== undefined) {
          this.offerFates.get(offer.id)!.nextRecordId = record.id;
          break;
        }
      }
    }
    // A hoarded seat that its holder finally cancels continues the chain of the seat's release.
    for (const duplicate of releasedDuplicates) {
      const record = created.get(`${duplicate.sessionId}#CANCELLED_CONFIRMED`)?.shift();
      const fate = this.offerFates.get(duplicate.offerId);
      if (record !== undefined && fate !== undefined) {
        fate.nextRecordId = record.id;
      }
    }
  }

  /** Called once per session when its cut-off passes (after the TICK at that instant). */
  recordCutoff(session: Session): void {
    if (this.cutoffsRecorded.has(session.id)) {
      return;
    }
    this.cutoffsRecorded.add(session.id);
    this.wastedAtCutoff += session.capacity - session.confirmed;
  }

  finish(final: WorkshopSnapshot, endMs: number): { metrics: RunMetrics; samples: RunSamples } {
    this.extraSeatMs += this.extraSeats * (endMs - this.lastObservedMs);
    this.lastObservedMs = endMs;
    for (const session of final.sessions) {
      this.recordCutoff(session); // sessions whose cut-off lies beyond the run end
    }

    const served = new Set<string>();
    let confirmedSeats = 0;
    for (const registration of final.registrations) {
      if (registration.status === 'CONFIRMED') {
        served.add(registration.userId);
      }
    }
    for (const session of final.sessions) {
      confirmedSeats += session.confirmed;
    }

    const relayLatencies: number[] = [];
    let releases = 0;
    let unrelayed = 0;
    for (const record of this.records.values()) {
      if (record.latencyMs !== undefined) {
        relayLatencies.push(record.latencyMs);
      }
      if (RELEASE_CAUSES.has(record.cause)) {
        releases += 1;
        if (record.reallocatedAt === undefined) {
          unrelayed += 1;
        }
      }
    }
    const refill = this.refillTimes();
    const totalCapacity = this.scenario.params.totalCapacity;

    const metrics: RunMetrics = {
      participants: this.scenario.participants.length,
      registrations: this.registrations,
      decisions: this.decisions,
      rejected: this.rejected,
      distinct_served: served.size,
      confirmed_seats: confirmedSeats,
      duplicate_confirmed: confirmedSeats - served.size,
      seats_wasted: this.wastedAtCutoff,
      fill_rate: totalCapacity === 0 ? Number.NaN : served.size / totalCapacity,
      dup_hold_events: this.dupEvents,
      dup_hold_peak_users: this.dupPeak,
      dup_hold_seat_hours: this.extraSeatMs / HOUR_MS,
      offers_created: this.offersCreated,
      offers_accepted: this.settled.ACCEPTED,
      offers_declined: this.settled.DECLINED,
      offers_expired: this.settled.EXPIRED,
      offers_revoked: this.settled.REVOKED,
      cancellations: this.cancellations,
      ended_cutoff: this.endedCutoff,
      seat_releases: releases,
      backfills_relayed: relayLatencies.length,
      releases_unrelayed: unrelayed,
      backfill_relay_ms_mean: mean(relayLatencies),
      backfill_relay_ms_p50: quantile(relayLatencies, 0.5),
      backfill_relay_ms_p95: quantile(relayLatencies, 0.95),
      seat_refill_samples: refill.samples.length,
      seat_refill_censored: refill.censored,
      seat_refill_min_mean: mean(refill.samples),
      seat_refill_min_p50: quantile(refill.samples, 0.5),
      seat_refill_min_p95: quantile(refill.samples, 0.95),
      invariant_violations: this.invariantViolations,
    };
    return { metrics, samples: { refillMin: refill.samples, relayMs: relayLatencies } };
  }

  /** Follows each release through the engine's relay links until a confirmation. */
  private refillTimes(): { samples: number[]; censored: number } {
    const samples: number[] = [];
    let censored = 0;
    for (const record of this.records.values()) {
      if (!RELEASE_CAUSES.has(record.cause)) {
        continue;
      }
      let current: BackfillRecord | undefined = record;
      let confirmedAtMs: number | undefined;
      let guard = 0;
      while (current !== undefined && current.newOfferId !== undefined) {
        const fate = this.offerFates.get(current.newOfferId);
        if (fate === undefined) {
          break; // the relayed offer is still live at the end of the run
        }
        if (fate.status === 'ACCEPTED' && !fate.duplicate) {
          confirmedAtMs = fate.settledAtMs;
          break;
        }
        current = fate.nextRecordId === undefined ? undefined : this.records.get(fate.nextRecordId);
        if (++guard > 100_000) {
          throw new Error('seat refill chain did not converge');
        }
      }
      if (confirmedAtMs === undefined) {
        censored += 1;
      } else {
        samples.push((confirmedAtMs - parseIso(record.releasedAt)) / 60_000);
      }
    }
    return { samples, censored };
  }
}
