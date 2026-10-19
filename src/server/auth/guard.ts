// Authentication guard: resolves the session token (cookie or Bearer header) to a Principal.

import type { Pool } from '../db.js';
import { unauthenticated } from '../http/errors.js';
import type { Ctx } from '../http/router.js';
import { authenticate } from './principal.js';

export const SESSION_COOKIE = 'opsdesk_session';

export function readToken(ctx: Ctx): string | null {
  const auth = ctx.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
  const cookie = ctx.header('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function requireAuth(pool: Pool) {
  return async (ctx: Ctx): Promise<void> => {
    const token = readToken(ctx);
    if (!token) throw unauthenticated();
    const principal = await authenticate(pool, token);
    if (!principal) throw unauthenticated('Your session has expired. Please sign in again.');
    ctx.principal = principal;
  };
}
