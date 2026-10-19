// The work-item workflow as DATA plus a pure evaluator. One table answers every question:
// "is this move legal?", "who may do it?", "what input must they give?", "which buttons to show?".
//
//   new ─► triaged ─► in_progress ─► resolved ─► closed
//    │        │         │   ▲  ╲                  │
//    │        │         ▼   │   ─► pending_approval│ (only if requires_approval)
//    │        │   pending_approval ─► approved ─► resolved
//    └────────┴────────────► cancelled        resolved ─► in_progress (reopen)

import type { Status, TransitionOption } from './contract.js';
import { isApprover, isLead, canWork, type Actor, type ItemFacts } from './permissions.js';

type Who = 'lead' | 'worker' | 'requester' | 'approver';

export interface TransitionDef {
  from: Status;
  to: Status;
  action: string;
  label: string;
  tone: TransitionOption['tone'];
  /** Any one of these grants the move. `worker` = the current assignee. */
  allow: Who[];
  needs: Array<'reason' | 'resolution'>;
  /** Four-eyes rule: the actor may be neither the requester nor the assignee. */
  separation?: boolean;
  /** Returns a violation when item state forbids the move. */
  guard?: (item: ItemFacts) => Violation | null;
  /** The target status is only valid with an assignee (also enforced by a DB CHECK constraint). */
  needsAssignee?: boolean;
}

export interface Violation {
  status: 403 | 409 | 422;
  code: string;
  message: string;
}

const needsApprovalFlow = (item: ItemFacts): Violation | null =>
  item.requiresApproval ? null : { status: 422, code: 'APPROVAL_NOT_REQUIRED', message: 'This item does not require approval.' };
const mustBeApprovedFirst = (item: ItemFacts): Violation | null =>
  item.requiresApproval ? { status: 422, code: 'APPROVAL_REQUIRED', message: 'This item requires approval before it can be resolved.' } : null;

export const TRANSITIONS: readonly TransitionDef[] = [
  { from: 'new', to: 'triaged', action: 'triage', label: 'Mark as triaged', tone: 'default', allow: ['lead'], needs: [] },
  { from: 'new', to: 'in_progress', action: 'start', label: 'Start work', tone: 'default', allow: ['worker', 'lead'], needs: [], needsAssignee: true },
  { from: 'triaged', to: 'in_progress', action: 'start', label: 'Start work', tone: 'default', allow: ['worker', 'lead'], needs: [], needsAssignee: true },
  { from: 'in_progress', to: 'pending_approval', action: 'request_approval', label: 'Request approval', tone: 'default', allow: ['worker', 'lead'], needs: [], guard: needsApprovalFlow },
  { from: 'in_progress', to: 'resolved', action: 'resolve', label: 'Resolve', tone: 'positive', allow: ['worker', 'lead'], needs: ['resolution'], guard: mustBeApprovedFirst },
  { from: 'pending_approval', to: 'approved', action: 'approve', label: 'Approve', tone: 'positive', allow: ['approver'], needs: [], separation: true },
  { from: 'pending_approval', to: 'in_progress', action: 'reject', label: 'Reject', tone: 'danger', allow: ['approver'], needs: ['reason'], separation: true },
  { from: 'approved', to: 'resolved', action: 'resolve', label: 'Resolve', tone: 'positive', allow: ['worker', 'lead'], needs: ['resolution'] },
  { from: 'resolved', to: 'closed', action: 'close', label: 'Confirm & close', tone: 'positive', allow: ['requester', 'lead'], needs: [] },
  { from: 'resolved', to: 'in_progress', action: 'reopen', label: 'Reopen', tone: 'default', allow: ['requester', 'worker', 'lead'], needs: ['reason'] },
  // Cancel: the requester may withdraw an item nobody has started; later only leads can.
  { from: 'new', to: 'cancelled', action: 'cancel', label: 'Cancel item', tone: 'danger', allow: ['lead', 'requester'], needs: ['reason'] },
  { from: 'triaged', to: 'cancelled', action: 'cancel', label: 'Cancel item', tone: 'danger', allow: ['lead', 'requester'], needs: ['reason'] },
  { from: 'in_progress', to: 'cancelled', action: 'cancel', label: 'Cancel item', tone: 'danger', allow: ['lead'], needs: ['reason'] },
  { from: 'pending_approval', to: 'cancelled', action: 'cancel', label: 'Cancel item', tone: 'danger', allow: ['lead'], needs: ['reason'] },
  { from: 'approved', to: 'cancelled', action: 'cancel', label: 'Cancel item', tone: 'danger', allow: ['lead'], needs: ['reason'] },
];

export function findTransition(from: Status, to: Status): TransitionDef | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

function holds(who: Who, item: ItemFacts, actor: Actor): boolean {
  switch (who) {
    case 'lead':
      return isLead(actor.roles);
    case 'worker':
      return item.assigneeId === actor.userId && canWork(actor.roles);
    case 'requester':
      return item.requesterId === actor.userId;
    case 'approver':
      return isApprover(actor.roles);
  }
}

const allowedFor = (def: TransitionDef, item: ItemFacts, actor: Actor): boolean => def.allow.some((w) => holds(w, item, actor));
const separationOk = (def: TransitionDef, item: ItemFacts, actor: Actor): boolean =>
  !def.separation || (actor.userId !== item.requesterId && actor.userId !== item.assigneeId);

export interface TransitionInput {
  reason?: string | undefined;
  resolution?: string | undefined;
}

export type Evaluation = { ok: true; def: TransitionDef } | { ok: false; violation: Violation };

/**
 * Decide whether `actor` may move `item` to `to`. Check order matters for the HTTP status returned:
 * state (409) → permission (403) → separation of duties (403) → business guards (422) → required input (422).
 */
export function evaluateTransition(item: ItemFacts, actor: Actor, to: Status, input: TransitionInput): Evaluation {
  const def = findTransition(item.status, to);
  if (!def) {
    return { ok: false, violation: { status: 409, code: 'INVALID_TRANSITION', message: `An item that is "${item.status}" cannot move to "${to}".` } };
  }
  if (!allowedFor(def, item, actor)) {
    return { ok: false, violation: { status: 403, code: 'FORBIDDEN', message: `You are not allowed to ${def.label.toLowerCase()} this item.` } };
  }
  if (!separationOk(def, item, actor)) {
    return {
      ok: false,
      violation: { status: 403, code: 'SEPARATION_OF_DUTIES', message: 'Approvals need a second pair of eyes: you cannot decide on an item you requested or are assigned to.' },
    };
  }
  const guard = def.guard?.(item);
  if (guard) return { ok: false, violation: guard };
  if (def.needsAssignee && item.assigneeId === null) {
    return { ok: false, violation: { status: 422, code: 'ASSIGNEE_REQUIRED', message: 'Assign the item to someone before starting work.' } };
  }
  if (def.needs.includes('resolution') && !input.resolution?.trim()) {
    return { ok: false, violation: { status: 422, code: 'RESOLUTION_REQUIRED', message: 'Describe how the item was resolved.' } };
  }
  if (def.needs.includes('reason') && !input.reason?.trim()) {
    return { ok: false, violation: { status: 422, code: 'REASON_REQUIRED', message: 'A reason is required for this decision.' } };
  }
  return { ok: true, def };
}

/** The moves to show as buttons for this actor right now. Blocked ones carry an explanation. */
export function availableTransitions(item: ItemFacts, actor: Actor): TransitionOption[] {
  const out: TransitionOption[] = [];
  for (const def of TRANSITIONS) {
    if (def.from !== item.status) continue;
    if (!allowedFor(def, item, actor) || !separationOk(def, item, actor)) continue;
    if (def.guard?.(item)) continue;
    const option: TransitionOption = { to: def.to, action: def.action, label: def.label, needs: [...def.needs], tone: def.tone };
    if (def.needsAssignee && item.assigneeId === null) option.blocked = 'Assign or claim the item first';
    out.push(option);
  }
  return out;
}
