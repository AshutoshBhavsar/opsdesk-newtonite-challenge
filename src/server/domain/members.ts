// Team membership management. Security-relevant, so it follows the strictest pattern in the code base:
//   * ALL membership rows of the team are locked (FOR UPDATE) first. That serialises concurrent admin
//     actions on the same team, which makes the "last admin" check race-free, and it orders strictly against
//     claim/assign (they take FOR SHARE on the user's membership rows).
//   * Every change is written to the append-only membership_changes table in the same transaction.

import { ROLES, type Member, type Role } from '../../shared/contract.js';
import { canManageMembers, canWork } from '../../shared/permissions.js';
import { teamIds, type Principal } from '../auth/principal.js';
import { rows, type Db, type Tx } from '../db.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import { appendEvent } from './events.js';
import { BUMP } from './items.js';

export async function listMembers(db: Db, p: Principal, teamId: string): Promise<Member[]> {
  if (!teamIds(p).includes(teamId)) throw notFound('Team');
  const found = await rows<{ user_id: string; name: string; email: string; role: Role }>(
    db,
    `SELECT m.user_id, u.name, u.email, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = $1 AND u.is_active
      ORDER BY u.name, u.id`,
    [teamId],
  );
  const byUser = new Map<string, Member>();
  for (const r of found) {
    let m = byUser.get(r.user_id);
    if (!m) byUser.set(r.user_id, (m = { userId: r.user_id, name: r.name, email: r.email, roles: [] }));
    m.roles.push(r.role);
  }
  for (const m of byUser.values()) m.roles.sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
  return [...byUser.values()];
}

/** Replace the roles `email` holds in `teamId`. An empty list removes the person from the team. */
export async function setMemberRoles(tx: Tx, p: Principal, teamId: string, email: string, roles: Role[]): Promise<Member[]> {
  if (!teamIds(p).includes(teamId)) throw notFound('Team');
  // 1. Lock every membership row of the team, then decide using what is true NOW (not the request-start snapshot).
  const locked = await rows<{ user_id: string; role: Role }>(tx, 'SELECT user_id, role FROM memberships WHERE team_id = $1 ORDER BY user_id, role FOR UPDATE', [teamId]);
  const actorRoles = new Set(locked.filter((r) => r.user_id === p.userId).map((r) => r.role));
  if (!canManageMembers(actorRoles)) throw forbidden('Only a team admin can manage members.');

  const target = await rows<{ id: string; name: string }>(tx, 'SELECT id, name FROM users WHERE lower(email) = lower($1) AND is_active', [email]);
  const user = target[0];
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'No active user has that email address.');

  const before = locked.filter((r) => r.user_id === user.id).map((r) => r.role);
  const after = [...new Set(roles)];
  const removed = before.filter((r) => !after.includes(r));
  const added = after.filter((r) => !before.includes(r));
  if (removed.length === 0 && added.length === 0) return listMembers(tx, p, teamId);

  // 2. Never leave a team without an admin.
  if (before.includes('admin') && !after.includes('admin')) {
    const otherAdmins = locked.filter((r) => r.role === 'admin' && r.user_id !== user.id).length;
    if (otherAdmins === 0) throw conflict('LAST_ADMIN', 'A team must keep at least one admin. Promote someone else first.');
  }

  // 3. If the person can no longer take on work, deal with the items they currently hold in this team.
  if (!canWork(new Set(after))) {
    const held = await rows<{ id: string; status: string; assignee_name: string }>(
      tx,
      `SELECT i.id, i.status, u.name AS assignee_name
         FROM work_items i JOIN users u ON u.id = i.assignee_id
        WHERE i.team_id = $1 AND i.assignee_id = $2
          AND i.status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved')
        ORDER BY i.id FOR UPDATE OF i`,
      [teamId, user.id],
    );
    const blocking = held.filter((h) => h.status === 'pending_approval' || h.status === 'approved');
    if (blocking.length > 0) {
      throw conflict('MEMBER_HAS_WORK', `${user.name} still owns ${blocking.length} item(s) that are awaiting or past approval. Reassign them first.`, {
        itemIds: blocking.map((b) => b.id),
      });
    }
    for (const h of held) {
      const next = h.status === 'in_progress' ? 'triaged' : h.status;
      await tx.query(`UPDATE work_items SET assignee_id = NULL, status = $2, ${BUMP} WHERE id = $1`, [h.id, next]);
      await appendEvent(tx, {
        itemId: h.id,
        teamId,
        actorId: p.userId,
        type: 'released',
        data: { from: { id: user.id, name: h.assignee_name }, status: { from: h.status, to: next }, cause: 'membership_changed' },
        reason: 'Released automatically because the assignee lost their working role in this team.',
      });
    }
  }

  // 4. Apply the change and record it.
  if (removed.length) await tx.query('DELETE FROM memberships WHERE team_id = $1 AND user_id = $2 AND role = ANY($3::text[])', [teamId, user.id, removed]);
  if (added.length) {
    await tx.query('INSERT INTO memberships (team_id, user_id, role) SELECT $1::uuid, $2::uuid, unnest($3::text[]) ON CONFLICT DO NOTHING', [teamId, user.id, added]);
  }
  await tx.query('INSERT INTO membership_changes (team_id, actor_id, target_user_id, roles_before, roles_after) VALUES ($1, $2, $3, $4::text[], $5::text[])', [
    teamId,
    p.userId,
    user.id,
    before,
    after,
  ]);
  return listMembers(tx, p, teamId);
}
