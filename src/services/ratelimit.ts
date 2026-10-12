import type { Clock } from "../domain/clock.js";

/** Default upper bound on tracked keys, so unique emails cannot grow the map without limit. */
export const DEFAULT_MAX_KEYS = 10_000;

/** The per-address bucket (all emails) allows this many times the per-(address,email) failure budget. */
export const LOGIN_IP_FAILURE_MULTIPLIER = 5;

/** At most this many login password verifications (scrypt) run at once per process; the rest wait their turn. */
export const LOGIN_MAX_CONCURRENT_VERIFIES = 2;

/** Logins waiting for a verification slot beyond this are refused (RATE_LIMITED) instead of queueing without bound. */
export const LOGIN_MAX_QUEUED_VERIFIES = 64;

/**
 * Failed-login limiter (in memory, per process). Keyed by whatever the caller composes (ip + email).
 *
 * Attempts are reserved synchronously with `tryReserve` before the caller awaits anything, and each reservation counts
 * against the budget until `settle` resolves it. Concurrent attempts therefore cannot all pass the check before the
 * first failure is recorded: completed failures plus in-flight reservations never exceed `maxFailures`.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.clock.now().getTime() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** True when recent failures plus attempts still in flight have used the whole budget. */
  blocked(key: string): boolean {
    return this.recent(key).length + (this.pending.get(key) ?? 0) >= this.maxFailures;
  }

  /**
   * Reserve one attempt against the budget, synchronously. Returns false (and reserves nothing) when the key is
   * already at its budget. Every successful reservation must be released exactly once with `settle`.
   */
  tryReserve(key: string): boolean {
    if (this.blocked(key)) return false;
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    return true;
  }

  /** Release a reservation; when `failed` it becomes a recorded failure, otherwise it simply stops counting. */
  settle(key: string, failed: boolean): void {
    const n = (this.pending.get(key) ?? 0) - 1;
    if (n > 0) this.pending.set(key, n);
    else this.pending.delete(key);
    if (failed) this.recordFailure(key);
  }

  /** Attempts reserved for this key that have not been settled yet. */
  inFlight(key: string): number {
    return this.pending.get(key) ?? 0;
  }

  recordFailure(key: string): void {
    const list = this.recent(key);
    list.push(this.clock.now().getTime());
    this.failures.set(key, list);
    if (this.failures.size > this.maxKeys) this.sweep();
  }

  /**
   * Make room: drop expired entries first; if still over the cap, drop keys that are NOT locked out before any that
   * are, least recently failed first, down to 90% of the cap so the sweep does not run on every insert. A flood of
   * unique keys therefore cannot reset a live lockout counter while unlocked entries remain to evict.
   */
  private sweep(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
    if (this.failures.size <= this.maxKeys) return;
    const ranked = [...this.failures.entries()]
      .map(([key, times]) => ({ key, locked: times.length >= this.maxFailures, last: times[times.length - 1] ?? 0 }))
      .sort((a, b) => Number(a.locked) - Number(b.locked) || a.last - b.last);
    const target = Math.floor(this.maxKeys * 0.9);
    for (const entry of ranked) {
      if (this.failures.size <= target) break;
      this.failures.delete(entry.key);
    }
  }

  /** Forget recorded failures for the key. Reservations still in flight keep counting until they settle. */
  clear(key: string): void {
    this.failures.delete(key);
  }
}

/** Thrown by `VerifyGate.run` when too many callers are already waiting for a slot. */
export class GateFullError extends Error {
  constructor() {
    super("verification gate is full");
    this.name = "GateFullError";
  }
}

/**
 * Small counting semaphore that caps how many expensive verifications (scrypt) run at once, so a burst of logins cannot
 * occupy the whole libuv thread pool that DNS lookups and file I/O share. Waiters are bounded by `maxQueued`.
 */
export class VerifyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  /** Highest number of concurrently running tasks observed (diagnostics and tests). */
  peak = 0;

  constructor(
    private readonly maxActive: number = LOGIN_MAX_CONCURRENT_VERIFIES,
    private readonly maxQueued: number = LOGIN_MAX_QUEUED_VERIFIES,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new RangeError("maxActive must be a positive integer");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) {
      if (this.waiters.length >= this.maxQueued) throw new GateFullError();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    this.peak = Math.max(this.peak, this.active);
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); // hand the slot straight to the next waiter; `active` is unchanged
      else this.active -= 1;
    }
  }
}
