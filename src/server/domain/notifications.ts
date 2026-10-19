// In-app notifications. Rows are created by the worker (worker/handlers.ts); this module only reads them
// and marks them read. Notifications about items in teams the user has since left are hidden.

import type { EventType, NotificationDto, Page } from '../../shared/contract.js';
import { teamIds, type Principal } from '../auth/principal.js';
import { rows, one, type Db } from '../db.js';

interface Row {
  id: number;
  created_at: Date;
  read_at: Date | null;
  event_type: EventType;
  event_data: Record<string, unknown>;
  reason: string | null;
  actor_id: string | null;
  actor_name: string | null;
  item_id: string;
  item_number: number;
  item_title: string;
}

export async function listNotifications(db: Db, p: Principal, opts: { cursor?: number | undefined; limit: number; unread: boolean }): Promise<Page<NotificationDto>> {
  const params: unknown[] = [p.userId, teamIds(p)];
  let extra = '';
  if (opts.cursor !== undefined) {
    params.push(opts.cursor);
    extra += ` AND n.id < $${params.length}`;
  }
  if (opts.unread) extra += ' AND n.read_at IS NULL';
  params.push(opts.limit + 1);
  const found = await rows<Row>(
    db,
    `SELECT n.id, n.created_at, n.read_at, e.type AS event_type, e.data AS event_data, e.reason,
            e.actor_id, a.name AS actor_name, i.id AS item_id, i.number AS item_number, i.title AS item_title
       FROM notifications n
       JOIN work_item_events e ON e.id = n.event_id
       JOIN work_items i ON i.id = n.item_id
       LEFT JOIN users a ON a.id = e.actor_id
      WHERE n.user_id = $1 AND i.team_id = ANY($2::uuid[]) ${extra}
      ORDER BY n.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = found.slice(0, opts.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      createdAt: r.created_at.toISOString(),
      readAt: r.read_at ? r.read_at.toISOString() : null,
      eventType: r.event_type,
      eventData: r.event_data,
      reason: r.reason,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? 'Unknown' } : null,
      item: { id: r.item_id, number: r.item_number, title: r.item_title },
    })),
    nextCursor: found.length > opts.limit ? String(page[page.length - 1]!.id) : null,
  };
}

export async function unreadCount(db: Db, p: Principal): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM notifications n JOIN work_items i ON i.id = n.item_id
      WHERE n.user_id = $1 AND n.read_at IS NULL AND i.team_id = ANY($2::uuid[])`,
    [p.userId, teamIds(p)],
  );
  return r?.n ?? 0;
}

/** Mark the given notifications (or all, if `ids` is omitted) as read. Only ever touches the caller's own rows. */
export async function markRead(db: Db, p: Principal, ids?: number[]): Promise<void> {
  if (ids && ids.length > 0) {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])', [p.userId, ids]);
  } else if (!ids) {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [p.userId]);
  }
}
