-- OpsDesk schema, migration 001.
--
-- Design notes (see ENGINEERING_DECISIONS.md for the reasoning):
--   * Correctness rules that must hold "no matter which code path wrote the row" are CHECK
--     constraints / triggers here, not only application code.
--   * work_item_events is an append-only audit log (enforced by trigger).
--   * outbox_jobs + notifications implement transactional-outbox async processing.
--   * Partial indexes target the "active work" subset, which is what people actually look at.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- identity ----

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  password_hash text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Opaque server-side sessions (only a SHA-256 of the token is stored): revocable instantly,
-- unlike a stateless JWT.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx   ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (team, user, role): a user can hold several responsibilities in one team,
-- and different ones in different teams.
CREATE TABLE memberships (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('member', 'lead', 'approver', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id, role)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- -------------------------------------------------------------- work items ----

CREATE TABLE work_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- human-friendly "#1234"
  team_id           uuid NOT NULL REFERENCES teams(id),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  kind              text NOT NULL CHECK (kind IN
                      ('customer_issue', 'incident', 'payment', 'compliance', 'access_request', 'task')),
  status            text NOT NULL DEFAULT 'new' CHECK (status IN
                      ('new', 'triaged', 'in_progress', 'pending_approval', 'approved',
                       'resolved', 'closed', 'cancelled')),
  priority          text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  priority_rank     smallint GENERATED ALWAYS AS (
                      CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
                    ) STORED,
  requester_id      uuid NOT NULL REFERENCES users(id),
  assignee_id       uuid REFERENCES users(id),
  requires_approval boolean NOT NULL DEFAULT false,
  resolution        text CHECK (resolution IS NULL OR char_length(resolution) BETWEEN 1 AND 5000),
  due_at            timestamptz,
  -- Optimistic-concurrency token: bumped on every change to the item's own fields.
  version           integer NOT NULL DEFAULT 1,
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  stale_notified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  search            tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                      setweight(to_tsvector('simple', coalesce(description, '')), 'B')
                    ) STORED,

  -- Workflow invariants enforced by the database itself:
  CONSTRAINT in_flight_needs_assignee CHECK
    (status NOT IN ('in_progress', 'pending_approval', 'approved') OR assignee_id IS NOT NULL),
  CONSTRAINT resolved_needs_resolution CHECK
    (status NOT IN ('resolved', 'closed') OR resolution IS NOT NULL)
);

-- team_id / requester_id / requires_approval are what authorization and workflow rules lean on;
-- they are immutable, so a check made before taking the row lock can never go stale.
CREATE FUNCTION work_items_guard_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.requires_approval IS DISTINCT FROM OLD.requires_approval
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'work_items: team_id, requester_id, requires_approval and created_at are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER work_items_immutable BEFORE UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION work_items_guard_immutable();

-- Listing: per-team keyset scans ordered by activity / priority. Partial indexes cover the
-- "active" subset (the default view) so closed history never slows the live list down.
CREATE INDEX items_team_activity_idx ON work_items (team_id, last_activity_at DESC, id DESC);
CREATE INDEX items_team_active_activity_idx ON work_items (team_id, last_activity_at DESC, id DESC)
  WHERE status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');
CREATE INDEX items_team_active_priority_idx ON work_items (team_id, priority_rank DESC, last_activity_at DESC, id DESC)
  WHERE status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');
-- "My work", approvals queue, triage queue, due dates, requester views, staleness scan.
CREATE INDEX items_assignee_active_idx ON work_items (assignee_id, last_activity_at DESC, id DESC)
  WHERE assignee_id IS NOT NULL AND status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');
CREATE INDEX items_pending_approval_idx ON work_items (team_id, priority_rank DESC, last_activity_at DESC)
  WHERE status = 'pending_approval';
CREATE INDEX items_new_idx ON work_items (team_id, created_at) WHERE status = 'new';
CREATE INDEX items_unassigned_idx ON work_items (team_id, priority_rank DESC, created_at)
  WHERE assignee_id IS NULL AND status IN ('new', 'triaged');
CREATE INDEX items_due_idx ON work_items (due_at)
  WHERE due_at IS NOT NULL AND status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');
CREATE INDEX items_requester_idx ON work_items (requester_id, created_at DESC);
CREATE INDEX items_resolved_requester_idx ON work_items (requester_id) WHERE status = 'resolved';
CREATE INDEX items_stale_idx ON work_items (last_activity_at)
  WHERE status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');
-- Search + duplicate detection.
CREATE INDEX items_search_idx ON work_items USING gin (search);
CREATE INDEX items_title_trgm_idx ON work_items USING gin (title gin_trgm_ops)
  WHERE status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');

-- Global "active" index: lets multi-team lists walk newest-first and stop early.
CREATE INDEX items_active_activity_idx ON work_items (last_activity_at DESC, id DESC)
  WHERE status IN ('new', 'triaged', 'in_progress', 'pending_approval', 'approved');

-- ----------------------------------------------------------- audit history ----

-- Every meaningful change AND every comment is one row here, written in the same transaction
-- as the change itself. Append-only: UPDATE/DELETE are rejected by trigger.
CREATE TABLE work_item_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  team_id    uuid NOT NULL,                       -- denormalised: team feeds / future partitioning
  actor_id   uuid REFERENCES users(id),           -- NULL = the system (e.g. stale detection)
  type       text NOT NULL CHECK (type IN
               ('created', 'updated', 'priority_changed', 'claimed', 'assigned', 'released',
                'status_changed', 'comment', 'stale_flagged')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- structured before/after
  reason     text,                                -- the "why" behind a decision
  body       text,                                -- comment text
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_item_idx ON work_item_events (item_id, id DESC);
CREATE INDEX events_team_idx ON work_item_events (team_id, id DESC);

CREATE FUNCTION forbid_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'work_item_events is append-only (% rejected)', TG_OP USING ERRCODE = '55000';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON work_item_events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();

-- ------------------------------------------------- idempotency & async work ----

-- A row is inserted in the SAME transaction as the operation it protects, so the key exists
-- if and only if the operation committed. Concurrent duplicates block on the unique index.
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  fingerprint     text NOT NULL,                  -- hash of method + path + body
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

-- Transactional outbox: enqueued in the same transaction as the business change.
CREATE TABLE outbox_jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX outbox_ready_idx      ON outbox_jobs (run_at, id)  WHERE status = 'pending';
CREATE INDEX outbox_processing_idx ON outbox_jobs (locked_at)   WHERE status = 'processing';
CREATE INDEX outbox_done_idx       ON outbox_jobs (completed_at) WHERE status = 'done';
CREATE INDEX outbox_dead_idx       ON outbox_jobs (id)          WHERE status = 'dead';

-- UNIQUE (user_id, event_id) makes the notify handler idempotent: re-running a job after a
-- crash or retry can never create a second notification for the same event.
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   bigint NOT NULL REFERENCES work_item_events(id),
  item_id    uuid NOT NULL REFERENCES work_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (user_id, event_id)
);
CREATE INDEX notifications_user_idx   ON notifications (user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Membership/role changes are security-relevant, so they get their own append-only trail.
CREATE TABLE membership_changes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id        uuid NOT NULL REFERENCES teams(id),
  actor_id       uuid NOT NULL REFERENCES users(id),
  target_user_id uuid NOT NULL REFERENCES users(id),
  roles_before   text[] NOT NULL,
  roles_after    text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX membership_changes_team_idx ON membership_changes (team_id, id DESC);
