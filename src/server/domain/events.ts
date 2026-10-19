// The audit trail. Every change to a work item goes through appendEvent, inside the same
// transaction as the change itself, so a change and its history can never diverge:
//   1. the event row            (durable history; the timeline reads this)
//   2. an outbox job            (reliable async work: notifications; processed by the worker)
//   3. pg_notify                (live "this item changed" push; delivered only if the tx COMMITS)

import type { EventType, RealtimeMessage } from '../../shared/contract.js';
import { rows, type Db } from '../db.js';

export const CHANGE_CHANNEL = 'ops_changes';

export interface NewEvent {
  itemId: string;
  teamId: string;
  actorId: string | null;
  type: EventType;
  data?: Record<string, unknown>;
  reason?: string | null;
  body?: string | null;
}

export async function appendEvent(db: Db, e: NewEvent): Promise<number> {
  const [row] = await rows<{ id: number }>(
    db,
    `INSERT INTO work_item_events (item_id, team_id, actor_id, type, data, reason, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [e.itemId, e.teamId, e.actorId, e.type, JSON.stringify(e.data ?? {}), e.reason ?? null, e.body ?? null],
  );
  const eventId = row!.id;
  await db.query(`INSERT INTO outbox_jobs (type, payload) VALUES ('notify_event', $1)`, [JSON.stringify({ eventId })]);
  const message: RealtimeMessage = { kind: 'item', itemId: e.itemId, teamId: e.teamId, type: e.type, actorId: e.actorId, eventId };
  await db.query('SELECT pg_notify($1, $2)', [CHANGE_CHANNEL, JSON.stringify(message)]);
  return eventId;
}
