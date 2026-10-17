/**
 * Minimal token bucket for the notifier's SES pacing (plan §2.4: ≤ 1 e-mail/s). `ratePerSec`
 * tokens are added per second up to `capacity`; `take()` resolves as soon as a token is
 * available. `now`/`sleep` are injectable for tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number = Math.max(1, ratePerSec),
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (!(ratePerSec > 0)) {
      throw new Error(`TokenBucket rate must be positive, got ${ratePerSec}`);
    }
    this.tokens = this.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.ratePerSec);
    this.last = current;
  }

  async take(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      await this.sleep(waitMs);
      this.refill();
      // Floating-point refill may land a hair below 1 after the computed wait.
      this.tokens = Math.max(this.tokens, 1);
    }
    this.tokens -= 1;
  }
}
