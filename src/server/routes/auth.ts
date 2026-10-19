import { z } from 'zod';
import type { Me } from '../../shared/contract.js';
import { readToken, requireAuth, SESSION_COOKIE } from '../auth/guard.js';
import { dummyHash, verifyPassword } from '../auth/passwords.js';
import { authenticate, createSession, revokeSession, type Principal } from '../auth/principal.js';
import { one, rows, type Db } from '../db.js';
import { AppError } from '../http/errors.js';
import type { Router } from '../http/router.js';
import { unreadCount } from '../domain/notifications.js';
import type { Deps } from './context.js';

export async function buildMe(db: Db, p: Principal): Promise<Me> {
  const ids = [...p.roles.keys()];
  const teams = ids.length ? await rows<{ id: string; name: string }>(db, 'SELECT id, name FROM teams WHERE id = ANY($1::uuid[]) ORDER BY name', [ids]) : [];
  return {
    user: { id: p.userId, name: p.name, email: p.email },
    teams: teams.map((t) => ({ id: t.id, name: t.name, roles: [...(p.roles.get(t.id) ?? [])] })),
    unreadNotifications: await unreadCount(db, p),
  };
}

const LoginBody = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });

export function register(router: Router, d: Deps): void {
  const auth = requireAuth(d.pool);

  router.add('POST', '/api/auth/login', async (ctx) => {
    const body = await ctx.json(LoginBody);
    const email = body.email.toLowerCase();
    const key = `${ctx.req.socket.remoteAddress ?? '?'}|${email}`;
    const wait = d.loginLimiter.check(key);
    if (wait > 0) throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.', undefined, { 'Retry-After': String(wait) });

    const user = await one<{ id: string; name: string; email: string; password_hash: string }>(
      d.pool,
      'SELECT id, name, email, password_hash FROM users WHERE lower(email) = $1 AND is_active',
      [email],
    );
    // Always run one scrypt verification so response time does not reveal whether the email exists.
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash()));
    if (!user || !ok) {
      d.loginLimiter.fail(key);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    }
    d.loginLimiter.reset(key);
    const session = await createSession(d.pool, user.id, d.config.sessionTtlHours);
    const p = await authenticate(d.pool, session.token);
    const cookie = [
      `${SESSION_COOKIE}=${session.token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${d.config.sessionTtlHours * 3600}`,
      ...(d.config.cookieSecure ? ['Secure'] : []),
    ].join('; ');
    return { status: 200, body: await buildMe(d.pool, p!), headers: { 'Set-Cookie': cookie } };
  });

  router.add('POST', '/api/auth/logout', async (ctx) => {
    const token = readToken(ctx);
    if (token) await revokeSession(d.pool, token);
    return { status: 204, headers: { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` } };
  });

  router.add('GET', '/api/me', async (ctx) => ({ body: await buildMe(d.pool, ctx.user) }), auth);
}
