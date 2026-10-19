// Attention, notifications, members, realtime stream and health.

import { z } from 'zod';
import { ROLES } from '../../shared/contract.js';
import { requireAuth } from '../auth/guard.js';
import { one } from '../db.js';
import { AppError } from '../http/errors.js';
import type { Router } from '../http/router.js';
import { getAttention } from '../domain/attention.js';
import { listMembers, setMemberRoles } from '../domain/members.js';
import { listNotifications, markRead } from '../domain/notifications.js';
import type { Deps } from './context.js';
import { mutate } from './context.js';

export function register(router: Router, d: Deps): void {
  const auth = requireAuth(d.pool);

  router.add('GET', '/api/attention', async (ctx) => ({ body: await getAttention(d.pool, ctx.user, d.config.staleAfterHours) }), auth);

  router.add(
    'GET',
    '/api/notifications',
    async (ctx) => {
      const q = ctx.query(
        z.object({
          cursor: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          unread: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        }),
      );
      return { body: await listNotifications(d.pool, ctx.user, q) };
    },
    auth,
  );

  router.add(
    'POST',
    '/api/notifications/read',
    async (ctx) => {
      const b = await ctx.json(z.object({ ids: z.array(z.number().int().min(1)).max(200).optional() }));
      await markRead(d.pool, ctx.user, b.ids);
      return { status: 204 };
    },
    auth,
  );

  const TeamParam = z.object({ teamId: z.string().uuid() });
  router.add('GET', '/api/teams/:teamId/members', async (ctx) => ({ body: await listMembers(d.pool, ctx.user, ctx.paramsAs(TeamParam).teamId) }), auth);

  router.add(
    'PUT',
    '/api/teams/:teamId/members',
    async (ctx) => {
      const { teamId } = ctx.paramsAs(TeamParam);
      const b = await ctx.json(z.object({ email: z.string().trim().min(3).max(200), roles: z.array(z.enum(ROLES)).max(4) }));
      return mutate(ctx, d.pool, b, (c) => setMemberRoles(c, ctx.user, teamId, b.email, b.roles));
    },
    auth,
  );

  router.addRaw('GET', '/api/stream', (ctx) => d.hub.attach(ctx), auth);

  router.add('GET', '/api/health', async () => {
    try {
      await one(d.pool, 'SELECT 1 AS ok');
      return { body: { ok: true } };
    } catch {
      throw new AppError(503, 'DB_UNAVAILABLE', 'Database is not reachable.');
    }
  });
}
