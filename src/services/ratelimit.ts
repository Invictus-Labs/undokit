import type { Clock } from "../domain/clock.js";

/** Default upper bound on tracked keys, so unique emails cannot grow the map without limit. */
export const DEFAULT_MAX_KEYS = 10_000;

/** Failed-login limiter (in memory, per process). Keyed by whatever the caller composes (ip + email). */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

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

  blocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
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

  clear(key: string): void {
    this.failures.delete(key);
  }
}
