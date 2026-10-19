// Authorization rules as pure functions. The server calls these to ENFORCE; the API also returns the
// result to the UI (Capabilities) so the interface can only offer what the server will accept.
// Roles are per team; a user's permissions in a team are the union of the roles they hold there.

import { isActive, type Role, type Status } from './contract.js';

export interface ItemFacts {
  status: Status;
  assigneeId: string | null;
  requesterId: string;
  requiresApproval: boolean;
}

export interface Actor {
  userId: string;
  /** The actor's roles in the item's team. */
  roles: ReadonlySet<Role>;
}

export const isLead = (r: ReadonlySet<Role>): boolean => r.has('lead') || r.has('admin');
export const isApprover = (r: ReadonlySet<Role>): boolean => r.has('approver') || r.has('admin');
/** May be assigned work items. Approver-only users are deliberately excluded (separation of duties). */
export const canWork = (r: ReadonlySet<Role>): boolean => r.has('member') || r.has('lead') || r.has('admin');
export const canCreate = (r: ReadonlySet<Role>): boolean => r.size > 0;
export const canComment = (r: ReadonlySet<Role>): boolean => r.size > 0;
export const canManageMembers = (r: ReadonlySet<Role>): boolean => r.has('admin');

/** Statuses in which an unassigned item may be claimed (in-flight statuses always have an assignee). */
const CLAIMABLE: readonly Status[] = ['new', 'triaged'];
/** Statuses in which the assignee may step away. in_progress falls back to triaged. */
export const RELEASABLE: readonly Status[] = ['new', 'triaged', 'in_progress'];

export function canClaim(item: ItemFacts, actor: Actor): boolean {
  return canWork(actor.roles) && item.assigneeId === null && CLAIMABLE.includes(item.status);
}

export function canRelease(item: ItemFacts, actor: Actor): boolean {
  if (item.assigneeId === null || !RELEASABLE.includes(item.status)) return false;
  return isLead(actor.roles) || (item.assigneeId === actor.userId && canWork(actor.roles));
}

export function canEdit(item: ItemFacts, actor: Actor): boolean {
  if (!isActive(item.status)) return false;
  if (isLead(actor.roles)) return true;
  return canCreate(actor.roles) && (item.requesterId === actor.userId || item.assigneeId === actor.userId);
}

export const canReassign = (item: ItemFacts, actor: Actor): boolean => isActive(item.status) && isLead(actor.roles);
export const canChangePriority = (item: ItemFacts, actor: Actor): boolean => isActive(item.status) && isLead(actor.roles);
