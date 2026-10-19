import { useEffect, useId, useRef, useState } from 'react';
import { PRIORITY_LABELS, STATUS_LABELS, KIND_LABELS } from '../../src/shared/contract.ts';
import { go } from './hooks.js';

// ----------------------------------------------------------------- time ----
export const ago = (iso) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
/** Display-only: DD/MM/YYYY, hh:mm AM/PM IST (Asia/Kolkata). Stored and API timestamps stay UTC ISO strings. */
const IST_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
export const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  const p = Object.fromEntries(IST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()} IST`;
};
/** A <input type="datetime-local"> value is a wall-clock time; read it as India time so it matches what `when` shows. */
export const istInputToISO = (v) => new Date(`${v.length === 16 ? `${v}:00` : v}+05:30`).toISOString();
/** "in 3d" / "2h overdue" — relative, with the exact time available in a tooltip. */
export const dueLabel = (iso) => {
  const ms = new Date(iso).getTime() - Date.now();
  const mins = Math.abs(ms) / 60000;
  const t = mins < 60 ? `${Math.max(1, Math.round(mins))}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return ms < 0 ? `${t} overdue` : `in ${t}`;
};
const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

// ---------------------------------------------------------------- icons ----
const ICONS = {
  attention: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16h.01" /></>,
  items: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  bell: <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2.2.7 3.5 2.7 3.5 5.5" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  logout: <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>,
};
export const Icon = ({ name, size = 18 }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {ICONS[name]}
  </svg>
);

// ---------------------------------------------------------- small pieces ----
export const Avatar = ({ name }) => <span className="avatar" aria-hidden="true">{initials(name)}</span>;
export const Person = ({ user }) => (user ? <span className="person"><Avatar name={user.name} /><span>{user.name}</span></span> : <span className="unassigned">Unassigned</span>);

/** Status / priority / kind label. Text stays neutral; a small dot carries the colour so it is never colour-only. */
export const Badge = ({ kind, value }) => (
  <span className={`badge ${kind}-${value}`}>
    <span className="dot" aria-hidden="true" />
    {(kind === 'status' ? STATUS_LABELS : kind === 'priority' ? PRIORITY_LABELS : KIND_LABELS)[value] ?? value}
  </span>
);

/** Shows the server's message; for validation errors also lists each field problem. */
export const ErrorBox = ({ error }) => {
  if (!error) return null;
  const issues = Array.isArray(error.details) && error.details.every((d) => d && typeof d.message === 'string') ? error.details : null;
  return (
    <div role="alert" className="error">
      {issues ? 'Please fix the following:' : error.message}
      {issues && <ul>{issues.map((d, i) => <li key={i}>{d.path ? <strong>{d.path}: </strong> : null}{d.message}</li>)}</ul>}
    </div>
  );
};

export function Loading({ rows = 4 }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => <i key={i} />)}
    </div>
  );
}

export const EmptyState = ({ title, children, bordered = true }) => (
  <div className={`empty${bordered ? ' bordered' : ''}`}>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
  </div>
);

export function Banner({ tone = 'info', children, action }) {
  return (
    <div className={`banner ${tone}`} role="status">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, documentTitle }) {
  useEffect(() => { document.title = `${documentTitle ?? title} · OpsDesk`; }, [documentTitle, title]);
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

// -------------------------------------------------------------- dialogs ----
/** Accessible modal on the native <dialog>: focus is trapped by the browser, Esc and a backdrop click close it. */
export function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby={titleId} onClick={(e) => { if (e.target === ref.current) ref.current.close(); }}>
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close dialog" onClick={() => ref.current?.close()}><Icon name="x" /></button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}

/** Confirmation for consequential actions. `onConfirm` resolves true on success (the dialog then closes). */
export function ConfirmDialog({ title, children, confirmLabel = 'Confirm', tone, onConfirm, onClose, error }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const ok = await onConfirm();
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="dialog-note">{children}</div>
      <ErrorBox error={error} />
      <div className="dialog-foot">
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        <button type="button" className={tone === 'danger' ? 'danger solid' : ''} disabled={busy} onClick={run}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------- item table ----
function ItemTableRow({ item, onClaim, busy }) {
  return (
    <tr className="row-link" onClick={(e) => { if (!e.target.closest('a,button')) go(`/items/${item.id}`); }}>
      <td className="c-title">
        <span className="num">#{item.number}</span>
        <a className="title-link" href={`#/items/${item.id}`}>{item.title}</a>
        <span className="sub">
          <span>{item.teamName}</span>
          <span>·</span>
          <span>{KIND_LABELS[item.kind] ?? item.kind}</span>
          {item.requiresApproval && <span className="tag">needs approval</span>}
          <span className="only-narrow">· {item.assignee ? item.assignee.name : 'Unassigned'}</span>
          {item.dueAt && <span className={`only-narrow${item.overdue ? ' overdue' : ''}`}>· Due {dueLabel(item.dueAt)}</span>}
        </span>
      </td>
      <td><Badge kind="status" value={item.status} /></td>
      <td><Badge kind="priority" value={item.priority} /></td>
      <td className="c-owner"><Person user={item.assignee} /></td>
      <td className="c-due">{item.dueAt ? <span className={item.overdue ? 'overdue' : ''} title={when(item.dueAt)}>{dueLabel(item.dueAt)}</span> : <span className="muted">—</span>}</td>
      <td className="c-upd"><span title={when(item.lastActivityAt)}>{ago(item.lastActivityAt)}</span></td>
      <td className="c-act">
        {item.claimable && onClaim && (
          <button className="secondary small" disabled={busy} onClick={() => onClaim(item)} aria-label={`Claim #${item.number}`}>
            {busy ? 'Claiming…' : 'Claim'}
          </button>
        )}
      </td>
    </tr>
  );
}

export function ItemTable({ items, onClaim, busyId, compact = false, caption }) {
  return (
    <div className="table-wrap">
      <table className={`data items${compact ? ' compact' : ''}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="c-title">Item</th><th scope="col" className="c-status">Status</th><th scope="col" className="c-prio">Priority</th>
            <th scope="col" className="c-owner">Owner</th><th scope="col" className="c-due">Due</th><th scope="col" className="c-upd">Updated</th>
            <th scope="col" className="c-act"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>{items.map((it) => <ItemTableRow key={it.id} item={it} onClaim={onClaim} busy={busyId === it.id} />)}</tbody>
      </table>
    </div>
  );
}
