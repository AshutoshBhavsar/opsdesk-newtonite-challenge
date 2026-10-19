# ARCHITECTURE — design, contracts and conventions

This is the original design blueprint. **Everything described here is now built** (the [BUILT]/[BUILT] tags below are historical); the code and `ENGINEERING_DECISIONS.md` are authoritative where they differ. Migration `002_global_list_indexes.sql` was added after this was written.

## 1. Stack and why

| Layer | Choice | Reason |
|---|---|---|
| DB | PostgreSQL 16 | transactions, row locks, `FOR UPDATE SKIP LOCKED` job queue, full-text, `pg_trgm`, partial indexes, `LISTEN/NOTIFY` — no Redis/Kafka needed |
| Server | Node 22 + TypeScript, `node:http`, **zod 3**, **pg** (only runtime deps besides React) | small surface = explainable; custom router in `http/router.ts` |
| Web | React 19, **plain JSX (no TS)**, bundled by esbuild (`scripts/build-web.mjs`) | verifiable in the sandbox with Playwright; no Vite needed |
| Tests | `node:test` + `tsx`, real Postgres | concurrency bugs only show up against a real DB |
| Run | `docker-compose.yml`: `db`, `api`, `worker` | worker is a separate process = separate failure domain |

Processes: **api** (HTTP + SSE) and **worker** (outbox + stale scan + housekeeping). `RUN_WORKER=true` runs the worker
inside the api process for local dev.

## 2. Repository layout

```
migrations/001_init.sql        [BUILT, VERIFIED applies]   schema, constraints, indexes
src/shared/                    [BUILT]  isomorphic (server + web bundle): contract.ts, workflow.ts, permissions.ts, capabilities.ts
src/server/config.ts log.ts db.ts           [BUILT]
src/server/http/{errors,router}.ts          [BUILT]
src/server/auth/{passwords,principal,rate-limit,guard}.ts   [BUILT]
src/server/domain/{idempotency,events,items}.ts             [BUILT]
src/server/domain/attention.ts notifications.ts members.ts  [BUILT]
src/server/routes/*.ts         [BUILT] one file per resource; each exports register(router, deps)
src/server/app.ts              [BUILT] createApp(config, pool) → { server, hub, close }  (used by main + tests)
src/server/main.ts             [BUILT] entry: migrate → listen (+ optional in-process worker); graceful shutdown
src/server/realtime/hub.ts     [BUILT] SSE hub + LISTEN ops_changes
src/server/worker/{loop,handlers,stale,main}.ts [BUILT]
src/server/scripts/{migrate,seed}.ts [BUILT]
web/                           [BUILT] index.html, src/*.jsx, styles.css  → built to dist/web
test/                          [BUILT] *.test.ts + helpers.ts
scripts/                       build-web.mjs [BUILT]
docs/                          this folder
```

## 3. Conventions (follow them; they keep the tree compiling)

- `tsconfig`: strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `module: NodeNext` ⇒ relative imports
  need the **`.js` extension** (`import { x } from './x.js'`), optional properties that may be `undefined` must be typed
  `T | undefined`.
- `src/shared/*` must stay dependency-free pure TS (it is bundled into the browser).
- Errors: throw `AppError` helpers from `http/errors.ts` (`notFound`, `forbidden`, `conflict`, `unprocessable`,
  `badRequest`, `unauthenticated`). Everything else → 500 with a request id. Postgres error codes are mapped in
  `toErrorReply` (23505→409, 23514/23503→409, 22P02→400, 57014/55P03→503).
- **Authorization = SQL filter + pure rules.** Read an item with `team_id = ANY($teams)` (so non-members get 404), then ask
  `shared/permissions.ts` / `workflow.ts`. Never trust a client-supplied role or team.
- **One transaction per mutation**: row change + `appendEvent()` (event + outbox job + `pg_notify`) all inside `tx()`.
- **Concurrency**: lock with `SELECT … FOR UPDATE OF i`, compare `version`, then `UPDATE … version = version + 1`.
  Claim uses a conditional `UPDATE … WHERE assignee_id IS NULL AND status IN ('new','triaged')`.
- **Idempotency** wraps mutating routes (`Idempotency-Key` header, 8–100 chars `[A-Za-z0-9_.:-]`): see §5.
- **CSP**: `script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'` — no inline `<script>`/`<style>` blocks.
- Dates: API sends ISO-8601 strings. Keyset cursors carry microsecond timestamps as **text** (`ts_activity`, `ts_created`)
  because JS `Date` truncates to ms.

## 4. Data model [BUILT — see `migrations/001_init.sql`]

`users`, `sessions` (SHA-256 token hash), `teams`, `memberships(team,user,role)` (multi-row per user/team),
`work_items` (version, `priority_rank` generated, `search` tsvector generated, CHECK constraints: in-flight statuses need
an assignee, resolved/closed need a resolution; trigger makes `team_id/requester_id/requires_approval/created_at`
immutable), `work_item_events` (append-only by trigger; also stores comments), `idempotency_keys`, `outbox_jobs`,
`notifications(UNIQUE user_id,event_id)`, `membership_changes`. Partial indexes target the "active" subset.

Workflow (see `src/shared/workflow.ts`, the single source of truth, also used to render buttons):

```
new ─► triaged ─► in_progress ─► resolved ─► closed
 │        │          │  ▲  ╲        │
 │        │          ▼  │   ╲       └─► in_progress (reopen, reason)
 │        │   pending_approval ─► approved ─► resolved      (only if requires_approval; reject → in_progress, reason)
 └────────┴──────────► cancelled (reason)
```

## 5. API contract

All under `/api`. JSON in/out. Auth: cookie `opsdesk_session` (HttpOnly, SameSite=Lax) or `Authorization: Bearer <token>`.
Errors: `{ "error": { "code", "message", "details"? } }`. Mutations accept `Idempotency-Key`; replays carry
`Idempotent-Replay: true`. **[BUILT]** = domain function exists; the HTTP route is **[BUILT]** unless stated.

| Method & path | Body / query | Success | Notable errors |
|---|---|---|---|
| `POST /auth/login` | `{email,password}` | 200 `Me`, sets cookie | 401 `INVALID_CREDENTIALS`, 429 `RATE_LIMITED` (+`Retry-After`) |
| `POST /auth/logout` | – | 204, clears cookie | |
| `GET /me` | – | `Me` (user, teams+roles, unread count) | 401 |
| `GET /items` | `team,status(active\|all\|csv),priority,kind,assignee(me\|unassigned\|uuid),requester,overdue,q,sort(activity\|priority\|created),limit≤100,cursor` | `Page<ItemSummary>` | 404 team not yours, 422 `INVALID_CURSOR` |
| `POST /items` | `{teamId,title,description?,kind,priority?,dueAt?}` | 201 `ItemDetail` | 404 team, 403 |
| `GET /items/similar` | `teamId,title` | `SimilarItem[]` | |
| `GET /items/:id` | | `ItemDetail` (+ `can` capabilities) | 404 |
| `PATCH /items/:id` | `{expectedVersion,title?,description?,dueAt?}` | `ItemDetail` | 409 `VERSION_CONFLICT`/`ITEM_FINAL`, 403 |
| `GET /items/:id/events` | `cursor,limit` | `Page<TimelineEvent>` (comments included) | 404 |
| `POST /items/:id/comments` | `{body}` | 201 `TimelineEvent` | 409 `ITEM_FINAL`, 403 |
| `POST /items/:id/claim` | – (no version; the guard is atomic) | `ItemDetail` | 409 `ALREADY_CLAIMED` (details.assignee) / `NOT_CLAIMABLE`, 403 |
| `POST /items/:id/release` | `{expectedVersion,reason?}` | `ItemDetail` | 409, 403 |
| `POST /items/:id/assign` | `{expectedVersion,assigneeId,reason}` | `ItemDetail` | 422 `INVALID_ASSIGNEE`/`NO_CHANGE`, 403 |
| `POST /items/:id/priority` | `{expectedVersion,priority,reason}` | `ItemDetail` | 403 (not lead), 422 `NO_CHANGE` |
| `POST /items/:id/transition` | `{expectedVersion,to,reason?,resolution?}` | `ItemDetail` | 409 `INVALID_TRANSITION`/`VERSION_CONFLICT`, 403 `FORBIDDEN`/`SEPARATION_OF_DUTIES`, 422 `REASON_REQUIRED`/`RESOLUTION_REQUIRED`/`APPROVAL_REQUIRED`/`ASSIGNEE_REQUIRED` |
| `GET /attention` | – | `AttentionResponse` (see §7) | |
| `GET /notifications` | `cursor,limit,unread?` | `Page<NotificationDto>` | |
| `POST /notifications/read` | `{ids?: number[]}` (omit = all) | 204 | |
| `GET /teams/:teamId/members` | – | `Member[]` (any member of team) | 404 |
| `PUT /teams/:teamId/members` | `{email,roles[]}` (empty = remove) | `Member[]` | 403 not admin, 404 `USER_NOT_FOUND`, 409 `LAST_ADMIN`/`MEMBER_HAS_WORK` |
| `GET /stream` | SSE | `data: <RealtimeMessage>` | 401 |
| `GET /health` | – | `{ok:true}` (checks DB) | 503 |

Status-code policy: 400 validation · 401 unauthenticated · 403 authenticated but not allowed **in a team you can see** ·
404 unknown **or not visible** · 409 state conflict (stale version, already claimed, illegal transition) ·
422 well-formed but violates a business rule · 429 rate limit · 503 DB busy/timeouts.

**Idempotency semantics** (`domain/idempotency.ts` [BUILT]): in the route wrapper `mutate(ctx, input, fn)`:
no header → run `fn` in `tx`; header → inside one `tx`: `beginIdempotent` (INSERT … ON CONFLICT DO NOTHING; a concurrent
duplicate blocks on the unique index until the first commits or rolls back) → replay stored response, or run `fn`, then
`completeIdempotent`. Errors thrown by `fn` roll the key back, so failed attempts can be retried with the same key.
`fingerprint = sha256(method path stableJSON(body))`; a reused key with a different fingerprint → 422.

## 6. Notifications and the worker [BUILT]

`appendEvent()` already inserts an outbox job `{type:'notify_event', payload:{eventId}}` and `pg_notify('ops_changes', …)`.

**Worker loop** (`worker/loop.ts`): every `workerPollMs` (and immediately while work is found):
1. *Reap*: `UPDATE outbox_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END, run_at = now()
   WHERE status='processing' AND locked_at < now() - visibility_timeout` (crashed worker recovery; attempts was already
   incremented at claim, so a poison job cannot loop forever).
2. *Claim* a batch: `UPDATE outbox_jobs SET status='processing', locked_at=now(), attempts=attempts+1 WHERE id IN
   (SELECT id FROM outbox_jobs WHERE status='pending' AND run_at<=now() ORDER BY run_at,id LIMIT $n FOR UPDATE SKIP LOCKED)
   RETURNING *`.
3. *Process each* in its own `tx`: run the handler **and** mark the job `done` in the same transaction (effects and
   completion are atomic). On exception: new tx → `attempts >= max_attempts` ? `dead` : `pending` with
   `run_at = now() + least(2^attempts * 5s, 15min) ± jitter`, `last_error` stored. Unknown job type or
   `PermanentError` → `dead` immediately.
4. Housekeeping every few minutes: delete expired sessions, idempotency keys > 24 h, `done` jobs > 7 days.

**`notify_event` handler**: load the event + item; compute recipients; `INSERT INTO notifications … ON CONFLICT
(user_id, event_id) DO NOTHING`; `pg_notify('ops_changes', {kind:'notification', userIds})` (delivered on commit).
Recipients (always exclude the actor; only active users who currently have a role in the item's team; de-duplicate):

| event type | recipients |
|---|---|
| `created` | team leads |
| `claimed` | requester |
| `assigned` | new assignee, previous assignee, requester |
| `released` | previous assignee (if actor differs), team leads, requester |
| `status_changed` | requester + assignee; **plus all approvers** (excl. requester/assignee) when `to = pending_approval` |
| `comment`, `updated`, `priority_changed` | requester + assignee |
| `stale_flagged` | assignee, or the team's leads if unassigned |

**Stale scan** (`worker/stale.ts`): every `staleScanIntervalMs`, in a tx:
`SELECT id,team_id FROM work_items WHERE status IN (active) AND last_activity_at < now() - $stale AND stale_notified_at IS NULL
ORDER BY last_activity_at LIMIT 200 FOR UPDATE SKIP LOCKED` → set `stale_notified_at = now()` (**not** `last_activity_at`,
**no** version bump) → `appendEvent(actor null, type 'stale_flagged')`. Any real activity (`BUMP` in items.ts) clears
`stale_notified_at`, so an item can be flagged again later.

## 7. Needs Attention (`domain/attention.ts`) [BUILT]

`GET /attention` returns groups; each = `{key,title,rule,total,items(≤5 ItemSummary)}`; the `rule` text is shown to users.
Compute per group with one SQL query using `count(*) OVER()`, restricted to the principal's teams. Empty groups are
omitted. Rules (all on *active* items):

1. `approvals` — "Waiting for your approval": `status='pending_approval'`, in teams where I'm approver/admin, requester≠me, assignee≠me.
2. `overdue_mine` — "Overdue and yours": assignee = me, `due_at < now()`.
3. `urgent_unassigned` — "Urgent and nobody owns it": priority `urgent`, unassigned, status new/triaged, in teams where I can work.
4. `needs_triage` — "New and not triaged": status `new`, in teams where I'm lead/admin.
5. `going_quiet` — "Going quiet": (assignee = me) OR (unassigned AND I'm lead), `last_activity_at < now() - stale`.
6. `confirm_resolved` — "Resolved — please confirm": requester = me, status `resolved`.

`summary`: counts of active items in my teams, assigned to me, requested by me.

## 8. Realtime (SSE) [BUILT]

`realtime/hub.ts`: one dedicated `pg.Client` runs `LISTEN ops_changes`; each notification payload is a `RealtimeMessage`.
`GET /api/stream` (raw handler, authenticated): headers `text/event-stream`, `Cache-Control: no-cache`; send a comment
heartbeat every 25 s; forward `item` messages only for teams in the client's team set, `notification` only if
`userIds` contains the client; re-authenticate every 60 s and close if the session/roles changed (refresh the team set).
If the LISTEN connection drops: reconnect with backoff and broadcast `{kind:'resync'}`. Messages never carry content,
only ids/types (clients refetch through the authorized API). Remove clients on `close`.

## 9. Frontend plan [BUILT] — React, JSX, esbuild → `dist/web`

`scripts/build-web.mjs` (esbuild API: bundle `web/src/main.jsx` → `dist/web/app.js`, copy `web/index.html`, `web/styles.css`;
`--watch` option). Server serves `dist/web` with SPA fallback (already implemented in `router.ts`). Screens:

- **Shell**: a compact dark sidebar (Needs attention, Items, New item, Notifications with unread count, Members, user + Sign out); below 900 px it
  becomes a drawer opened from a top bar (Esc and the scrim close it). A skip link comes first; focus moves to the page on navigation.
- **Login** (demo accounts in a disclosure), **Needs Attention** (summary counts, then one panel per rule group showing the rule text and a
  compact item table), **Items** (labelled filter toolbar: search with debounce, team, status, priority, kind, assignee, sort, overdue;
  real `<table>` with aligned columns, rows open the item; "Load more" using `nextCursor`; per-row **Claim** when `claimable`),
  **Item detail** (two columns: description, comment form and History timeline on the left; an Actions panel driven only by `item.can`
  plus a Details panel on the right; blocked transitions are listed with the server's reason; reason/resolution dialogs where `needs`
  demands), **New item** (live "similar open items" warning via `/items/similar`), **Notifications**, **Team members** (table with role
  descriptions; admins add/change members and confirm removals in a dialog).
- **Design system**: tokens in `web/styles.css` (type scale, 4 px spacing, neutral palette, one indigo accent, semantic colours used only as
  status/priority dots, warnings and errors); shared components in `web/src/ui.jsx` (`ItemTable`, `Badge`, `Dialog`, `ConfirmDialog`,
  `PageHeader`, `EmptyState`, `Loading` skeleton, `ErrorBox`). System fonts only (the CSP allows no external fonts).
- **State**: a tiny data layer (`api.js` fetch wrapper → throws `{status, code, message, details}`; cache keyed by URL;
  invalidate on mutations and on SSE messages). **One idempotency key per user action**, generated when the action starts and
  reused for automatic retries (network failure / 5xx / timeouts), discarded on a definitive answer.
- **Optimistic updates**: claim and comment update the UI immediately; on `409 ALREADY_CLAIMED` roll back and show who has it;
  on `409 VERSION_CONFLICT` roll back, show a banner "X changed this while you were looking" with the fresh values from
  `error.details.current`, and let the user re-apply their edit on the new version; on `403/404` roll back and explain.
- **Live banner**: SSE `item` message for the open item from another actor → "This item changed — Refresh".
- Accessible: every control has a label, visible focus rings, native `<dialog>` (focus trap, Esc), tables with captions and column headers,
  `prefers-reduced-motion` respected, errors announced with `role="alert"`; responsive at desktop, tablet and phone widths. Errors from a failed
  action appear *inside* the open dialog.

## 9b. Seed data (`scripts/seed` → `src/server/scripts/seed.ts`) [BUILT]

Password for every demo user: `Passw0rd!demo` (dev only; print on the login page when `NODE_ENV !== 'production'`).

| user | email | roles |
|---|---|---|
| Ananya Iyer | ananya@kaveri.test | admin in Support, Platform, Finance |
| Vikram Nair | vikram@kaveri.test | lead+member in Support |
| Priya Sharma | priya@kaveri.test | member in Support, member in Platform |
| Rajesh Menon | rajesh@kaveri.test | approver in Finance (approver only: cannot be assigned work, separation of duties) |
| Meera Reddy | meera@kaveri.test | lead+member in Finance, member in Platform |
| Siddharth Rao | siddharth@kaveri.test | member in Platform |
| Zoya Khan | zoya@kaveri.test | member in a 4th team "Legal" only (cross-team negative tests) |

Plus a handful of realistic demo items per team in various states (one pending approval, one overdue, one urgent
unassigned, one stale, one resolved awaiting confirmation) so every Needs-Attention group is populated.
`npm run seed:large` additionally inserts ≈50 000 items and ≈500 000 events across teams (use `generate_series`/`INSERT … SELECT`,
batch in a few statements; events are append-only so insert them *before* nothing else needs updating) and prints
`EXPLAIN (ANALYZE, BUFFERS)` for: default list, single-team list, deep keyset page, search, attention queries. Save the output
to `docs/PERFORMANCE.md`.

## 10. Test plan [BUILT] — `test/*.test.ts`, helper `test/helpers.ts`

`helpers.ts`: `createTestDb(name)` (drops/creates `opsdesk_t_<name>`, runs `migrate`), `startApp(db)` (createApp on port 0),
`seedBasic()` (the roles in §9b), `client(app, email)` (login → cookie jar → `get/post/patch/put`), `uniqueKey()`.

Must-have tests (name them like this so the README can list them):

1. **claim race**: 20 concurrent `POST /claim` by 20 different workers → exactly one 200, nineteen 409 `ALREADY_CLAIMED`;
   exactly one `claimed` event; version bumped once.
2. **stale version**: A and B load v1; A edits → v2; B edits with `expectedVersion:1` → 409 `VERSION_CONFLICT` with `details.current.version===2`; nothing written by B.
3. **idempotent create**: same key twice (and 10× concurrently) → one item, identical bodies, `Idempotent-Replay` on repeats;
   same key + different body → 422; failed request leaves key unused.
4. **workflow rules**: illegal transition → 409; resolve without resolution → 422; request_approval on a non-approval kind → 422;
   resolve a `payment` item without approval → 422 `APPROVAL_REQUIRED`; reject without reason → 422.
5. **four-eyes**: requester cannot approve own item; assignee cannot approve; a different approver can (200).
6. **authorization (resource-level)**: Zoya (other team) gets 404 on get/claim/comment/transition/events for another team's item;
   approver-only user cannot claim (403); plain member cannot reassign/prioritise (403); cannot create in a team they are not in.
7. **audit atomicity**: force a failure after the UPDATE inside a tx (e.g. DB constraint) → item unchanged **and** no event row,
   no outbox job; successful mutation → exactly one event + one outbox job; `UPDATE/DELETE` on `work_item_events` is rejected.
8. **outbox worker**: job fails twice then succeeds (inject failing handler) → backoff, attempts counted; max attempts → `dead`;
   **crash recovery**: a `processing` job with old `locked_at` is re-queued; **duplicate delivery**: run the same job twice →
   still one notification per (user,event); two workers polling concurrently never process the same job twice.
9. **stale scan**: old item flagged once; second scan does nothing; activity clears flag; scan is safe with two concurrent runners.
10. **keyset pagination**: with ≥120 items incl. identical timestamps, paging through by cursor returns every item exactly once, in order; tampered cursor → 422.
11. **membership**: cannot remove the last admin; removing a member releases their releasable items and refuses when they hold
    pending_approval/approved items (`MEMBER_HAS_WORK`); permission changes take effect on the very next request.
12. **UI smoke (Playwright)**: login → attention page shows groups → open item → claim → second browser context sees conflict; (separate scripts `test/e2e/ui-smoke.mjs` and `test/e2e/ui-redesign.mjs`, not part of `npm test`).

## 11. Performance notes / what to tell the interviewer

Keyset (not OFFSET) pagination; per-team + partial indexes; GIN on `search` and trigram on `title`; history paginated separately
from the item; no list endpoint returns descriptions or full history; SSE carries ids only. At 10× scale: partition
`work_item_events` by time, read replicas for lists, move the outbox to a dedicated queue (SQS/Kafka) while keeping the
transactional-outbox pattern, cache `/me`, add pgbouncer. Next week: attachments, SLA timers, email/Slack delivery, saved views, audit export.
