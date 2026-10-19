-- Lists across ALL of a user's teams (the default view) have no team_id equality, so the per-team indexes
-- from 001 cannot give an ordered scan: Postgres had to sort every active row (~35k at 50k items, ~50 ms).
-- These two indexes let the planner walk the index in order and stop after LIMIT (keyset pagination).
CREATE INDEX IF NOT EXISTS items_active_priority_idx
  ON work_items (priority_rank DESC, last_activity_at DESC, id DESC) WHERE (status = ANY (ARRAY['new'::text, 'triaged'::text, 'in_progress'::text, 'pending_approval'::text, 'approved'::text]));
CREATE INDEX IF NOT EXISTS items_activity_idx
  ON work_items (last_activity_at DESC, id DESC);
-- "Newest first" sort (sort=created) across all teams.
CREATE INDEX IF NOT EXISTS items_created_idx
  ON work_items (created_at DESC, id DESC);
