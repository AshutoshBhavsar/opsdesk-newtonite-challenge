// Stale ("going quiet") detection. Flags each quiet active item once; real activity clears the flag
// (see BUMP in domain/items.ts) so it can be flagged again later. SKIP LOCKED makes concurrent scanners safe.

import { tx, rows, type Pool } from '../db.js';
import { ACTIVE_SQL } from '../domain/items.js';
import { appendEvent } from '../domain/events.js';

export async function scanStale(pool: Pool, staleAfterHours: number, limit = 200): Promise<number> {
  return tx(pool, async (c) => {
    const quiet = await rows<{ id: string; team_id: string }>(
      c,
      `SELECT id, team_id FROM work_items
        WHERE status IN (${ACTIVE_SQL}) AND stale_notified_at IS NULL
          AND last_activity_at < now() - make_interval(hours => $1::int)
        ORDER BY last_activity_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [staleAfterHours, limit],
    );
    for (const it of quiet) {
      // Deliberately NOT touching last_activity_at or version: flagging is not human activity and must not cause edit conflicts.
      await c.query('UPDATE work_items SET stale_notified_at = now() WHERE id = $1', [it.id]);
      await appendEvent(c, { itemId: it.id, teamId: it.team_id, actorId: null, type: 'stale_flagged', data: { staleAfterHours } });
    }
    return quiet.length;
  });
}
