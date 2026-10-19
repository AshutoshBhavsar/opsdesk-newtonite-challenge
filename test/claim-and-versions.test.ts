// Critical behaviours 1-3: atomic claim, optimistic concurrency, idempotency keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { as, count, mkItem, passwordHash, startEnv, uniqueKey, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => { env = await startEnv('claim'); });
after(async () => { await env.close(); });

test('claim race: 20 concurrent claims -> exactly one winner, 19 x 409 ALREADY_CLAIMED', async () => {
  const hash = await passwordHash();
  const emails: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await env.pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [`w${i}@acme.test`, `Worker ${i}`, hash]);
    await env.pool.query(`INSERT INTO memberships (team_id, user_id, role) VALUES ($1,$2,'member')`, [env.teams.Support, r.rows[0].id]);
    emails.push(`w${i}@acme.test`);
  }
  const liam = await as(env, 'liam');
  const item = await mkItem(liam, env.teams.Support!);
  const { Client } = await import('./helpers.js');
  const workers = await Promise.all(emails.map((e) => new Client(env.base, e).login()));
  const results = await Promise.all(workers.map((w) => w.post(`/api/items/${item.id}/claim`)));
  const wins = results.filter((r) => r.status === 200);
  const losses = results.filter((r) => r.status === 409);
  assert.equal(wins.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(losses.length, 19);
  assert.ok(losses.every((r) => r.body.error.code === 'ALREADY_CLAIMED' && r.body.error.details.assignee.name));
  assert.equal(await count(env.pool, `SELECT count(*) n FROM work_item_events WHERE item_id=$1 AND type='claimed'`, [item.id]), 1);
  assert.equal((await liam.get(`/api/items/${item.id}`)).body.version, 2);
});

test('stale version: second editor gets 409 VERSION_CONFLICT with current state; nothing is written', async () => {
  const liam = await as(env, 'liam');
  const noor = await as(env, 'noor');
  const item = await mkItem(noor, env.teams.Support!, { title: 'Original title' });
  const a = await liam.patch(`/api/items/${item.id}`, { expectedVersion: 1, title: 'Liam edit' });
  assert.equal(a.status, 200);
  assert.equal(a.body.version, 2);
  const b = await noor.patch(`/api/items/${item.id}`, { expectedVersion: 1, title: 'Noor edit' });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'VERSION_CONFLICT');
  assert.equal(b.body.error.details.current.version, 2);
  assert.equal(b.body.error.details.current.title, 'Liam edit');
  assert.equal((await noor.get(`/api/items/${item.id}`)).body.title, 'Liam edit');
});

test('idempotent create: same key (also 10x concurrently) -> one item, replays flagged; other body -> 422; failure leaves key unused', async () => {
  const noor = await as(env, 'noor');
  const key = uniqueKey();
  const body = { teamId: env.teams.Support, title: 'Idempotent request', kind: 'task' };
  const first = await noor.post('/api/items', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  const again = await noor.post('/api/items', body, { 'Idempotency-Key': key });
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal(again.body.id, first.body.id);
  assert.equal(await count(env.pool, `SELECT count(*) n FROM work_items WHERE title='Idempotent request'`), 1);

  const key2 = uniqueKey();
  const burst = await Promise.all(Array.from({ length: 10 }, () => noor.post('/api/items', { ...body, title: 'Burst request' }, { 'Idempotency-Key': key2 })));
  assert.ok(burst.every((r) => r.status === 201), JSON.stringify(burst.map((r) => r.status)));
  assert.equal(new Set(burst.map((r) => r.body.id)).size, 1);
  assert.equal(await count(env.pool, `SELECT count(*) n FROM work_items WHERE title='Burst request'`), 1);

  const diff = await noor.post('/api/items', { ...body, title: 'Different body' }, { 'Idempotency-Key': key });
  assert.equal(diff.status, 422);
  assert.equal(diff.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

  // A failing request must not consume the key: the same key succeeds once the problem is fixed.
  const key3 = uniqueKey();
  const bad = await noor.post('/api/items', { teamId: env.teams.Legal, title: 'Wrong team', kind: 'task' }, { 'Idempotency-Key': key3 });
  assert.equal(bad.status, 404);
  assert.equal(await count(env.pool, 'SELECT count(*) n FROM idempotency_keys WHERE key=$1', [key3]), 0);
});
