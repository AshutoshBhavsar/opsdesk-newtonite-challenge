// Job handlers. `notify_event` turns an audit event into in-app notifications.
// It is idempotent: UNIQUE(user_id, event_id) + ON CONFLICT DO NOTHING means running it twice
// (retry after a crash, duplicate delivery) can never produce a second notification.

import type { EventType } from '../../shared/contract.js';
import { rows, type Tx } from '../db.js';

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type Handler = (c: Tx, job: Job) => Promise<void>;

/** Throw this for failures that retrying cannot fix: the job goes straight to 'dead'. */
export class PermanentError extends Error {}

interface EventCtx {
  type: EventType;
  actor_id: string | null;
  data: { from?: { id?: string } | string | null; to?: { id?: string } | string | null };
  team_id: string;
  item_id: string;
  requester_id: string;
  assignee_id: string | null;
}

const idOf = (v: unknown): string | null => (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);

/** Who should hear about this event (before the actor is removed and membership is checked). */
async function candidates(c: Tx, e: EventCtx): Promise<string[]> {
  const leads = async (): Promise<string[]> =>
    (await rows<{ user_id: string }>(c, `SELECT DISTINCT user_id FROM memberships WHERE team_id = $1 AND role IN ('lead', 'admin')`, [e.team_id])).map((r) => r.user_id);
  const approvers = async (): Promise<string[]> =>
    (await rows<{ user_id: string }>(c, `SELECT DISTINCT user_id FROM memberships WHERE team_id = $1 AND role IN ('approver', 'admin')`, [e.team_id])).map((r) => r.user_id);
  const out: Array<string | null> = [];
  switch (e.type) {
    case 'created':
      out.push(...(await leads()));
      break;
    case 'claimed':
      out.push(e.requester_id);
      break;
    case 'assigned':
      out.push(idOf(e.data.to), idOf(e.data.from), e.requester_id);
      break;
    case 'released':
      out.push(idOf(e.data.from), e.requester_id, ...(await leads()));
      break;
    case 'status_changed':
      out.push(e.requester_id, e.assignee_id);
      if ((e.data.to as unknown) === 'pending_approval') out.push(...(await approvers()));
      break;
    case 'stale_flagged':
      if (e.assignee_id) out.push(e.assignee_id);
      else out.push(...(await leads()));
      break;
    default: // comment, updated, priority_changed
      out.push(e.requester_id, e.assignee_id);
  }
  return [...new Set(out.filter((x): x is string => x !== null))];
}

async function notifyEvent(c: Tx, job: Job): Promise<void> {
  const eventId = Number(job.payload.eventId);
  if (!Number.isInteger(eventId)) throw new PermanentError('notify_event payload has no eventId');
  const [e] = await rows<EventCtx>(
    c,
    `SELECT e.type, e.actor_id, e.data, e.team_id, e.item_id, i.requester_id, i.assignee_id
       FROM work_item_events e JOIN work_items i ON i.id = e.item_id WHERE e.id = $1`,
    [eventId],
  );
  if (!e) throw new PermanentError(`event ${eventId} not found`);

  let recipients = (await candidates(c, e)).filter((u) => u !== e.actor_id);
  if (recipients.length === 0) return;
  // Only active users who currently hold a role in the item's team (leavers must not receive item details).
  recipients = (
    await rows<{ id: string }>(
      c,
      `SELECT DISTINCT u.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.team_id = $1
        WHERE u.is_active AND u.id = ANY($2::uuid[])`,
      [e.team_id, recipients],
    )
  ).map((r) => r.id);
  if (recipients.length === 0) return;

  const inserted = await rows<{ user_id: string }>(
    c,
    `INSERT INTO notifications (user_id, event_id, item_id)
     SELECT u, $2::bigint, $3::uuid FROM unnest($1::uuid[]) AS u
     ON CONFLICT (user_id, event_id) DO NOTHING RETURNING user_id`,
    [recipients, eventId, e.item_id],
  );
  if (inserted.length > 0) {
    // Delivered to listeners only if this transaction commits.
    await c.query('SELECT pg_notify($1, $2)', ['ops_changes', JSON.stringify({ kind: 'notification', userIds: inserted.map((r) => r.user_id) })]);
  }
}

export const handlers: Record<string, Handler> = { notify_event: notifyEvent };
