# Engineering decisions

Five decisions that shape the system, with the trade-offs I accepted. Every behaviour mentioned here has an automated test
(see README → Tests). Assumptions that the brief left open are listed at the end.

## 1. PostgreSQL is the only infrastructure

**Decision.** One PostgreSQL database provides: transactions and row locks (concurrency), `CHECK` constraints and triggers (data
integrity), `FOR UPDATE SKIP LOCKED` (the job queue), `tsvector` + GIN (search), `pg_trgm` (duplicate warning), partial indexes
(fast "active work" lists) and `LISTEN/NOTIFY` (live updates). No Redis, no Kafka, no search engine.

**Why.** The hard requirements are about *correctness under concurrency*. If the work item, its history and its background job
live in the same database, they can be committed atomically — with a separate queue or cache that guarantee needs extra
machinery (two-phase commit or reconciliation). Fewer moving parts is also what I can explain and operate.

**Trade-offs.** The database is the single point of contention and failure; a queue in Postgres has a throughput ceiling (thousands
of jobs/second is fine for this domain, millions is not); full-text search is "good", not a search engine (no typo tolerance, no stemming:
`simple` configuration). At 10× scale I would add read replicas for lists and move the outbox consumer to a dedicated broker
**while keeping the outbox pattern** (see decision 4).

## 2. Concurrency: let the database decide, tell the client the truth

**Decision.** Three different tools for three different problems:

- **Claiming** is one conditional statement: `UPDATE … SET assignee_id = me WHERE id = $1 AND assignee_id IS NULL AND status IN ('new','triaged')`.
  Zero rows updated means someone else won; the server then replies `409 ALREADY_CLAIMED` naming the owner. No read-then-write window exists.
- **Edits, priority, assignment, transitions** use optimistic locking: the client sends `expectedVersion`; the server locks the row
  (`FOR UPDATE`), compares, and bumps `version`. A mismatch is `409 VERSION_CONFLICT` carrying the current state so the UI can show what changed
  and let the user re-apply their edit. Comments deliberately do not bump the version (a comment must not break someone's edit).
- **Repeated requests** carry an `Idempotency-Key`. Inside the same transaction as the work, the server inserts the key
  (`ON CONFLICT DO NOTHING`); a concurrent duplicate blocks on the unique index until the first request commits, then replays the stored response.
  The same key with a different body is `422`. A failed request rolls the key back, so a retry with the same key is allowed.

**Why not last-write-wins?** It silently loses someone's work, which is exactly the problem described in the brief ("one person changes a
request while another views an older version"). **Why not pessimistic locks held across a user's think time?** They stall everyone when a
browser tab is left open.

**Trade-offs.** Users occasionally see a conflict message and must re-apply an edit (the UI makes this one click). Locks are held only for
the duration of a short transaction, but role changes lock a team's membership rows (so admin actions are serialised per team: correct, and rare).

## 3. Authorization is enforced in the server, per resource, per team

**Decision.** Roles are per team and additive: `member` (works items), `lead` (triage, assign, prioritise), `approver` (approve/reject; cannot be
assigned work — separation of duties), `admin` (everything + manage members). A user can hold several roles in a team and different roles in
different teams. Rules are pure functions in `src/shared/` (`permissions.ts`, `workflow.ts`) used by the server to decide *and* by the UI to
decide which buttons to show — one source of truth. Queries filter by the caller's teams in SQL (`team_id = ANY($teams)`), so an item in a
foreign team is a **404, not a 403** (existence is not leaked). The principal (roles and teams) is reloaded on every request, so a role
change applies on the next request and a stale token can never carry old privileges. **Four-eyes rule:** the requester and the assignee cannot
approve their own request.

**Why.** Hiding buttons is not security; every mutation re-checks on the server inside its transaction (`freshRoles` re-reads and locks the
caller's roles so a concurrent role removal is strictly ordered before or after the action).

**Trade-offs.** One extra query per request (cheap, indexed; a cache would reintroduce stale permissions). The role model is deliberately
small (no custom roles, no per-item ACLs). Sessions are server-side rows (revocable) instead of self-contained JWTs.

## 4. Synchronous core, asynchronous side effects (transactional outbox)

**Decision.** The state change, its history event and an outbox job are written in **one transaction** (`appendEvent`). A separate worker
claims jobs with `FOR UPDATE SKIP LOCKED`, runs the handler and marks the job done **in the same transaction**, so effect and completion are atomic.
Failures retry with exponential back-off and jitter, then become `dead` after the maximum attempts; unknown job types are dead immediately; a job
stuck in `processing` past a visibility timeout (crashed worker) is re-queued. Handlers are idempotent: notifications have
`UNIQUE (user_id, event_id)`, so duplicate delivery changes nothing. Live updates (SSE) are pushed with `pg_notify` on commit and carry **ids only**;
the browser re-fetches through the authorized API, so the stream can never leak content.

**Why.** Sending notifications inside the request would couple user-facing latency and success to a side effect, and "write to DB then
publish to a queue" can lose or duplicate messages on a crash. The outbox makes the guarantee *at-least-once delivery + idempotent consumers*.
The audit log is append-only (a trigger rejects `UPDATE`/`DELETE`), so important actions cannot silently disappear.

**Trade-offs.** Notifications are eventually consistent (seconds, or longer while the worker is down — the backlog drains when it returns).
At-least-once means handlers must stay idempotent. The worker polls (default every second) instead of being woken by `NOTIFY`.

## 5. Built for the stated scale; what I intentionally did not build

**Scale choices.** Keyset (cursor) pagination instead of `OFFSET`; per-team and global partial indexes for the "active" subset; history is
separate from the item and paginated on its own; no endpoint returns unbounded data; "Needs attention" is computed by indexed SQL, never in
application memory. Measured on 50 013 items / 500 027 events: list pages 2–4 ms, search 3 ms, Needs attention ≈ 90–120 ms for an admin who sees
everything ([PERFORMANCE.md](PERFORMANCE.md)). One finding changed the design: the first schema only had per-team indexes, so the default
all-teams list sorted ~35 000 rows (≈50 ms); migration `002` added global indexes (now ≈3 ms).

**Not built, on purpose.** Attachments, e-mail/Slack delivery (notifications are in-app), SLA timers and escalations, sign-up / password reset / SSO
(users are seeded or admin-managed), saved views, audit export, multi-region, microservices, GraphQL, an offline-capable UI.
I preferred a small system whose behaviour I can prove over a large one with half-working features.

**What changes at 10×.** Partition `work_item_events` by time; read replicas for lists; pgbouncer; move the outbox consumer to a real broker;
cache `/me` and per-user attention for a few seconds; replace the in-memory login rate limiter with a shared store.
**With another week:** attachments, SLA timers, e-mail/Slack delivery, saved views, audit export, a CI pipeline, more browser tests.

## Assumptions the brief left open

- Authentication is e-mail + password (scrypt) with server-side sessions; users are seeded/admin-managed.
- `payment`, `compliance`, `access_request` items require approval before they can be resolved (derived from `kind` at creation, immutable).
- "Needs attention" is defined by six explicit rules shown in the UI; an item is "going quiet" after 72 h without activity (configurable).
- Single region, single Postgres primary; no e-mail delivery.
