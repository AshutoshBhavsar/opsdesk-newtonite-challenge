// Work items: queries and mutations. This module is where the concurrency and correctness rules live.
//
// Rules of thumb used throughout:
//   * Every read of an item is filtered by the caller's team ids IN SQL (`team_id = ANY($teams)`), so an item
//     in a team the user does not belong to behaves exactly like one that does not exist (404, no leak).
//   * Every mutation runs in ONE transaction: row change + audit event + outbox job + live notify.
//   * Writes lock the item row (`FOR UPDATE`) or use a conditional UPDATE, then compare `version`.
//   * Rules are evaluated by the shared pure functions (permissions.ts / workflow.ts) AFTER the row is locked,
//     so decisions are made against the exact state that will be written.

import { ACTIVE_STATUSES, KIND_REQUIRES_APPROVAL, type Capabilities, type ItemDetail, type ItemSummary, type Kind, type Page, type Priority, type Role, type SimilarItem, type Status, type TimelineEvent, type EventType } from '../../shared/contract.js';
import { capabilities } from '../../shared/capabilities.js';
import { canChangePriority, canClaim, canEdit, canRelease, canReassign, canWork, canComment, canCreate, type Actor, type ItemFacts } from '../../shared/permissions.js';
import { evaluateTransition } from '../../shared/workflow.js';
import { one, rows, type Db, type Tx } from '../db.js';
import { rolesIn, teamIds, type Principal } from '../auth/principal.js';
import { conflict, forbidden, notFound, unprocessable } from '../http/errors.js';
import { appendEvent } from './events.js';

// ------------------------------------------------------------------ rows ----

export interface ItemRow {
  id: string;
  number: number;
  team_id: string;
  team_name: string;
  title: string;
  description?: string;
  kind: Kind;
  status: Status;
  priority: Priority;
  requester_id: string;
  requester_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  requires_approval: boolean;
  resolution?: string | null;
  due_at: Date | null;
  overdue: boolean;
  version: number;
  last_activity_at: Date;
  created_at: Date;
  ts_activity?: string;
  ts_created?: string;
  priority_rank?: number;
}

export const ACTIVE_SQL = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

export const SUMMARY_COLS = `
  i.id, i.number, i.team_id, t.name AS team_name, i.title, i.kind, i.status, i.priority, i.priority_rank,
  i.requester_id, ru.name AS requester_name, i.assignee_id, au.name AS assignee_name,
  i.requires_approval, i.due_at, i.version, i.last_activity_at, i.created_at,
  (i.due_at IS NOT NULL AND i.due_at < now() AND i.status IN (${ACTIVE_SQL})) AS overdue,
  to_char(i.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_activity,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_created`;

const DETAIL_COLS = `${SUMMARY_COLS}, i.description, i.resolution`;

export const FROM = `
  FROM work_items i
  JOIN teams t ON t.id = i.team_id
  JOIN users ru ON ru.id = i.requester_id
  LEFT JOIN users au ON au.id = i.assignee_id`;

export const factsOf = (r: ItemRow): ItemFacts => ({
  status: r.status,
  assigneeId: r.assignee_id,
  requesterId: r.requester_id,
  requiresApproval: r.requires_approval,
});

export const actorFor = (p: Principal, teamId: string): Actor => ({ userId: p.userId, roles: rolesIn(p, teamId) });

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function baseSummary(r: ItemRow) {
  return {
    id: r.id,
    number: r.number,
    teamId: r.team_id,
    teamName: r.team_name,
    title: r.title,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    requester: { id: r.requester_id, name: r.requester_name },
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name ?? 'Unknown' } : null,
    requiresApproval: r.requires_approval,
    dueAt: iso(r.due_at),
    overdue: r.overdue,
    version: r.version,
    lastActivityAt: r.last_activity_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  };
}

export function toSummary(r: ItemRow, p: Principal): ItemSummary {
  return { ...baseSummary(r), claimable: canClaim(factsOf(r), actorFor(p, r.team_id)) };
}

export function toDetail(r: ItemRow, p: Principal): ItemDetail {
  const can: Capabilities = capabilities(factsOf(r), actorFor(p, r.team_id));
  return { ...baseSummary(r), description: r.description ?? '', resolution: r.resolution ?? null, can };
}

// ----------------------------------------------------------------- reads ----

export async function getItemRow(db: Db, p: Principal, id: string): Promise<ItemRow> {
  const r = await one<ItemRow>(db, `SELECT ${DETAIL_COLS} ${FROM} WHERE i.id = $1 AND i.team_id = ANY($2::uuid[])`, [id, teamIds(p)]);
  if (!r) throw notFound('Work item');
  return r;
}

export async function getItem(db: Db, p: Principal, id: string): Promise<ItemDetail> {
  return toDetail(await getItemRow(db, p, id), p);
}

/** Same as getItemRow, but takes the row lock. Non-members match zero rows, so they never block anyone. */
async function lockItem(tx: Tx, p: Principal, id: string): Promise<ItemRow> {
  const r = await one<ItemRow>(
    tx,
    `SELECT ${DETAIL_COLS} ${FROM} WHERE i.id = $1 AND i.team_id = ANY($2::uuid[]) FOR UPDATE OF i`,
    [id, teamIds(p)],
  );
  if (!r) throw notFound('Work item');
  return r;
}

/** Optimistic concurrency: the caller acted on version N; the row is no longer at N. Reply with the fresh state. */
function assertVersion(row: ItemRow, expected: number, p: Principal): void {
  if (row.version !== expected) {
    throw conflict(
      'VERSION_CONFLICT',
      `This item was changed by someone else (you had version ${expected}, it is now ${row.version}). Review the latest and try again.`,
      { current: toDetail(row, p) },
    );
  }
}

// --------------------------------------------------------------- listing ----

export interface ListFilters {
  team?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  kind?: string | undefined;
  assignee?: string | undefined;
  requester?: string | undefined;
  overdue?: boolean | undefined;
  q?: string | undefined;
  sort: 'activity' | 'priority' | 'created';
  limit: number;
  cursor?: string | undefined;
}

interface CursorPayload {
  s: ListFilters['sort'];
  v: Array<string | number>;
  id: string;
}

const encodeCursor = (c: CursorPayload): string => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string, sort: ListFilters['sort']): CursorPayload {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
    const expected = sort === 'priority' ? 2 : 1;
    if (c.s !== sort || !Array.isArray(c.v) || c.v.length !== expected || typeof c.id !== 'string') throw new Error('shape');
    return c;
  } catch {
    throw unprocessable('INVALID_CURSOR', 'The page cursor is invalid. Reload the list.');
  }
}

const csv = (s: string | undefined): string[] => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

export async function listItems(db: Db, p: Principal, f: ListFilters): Promise<Page<ItemSummary>> {
  let scope = teamIds(p);
  if (f.team) {
    if (!scope.includes(f.team)) throw notFound('Team');
    scope = [f.team];
  }
  if (scope.length === 0) return { items: [], nextCursor: null };

  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [`i.team_id = ANY(${bind(scope)}::uuid[])`];

  // Status: default is the live work queue; literals (not parameters) let the planner use the partial indexes.
  const statuses = csv(f.status);
  if (statuses.length === 0 || (statuses.length === 1 && statuses[0] === 'active')) where.push(`i.status IN (${ACTIVE_SQL})`);
  else if (!(statuses.length === 1 && statuses[0] === 'all')) where.push(`i.status = ANY(${bind(statuses)}::text[])`);

  const prios = csv(f.priority);
  if (prios.length) where.push(`i.priority = ANY(${bind(prios)}::text[])`);
  const kinds = csv(f.kind);
  if (kinds.length) where.push(`i.kind = ANY(${bind(kinds)}::text[])`);

  if (f.assignee === 'unassigned') where.push('i.assignee_id IS NULL');
  else if (f.assignee) where.push(`i.assignee_id = ${bind(f.assignee === 'me' ? p.userId : f.assignee)}`);
  if (f.requester) where.push(`i.requester_id = ${bind(f.requester === 'me' ? p.userId : f.requester)}`);
  if (f.overdue) where.push(`i.due_at < now() AND i.status IN (${ACTIVE_SQL})`);

  if (f.q) {
    const tokens = (f.q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((t) => t.toLowerCase());
    if (tokens.length) {
      const tsq = `to_tsquery('simple', ${bind(tokens.map((t) => `${t}:*`).join(' & '))})`;
      const num = /^#?(\d{1,15})$/.exec(f.q.trim());
      where.push(num ? `(i.search @@ ${tsq} OR i.number = ${bind(Number(num[1]))})` : `i.search @@ ${tsq}`);
    }
  }

  // Keyset pagination: "everything strictly after the last row I saw", so pages stay stable and cheap at any depth.
  let order: string;
  if (f.sort === 'priority') order = 'i.priority_rank DESC, i.last_activity_at DESC, i.id DESC';
  else if (f.sort === 'created') order = 'i.created_at DESC, i.id DESC';
  else order = 'i.last_activity_at DESC, i.id DESC';

  if (f.cursor) {
    const c = decodeCursor(f.cursor, f.sort);
    if (f.sort === 'priority') where.push(`(i.priority_rank, i.last_activity_at, i.id) < (${bind(Number(c.v[0]))}::smallint, ${bind(String(c.v[1]))}::timestamptz, ${bind(c.id)}::uuid)`);
    else if (f.sort === 'created') where.push(`(i.created_at, i.id) < (${bind(String(c.v[0]))}::timestamptz, ${bind(c.id)}::uuid)`);
    else where.push(`(i.last_activity_at, i.id) < (${bind(String(c.v[0]))}::timestamptz, ${bind(c.id)}::uuid)`);
  }

  const found = await rows<ItemRow>(db, `SELECT ${SUMMARY_COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${bind(f.limit + 1)}`, params);
  const page = found.slice(0, f.limit);
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (found.length > f.limit && last) {
    const v = f.sort === 'priority' ? [last.priority_rank ?? 0, last.ts_activity!] : f.sort === 'created' ? [last.ts_created!] : [last.ts_activity!];
    nextCursor = encodeCursor({ s: f.sort, v, id: last.id });
  }
  return { items: page.map((r) => toSummary(r, p)), nextCursor };
}

/** "Similar open items" shown while someone is typing a new request: fights duplicate work. */
export async function findSimilar(db: Db, p: Principal, teamId: string, title: string): Promise<SimilarItem[]> {
  if (!teamIds(p).includes(teamId)) throw notFound('Team');
  const found = await rows<{ id: string; number: number; title: string; status: Status; sim: number }>(
    db,
    `SELECT id, number, title, status, similarity(title, $2) AS sim
       FROM work_items
      WHERE team_id = $1 AND status IN (${ACTIVE_SQL}) AND title % $2
      ORDER BY sim DESC, id DESC LIMIT 5`,
    [teamId, title],
  );
  return found.map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, similarity: Math.round(r.sim * 100) / 100 }));
}

// -------------------------------------------------------------- timeline ----

interface EventRow {
  id: number;
  type: EventType;
  actor_id: string | null;
  actor_name: string | null;
  data: Record<string, unknown>;
  reason: string | null;
  body: string | null;
  created_at: Date;
}

export const toTimelineEvent = (r: EventRow): TimelineEvent => ({
  id: r.id,
  type: r.type,
  actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? 'Unknown' } : null,
  data: r.data,
  reason: r.reason,
  body: r.body,
  createdAt: r.created_at.toISOString(),
});

export const EVENT_COLS = `e.id, e.type, e.actor_id, u.name AS actor_name, e.data, e.reason, e.body, e.created_at`;

export async function listEvents(db: Db, p: Principal, itemId: string, cursor: number | undefined, limit: number): Promise<Page<TimelineEvent>> {
  await getItemRow(db, p, itemId); // authorization + existence
  const params: unknown[] = [itemId];
  let after = '';
  if (cursor !== undefined) {
    params.push(cursor);
    after = 'AND e.id < $2';
  }
  params.push(limit + 1);
  const found = await rows<EventRow>(
    db,
    `SELECT ${EVENT_COLS} FROM work_item_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.item_id = $1 ${after} ORDER BY e.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = found.slice(0, limit);
  return { items: page.map(toTimelineEvent), nextCursor: found.length > limit ? String(page[page.length - 1]!.id) : null };
}

// ------------------------------------------------------------- mutations ----

export interface CreateInput {
  teamId: string;
  title: string;
  description: string;
  kind: Kind;
  priority: Priority;
  dueAt: Date | null;
}

export async function createItem(tx: Tx, p: Principal, input: CreateInput): Promise<ItemDetail> {
  if (!teamIds(p).includes(input.teamId)) throw notFound('Team');
  if (!canCreate(rolesIn(p, input.teamId))) throw forbidden('You cannot create items in this team.');
  const requiresApproval = KIND_REQUIRES_APPROVAL[input.kind] ?? false;
  const created = await one<{ id: string }>(
    tx,
    `INSERT INTO work_items (team_id, title, description, kind, priority, requester_id, requires_approval, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.teamId, input.title, input.description, input.kind, input.priority, p.userId, requiresApproval, input.dueAt],
  );
  await appendEvent(tx, {
    itemId: created!.id,
    teamId: input.teamId,
    actorId: p.userId,
    type: 'created',
    data: { title: input.title, kind: input.kind, priority: input.priority, requiresApproval },
  });
  return getItem(tx, p, created!.id);
}

/** Shared tail of every item mutation: bump version + activity clock, clear the stale flag. */
export const BUMP = 'version = version + 1, last_activity_at = now(), stale_notified_at = NULL';

export interface UpdateInput {
  expectedVersion: number;
  title?: string | undefined;
  description?: string | undefined;
  dueAt?: Date | null | undefined;
}

export async function updateItem(tx: Tx, p: Principal, id: string, input: UpdateInput): Promise<ItemDetail> {
  const row = await lockItem(tx, p, id);
  assertVersion(row, input.expectedVersion, p);
  const actor = actorFor(p, row.team_id);
  if (!canEdit(factsOf(row), actor)) {
    if (!ACTIVE_STATUSES.includes(row.status)) throw conflict('ITEM_FINAL', 'Resolved-and-closed or cancelled items cannot be edited.');
    throw forbidden('Only the requester, the assignee or a lead can edit this item.');
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.title !== undefined && input.title !== row.title) {
    changes.title = { from: row.title, to: input.title };
    set('title', input.title);
  }
  if (input.description !== undefined && input.description !== (row.description ?? '')) {
    changes.description = { from: row.description ?? '', to: input.description };
    set('description', input.description);
  }
  if (input.dueAt !== undefined && (input.dueAt?.getTime() ?? null) !== (row.due_at?.getTime() ?? null)) {
    changes.dueAt = { from: iso(row.due_at), to: iso(input.dueAt) };
    set('due_at', input.dueAt);
  }
  if (sets.length === 0) return toDetail(row, p); // nothing changed: no version bump, no history noise
  await tx.query(`UPDATE work_items SET ${sets.join(', ')}, ${BUMP} WHERE id = $1`, vals);
  await appendEvent(tx, { itemId: id, teamId: row.team_id, actorId: p.userId, type: 'updated', data: { changes } });
  return getItem(tx, p, id);
}

export async function changePriority(tx: Tx, p: Principal, id: string, input: { expectedVersion: number; priority: Priority; reason: string }): Promise<ItemDetail> {
  const row = await lockItem(tx, p, id);
  assertVersion(row, input.expectedVersion, p);
  const actor = actorFor(p, row.team_id);
  if (!ACTIVE_STATUSES.includes(row.status)) throw conflict('ITEM_FINAL', 'This item is no longer active.');
  if (!canChangePriority(factsOf(row), actor)) throw forbidden('Only a lead can change priority.');
  if (row.priority === input.priority) throw unprocessable('NO_CHANGE', `The priority is already ${row.priority}.`);
  await tx.query(`UPDATE work_items SET priority = $2, ${BUMP} WHERE id = $1`, [id, input.priority]);
  await appendEvent(tx, {
    itemId: id,
    teamId: row.team_id,
    actorId: p.userId,
    type: 'priority_changed',
    data: { from: row.priority, to: input.priority },
    reason: input.reason,
  });
  return getItem(tx, p, id);
}

/**
 * Claim = "I will take this". The guard is in the UPDATE's WHERE clause, so it is evaluated against the
 * LATEST committed row version while holding the row lock: with N concurrent claims exactly one UPDATE matches
 * and the rest affect zero rows. No read-then-write race exists, and no application-level locking is needed.
 */
export async function claimItem(tx: Tx, p: Principal, id: string): Promise<ItemDetail> {
  const peek = await one<{ team_id: string }>(tx, 'SELECT team_id FROM work_items WHERE id = $1 AND team_id = ANY($2::uuid[])', [id, teamIds(p)]);
  if (!peek) throw notFound('Work item');
  // Re-read the claimant's roles inside the transaction and share-lock them, so a concurrent role removal
  // (which takes the exclusive lock) is ordered strictly before or after this claim.
  const fresh = await freshRoles(tx, p.userId, peek.team_id, 'SHARE');
  if (!canWork(fresh)) throw forbidden('Your role in this team does not allow you to take on work.');

  const claimed = await tx.query(
    `UPDATE work_items SET assignee_id = $2, ${BUMP}
      WHERE id = $1 AND assignee_id IS NULL AND status IN ('new', 'triaged')`,
    [id, p.userId],
  );
  if (claimed.rowCount === 0) {
    const row = await getItemRow(tx, p, id);
    if (row.assignee_id) {
      throw conflict(
        'ALREADY_CLAIMED',
        row.assignee_id === p.userId ? 'You already own this item.' : `${row.assignee_name} already took this item.`,
        { assignee: { id: row.assignee_id, name: row.assignee_name }, current: toDetail(row, p) },
      );
    }
    throw conflict('NOT_CLAIMABLE', `An item that is "${row.status}" cannot be claimed.`, { current: toDetail(row, p) });
  }
  await appendEvent(tx, { itemId: id, teamId: peek.team_id, actorId: p.userId, type: 'claimed', data: { to: { id: p.userId, name: p.name } } });
  return getItem(tx, p, id);
}

export async function releaseItem(tx: Tx, p: Principal, id: string, input: { expectedVersion: number; reason?: string | undefined }): Promise<ItemDetail> {
  const row = await lockItem(tx, p, id);
  assertVersion(row, input.expectedVersion, p);
  if (!canRelease(factsOf(row), actorFor(p, row.team_id))) {
    if (row.assignee_id === null) throw conflict('NOT_ASSIGNED', 'Nobody is assigned to this item.', { current: toDetail(row, p) });
    throw forbidden('Only the assignee or a lead can release this item, and not while it is awaiting or past approval.');
  }
  // An item that was being worked on returns to the triaged pool; in-flight statuses require an assignee (DB CHECK).
  const nextStatus: Status = row.status === 'in_progress' ? 'triaged' : row.status;
  await tx.query(`UPDATE work_items SET assignee_id = NULL, status = $2, ${BUMP} WHERE id = $1`, [id, nextStatus]);
  await appendEvent(tx, {
    itemId: id,
    teamId: row.team_id,
    actorId: p.userId,
    type: 'released',
    data: { from: { id: row.assignee_id, name: row.assignee_name }, status: { from: row.status, to: nextStatus } },
    reason: input.reason ?? null,
  });
  return getItem(tx, p, id);
}

export async function assignItem(tx: Tx, p: Principal, id: string, input: { expectedVersion: number; assigneeId: string; reason: string }): Promise<ItemDetail> {
  const row = await lockItem(tx, p, id);
  assertVersion(row, input.expectedVersion, p);
  const actor = actorFor(p, row.team_id);
  if (!ACTIVE_STATUSES.includes(row.status)) throw conflict('ITEM_FINAL', 'This item is no longer active.');
  if (!canReassign(factsOf(row), actor)) throw forbidden('Only a lead can assign work to someone else.');
  if (row.assignee_id === input.assigneeId) throw unprocessable('NO_CHANGE', 'That person is already the assignee.');
  const target = await freshRoles(tx, input.assigneeId, row.team_id, 'SHARE');
  if (!canWork(target)) throw unprocessable('INVALID_ASSIGNEE', 'That person is not a member of this team who can take on work.');
  const name = await one<{ name: string }>(tx, 'SELECT name FROM users WHERE id = $1 AND is_active', [input.assigneeId]);
  if (!name) throw unprocessable('INVALID_ASSIGNEE', 'That user is not active.');
  await tx.query(`UPDATE work_items SET assignee_id = $2, ${BUMP} WHERE id = $1`, [id, input.assigneeId]);
  await appendEvent(tx, {
    itemId: id,
    teamId: row.team_id,
    actorId: p.userId,
    type: 'assigned',
    data: { from: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null, to: { id: input.assigneeId, name: name.name } },
    reason: input.reason,
  });
  return getItem(tx, p, id);
}

export async function transitionItem(
  tx: Tx,
  p: Principal,
  id: string,
  input: { expectedVersion: number; to: Status; reason?: string | undefined; resolution?: string | undefined },
): Promise<ItemDetail> {
  const row = await lockItem(tx, p, id);
  assertVersion(row, input.expectedVersion, p);
  const verdict = evaluateTransition(factsOf(row), actorFor(p, row.team_id), input.to, input);
  if (!verdict.ok) {
    const v = verdict.violation;
    throw v.status === 409 ? conflict(v.code, v.message, { current: toDetail(row, p) }) : v.status === 403 ? forbidden(v.message, v.code) : unprocessable(v.code, v.message);
  }
  const resolution = verdict.def.needs.includes('resolution') ? input.resolution!.trim() : undefined;
  const reopening = verdict.def.action === 'reopen';
  await tx.query(
    `UPDATE work_items SET status = $2, resolution = CASE WHEN $4::boolean THEN NULL ELSE COALESCE($3, resolution) END, ${BUMP} WHERE id = $1`,
    [id, input.to, resolution ?? null, reopening],
  );
  await appendEvent(tx, {
    itemId: id,
    teamId: row.team_id,
    actorId: p.userId,
    type: 'status_changed',
    data: { from: row.status, to: input.to, action: verdict.def.action, ...(resolution ? { resolution } : {}), ...(reopening && row.resolution ? { previousResolution: row.resolution } : {}) },
    reason: input.reason?.trim() || null,
  });
  return getItem(tx, p, id);
}

export async function addComment(tx: Tx, p: Principal, id: string, body: string): Promise<TimelineEvent> {
  // A comment does not change the item's own fields (no version bump, so it never causes edit conflicts), but it does
  // touch last_activity_at. NO KEY UPDATE is exactly the lock that UPDATE needs: taking it up front (instead of a
  // SHARE lock that is upgraded later) means two concurrent commenters queue instead of deadlocking.
  const row = await one<ItemRow>(tx, `SELECT ${SUMMARY_COLS} ${FROM} WHERE i.id = $1 AND i.team_id = ANY($2::uuid[]) FOR NO KEY UPDATE OF i`, [id, teamIds(p)]);
  if (!row) throw notFound('Work item');
  if (!canComment(rolesIn(p, row.team_id))) throw forbidden('You cannot comment in this team.');
  if (row.status === 'closed' || row.status === 'cancelled') throw conflict('ITEM_FINAL', 'Closed and cancelled items are read-only.');
  await tx.query('UPDATE work_items SET last_activity_at = now(), stale_notified_at = NULL WHERE id = $1', [id]);
  const eventId = await appendEvent(tx, { itemId: id, teamId: row.team_id, actorId: p.userId, type: 'comment', body });
  const ev = await one<EventRow>(tx, `SELECT ${EVENT_COLS} FROM work_item_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.id = $1`, [eventId]);
  return toTimelineEvent(ev!);
}

// ---------------------------------------------------------------- helpers ----

/**
 * Roles read from the database inside the current transaction, row-locked in the given mode.
 * `SHARE` = "I rely on this staying true until I commit"; membership changes take the exclusive lock.
 */
export async function freshRoles(tx: Tx, userId: string, teamId: string, lock: 'SHARE' | 'UPDATE'): Promise<ReadonlySet<Role>> {
  const found = await rows<{ role: Role }>(tx, `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2 FOR ${lock}`, [userId, teamId]);
  return new Set(found.map((r) => r.role));
}
