# OpsDesk — internal operations work-item tracker

A small, correctness-first internal web app that replaces "chat + spreadsheets + email" for operational work
(customer issues, incidents, payments, compliance, access requests, tasks). Built for the Newtonite Software
Engineering Challenge, *"Operations Under Pressure"*.

**Stack:** Node 22 + TypeScript (`node:http`, zod, pg) · PostgreSQL 16 only (locks, constraints, job queue, full-text,
trigram, LISTEN/NOTIFY) · React (plain JSX, bundled by esbuild) · tests with `node:test` against a real Postgres.

What makes it more than CRUD (each has an automated test, see [Tests](#tests)):

| # | Behaviour | Where |
|---|---|---|
| 1 | **Atomic claim**: 20 people click "Claim" at once, exactly one wins, the rest get `409 ALREADY_CLAIMED` naming the owner | `claimItem` in `src/server/domain/items.ts` |
| 2 | **Optimistic concurrency**: every edit carries `expectedVersion`; stale edits get `409 VERSION_CONFLICT` with the current state | `assertVersion` in `items.ts` |
| 3 | **Idempotency keys**: retrying the same action returns the original result instead of creating a duplicate | `src/server/domain/idempotency.ts` |
| 4 | **Workflow state machine, enforced on the server**, with reasons, resolution notes and a **four-eyes** approval rule | `src/shared/workflow.ts` |
| 5 | **Resource-level authorization**: per-team roles; an item in a team you are not in is a `404` (no existence leak) | `src/shared/permissions.ts`, SQL filters in `items.ts` |
| 6 | **Atomic audit trail + transactional outbox**: change, history event and background job commit together; a worker (retries, back-off, dead-letter, crash recovery) creates notifications | `events.ts`, `src/server/worker/*` |
| 7 | **UI reconciliation**: optimistic claim/comment, rolled back and explained on `409`; live "changed by someone else" banner over SSE | `web/src/*` |

Plus: a **Needs attention** home driven by six explicit, visible rules; forgotten-item detection by a scheduled job;
duplicate warning when creating an item (trigram similarity); a decision log (reasons are mandatory for reassign /
priority change / reject / reopen / cancel); keyset pagination and indexes verified on 50 000 items
([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

---

## Run it

You need **one** of: Docker Desktop, or Node.js 22+ and a PostgreSQL 16 server.

### Option A — Docker (simplest, nothing else to install)

```bash
docker compose up --build
```

Open **http://localhost:3000**. The first start migrates the database and loads demo data. Stop with `Ctrl+C`;
`docker compose down -v` also deletes the database volume (a clean slate).

> **Verified locally on Windows:** `docker compose up --build` started PostgreSQL, the API, and the worker successfully. The demo login worked, all 29 backend tests passed, and both Playwright browser test suites passed.
### Option B — Node + PostgreSQL on your machine (works on Windows, macOS, Linux)

1. Install Node.js 22+ (`node -v`) and PostgreSQL 16. Create the database (default connection is
   `postgres://postgres:postgres@localhost:5432/opsdesk`):
   - with psql: `psql -U postgres -c "CREATE DATABASE opsdesk"`
   - **or** with Docker only for the database: `docker compose up -d db` (creates `opsdesk` for you).
2. Install, set up and start:

```bash
npm install
npm run migrate        # creates tables, constraints, indexes
npm run seed           # 7 demo users, 4 teams, 12 demo items
npm run build:web      # bundles the React UI into dist/web
npm run dev            # API + worker in one process, auto-restart on changes
```

3. Open **http://localhost:3000**.

Different database? Set `DATABASE_URL` (e.g. PowerShell: `$env:DATABASE_URL="postgres://user:pass@host:5432/db"`;
bash: `export DATABASE_URL=...`). Other settings are in `.env.example` and `src/server/config.ts`.

Production-style start (what Docker does): `npm run build && npm run migrate && node dist/server/main.js`, and the
worker as a separate process: `npm run start:worker`.

### Demo accounts

Password for **all**: `Passw0rd!demo` (also shown on the login page; click an email to fill the form).

| Email | Roles |
|---|---|
| `ananya@kaveri.test` (Ananya Iyer) | admin in Support, Platform and Finance |
| `vikram@kaveri.test` (Vikram Nair) | lead + member in Support |
| `priya@kaveri.test` (Priya Sharma) | member in Support and Platform |
| `rajesh@kaveri.test` (Rajesh Menon) | approver in Finance (approver only: cannot be assigned work) |
| `meera@kaveri.test` (Meera Reddy) | lead + member in Finance, member in Platform |
| `siddharth@kaveri.test` (Siddharth Rao) | member in Platform |
| `zoya@kaveri.test` (Zoya Khan) | member of a 4th team (Legal) only — use to see that other teams' items are invisible |

### A 5-minute tour (shows the hard parts)

1. **Needs attention** (home, as `ananya`): groups such as *Waiting for your approval* and *Urgent and nobody owns it*. Each group shows the
   rule behind it.
2. **Claim race**: open two browsers (one normal, one private window). Log in as `priya` and `siddharth`, open the same unassigned Platform item
   (**New** → create one, or use the list). Priya clicks **Claim it**; then Siddharth (whose page is stale) clicks it too: Siddharth is told who owns it,
   and the page corrects itself. Only one claim is ever recorded in the history.
3. **Live updates**: open the same item as `ananya` in two windows and edit the title in one: the other window refreshes itself within a
   second (server-sent events carry only ids; the browser re-fetches through the authorized API). If the page is ever behind, the UI shows
   "Someone else changed this item" with a Refresh button, and a save on an outdated version shows the conflict banner (see step 8 for the raw API).
4. **Four-eyes approval**: as `meera` open a *payment* item in `pending_approval` that she requested (Items → Status filter): there is no Approve button.
   Log in as `rajesh` and the same item offers **Approve** / **Reject**.
5. **Authorization**: as `zoya` the Platform/Support/Finance items do not exist (404 even if you paste an item URL).
6. **Notifications**: after actions above, the other users' **Notifications** page and badge show them (created asynchronously by the worker).
7. **Duplicate warning**: **New** → type a title similar to an existing open item; a "similar open items" box appears.
8. **Stale edit and idempotency through the raw API** (bash; on Windows use Git Bash or WSL):

```bash
B=http://localhost:3000/api
curl -s -c cj -H 'content-type: application/json' -d '{"email":"ananya@kaveri.test","password":"Passw0rd!demo"}' $B/auth/login >/dev/null
ID=$(curl -s -b cj "$B/items?limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin)['items'][0]['id'])")
V=$(curl -s -b cj $B/items/$ID | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
# two editors who both saw version $V:
curl -s -b cj -X PATCH -H 'content-type: application/json' -d "{\"expectedVersion\":$V,\"title\":\"First editor\"}" $B/items/$ID -o /dev/null -w "%{http_code}\n"   # 200
curl -s -b cj -X PATCH -H 'content-type: application/json' -d "{\"expectedVersion\":$V,\"title\":\"Second editor\"}" $B/items/$ID                # 409 VERSION_CONFLICT + current state
```

   Repeating a `POST /api/items` with the same `Idempotency-Key` header returns `201` the first time and the same body with
   `Idempotent-Replay: true` afterwards (no second item).

---

## Tests

Tests run against a **real PostgreSQL** (concurrency bugs do not show up on mocks). They create and drop their own throw-away
databases (`opsdesk_t_*`), so they need a Postgres user that can create databases (default `postgres`/`postgres` on localhost,
override with `TEST_ADMIN_URL`).

```bash
npm run typecheck      # TypeScript strict mode, no errors expected
npm test               # 29 tests, ~7 s
npm run test:e2e       # optional browser smoke test: login, Needs attention, claim race (see below)
npm run test:e2e:ui    # optional browser test of the redesigned UI: overflow at 3 widths, mobile drawer, dialogs, confirmations
```

| File | What it proves |
|---|---|
| `claim-and-versions.test.ts` | 20-way claim race → one winner; stale version → 409 and nothing written; idempotent create (also 10× concurrent) |
| `workflow.test.ts`, `workflow-and-auth.test.ts` | illegal transitions, required reasons/resolutions, approval-required kinds, four-eyes, 404-not-403 for other teams, role checks, unauthenticated/bad-password |
| `audit-and-worker.test.ts` | failed mutation leaves no event/job; audit log is append-only; notifications are idempotent; retry + back-off → success; dead-letter; crash recovery; two concurrent workers never double-process; stale scan flags once |
| `pagination.test.ts` | keyset paging returns every item exactly once for every sort; search by prefix and `#number` |
| `membership.test.ts` | cannot remove the last admin; removal releases items / is refused when approvals are held; role changes apply on the next request |
| `api-surface.test.ts` | each Needs-attention rule, every remaining endpoint, SSE pushes an id-only message after a commit |

**Browser smoke test** (needs a running, seeded server and Playwright's browser):

```bash
npx playwright install chromium     # once
npm run test:e2e                    # BASE_URL=http://localhost:3000 by default
```

`test:e2e` logs in, checks the Needs-attention groups, has two users open the same item, claims in the UI, and checks that the second user
sees the conflict and that the server recorded exactly one winner.

`test:e2e:ui` (same prerequisites) checks the redesigned interface: a wrong password is explained; no horizontal overflow on the five main
pages at 1280, 820 and 390 px; the phone navigation drawer opens and closes with Esc; a list row opens its item; unavailable actions are
listed with the server's reason; a version conflict is shown *inside* the edit dialog and nothing is overwritten; removing a member needs
a confirmation and Cancel changes nothing; the first Tab stop is the "Skip to content" link. If Playwright cannot find a browser, set
`CHROMIUM_PATH` to a Chromium/Chrome executable (both scripts honour it).

Large-data check: `npm run seed:large` inserts 50 000 items / 500 000 events and prints `EXPLAIN ANALYZE` for the key queries
(results and findings in [docs/PERFORMANCE.md](docs/PERFORMANCE.md)). Run `ANALYZE` afterwards if lists feel slow right after the bulk load.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5432` / tests all fail | PostgreSQL is not running (or `docker compose up -d db`). |
| `database "opsdesk" does not exist` | Create it (step 1 of Option B). |
| `password authentication failed` | Set `DATABASE_URL` with your real credentials; tests use `TEST_ADMIN_URL` (a role that can `CREATE DATABASE`). |
| Blank page / 404 for `app.js` | Run `npm run build:web` (it creates `dist/web`). |
| Port 3000 busy | `PORT=3001 npm run dev` (PowerShell: `$env:PORT=3001; npm run dev`). |
| Want a clean slate | `npm run seed -- --reset` wipes and re-seeds the demo data. |
| `extension "pg_trgm" is not available` | Install PostgreSQL's *contrib* package (it is included in the official Docker image and Windows/macOS installers). |

## Repository map

```
migrations/            001 schema + constraints + indexes, 002 global list indexes
src/shared/            rules shared by server and browser: workflow, permissions, API contract
src/server/            config, db, http (router, errors), auth, domain (items, members, attention, ...), routes,
                       realtime (SSE hub), worker (outbox loop, handlers, stale scan), scripts (migrate, seed)
web/                   React UI (JSX) + styles; built to dist/web by scripts/build-web.mjs
test/                  node:test suites + e2e/ui-smoke.mjs and e2e/ui-redesign.mjs (Playwright)
docs/                  ARCHITECTURE, ENGINEERING_DECISIONS, KNOWN_LIMITATIONS, PERFORMANCE, VIVA_PREP, SPEC (the brief)
```

Start with [docs/ENGINEERING_DECISIONS.md](docs/ENGINEERING_DECISIONS.md), then [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)
(which includes the failure-scenarios table).
