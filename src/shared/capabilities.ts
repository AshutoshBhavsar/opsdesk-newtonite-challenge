// Combines the permission predicates and the workflow table into one "what may this user do
// with this item?" answer. The server enforces the individual rules; the API sends this summary
// to the UI so it only offers actions the server will accept.

import type { Capabilities } from './contract.js';
import { canChangePriority, canClaim, canComment, canEdit, canReassign, canRelease, type Actor, type ItemFacts } from './permissions.js';
import { availableTransitions } from './workflow.js';

export function capabilities(item: ItemFacts, actor: Actor): Capabilities {
  return {
    edit: canEdit(item, actor),
    claim: canClaim(item, actor),
    release: canRelease(item, actor),
    reassign: canReassign(item, actor),
    changePriority: canChangePriority(item, actor),
    comment: canComment(actor.roles),
    transitions: availableTransitions(item, actor),
  };
}
