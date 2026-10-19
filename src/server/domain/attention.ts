// "Needs attention": the home screen. Every group is an explicit rule (shown to the user) evaluated by one
// indexed SQL query restricted to the caller's teams; nothing is computed in application memory.

import type { AttentionGroup, AttentionResponse } from '../../shared/contract.js';
import { isApprover, isLead, canWork } from '../../shared/permissions.js';
import { teamIds, teamsWhere, type Principal } from '../auth/principal.js';
import { one, rows, type Db } from '../db.js';
import { ACTIVE_SQL, FROM, SUMMARY_COLS, toSummary, type ItemRow } from './items.js';

const PER_GROUP = 5;
// NOTE: every query is always sent $1..$4. Postgres rejects a parameter that is never referenced (it cannot infer its
// type), so the executed SQL always mentions all four via the harmless predicate added in getAttention().

interface Def {
  key: string;
  title: string;
  rule: string;
  /** SQL condition; $1 = user id, $2 = team ids, $3 = lead team ids, $4 = stale hours. Returns null to skip the group. */
  where: string;
  order: string;
  needsTeams: 'all' | 'approver' | 'worker' | 'lead' | 'none';
}

const DEFS: Def[] = [
  {
    key: 'approvals',
    title: 'Waiting for your approval',
    rule: 'Pending approval, in a team where you are an approver, and you neither requested it nor own it.',
    where: `i.status = 'pending_approval' AND i.team_id = ANY($2::uuid[]) AND i.requester_id <> $1 AND i.assignee_id IS DISTINCT FROM $1`,
    order: 'i.priority_rank DESC, i.last_activity_at ASC',
    needsTeams: 'approver',
  },
  {
    key: 'overdue_mine',
    title: 'Overdue and yours',
    rule: 'Assigned to you, still active, and past its due date.',
    where: `i.assignee_id = $1 AND i.due_at < now() AND i.status IN (${ACTIVE_SQL}) AND i.team_id = ANY($2::uuid[])`,
    order: 'i.due_at ASC, i.id',
    needsTeams: 'all',
  },
  {
    key: 'urgent_unassigned',
    title: 'Urgent and nobody owns it',
    rule: 'Urgent priority, no assignee, not started — in a team where you can take on work.',
    where: `i.priority = 'urgent' AND i.assignee_id IS NULL AND i.status IN ('new', 'triaged') AND i.team_id = ANY($2::uuid[])`,
    order: 'i.created_at ASC, i.id',
    needsTeams: 'worker',
  },
  {
    key: 'needs_triage',
    title: 'New and not triaged',
    rule: 'Status "New", in a team where you are a lead.',
    where: `i.status = 'new' AND i.team_id = ANY($2::uuid[])`,
    order: 'i.priority_rank DESC, i.created_at ASC',
    needsTeams: 'lead',
  },
  {
    key: 'going_quiet',
    title: 'Going quiet',
    rule: 'Active with no activity for the stale period, and either assigned to you or unassigned in a team you lead.',
    where: `i.status IN (${ACTIVE_SQL}) AND i.last_activity_at < now() - ($4::int * interval '1 hour')
            AND (i.assignee_id = $1 OR (i.assignee_id IS NULL AND i.team_id = ANY($3::uuid[]))) AND i.team_id = ANY($2::uuid[])`,
    order: 'i.last_activity_at ASC, i.id',
    needsTeams: 'all',
  },
  {
    key: 'confirm_resolved',
    title: 'Resolved — please confirm',
    rule: 'You requested it and it has been marked resolved; confirm it is fixed (or reopen it).',
    where: `i.requester_id = $1 AND i.status = 'resolved' AND i.team_id = ANY($2::uuid[])`,
    order: 'i.last_activity_at ASC, i.id',
    needsTeams: 'all',
  },
];

export async function getAttention(db: Db, p: Principal, staleAfterHours: number): Promise<AttentionResponse> {
  const all = teamIds(p);
  const leadTeams = teamsWhere(p, isLead);
  const scopes: Record<Def['needsTeams'], string[]> = {
    all,
    approver: teamsWhere(p, isApprover),
    worker: teamsWhere(p, canWork),
    lead: leadTeams,
    none: [],
  };

  const groups = await Promise.all(
    DEFS.map(async (d): Promise<AttentionGroup | null> => {
      const scope = scopes[d.needsTeams];
      if (scope.length === 0) return null;
      const found = await rows<ItemRow & { total: number }>(
        db,
        `SELECT ${SUMMARY_COLS}, count(*) OVER () AS total ${FROM} WHERE $1::uuid IS NOT NULL AND $2::uuid[] IS NOT NULL AND $3::uuid[] IS NOT NULL AND $4::int IS NOT NULL AND (${d.where}) ORDER BY ${d.order} LIMIT ${PER_GROUP}`,
        [p.userId, scope, leadTeams, staleAfterHours],
      );
      if (found.length === 0) return null;
      return { key: d.key, title: d.title, rule: d.rule, total: Number(found[0]!.total), items: found.map((r) => toSummary(r, p)) };
    }),
  );

  const s = all.length
    ? await one<{ active: number; mine: number; requested: number }>(
        db,
        `SELECT count(*)::int AS active,
                (count(*) FILTER (WHERE assignee_id = $1))::int AS mine,
                (count(*) FILTER (WHERE requester_id = $1))::int AS requested
           FROM work_items WHERE team_id = ANY($2::uuid[]) AND status IN (${ACTIVE_SQL})`,
        [p.userId, all],
      )
    : undefined;
  return {
    summary: { activeInMyTeams: s?.active ?? 0, assignedToMe: s?.mine ?? 0, requestedByMe: s?.requested ?? 0 },
    groups: groups.filter((g): g is AttentionGroup => g !== null),
  };
}
