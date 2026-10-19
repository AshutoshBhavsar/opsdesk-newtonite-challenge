// "Who is calling and what may they do?" The principal is rebuilt from the database on every
// request, so revoking a role, removing a member or deactivating a user takes effect immediately
// (nothing is baked into a long-lived token).

import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '../../shared/contract.js';
import type { Db } from '../db.js';
import { one, rows } from '../db.js';

export interface Principal {
  userId: string;
  name: string;
  email: string;
  /** teamId → the roles this user holds in that team. Teams not present here are invisible to them. */
  roles: Map<string, Set<Role>>;
}

const EMPTY: ReadonlySet<Role> = new Set();

export function rolesIn(p: Principal, teamId: string): ReadonlySet<Role> {
  return p.roles.get(teamId) ?? EMPTY;
}

export function teamIds(p: Principal): string[] {
  return [...p.roles.keys()];
}

/** Teams where the user holds a role satisfying `pred`. */
export function teamsWhere(p: Principal, pred: (roles: ReadonlySet<Role>) => boolean): string[] {
  return [...p.roles.entries()].filter(([, r]) => pred(r)).map(([id]) => id);
}

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

export async function createSession(db: Db, userId: string, ttlHours: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, expiresAt]);
  return { token, expiresAt };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function authenticate(db: Db, token: string): Promise<Principal | null> {
  const found = await rows<{ id: string; name: string; email: string; team_id: string | null; role: Role | null }>(
    db,
    `SELECT u.id, u.name, u.email, m.team_id, m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [hashToken(token)],
  );
  const first = found[0];
  if (!first) return null;
  const roles = new Map<string, Set<Role>>();
  for (const r of found) {
    if (r.team_id && r.role) {
      let set = roles.get(r.team_id);
      if (!set) roles.set(r.team_id, (set = new Set()));
      set.add(r.role);
    }
  }
  return { userId: first.id, name: first.name, email: first.email, roles };
}

export async function userExists(db: Db, userId: string): Promise<boolean> {
  return (await one(db, 'SELECT 1 AS x FROM users WHERE id = $1 AND is_active', [userId])) !== undefined;
}
