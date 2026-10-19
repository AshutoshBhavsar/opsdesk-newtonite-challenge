// Surface test: every endpoint is called at least once on a clean database, and the home-screen ("Needs
// attention") rules are checked per role. Written after a real first run found that /api/attention returned 500.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { as, mkItem, startEnv, type TestEnv } from './helpers.js';
import { processOnce } from '../src/server/worker/loop.js';

let env: TestEnv;
before(async () => { env = await startEnv('surface'); });
after(async () => { await env.close(); });

const groupKeys = (body: any): string[] => body.groups.map((g: any) => g.key);

test('attention: each rule group shows up for the right role, with items from the right teams only', async () => {
  const liam = await as(env, 'liam'); // lead + member in Support
  const raj = await as(env, 'raj'); // approver in Finance
  const zoe = await as(env, 'zoe'); // member in Legal only
  const mei = await as(env, 'mei');

  const urgent = await mkItem(liam, env.teams.Support!, { priority: 'urgent', title: 'Urgent unowned thing' });
  const payment = await mkItem(mei, env.teams.Finance!, { kind: 'payment', title: 'Pay the vendor invoice' });
  let v = (await mei.post(`/api/items/${payment.id}/claim`)).body;
  v = (await mei.post(`/api/items/${payment.id}/transition`, { expectedVersion: v.version, to: 'in_progress' })).body;
  v = (await mei.post(`/api/items/${payment.id}/transition`, { expectedVersion: v.version, to: 'pending_approval' })).body;
  assert.equal(v.status, 'pending_approval');

  const l = await liam.get('/api/attention');
  assert.equal(l.status, 200);
  assert.ok(groupKeys(l.body).includes('urgent_unassigned'));
  assert.ok(groupKeys(l.body).includes('needs_triage'));
  assert.ok(!JSON.stringify(l.body).includes(payment.id), 'a Support lead must never see a Finance item');

  const r = await raj.get('/api/attention');
  assert.equal(r.status, 200);
  const approvals = r.body.groups.find((g: any) => g.key === 'approvals');
  assert.ok(approvals, 'the approver sees the pending approval');
  assert.deepEqual(approvals.items.map((i: any) => i.id), [payment.id]);

  const mei2 = await mei.get('/api/attention');
  assert.ok(!groupKeys(mei2.body).includes('approvals'), 'the requester does not see her own request as an approval');

  const z = await zoe.get('/api/attention');
  assert.equal(z.status, 200);
  assert.ok(!JSON.stringify(z.body).includes(urgent.id));
  assert.deepEqual(z.body.summary, { activeInMyTeams: 0, assignedToMe: 0, requestedByMe: 0 });
});

test('attention: going quiet and overdue-and-mine', async () => {
  const noor = await as(env, 'noor');
  const it = await mkItem(noor, env.teams.Support!, { title: 'Old quiet item' });
  const c = (await noor.post(`/api/items/${it.id}/claim`)).body;
  await noor.post(`/api/items/${it.id}/transition`, { expectedVersion: c.version, to: 'in_progress' });
  await env.pool.query("UPDATE work_items SET last_activity_at = now() - interval '100 hours', due_at = now() - interval '1 hour' WHERE id = $1", [it.id]);
  const a = await noor.get('/api/attention');
  assert.equal(a.status, 200);
  assert.ok(groupKeys(a.body).includes('going_quiet'));
  assert.ok(groupKeys(a.body).includes('overdue_mine'));
});

test('every remaining endpoint answers sensibly: similar, events, comments, release, assign, priority, notifications, members', async () => {
  const liam = await as(env, 'liam');
  const noor = await as(env, 'noor');
  const item = await mkItem(liam, env.teams.Support!, { title: 'Customer cannot log in after password reset' });

  const sim = await liam.get(`/api/items/similar?teamId=${env.teams.Support}&title=${encodeURIComponent('Customer cannot log in after password reset!')}`);
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.ok(sim.body.some((s: any) => s.id === item.id));

  const cm = await noor.post(`/api/items/${item.id}/comments`, { body: 'Looking into this' });
  assert.equal(cm.status, 201, JSON.stringify(cm.body));

  const claimed = await noor.post(`/api/items/${item.id}/claim`);
  assert.equal(claimed.status, 200);
  const rel = await noor.post(`/api/items/${item.id}/release`, { expectedVersion: claimed.body.version });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  const asg = await liam.post(`/api/items/${item.id}/assign`, { expectedVersion: rel.body.version, assigneeId: env.users.noor, reason: 'Noor knows this system' });
  assert.equal(asg.status, 200, JSON.stringify(asg.body));
  const pri = await liam.post(`/api/items/${item.id}/priority`, { expectedVersion: asg.body.version, priority: 'high', reason: 'Customer is blocked' });
  assert.equal(pri.status, 200, JSON.stringify(pri.body));
  const upd = await liam.patch(`/api/items/${item.id}`, { expectedVersion: pri.body.version, title: 'Customer cannot log in (reset)' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));

  const ev = await liam.get(`/api/items/${item.id}/events`);
  assert.equal(ev.status, 200);
  const types = ev.body.items.map((e: any) => e.type);
  for (const t of ['created', 'comment', 'claimed', 'released', 'assigned', 'priority_changed', 'updated']) assert.ok(types.includes(t), `timeline lacks ${t}: ${types}`);

  while ((await processOnce(env.pool, env.config)) > 0);
  const n = await noor.get('/api/notifications');
  assert.equal(n.status, 200, JSON.stringify(n.body));
  assert.ok(n.body.items.length >= 1, 'Noor was assigned work, so she has a notification');
  const me1 = await noor.get('/api/me');
  assert.ok(me1.body.unreadNotifications >= 1);
  assert.equal((await noor.post('/api/notifications/read', {})).status, 204);
  assert.equal((await noor.get('/api/me')).body.unreadNotifications, 0);

  const members = await liam.get(`/api/teams/${env.teams.Support}/members`);
  assert.equal(members.status, 200);
  assert.ok(members.body.some((m: any) => m.email === 'liam@acme.test'));
});

test('SSE stream: connects, and a committed change is pushed as an id-only message', async () => {
  const noor = await as(env, 'noor');
  const ac = new AbortController();
  const res = await fetch(`${env.base}/api/stream`, { headers: { Cookie: noor.cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += dec.decode(value); } } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 300));
  await mkItem(noor, env.teams.Support!, { title: 'Triggers a push message' });
  for (let i = 0; i < 30 && !seen.includes('"kind":"item"'); i++) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await pump;
  assert.ok(seen.includes('"kind":"item"'), `no item message received; got: ${seen.slice(0, 300)}`);
  assert.ok(!seen.includes('Triggers a push message'), 'push messages carry ids only, never content');
});
