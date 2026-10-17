/**
 * Plan §1.4: every time is judged on the server's UTC clock. A browser clock can be minutes off,
 * which would show a valid offer as "expired" or hide a session that can still be joined. So the
 * offer countdown, the settlement copy and the cut-off checks use `serverNow()`: the local clock
 * plus an offset estimated from `GET /health` (`time`), NTP-style. One sample gives
 * `offset = serverTime − midpoint(sent, received)` with an error of at most half the round trip;
 * the sample with the smallest round trip wins, and a sample older than `RESAMPLE_AFTER_MS` is
 * replaced by the next one (the local clock may have been adjusted).
 *
 * The browser never decides anything with this clock: ACCEPT stays enabled after the countdown
 * reaches zero, and the server's tick-first logic gives the answer.
 */

/** A slower answer says too little about when the server read its clock. */
export const MAX_SAMPLE_RTT_MS = 10_000;
export const RESAMPLE_AFTER_MS = 10 * 60_000;

export class ServerClock {
  #offsetMs = 0;
  #bestRttMs = Number.POSITIVE_INFINITY;
  #sampledAt: number | undefined;
  readonly #localNow: () => number;

  constructor(localNow: () => number = () => Date.now()) {
    this.#localNow = localNow;
  }

  /** Server clock minus local clock, in ms (0 until the first sample). */
  get offsetMs(): number {
    return this.#offsetMs;
  }

  get synced(): boolean {
    return this.#sampledAt !== undefined;
  }

  now(): number {
    return this.#localNow() + this.#offsetMs;
  }

  /**
   * One sample: the server stamped `serverIso` while the request was in flight between the local
   * times `sentAt` and `receivedAt`. Returns whether the estimate was updated.
   */
  observe(serverIso: string, sentAt: number, receivedAt: number): boolean {
    const server = Date.parse(serverIso);
    const rtt = receivedAt - sentAt;
    if (Number.isNaN(server) || rtt < 0 || rtt > MAX_SAMPLE_RTT_MS) {
      return false;
    }
    const outdated =
      this.#sampledAt === undefined || receivedAt - this.#sampledAt > RESAMPLE_AFTER_MS;
    if (!outdated && rtt > this.#bestRttMs) {
      return false;
    }
    this.#offsetMs = Math.round(server - (sentAt + receivedAt) / 2);
    this.#bestRttMs = rtt;
    this.#sampledAt = receivedAt;
    return true;
  }
}

/** The app's clock (one browser, one offset). */
export const serverClock = new ServerClock();

export function serverNow(): number {
  return serverClock.now();
}

/** Times one `GET /health` and feeds it to the clock. Errors are the caller's to ignore. */
export async function syncServerClock(
  fetchServerTime: () => Promise<string>,
  clock: ServerClock = serverClock,
  localNow: () => number = () => Date.now(),
): Promise<boolean> {
  const sentAt = localNow();
  const time = await fetchServerTime();
  return clock.observe(time, sentAt, localNow());
}
