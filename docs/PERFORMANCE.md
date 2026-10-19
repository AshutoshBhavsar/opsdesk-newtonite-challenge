# PERFORMANCE — evidence at 50 000 items / 500 000 events

Measured by agent #4 on PostgreSQL 16.15 (sandbox VM, default config, API + DB on the same machine, warm cache).
Dataset: `npm run seed:large` -> **50 013 work items, 500 027 events**. User = Ananya (admin of 3 teams, so she sees *everything* — the worst case).

## What was measured and what it shows

HTTP round-trip time (`curl -w %{time_total}`, one request, full stack: auth -> principal load -> SQL -> JSON):

| Endpoint | Before migration 002 | After 002 | Notes |
|---|---|---|---|
| `GET /items?limit=25` (default: active, newest activity) | 4 ms | 2 ms | walks `items_active_activity_idx`, stops at LIMIT |
| `GET /items?sort=priority&limit=25` (all my teams) | **48 ms** | **3 ms** | had to sort ~35k active rows (indexes lead with `team_id`) |
| `GET /items?status=all&limit=25` | **62 ms** | **2 ms** | same reason |
| `GET /items?sort=created&limit=25` | **46 ms** | **3 ms** | same reason (index added to 002 afterwards) |
| `GET /items?sort=created&team=<one team>` | – | 2 ms | per-team indexes |
| `GET /items?q=refund` (full-text) | 4 ms | 3 ms | GIN on `search` tsvector |
| `GET /items?assignee=unassigned&priority=urgent` | 4 ms | – | partial index `items_unassigned_idx` |
| `GET /items/:id`, `/items/:id/events`, `/me` | 3 ms | – | primary-key / `(item_id, id)` lookups |
| `GET /notifications` | 106 ms (stale statistics) | 5 ms after `ANALYZE` | see "Findings" 2 |
| `GET /attention` (6 queries in parallel) | 80-120 ms | 80-120 ms | see "Findings" 3 |

## Findings (honest list)

1. **Cross-team ordered lists needed global indexes.** The first design indexed `(team_id, …)` only. A list across *all* of a user's teams has no
   `team_id =` predicate, so Postgres sorted every matching row. Migration `002_global_list_indexes.sql` adds three small indexes
   (`items_active_priority_idx`, `items_activity_idx`, `items_created_idx`). Trade-off: three more indexes to maintain on every write.
2. **Statistics matter after bulk loads.** Right after `seed:large`, the planner chose a merge join over 500k events for `/notifications`
   (68 ms). `ANALYZE` fixed it (5 ms). In production autovacuum's auto-analyze does this; the seed script analyzes after inserting items/events
   but notifications are created later by the worker, so a manual `ANALYZE` may be needed in the demo.
3. **Needs-attention is the slowest endpoint (~100 ms at 50k).** Each group uses `count(*) OVER ()` to report the true total, which forces
   Postgres to visit every matching row, not just the 5 shown. It is still one round trip and well under a second. If it ever hurts: cap the
   count (`LIMIT 1000` subquery -> show "1000+"), or cache per user for a few seconds.
4. Nothing in the API returns unbounded data: lists use keyset pagination (max 100/page), history is a separate paginated endpoint, attention
   returns <= 5 items per group, SSE carries ids only.

## Raw EXPLAIN (ANALYZE, BUFFERS) output from `npm run seed:large` (taken before migration 002)

Reading guide: "Index Scan using items_active_activity_idx ... rows=26" means the first page touched ~26 rows, not 35 000.

```
### default list (all my teams, active, newest activity, first page)
Limit  (cost=0.29..8.75 rows=26 width=24) (actual time=0.010..0.030 rows=26 loops=1)
  Buffers: shared hit=25 read=2
  ->  Index Scan using items_active_activity_idx on work_items i  (cost=0.29..11437.05 rows=35141 width=24) (actual time=0.009..0.028 rows=26 loops=1)
        Filter: (team_id = ANY ('{6534eea4-7fa6-4516-a59f-ff2311f3620b,c4d872c8-723c-44b5-8e82-62fa0fe4b85e,f61d276f-cadc-4141-ac3b-4e6df6785e35,4fdd827f-c5fc-4644-91a0-881f9b669a6d}'::uuid[]))
        Buffers: shared hit=25 read=2
Planning:
  Buffers: shared hit=46 read=2
Planning Time: 0.264 ms
Execution Time: 0.039 ms

### single-team list (first page)
Limit  (cost=0.29..34.29 rows=26 width=24) (actual time=0.010..0.085 rows=26 loops=1)
  Buffers: shared hit=119
  ->  Index Scan using items_active_activity_idx on work_items i  (cost=0.29..11305.28 rows=8645 width=24) (actual time=0.010..0.083 rows=26 loops=1)
        Filter: (team_id = ANY ('{6534eea4-7fa6-4516-a59f-ff2311f3620b}'::uuid[]))
        Rows Removed by Filter: 91
        Buffers: shared hit=119
Planning:
  Buffers: shared hit=1
Planning Time: 0.187 ms
Execution Time: 0.092 ms

### deep keyset page (cursor 30 days back)
Limit  (cost=0.29..9.53 rows=26 width=24) (actual time=0.010..0.025 rows=26 loops=1)
  Buffers: shared hit=27 read=1
  ->  Index Scan using items_active_activity_idx on work_items i  (cost=0.29..11395.95 rows=32091 width=24) (actual time=0.009..0.023 rows=26 loops=1)
        Index Cond: (ROW(last_activity_at, id) < ROW((now() - '30 days'::interval), 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
        Filter: (team_id = ANY ('{6534eea4-7fa6-4516-a59f-ff2311f3620b,c4d872c8-723c-44b5-8e82-62fa0fe4b85e,f61d276f-cadc-4141-ac3b-4e6df6785e35,4fdd827f-c5fc-4644-91a0-881f9b669a6d}'::uuid[]))
        Buffers: shared hit=27 read=1
Planning:
  Buffers: shared hit=10
Planning Time: 0.228 ms
Execution Time: 0.039 ms

### full-text search
Limit  (cost=1337.90..1337.93 rows=14 width=24) (actual time=3.444..3.447 rows=26 loops=1)
  Buffers: shared hit=288 read=294
  ->  Sort  (cost=1337.90..1337.93 rows=14 width=24) (actual time=3.443..3.445 rows=26 loops=1)
        Sort Key: last_activity_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=288 read=294
        ->  Bitmap Heap Scan on work_items i  (cost=1262.52..1337.63 rows=14 width=24) (actual time=2.986..3.393 rows=500 loops=1)
              Recheck Cond: (search @@ '''refund'':* & ''failing'':*'::tsquery)
              Filter: ((team_id = ANY ('{6534eea4-7fa6-4516-a59f-ff2311f3620b,c4d872c8-723c-44b5-8e82-62fa0fe4b85e,f61d276f-cadc-4141-ac3b-4e6df6785e35,4fdd827f-c5fc-4644-91a0-881f9b669a6d}'::uuid[])) AND (status = ANY ('{new,triaged,in_progress,pending_approval,approved}'::text[])))
              Heap Blocks: exact=286
              Buffers: shared hit=288 read=294
              ->  Bitmap Index Scan on items_search_idx  (cost=0.00..1262.52 rows=20 width=0) (actual time=2.960..2.960 rows=500 loops=1)
                    Index Cond: (search @@ '''refund'':* & ''failing'':*'::tsquery)
                    Buffers: shared hit=2 read=294
Planning:
  Buffers: shared hit=11
Planning Time: 0.224 ms
Execution Time: 3.461 ms

### attention: unassigned urgent
Limit  (cost=3234.53..3234.54 rows=5 width=24) (actual time=7.168..7.170 rows=5 loops=1)
  Buffers: shared hit=2513 read=227
  ->  Sort  (cost=3234.53..3241.46 rows=2773 width=24) (actual time=7.167..7.168 rows=5 loops=1)
        Sort Key: created_at, id
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=2513 read=227
        ->  Bitmap Heap Scan on work_items i  (cost=458.91..3188.47 rows=2773 width=24) (actual time=1.693..6.788 rows=5002 loops=1)
              Recheck Cond: ((team_id = ANY ('{6534eea4-7fa6-4516-a59f-ff2311f3620b,c4d872c8-723c-44b5-8e82-62fa0fe4b85e,f61d276f-cadc-4141-ac3b-4e6df6785e35,4fdd827f-c5fc-4644-91a0-881f9b669a6d}'::uuid[])) AND (assignee_id IS NULL) AND (status = ANY ('{new,triaged}'::text[])))
              Filter: (priority = 'urgent'::text)
              Rows Removed by Filter: 17503
              Heap Blocks: exact=2504
              Buffers: shared hit=2513 read=227
              ->  Bitmap Index Scan on items_unassigned_idx  (cost=0.00..458.22 rows=11278 width=0) (actual time=1.453..1.454 rows=22507 loops=1)
                    Index Cond: (team_id = ANY ('{6534eea4-7fa6-4516-a59f-ff2311f3620b,c4d872c8-723c-44b5-8e82-62fa0fe4b85e,f61d276f-cadc-4141-ac3b-4e6df6785e35,4fdd827f-c5fc-4644-91a0-881f9b669a6d}'::uuid[]))
                    Buffers: shared hit=9 read=227
Planning:
  Buffers: shared hit=10
Planning Time: 0.176 ms
Execution Time: 7.181 ms

### duplicate check (trigram)
Limit  (cost=3223.22..3223.23 rows=5 width=20) (actual time=24.475..24.477 rows=5 loops=1)
  Buffers: shared hit=629 read=85
  ->  Sort  (cost=3223.22..3228.68 rows=2183 width=20) (actual time=24.474..24.475 rows=5 loops=1)
        Sort Key: (similarity(title, 'Refund failing for account 7'::text)) DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=629 read=85
        ->  Bitmap Heap Scan on work_items  (cost=493.80..3186.96 rows=2183 width=20) (actual time=0.500..24.348 rows=1158 loops=1)
              Recheck Cond: ((team_id = '6534eea4-7fa6-4516-a59f-ff2311f3620b'::uuid) AND (status = ANY ('{new,triaged,in_progress,pending_approval,approved}'::text[])))
              Filter: (title % 'Refund failing for account 7'::text)
              Rows Removed by Filter: 6346
              Heap Blocks: exact=629
              Buffers: shared hit=629 read=85
              ->  Bitmap Index Scan on items_team_active_activity_idx  (cost=0.00..493.25 rows=8645 width=0) (actual time=0.414..0.414 rows=7505 loops=1)
                    Index Cond: (team_id = '6534eea4-7fa6-4516-a59f-ff2311f3620b'::uuid)
                    Buffers: shared read=85
Planning:
  Buffers: shared hit=25 read=1
Planning Time: 0.567 ms
Execution Time: 24.489 ms
```
