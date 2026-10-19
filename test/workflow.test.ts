// Pure unit tests of the workflow table (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTransition, availableTransitions, TRANSITIONS } from '../src/shared/workflow.js';
import type { Actor, ItemFacts } from '../src/shared/permissions.js';
import type { Role } from '../src/shared/contract.js';

const actor = (id: string, ...roles: Role[]): Actor => ({ userId: id, roles: new Set(roles) });
const item = (o: Partial<ItemFacts> = {}): ItemFacts => ({ status: 'in_progress', assigneeId: 'w', requesterId: 'r', requiresApproval: false, ...o });

test('illegal transition is 409', () => {
  const v = evaluateTransition(item({ status: 'new', assigneeId: null }), actor('l', 'lead'), 'resolved', {});
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.violation.status, 409);
});

test('resolve needs a resolution; payment needs approval first', () => {
  const w = actor('w', 'member');
  const noRes = evaluateTransition(item(), w, 'resolved', {});
  assert.ok(!noRes.ok && noRes.violation.code === 'RESOLUTION_REQUIRED');
  const pay = evaluateTransition(item({ requiresApproval: true }), w, 'resolved', { resolution: 'done' });
  assert.ok(!pay.ok && pay.violation.code === 'APPROVAL_REQUIRED');
  assert.ok(evaluateTransition(item(), w, 'resolved', { resolution: 'done' }).ok);
});

test('request_approval only for items that require approval', () => {
  const v = evaluateTransition(item(), actor('w', 'member'), 'pending_approval', {});
  assert.ok(!v.ok && v.violation.code === 'APPROVAL_NOT_REQUIRED');
});

test('four-eyes: requester and assignee cannot approve; another approver can', () => {
  const pending = item({ status: 'pending_approval', requiresApproval: true });
  assert.ok(!evaluateTransition(pending, actor('r', 'admin'), 'approved', {}).ok);
  const own = evaluateTransition(pending, actor('w', 'admin'), 'approved', {});
  assert.ok(!own.ok && own.violation.code === 'SEPARATION_OF_DUTIES');
  assert.ok(evaluateTransition(pending, actor('x', 'approver'), 'approved', {}).ok);
});

test('reject and cancel and reopen require a reason', () => {
  const pending = item({ status: 'pending_approval', requiresApproval: true });
  const rej = evaluateTransition(pending, actor('x', 'approver'), 'in_progress', {});
  assert.ok(!rej.ok && rej.violation.code === 'REASON_REQUIRED');
  const cancel = evaluateTransition(item({ status: 'new', assigneeId: null }), actor('l', 'lead'), 'cancelled', {});
  assert.ok(!cancel.ok && cancel.violation.code === 'REASON_REQUIRED');
});

test('buttons offered are exactly the transitions the evaluator accepts', () => {
  const states = ['new', 'triaged', 'in_progress', 'pending_approval', 'approved', 'resolved'] as const;
  const actors = [actor('w', 'member'), actor('l', 'lead'), actor('x', 'approver'), actor('r', 'member'), actor('z')];
  for (const status of states) for (const a of actors) for (const req of [true, false]) {
    const it = item({ status, requiresApproval: req, assigneeId: status === 'new' || status === 'triaged' ? null : 'w' });
    const offered = new Set(availableTransitions(it, a).map((o) => o.to));
    for (const def of TRANSITIONS.filter((t) => t.from === status)) {
      const filled = evaluateTransition(it, a, def.to, { reason: 'because', resolution: 'fixed' });
      const blockedOnlyByAssignee = !filled.ok && filled.violation.code === 'ASSIGNEE_REQUIRED';
      assert.equal(offered.has(def.to), filled.ok || blockedOnlyByAssignee, `${status}->${def.to} for ${[...a.roles].join(',') || 'none'} req=${req}`);
    }
  }
});
