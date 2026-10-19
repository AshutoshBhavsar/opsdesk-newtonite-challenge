// Tiny in-memory fixed-window limiter used for login attempts. In-memory means each API instance
// counts separately; behind a load balancer the effective limit is (limit × instances). Documented
// in KNOWN_LIMITATIONS.md; moving the counters to Postgres or Redis is a straightforward follow-up.

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 if the call is allowed, otherwise the number of seconds until it will be. */
  check(key: string): number {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) return 0;
    return entry.count >= this.limit ? Math.ceil((entry.resetAt - t) / 1000) : 0;
  }

  /** Record a failure (call after a failed attempt). */
  fail(key: string): void {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    else entry.count++;
    if (this.hits.size > 10_000) this.sweep(t);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
