// Types and constants shared by the server and the web app: the API "contract".
// Pure TypeScript, no runtime dependencies, so it can be bundled into the browser as-is.

export const ROLES = ['member', 'lead', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const STATUSES = [
  'new',
  'triaged',
  'in_progress',
  'pending_approval',
  'approved',
  'resolved',
  'closed',
  'cancelled',
] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that still need somebody's attention. Mirrors the partial-index predicates in SQL. */
export const ACTIVE_STATUSES: readonly Status[] = ['new', 'triaged', 'in_progress', 'pending_approval', 'approved'];
export const isActive = (s: Status): boolean => ACTIVE_STATUSES.includes(s);

/** Kinds of work whose outcome carries money, access or legal weight need a second person's approval.
 *  Derived from the kind at creation and then immutable, so a requester cannot opt out. */
export const KIND_REQUIRES_APPROVAL: Record<string, boolean> = {
  customer_issue: false,
  incident: false,
  payment: true,
  compliance: true,
  access_request: true,
  task: false,
};

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const KINDS = ['customer_issue', 'incident', 'payment', 'compliance', 'access_request', 'task'] as const;
export type Kind = (typeof KINDS)[number];

export const EVENT_TYPES = [
  'created',
  'updated',
  'priority_changed',
  'claimed',
  'assigned',
  'released',
  'status_changed',
  'comment',
  'stale_flagged',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  new: 'New',
  triaged: 'Triaged',
  in_progress: 'In progress',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
export const PRIORITY_LABELS: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const KIND_LABELS: Record<Kind, string> = {
  customer_issue: 'Customer issue',
  incident: 'Incident',
  payment: 'Payment',
  compliance: 'Compliance',
  access_request: 'Access request',
  task: 'Task',
};
export const ROLE_LABELS: Record<Role, string> = { member: 'Member', lead: 'Lead', approver: 'Approver', admin: 'Admin' };

// ------------------------------------------------------------------- DTOs ----

export interface UserRef {
  id: string;
  name: string;
}

export interface TransitionOption {
  to: Status;
  action: string;
  label: string;
  /** Extra input the server will require for this transition. */
  needs: Array<'reason' | 'resolution'>;
  tone: 'default' | 'positive' | 'danger';
  /** Set when the transition exists but cannot be done right now (e.g. nobody assigned yet). */
  blocked?: string;
}

/** What the *current user* may do with a specific item. Computed by the server; the UI only renders it. */
export interface Capabilities {
  edit: boolean;
  claim: boolean;
  release: boolean;
  reassign: boolean;
  changePriority: boolean;
  comment: boolean;
  transitions: TransitionOption[];
}

export interface ItemSummary {
  id: string;
  number: number;
  teamId: string;
  teamName: string;
  title: string;
  kind: Kind;
  status: Status;
  priority: Priority;
  requester: UserRef;
  assignee: UserRef | null;
  requiresApproval: boolean;
  dueAt: string | null;
  overdue: boolean;
  version: number;
  lastActivityAt: string;
  createdAt: string;
  /** Cheap per-row flag so the list can offer a one-click "Claim". */
  claimable: boolean;
}

export interface ItemDetail extends Omit<ItemSummary, 'claimable'> {
  description: string;
  resolution: string | null;
  can: Capabilities;
}

export interface TimelineEvent {
  id: number;
  type: EventType;
  actor: UserRef | null;
  data: Record<string, unknown>;
  reason: string | null;
  body: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AttentionGroup {
  key: string;
  title: string;
  /** The explicit rule behind the group, shown to users so nothing feels like magic. */
  rule: string;
  total: number;
  items: ItemSummary[];
}

export interface AttentionResponse {
  summary: { activeInMyTeams: number; assignedToMe: number; requestedByMe: number };
  groups: AttentionGroup[];
}

export interface TeamRef {
  id: string;
  name: string;
  roles: Role[];
}

export interface Me {
  user: { id: string; name: string; email: string };
  teams: TeamRef[];
  unreadNotifications: number;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  roles: Role[];
}

export interface NotificationDto {
  id: number;
  createdAt: string;
  readAt: string | null;
  eventType: EventType;
  eventData: Record<string, unknown>;
  reason: string | null;
  actor: UserRef | null;
  item: { id: string; number: number; title: string };
}

export interface SimilarItem {
  id: string;
  number: number;
  title: string;
  status: Status;
  similarity: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Pushed over the SSE stream. */
export type RealtimeMessage =
  | { kind: 'item'; itemId: string; teamId: string; type: EventType; actorId: string | null; eventId: number }
  | { kind: 'notification'; userIds: string[] }
  | { kind: 'resync' };
