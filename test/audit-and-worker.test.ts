// Critical behaviours 6 (audit atomicity) and the outbox worker: retries, dead letters, crash recovery, duplicates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { as, count, mkItem, startEnv, type TestEnv } from './helpers.js';
import { tx } from '../src/server/db.js';
import { claimItem } from '../src/server/domain/items.js';
import { authenticate } from '../src/server/auth/principal.js';
import { processOnce } from '../src/server/worker/loop.js';
import { handlers } from '../src/server/worker/handlers.js';
import { scanStale } from '../src/server/worker/stale.js';

let env: TestEnv;
before(async () => { env = await startEnv('worker'); });
after(async () => { await env.close(); });

const cfg = { jobVisibilityTimeoutMs: 60_000 };

test('audit atomicity: a failure after the UPDATE leaves no change, no event, no outbox job', async () => {
  const liam = await as(env, 'liam');
  const item = await mkItem(liam, env.teams.Support!);
  const events = await count(env.pool, 'SELECT count(*) n FROM work_item_events');
  const jobs = await count(env.pool, 'SELECT count(*) n FROM outbox_jobs');
  const login = await liam.post('/api/auth/login', { email: 'noor@acme.test', password: 'Passw0rd!demo' });
  const token = login.headers.getSetCookie()[0]!.split(';')[0]!.split('=')[1]!;
  const noor = (await authenticate(env.pool, token))!;
  await assert.rejects(tx(env.pool, async (c) => { await claimItem(c, noor, item.id); throw new Error('boom after claim'); }), /boom/);
  const after = (await liam.get(`/api/items/${item.id}`)).body;
  assert.equal(after.assignee, null);
  assert.equal(after.version, item.version);
  assert.equal(await count(env.pool, 'SELECT count(*) n FROM work_item_events'), events);
  assert.equal(await count(env.pool, 'SELECT count(*) n FROM outbox_jobs'), jobs);
});

test('audit log is append-only; a successful mutation writes exactly one event and one outbox job', async () => {
  const noor = await as(env, 'noor');
  const item = await mkItem(noor, env.teams.Support!);
  const e0 = await count(env.pool, 'SELECT count(*) n FROM work_item_events WHERE item_id=$1', [item.id]);
  const j0 = await count(env.pool, 'SELECT count(*) n FROM outbox_jobs');
  await noor.post(`/api/items/${item.id}/claim`);
  assert.equal(await count(env.pool, 'SELECT count(*) n FROM work_item_events WHERE item_id=$1', [item.id]), e0 + 1);
  assert.equal(await count(env.pool, 'SELECT count(*) n FROM outbox_jobs'), j0 + 1);
  await assert.rejects(env.pool.query('UPDATE work_item_events SET reason = $1 WHERE item_id = $2', ['tamper', item.id]), /append-only/);
  await assert.rejects(env.pool.query('DELETE FROM work_item_events WHERE item_id = $1', [item.id]), /append-only/);
});

test('worker creates one notification per recipient, never for the actor, and is idempotent under duplicate delivery', async () => {
  await env.pool.query(`UPDATE outbox_jobs SET status='done'`);
  const noor = await as(env, 'noor');
  const liam = await as(env, 'liam');
  const item = await mkItem(noor, env.teams.Support!);            // created -> leads (liam, ava)
  await liam.post(`/api/items/${item.id}/comments`, { body: 'looking' }); // comment -> requester noor
  while ((await processOnce(env.pool, cfg)) > 0);
  const forNoor = await count(env.pool, 'SELECT count(*) n FROM notifications WHERE user_id=$1', [env.users.noor]);
  const forLiam = await count(env.pool, 'SELECT count(*) n FROM notifications WHERE user_id=$1', [env.users.liam]);
  assert.equal(forNoor, 1);
  assert.equal(forLiam, 1); // created -> lead; Liam's own comment does not notify Liam
  // duplicate delivery: re-queue every job as pending and run again -> still the same notifications
  await env.pool.query(`UPDATE outbox_jobs SET status='pending', run_at=now(), attempts=0`);
  while ((await processOnce(env.pool, cfg)) > 0);
  assert.equal(await count(env.pool, 'SELECT count(*) n FROM notifications WHERE user_id=$1', [env.users.noor]), forNoor);
  const list = await noor.get('/api/notifications');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 1);
});

test('retry with backoff, then success; dead-letter after max attempts; unknown type dies immediately', async () => {
  await env.pool.query(`UPDATE outbox_jobs SET status='done'`);
  await env.pool.query(`INSERT INTO outbox_jobs (type, payload) VALUES ('flaky', '{}'), ('always_fails', '{}'), ('mystery', '{}')`);
  let flakyCalls = 0;
  const h = {
    flaky: async () => { if (++flakyCalls < 3) throw new Error('transient'); },
    always_fails: async () => { throw new Error('nope'); },
  };
  await processOnce(env.pool, cfg, h);
  const first = (await env.pool.query(`SELECT type, status, attempts, run_at > now() AS delayed, last_error FROM outbox_jobs WHERE status <> 'done' ORDER BY type`)).rows;
  const by = Object.fromEntries(first.map((r: any) => [r.type, r]));
  assert.equal(by.flaky.status, 'pending');
  assert.equal(by.flaky.delayed, true);       // backoff pushed run_at into the future
  assert.equal(by.flaky.attempts, 1);
  assert.equal(by.mystery.status, 'dead');
  for (let i = 0; i < 10; i++) {
    await env.pool.query(`UPDATE outbox_jobs SET run_at = now() WHERE status='pending'`);
    await processOnce(env.pool, cfg, h);
  }
  const final = Object.fromEntries((await env.pool.query(`SELECT type, status, attempts FROM outbox_jobs WHERE type IN ('flaky','always_fails')`)).rows.map((r: any) => [r.type, r]));
  assert.equal(final.flaky.status, 'done');
  assert.equal(final.flaky.attempts, 3);
  assert.equal(final.always_fails.status, 'dead');
  assert.equal(final.always_fails.attempts, 6);
});

test('crash recovery: a job stuck in processing past the visibility timeout is re-queued and finished', async () => {
  await env.pool.query(`UPDATE outbox_jobs SET status='done'`);
  const r = await env.pool.query(`INSERT INTO outbox_jobs (type, status, attempts, locked_at) VALUES ('recovered', 'processing', 1, now() - interval '5 minutes') RETURNING id`);
  let ran = 0;
  await processOnce(env.pool, cfg, { recovered: async () => { ran++; } });
  assert.equal(ran, 1);
  assert.equal((await env.pool.query('SELECT status FROM outbox_jobs WHERE id=$1', [r.rows[0].id])).rows[0].status, 'done');
});

test('two workers polling concurrently never process the same job twice', async () => {
  await env.pool.query(`UPDATE outbox_jobs SET status='done'`);
  await env.pool.query(`INSERT INTO outbox_jobs (type) SELECT 'counted' FROM generate_series(1, 60)`);
  const seen: number[] = [];
  const h = { counted: async (_c: unknown, job: { id: number }) => { seen.push(job.id); } };
  await Promise.all([1, 2, 3, 4].map(async () => { while ((await processOnce(env.pool, cfg, h as never, 5)) > 0); }));
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen).size, 60);
});

test('stale scan flags a quiet item once; activity clears the flag; concurrent scanners do not double-flag', async () => {
  const noor = await as(env, 'noor');
  const item = await mkItem(noor, env.teams.Support!);
  await env.pool.query(`UPDATE work_items SET last_activity_at = now() - interval '5 days' WHERE id = $1`, [item.id]);
  const runs = await Promise.all([scanStale(env.pool, 72), scanStale(env.pool, 72), scanStale(env.pool, 72)]);
  assert.equal(runs.reduce((a, b) => a + b, 0), 1);
  assert.equal(await count(env.pool, `SELECT count(*) n FROM work_item_events WHERE item_id=$1 AND type='stale_flagged'`, [item.id]), 1);
  assert.equal(await scanStale(env.pool, 72), 0);
  assert.equal((await noor.get(`/api/items/${item.id}`)).body.version, item.version); // flagging does not bump version
  await noor.post(`/api/items/${item.id}/comments`, { body: 'still on it' });
  const flag = await env.pool.query('SELECT stale_notified_at FROM work_items WHERE id=$1', [item.id]);
  assert.equal(flag.rows[0].stale_notified_at, null);
  void handlers;
});
