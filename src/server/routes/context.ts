// Shared plumbing for route modules: dependencies and the `mutate` wrapper that gives every
// state-changing endpoint "one transaction + optional idempotency key".

import type { Config } from '../config.js';
import { tx, type Pool, type Tx } from '../db.js';
import { badRequest } from '../http/errors.js';
import type { Ctx, Reply } from '../http/router.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { beginIdempotent, completeIdempotent, fingerprint, IDEMPOTENCY_KEY_PATTERN } from '../domain/idempotency.js';
import type { Hub } from '../realtime/hub.js';

export interface Deps {
  config: Config;
  pool: Pool;
  hub: Hub;
  loginLimiter: RateLimiter;
}

/**
 * Run `fn` in one transaction. With an `Idempotency-Key` header the key row is written in the same
 * transaction (see domain/idempotency.ts): a replay returns the stored response, a failure leaves no trace.
 * `input` is the VALIDATED request body; it is hashed so reusing a key for a different request is detected.
 */
export async function mutate(ctx: Ctx, pool: Pool, input: unknown, fn: (c: Tx) => Promise<unknown>, okStatus = 200): Promise<Reply> {
  const key = ctx.header('idempotency-key');
  if (key === undefined) return { status: okStatus, body: await tx(pool, fn) };
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-100 characters of letters, digits and _ . : -');
  }
  const userId = ctx.user.userId;
  const fp = fingerprint(ctx.req.method ?? 'POST', ctx.url.pathname, input);
  const out = await tx(pool, async (c) => {
    const start = await beginIdempotent(c, userId, key, fp);
    if ('replay' in start) return { replayed: true as const, status: start.replay.status, body: start.replay.body };
    const body = await fn(c);
    await completeIdempotent(c, userId, key, okStatus, body);
    return { replayed: false as const, status: okStatus, body };
  });
  return out.replayed ? { status: out.status, body: out.body, headers: { 'Idempotent-Replay': 'true' } } : { status: out.status, body: out.body };
}
