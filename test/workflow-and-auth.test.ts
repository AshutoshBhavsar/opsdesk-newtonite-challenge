// Critical behaviours 4-5 over HTTP: server-enforced workflow, four-eyes, resource-level authorization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { as, mkItem, startEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => { env = await startEnv('wfauth'); });
after(async () => { await env.close(); });

const err = (r: { body: any }) => r.body.error.code as string;

test('workflow rules are enforced by the server', async () => {
  const noor = await as(env, 'noor');
  const t = await mkItem(noor, env.teams.Support!);
  assert.equal(t.status, 'new');
  const illegal = await noor.post(`/api/items/${t.id}/transition`, { expectedVersion: t.version, to: 'resolved', resolution: 'x' });
  assert.equal(illegal.status, 409);
  assert.equal(err(illegal), 'INVALID_TRANSITION');

  const claimed = (await noor.post(`/api/items/${t.id}/claim`)).body;
  const started = (await noor.post(`/api/items/${t.id}/transition`, { expectedVersion: claimed.version, to: 'in_progress' })).body;
  assert.equal(started.status, 'in_progress');

  const noRes = await noor.post(`/api/items/${t.id}/transition`, { expectedVersion: started.version, to: 'resolved' });
  assert.equal(noRes.status, 422);
  assert.equal(err(noRes), 'RESOLUTION_REQUIRED');
  const notApprovalKind = await noor.post(`/api/items/${t.id}/transition`, { expectedVersion: started.version, to: 'pending_approval' });
  assert.equal(err(notApprovalKind), 'APPROVAL_NOT_REQUIRED');
  const ok = await noor.post(`/api/items/${t.id}/transition`, { expectedVersion: started.version, to: 'resolved', resolution: 'Fixed it' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.resolution, 'Fixed it');
});

test('payment: cannot resolve without approval; four-eyes; reject needs reason; second approver succeeds', async () => {
  const mei = await as(env, 'mei');
  const ava = await as(env, 'ava');
  const raj = await as(env, 'raj');
  const p = await mkItem(mei, env.teams.Finance!, { kind: 'payment', title: 'Pay vendor invoice 1' });
  assert.equal(p.requiresApproval, true);
  let v = (await ava.post(`/api/items/${p.id}/claim`)).body; // Ava (admin) takes it, Mei is the requester
  v = (await ava.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'in_progress' })).body;
  const early = await ava.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'resolved', resolution: 'paid' });
  assert.equal(early.status, 422);
  assert.equal(err(early), 'APPROVAL_REQUIRED');
  v = (await ava.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'pending_approval' })).body;
  assert.equal(v.status, 'pending_approval');

  const own = await ava.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'approved' });
  assert.equal(own.status, 403);
  assert.equal(err(own), 'SEPARATION_OF_DUTIES'); // assignee may not approve
  const byRequester = await mei.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'approved' });
  assert.equal(byRequester.status, 403); // requester is not an approver at all

  const rejectNoReason = await raj.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'in_progress' });
  assert.equal(err(rejectNoReason), 'REASON_REQUIRED');
  const approved = await raj.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
});

test('resource-level authorization: outsiders get 404 everywhere, roles are enforced', async () => {
  const noor = await as(env, 'noor');
  const zoe = await as(env, 'zoe');
  const raj = await as(env, 'raj');
  const liam = await as(env, 'liam');
  const item = await mkItem(noor, env.teams.Support!);

  for (const [m, path, body] of [
    ['GET', `/api/items/${item.id}`, undefined],
    ['GET', `/api/items/${item.id}/events`, undefined],
    ['POST', `/api/items/${item.id}/claim`, {}],
    ['POST', `/api/items/${item.id}/comments`, { body: 'hi' }],
    ['POST', `/api/items/${item.id}/transition`, { expectedVersion: 1, to: 'triaged' }],
    ['PATCH', `/api/items/${item.id}`, { expectedVersion: 1, title: 'hacked' }],
  ] as const) {
    const r = await zoe.call(m, path, body);
    assert.equal(r.status, 404, `${m} ${path}`);
  }
  assert.equal((await zoe.post('/api/items', { teamId: env.teams.Support, title: 'Not my team', kind: 'task' })).status, 404);
  assert.equal((await zoe.get(`/api/items?team=${env.teams.Support}`)).status, 404);
  assert.equal((await zoe.get('/api/items')).body.items.every((i: any) => i.teamId === env.teams.Legal), true);

  // approver-only user cannot take on work; plain members cannot reassign or reprioritise
  const fin = await mkItem(await as(env, 'mei'), env.teams.Finance!);
  assert.equal((await raj.post(`/api/items/${fin.id}/claim`)).status, 403);
  assert.equal((await noor.post(`/api/items/${item.id}/priority`, { expectedVersion: item.version, priority: 'urgent', reason: 'because' })).status, 403);
  assert.equal((await noor.post(`/api/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: env.users.noor, reason: 'because' })).status, 403);
  // a lead can; and the decision (with reason) lands in the timeline
  const prio = await liam.post(`/api/items/${item.id}/priority`, { expectedVersion: item.version, priority: 'urgent', reason: 'customer is blocked' });
  assert.equal(prio.status, 200);
  const events = (await liam.get(`/api/items/${item.id}/events`)).body.items;
  assert.ok(events.some((e: any) => e.type === 'priority_changed' && e.reason === 'customer is blocked'));
});

test('unauthenticated requests are rejected; wrong password is 401', async () => {
  const anon = await (await import('./helpers.js')).Client.prototype.call.call({ base: env.base, cookie: '' }, 'GET', '/api/items');
  assert.equal(anon.status, 401);
  const bad = await new (await import('./helpers.js')).Client(env.base, 'noor@acme.test').call('POST', '/api/auth/login', { email: 'noor@acme.test', password: 'nope' });
  assert.equal(bad.status, 401);
});
