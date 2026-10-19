// Membership rules: last admin protected, removal releases work, approvals block removal, changes apply immediately.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { as, mkItem, startEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => { env = await startEnv('members'); });
after(async () => { await env.close(); });

test('only admins manage members; the last admin cannot be removed', async () => {
  const noor = await as(env, 'noor');
  const ava = await as(env, 'ava');
  assert.equal((await noor.put(`/api/teams/${env.teams.Support}/members`, { email: 'noor@acme.test', roles: ['admin'] })).status, 403);
  const last = await ava.put(`/api/teams/${env.teams.Support}/members`, { email: 'ava@acme.test', roles: ['member'] });
  assert.equal(last.status, 409);
  assert.equal(last.body.error.code, 'LAST_ADMIN');
  assert.equal((await ava.put(`/api/teams/${env.teams.Support}/members`, { email: 'nobody@acme.test', roles: ['member'] })).body.error.code, 'USER_NOT_FOUND');
});

test('removing a member releases their releasable items and the change applies on the very next request', async () => {
  const ava = await as(env, 'ava');
  const noor = await as(env, 'noor');
  const item = await mkItem(noor, env.teams.Support!);
  const claimed = (await noor.post(`/api/items/${item.id}/claim`)).body;
  await noor.post(`/api/items/${item.id}/transition`, { expectedVersion: claimed.version, to: 'in_progress' });
  const r = await ava.put(`/api/teams/${env.teams.Support}/members`, { email: 'noor@acme.test', roles: [] });
  assert.equal(r.status, 200);
  assert.ok(!r.body.some((m: any) => m.email === 'noor@acme.test'));
  assert.equal((await noor.get(`/api/items/${item.id}`)).status, 404); // lost access immediately
  const after = (await ava.get(`/api/items/${item.id}`)).body;
  assert.equal(after.assignee, null);
  assert.equal(after.status, 'triaged');
});

test('a member holding a pending-approval item cannot be removed (MEMBER_HAS_WORK)', async () => {
  const ava = await as(env, 'ava');
  const mei = await as(env, 'mei');
  const p = await mkItem(mei, env.teams.Finance!, { kind: 'payment' });
  let v = (await mei.post(`/api/items/${p.id}/claim`)).body;
  v = (await mei.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'in_progress' })).body;
  await mei.post(`/api/items/${p.id}/transition`, { expectedVersion: v.version, to: 'pending_approval' });
  const r = await ava.put(`/api/teams/${env.teams.Finance}/members`, { email: 'mei@acme.test', roles: [] });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'MEMBER_HAS_WORK');
});
