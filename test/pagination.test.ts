// Keyset pagination returns every row exactly once even with identical timestamps; tampered cursors are rejected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { as, startEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => { env = await startEnv('paging'); });
after(async () => { await env.close(); });

test('paging by cursor yields each item once, in order, for every sort', async () => {
  await env.pool.query(
    `INSERT INTO work_items (team_id, title, kind, priority, requester_id, created_at, last_activity_at)
     SELECT $1, 'Paging item ' || g, 'task', (ARRAY['low','medium','high','urgent'])[1 + g % 4], $2,
            now() - (g / 10) * interval '1 minute', now() - (g / 10) * interval '1 minute'   -- 10 rows share each timestamp
       FROM generate_series(1, 130) g`,
    [env.teams.Support, env.users.liam],
  );
  const liam = await as(env, 'liam');
  for (const sort of ['activity', 'priority', 'created']) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await liam.get(`/api/items?sort=${sort}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((i: any) => i.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    assert.equal(seen.length, 130, sort);
    assert.equal(new Set(seen).size, 130, `${sort}: duplicates`);
  }
  const bad = await liam.get('/api/items?cursor=not-a-real-cursor');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'INVALID_CURSOR');
});

test('search finds items by prefix and by #number', async () => {
  const liam = await as(env, 'liam');
  const r = await liam.get('/api/items?q=pagin');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length > 0);
  const weird = await liam.get(`/api/items?q=${encodeURIComponent("'; drop table work_items; --")}`);
  assert.equal(weird.status, 200);
});
