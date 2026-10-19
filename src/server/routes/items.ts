import { z } from 'zod';
import { KINDS, PRIORITIES, STATUSES } from '../../shared/contract.js';
import { requireAuth } from '../auth/guard.js';
import type { Router } from '../http/router.js';
import { addComment, assignItem, changePriority, claimItem, createItem, findSimilar, getItem, listEvents, listItems, releaseItem, transitionItem, updateItem } from '../domain/items.js';
import type { Deps } from './context.js';
import { mutate } from './context.js';

const uuid = z.string().uuid();
const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().max(max);
const reason = z.string().trim().min(3).max(1000);
const dueAt = z.string().datetime({ offset: true }).transform((s) => new Date(s)).nullable();

const ListQuery = z.object({
  team: uuid.optional(),
  status: z.string().max(200).optional(),
  priority: z.string().max(100).optional(),
  kind: z.string().max(200).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), uuid]).optional(),
  requester: z.union([z.literal('me'), uuid]).optional(),
  overdue: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['activity', 'priority', 'created']).default('activity'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});

const CreateBody = z.object({
  teamId: uuid,
  title: text(200).min(3),
  description: text(10000).default(''),
  kind: z.enum(KINDS),
  priority: z.enum(PRIORITIES).default('medium'),
  dueAt: dueAt.optional(),
});
const UpdateBody = z.object({ expectedVersion: version, title: text(200).min(3).optional(), description: text(10000).optional(), dueAt: dueAt.optional() });
const ReleaseBody = z.object({ expectedVersion: version, reason: reason.optional() });
const AssignBody = z.object({ expectedVersion: version, assigneeId: uuid, reason });
const PriorityBody = z.object({ expectedVersion: version, priority: z.enum(PRIORITIES), reason });
const TransitionBody = z.object({
  expectedVersion: version,
  to: z.enum(STATUSES),
  reason: text(1000).optional(),
  resolution: text(5000).optional(),
});
const CommentBody = z.object({ body: text(5000).min(1) });
const IdParam = z.object({ id: uuid });

export function register(router: Router, d: Deps): void {
  const auth = requireAuth(d.pool);

  router.add('GET', '/api/items', async (ctx) => ({ body: await listItems(d.pool, ctx.user, ctx.query(ListQuery)) }), auth);

  router.add(
    'GET',
    '/api/items/similar',
    async (ctx) => {
      const q = ctx.query(z.object({ teamId: uuid, title: z.string().trim().min(3).max(200) }));
      return { body: await findSimilar(d.pool, ctx.user, q.teamId, q.title) };
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items',
    async (ctx) => {
      const b = await ctx.json(CreateBody);
      return mutate(ctx, d.pool, b, (c) => createItem(c, ctx.user, { ...b, dueAt: b.dueAt ?? null }), 201);
    },
    auth,
  );

  router.add('GET', '/api/items/:id', async (ctx) => ({ body: await getItem(d.pool, ctx.user, ctx.paramsAs(IdParam).id) }), auth);

  router.add(
    'PATCH',
    '/api/items/:id',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const b = await ctx.json(UpdateBody);
      return mutate(ctx, d.pool, b, (c) => updateItem(c, ctx.user, id, b));
    },
    auth,
  );

  router.add(
    'GET',
    '/api/items/:id/events',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const q = ctx.query(z.object({ cursor: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }));
      return { body: await listEvents(d.pool, ctx.user, id, q.cursor, q.limit) };
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items/:id/comments',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const b = await ctx.json(CommentBody);
      return mutate(ctx, d.pool, b, (c) => addComment(c, ctx.user, id, b.body), 201);
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items/:id/claim',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      await ctx.json(z.object({}).passthrough()); // body is empty; parsing enforces the JSON content type
      return mutate(ctx, d.pool, {}, (c) => claimItem(c, ctx.user, id));
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items/:id/release',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const b = await ctx.json(ReleaseBody);
      return mutate(ctx, d.pool, b, (c) => releaseItem(c, ctx.user, id, b));
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items/:id/assign',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const b = await ctx.json(AssignBody);
      return mutate(ctx, d.pool, b, (c) => assignItem(c, ctx.user, id, b));
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items/:id/priority',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const b = await ctx.json(PriorityBody);
      return mutate(ctx, d.pool, b, (c) => changePriority(c, ctx.user, id, b));
    },
    auth,
  );

  router.add(
    'POST',
    '/api/items/:id/transition',
    async (ctx) => {
      const { id } = ctx.paramsAs(IdParam);
      const b = await ctx.json(TransitionBody);
      return mutate(ctx, d.pool, b, (c) => transitionItem(c, ctx.user, id, b));
    },
    auth,
  );
}
