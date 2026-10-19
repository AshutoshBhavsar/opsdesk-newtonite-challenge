import { useEffect, useMemo, useState } from 'react';
import { KINDS, PRIORITIES, ROLES, STATUSES, STATUS_LABELS, PRIORITY_LABELS, KIND_LABELS, ROLE_LABELS } from '../../src/shared/contract.ts';
import { ApiError, bus, get, mutate } from './api.js';
import { go, useApi, useDebounced } from './hooks.js';
import { Badge, Banner, ConfirmDialog, Dialog, EmptyState, ErrorBox, Icon, ItemTable, Loading, PageHeader, Person, ago, istInputToISO, when } from './ui.jsx';

// ------------------------------------------------------------------ login ----
export function Login({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = 'Sign in · OpsDesk'; }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await mutate('POST', '/auth/login', { email, password }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const demo = [
    ['ananya@kaveri.test', 'Admin in Support, Platform, Finance'],
    ['vikram@kaveri.test', 'Lead in Support'],
    ['priya@kaveri.test', 'Member in Support + Platform'],
    ['rajesh@kaveri.test', 'Approver in Finance'],
    ['meera@kaveri.test', 'Lead in Finance'],
    ['siddharth@kaveri.test', 'Member in Platform'],
    ['zoya@kaveri.test', 'Member in Legal only (sees nothing else)'],
  ];
  return (
    <div className="login-wrap">
      <main className="login">
        <div className="brand"><span className="brand-mark" aria-hidden="true">O</span>OpsDesk</div>
        <section className="panel">
          <div className="panel-body">
            <h1>Sign in</h1>
            <p className="muted">Track who owns what, what needs attention and what changed.</p>
            <form className="form" onSubmit={submit}>
              <div className="field"><label htmlFor="login-email">Email</label><input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></div>
              <div className="field"><label htmlFor="login-password">Password</label><input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
              <ErrorBox error={error} />
              <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </form>
            <details>
              <summary>Demo accounts</summary>
              <p className="hint">Password for all: <code>Passw0rd!demo</code>. Choose one to fill the form.</p>
              <ul className="demo">
                {demo.map(([e, d]) => (
                  <li key={e}><button type="button" className="link" onClick={() => { setEmail(e); setPassword('Passw0rd!demo'); }}>{e}</button> <span className="muted">{d}</span></li>
                ))}
              </ul>
            </details>
          </div>
        </section>
      </main>
    </div>
  );
}

// -------------------------------------------------------------- attention ----
export function Attention() {
  const { data, error, loading } = useApi('/attention');
  const [claimErr, setClaimErr] = useState(null);
  const [claiming, setClaiming] = useState(null);
  const claim = async (item) => {
    setClaimErr(null);
    setClaiming(item.id);
    try {
      await mutate('POST', `/items/${item.id}/claim`, {});
    } catch (e) {
      setClaimErr(e);
    } finally {
      setClaiming(null);
    }
  };
  return (
    <>
      <PageHeader title="Needs attention" subtitle="Work that is waiting on you or at risk. The rule behind each group is shown with it." />
      <ErrorBox error={error ?? claimErr} />
      {loading && !data && <div className="panel"><Loading rows={6} /></div>}
      {data && (
        <>
          <dl className="summary">
            <div><dt>Active in your teams</dt><dd>{data.summary.activeInMyTeams}</dd></div>
            <div><dt>Assigned to you</dt><dd>{data.summary.assignedToMe}</dd></div>
            <div><dt>Requested by you</dt><dd>{data.summary.requestedByMe}</dd></div>
          </dl>
          {data.groups.length === 0 && (
            <EmptyState title="Nothing needs your attention right now">
              Approvals, overdue work, urgent unowned items and quiet items will appear here. <a href="#/items">Browse all items</a>
            </EmptyState>
          )}
          <div className="stack">
            {data.groups.map((g) => (
              <section key={g.key} className="panel" aria-labelledby={`g-${g.key}`}>
                <div className="panel-head">
                  <div>
                    <h2 id={`g-${g.key}`}>{g.title} <span className="count">{g.total}</span></h2>
                    <p>Why you see this: {g.rule}</p>
                  </div>
                </div>
                <ItemTable items={g.items} onClaim={claim} busyId={claiming} compact caption={g.title} />
                {g.total > g.items.length && <div className="panel-foot">and {g.total - g.items.length} more — <a href="#/items">open the full list</a></div>}
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ items ----
const DEFAULT_FILTERS = { team: '', status: 'active', priority: '', kind: '', assignee: '', sort: 'activity', overdue: false };

export function Items({ me, params }) {
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q);
  const [f, setF] = useState(DEFAULT_FILTERS);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [more, setMore] = useState({ loading: false, error: null });
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: '25', sort: f.sort, status: f.status });
    for (const k of ['team', 'priority', 'kind', 'assignee']) if (f[k]) p.set(k, f[k]);
    if (f.overdue) p.set('overdue', 'true');
    if (dq.trim()) p.set('q', dq.trim());
    return p.toString();
  }, [f, dq]);
  const { data, error, loading } = useApi(`/items?${qs}`);
  useEffect(() => { setExtra([]); setCursor(null); }, [qs]);
  const next = cursor ?? data?.nextCursor ?? null;
  const loadMore = async () => {
    setMore({ loading: true, error: null });
    try {
      const page = await get(`/items?${qs}&cursor=${encodeURIComponent(next)}`);
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor ?? '');
      setMore({ loading: false, error: null });
    } catch (e) {
      setMore({ loading: false, error: e });
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const [claimErr, setClaimErr] = useState(null);
  const [claiming, setClaiming] = useState(null);
  const claim = async (item) => {
    setClaimErr(null);
    setClaiming(item.id);
    try { await mutate('POST', `/items/${item.id}/claim`, {}); } catch (e) { setClaimErr(e); } finally { setClaiming(null); }
  };
  const all = [...(data?.items ?? []), ...extra];
  const filtered = Boolean(q.trim()) || JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTERS);
  const clear = () => { setQ(''); setF(DEFAULT_FILTERS); };
  return (
    <>
      <PageHeader title="Work items" subtitle="Everything in your teams. Search, filter and sort run on the server, so large lists stay fast." actions={<a className="button" href="#/new"><Icon name="plus" size={16} />New item</a>} documentTitle="Items" />
      <form className="panel toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field grow"><label htmlFor="f-q">Search</label><div className="input-icon"><Icon name="search" size={16} /><input id="f-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, description or #number" /></div></div>
        <div className="field"><label htmlFor="f-team">Team</label><select id="f-team" value={f.team} onChange={set('team')}><option value="">All my teams</option>{me.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div className="field"><label htmlFor="f-status">Status</label><select id="f-status" value={f.status} onChange={set('status')}><option value="active">Active</option><option value="all">All</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select></div>
        <div className="field"><label htmlFor="f-priority">Priority</label><select id="f-priority" value={f.priority} onChange={set('priority')}><option value="">Any</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select></div>
        <div className="field"><label htmlFor="f-kind">Kind</label><select id="f-kind" value={f.kind} onChange={set('kind')}><option value="">Any</option>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></div>
        <div className="field"><label htmlFor="f-assignee">Assignee</label><select id="f-assignee" value={f.assignee} onChange={set('assignee')}><option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option></select></div>
        <div className="field"><label htmlFor="f-sort">Sort</label><select id="f-sort" value={f.sort} onChange={set('sort')}><option value="activity">Recent activity</option><option value="priority">Priority</option><option value="created">Newest</option></select></div>
        <div className="toolbar-foot">
          <label className="check"><input type="checkbox" checked={f.overdue} onChange={set('overdue')} /> Overdue only</label>
          {filtered && <button type="button" className="secondary small" onClick={clear}>Clear filters</button>}
        </div>
      </form>
      <ErrorBox error={error ?? claimErr ?? more.error} />
      <section className="panel" aria-label="Work items" aria-busy={loading && Boolean(data)}>
        {loading && !data ? <Loading rows={8} /> : all.length === 0 ? (
          <EmptyState bordered={false} title={filtered ? 'No items match these filters' : 'No work items yet'}>
            {filtered ? <button type="button" className="secondary" onClick={clear}>Clear filters</button> : <a href="#/new">Create the first item</a>}
          </EmptyState>
        ) : (
          <>
            <p className="result-count" aria-live="polite">{all.length} item{all.length === 1 ? '' : 's'} shown{next ? ' · more available' : ''}</p>
            <ItemTable items={all} onClaim={claim} busyId={claiming} caption="Work items" />
            {next && <div className="load-more"><button type="button" className="secondary" disabled={more.loading} onClick={loadMore}>{more.loading ? <><span className="spinner" aria-hidden="true" />Loading…</> : 'Load more'}</button></div>}
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- new item ----
export function NewItem({ me }) {
  const [form, setForm] = useState({ teamId: me.teams[0]?.id ?? '', title: '', description: '', kind: 'task', priority: 'medium', dueAt: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const dt = useDebounced(form.title, 400);
  const similar = useApi(dt.trim().length >= 3 && form.teamId ? `/items/similar?teamId=${form.teamId}&title=${encodeURIComponent(dt.trim())}` : null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = { ...form, dueAt: form.dueAt ? istInputToISO(form.dueAt) : undefined };
      if (!body.dueAt) delete body.dueAt;
      const created = await mutate('POST', '/items', body);
      go(`/items/${created.id}`);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  const needsApproval = ['payment', 'compliance', 'access_request'].includes(form.kind);
  return (
    <>
      <PageHeader title="New work item" subtitle="Say what needs doing and why, so whoever picks it up has the context." documentTitle="New item" />
      <form onSubmit={submit} className="panel">
        <div className="panel-body form">
          <div className="form-grid">
            <div className="field"><label htmlFor="n-team">Team</label><select id="n-team" value={form.teamId} onChange={set('teamId')}>{me.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            <div className="field"><label htmlFor="n-kind">Kind</label><select id="n-kind" value={form.kind} onChange={set('kind')}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></div>
          </div>
          <div className="field">
            <label htmlFor="n-title">Title</label>
            <input id="n-title" value={form.title} onChange={set('title')} minLength={3} maxLength={200} required aria-describedby="n-title-h" />
            <p id="n-title-h" className="hint">3–200 characters. Be specific: “Refund for order 4412 failing” beats “Refund problem”.</p>
          </div>
          {similar.data?.length > 0 && (
            <Banner tone="warn">
              <strong>Similar open items already exist.</strong> Check before creating a duplicate:
              <ul>{similar.data.map((s) => <li key={s.id}><a href={`#/items/${s.id}`} target="_blank" rel="noreferrer">#{s.number} {s.title}</a> ({STATUS_LABELS[s.status]})</li>)}</ul>
            </Banner>
          )}
          <div className="field"><label htmlFor="n-desc">Why does this exist? (description)</label><textarea id="n-desc" rows={5} value={form.description} onChange={set('description')} maxLength={10000} /></div>
          <div className="form-grid">
            <div className="field"><label htmlFor="n-priority">Priority</label><select id="n-priority" value={form.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select></div>
            <div className="field"><label htmlFor="n-due">Due (optional, IST)</label><input id="n-due" type="datetime-local" value={form.dueAt} onChange={set('dueAt')} /></div>
          </div>
          {needsApproval && <Banner tone="info">This kind of work needs a second person’s approval before it can be resolved.</Banner>}
          <ErrorBox error={err} />
          <div className="form-foot">
            <a className="button secondary" href="#/items">Cancel</a>
            <button disabled={busy}>{busy ? 'Creating…' : 'Create item'}</button>
          </div>
        </div>
      </form>
    </>
  );
}

// ------------------------------------------------------------- item detail ----
function describeEvent(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'created': return 'created this item';
    case 'claimed': return 'took ownership';
    case 'assigned': return `assigned it to ${d.to?.name ?? '?'}${d.from ? ` (was ${d.from.name})` : ''}`;
    case 'released': return `released it${d.from ? ` (was ${d.from.name})` : ''}`;
    case 'priority_changed': return `changed priority ${PRIORITY_LABELS[d.from] ?? d.from} → ${PRIORITY_LABELS[d.to] ?? d.to}`;
    case 'status_changed': return `${d.action?.replace('_', ' ') ?? 'changed status'}: ${STATUS_LABELS[d.from] ?? d.from} → ${STATUS_LABELS[d.to] ?? d.to}`;
    case 'updated': return `edited ${Object.keys(d.changes ?? {}).join(', ') || 'the item'}`;
    case 'stale_flagged': return 'flagged this item as going quiet';
    case 'comment': return 'commented';
    default: return e.type;
  }
}

export function ItemPage({ id, me }) {
  const item = useApi(`/items/${id}`);
  const events = useApi(`/items/${id}/events?limit=50`);
  const [pending, setPending] = useState([]);            // optimistic comments
  const [dialog, setDialog] = useState(null);            // {kind:'transition'|'assign'|'priority'|'release'|'edit', ...}
  const [msg, setMsg] = useState(null);                  // {tone, text}
  const [conflict, setConflict] = useState(null);        // server's fresh copy after VERSION_CONFLICT
  const [stale, setStale] = useState(false);
  const [optimistic, setOptimistic] = useState(null);
  const [comment, setComment] = useState('');
  const [olderEvents, setOlderEvents] = useState([]);
  const [olderCursor, setOlderCursor] = useState(undefined);

  useEffect(() => {
    const on = (e) => {
      const m = e.detail;
      if (m.kind === 'item' && m.itemId === id && m.actorId !== me.user.id) setStale(true);
    };
    bus.addEventListener('sse', on);
    return () => bus.removeEventListener('sse', on);
  }, [id, me.user.id]);

  if (item.loading && !item.data) return <div className="panel"><Loading rows={8} /></div>;
  if (item.error?.status === 404) {
    return (
      <>
        <PageHeader title="Not found" />
        <EmptyState title="This item does not exist or you do not have access to it."><a href="#/items">Back to the list</a></EmptyState>
      </>
    );
  }
  if (!item.data) return <ErrorBox error={item.error} />;
  const it = optimistic ? { ...item.data, ...optimistic } : item.data;
  const can = item.data.can;

  // Run an action; on a 409 roll back, tell the user what happened and show the server's current state.
  const act = async (fn, { rollback } = {}) => {
    setMsg(null);
    try {
      await fn();
      setStale(false);
      setConflict(null);
      return true;
    } catch (e) {
      rollback?.();
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setConflict(e.details?.current ?? null);
        setMsg({ tone: 'warn', text: e.message });
      } else if (e instanceof ApiError && e.code === 'ALREADY_CLAIMED') {
        setMsg({ tone: 'warn', text: e.message });
      } else {
        setMsg({ tone: 'error', text: e.message });
      }
      item.reload();
      return false;
    }
  };
  const openDialog = (d) => { setMsg(null); setDialog(d); };

  // Optimistic claim: show the claim immediately (marked "claiming…"); roll back and explain if someone else won.
  const onClaim = async () => {
    setOptimistic({ assignee: { id: me.user.id, name: me.user.name } });
    await act(() => mutate('POST', `/items/${id}/claim`, {}));
    await item.reload();
    setOptimistic(null);
  };

  const addComment = async (e) => {
    e.preventDefault();
    const body = comment.trim();
    if (!body) return;
    const tmp = { id: `tmp-${Date.now()}`, body, createdAt: new Date().toISOString(), actor: me.user };
    setPending((p) => [...p, tmp]);
    setComment('');
    const ok = await act(() => mutate('POST', `/items/${id}/comments`, { body }), { rollback: () => setComment(body) });
    setPending((p) => p.filter((x) => x.id !== tmp.id));
    if (ok) events.reload();
  };

  const loadOlder = async () => {
    const cur = olderCursor === undefined ? events.data?.nextCursor : olderCursor;
    if (!cur) return;
    const page = await get(`/items/${id}/events?limit=50&cursor=${cur}`);
    setOlderEvents((o) => [...o, ...page.items]);
    setOlderCursor(page.nextCursor ?? null);
  };
  const nextOlder = olderCursor === undefined ? events.data?.nextCursor : olderCursor;
  const timeline = [...pending.map((p) => ({ ...p, type: 'comment', pending: true })).reverse(), ...(events.data?.items ?? []), ...olderEvents];
  const available = can.transitions.filter((t) => !t.blocked);
  const blocked = can.transitions.filter((t) => t.blocked);
  const hasActions = can.claim || available.length > 0 || can.release || can.reassign || can.changePriority || can.edit;

  return (
    <article>
      <nav className="crumbs" aria-label="Breadcrumb"><a href="#/items">Work items</a><span aria-hidden="true">/</span><span>#{it.number}</span></nav>
      <PageHeaderTitle number={it.number} title={it.title} />
      <div className="meta-line">
        <Badge kind="status" value={it.status} /> <Badge kind="priority" value={it.priority} /> <Badge kind="kind" value={it.kind} />
        <span className="muted">{it.teamName}</span>
        {it.overdue && <span className="tag danger">overdue</span>}
        {it.requiresApproval && <span className="tag">needs approval</span>}
      </div>
      {stale && <Banner tone="info" action={<button className="secondary small" onClick={() => { item.reload(); events.reload(); setStale(false); }}>Refresh</button>}>Someone else changed this item.</Banner>}
      {msg && !dialog && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {conflict && (
        <Banner tone="warn" action={<button className="secondary small" onClick={() => { openDialog({ kind: 'edit', base: conflict }); setConflict(null); }}>Re-apply my edit</button>}>
          Latest version is v{conflict.version}: “{conflict.title}” (status {STATUS_LABELS[conflict.status]}, {conflict.assignee ? `owner ${conflict.assignee.name}` : 'unassigned'}).
        </Banner>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <section aria-labelledby="why">
            <h2 id="why">Why this exists</h2>
            <p className="desc">{it.description || <em className="muted">No description.</em>}</p>
          </section>
          {it.resolution && <section aria-labelledby="res"><h2 id="res">Resolution</h2><p className="desc">{it.resolution}</p></section>}
          <section aria-labelledby="hist">
            <h2 id="hist">History</h2>
            {can.comment && (
              <form onSubmit={addComment} className="comment-form form">
                <div className="field"><label htmlFor="c-body">Add a comment</label><textarea id="c-body" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} /></div>
                <div className="form-foot"><button disabled={!comment.trim()}>Comment</button></div>
              </form>
            )}
            <ol className="timeline">
              {timeline.map((e) => (
                <li key={e.id} className={`tl-item${e.type === 'comment' ? ' is-comment' : ''}${e.pending ? ' pending' : ''}`}>
                  <span className="tl-dot" aria-hidden="true" />
                  <div className="tl-head"><strong>{e.actor?.name ?? 'System'}</strong> <span>{describeEvent(e)}</span> <time className="muted" dateTime={e.createdAt} title={when(e.createdAt)}>{e.pending ? 'sending…' : ago(e.createdAt)}</time></div>
                  {e.body && <p className="tl-body">{e.body}</p>}
                  {e.reason && <p className="tl-note"><span>Reason:</span> {e.reason}</p>}
                  {e.data?.resolution && <p className="tl-note"><span>Resolution:</span> {e.data.resolution}</p>}
                </li>
              ))}
            </ol>
            {nextOlder && <button className="secondary" onClick={loadOlder}>Older history</button>}
          </section>
        </div>

        <aside className="detail-side" aria-label="Actions and details">
          <section className="panel" aria-labelledby="act">
            <div className="panel-head"><h2 id="act">Actions</h2></div>
            <div className="panel-body">
              {can.claim && <button onClick={onClaim} disabled={Boolean(optimistic)}>{optimistic ? 'Claiming…' : 'Claim it'}</button>}
              {available.map((t) => (
                <button key={t.to} className={t.tone === 'danger' ? 'danger' : t.tone === 'positive' ? '' : 'secondary'}
                  onClick={() => (t.needs.length ? openDialog({ kind: 'transition', t }) : act(() => mutate('POST', `/items/${id}/transition`, { expectedVersion: it.version, to: t.to })))}>
                  {t.label}
                </button>
              ))}
              {can.release && <button className="secondary" onClick={() => openDialog({ kind: 'release' })}>Release</button>}
              {can.reassign && <button className="secondary" onClick={() => openDialog({ kind: 'assign' })}>Assign…</button>}
              {can.changePriority && <button className="secondary" onClick={() => openDialog({ kind: 'priority' })}>Change priority…</button>}
              {can.edit && <button className="secondary" onClick={() => openDialog({ kind: 'edit', base: item.data })}>Edit</button>}
              {!hasActions && blocked.length === 0 && <p className="hint">No actions are available to you on this item right now.</p>}
              {blocked.length > 0 && (
                <div className="unavailable">
                  <h3>Not available right now</h3>
                  <ul>{blocked.map((t) => <li key={t.to}><strong>{t.label}:</strong> {t.blocked}</li>)}</ul>
                </div>
              )}
            </div>
          </section>
          <section className="panel" aria-labelledby="det">
            <div className="panel-head"><h2 id="det">Details</h2></div>
            <div className="panel-body">
              <dl className="facts">
                <dt>Requested by</dt><dd>{it.requester.name}</dd>
                <dt>Owner</dt><dd><Person user={it.assignee} />{optimistic && <> <span className="pending-text">claiming…</span></>}</dd>
                <dt>Due</dt><dd className={it.overdue ? 'overdue' : undefined}>{it.dueAt ? when(it.dueAt) : '—'}</dd>
                <dt>Last activity</dt><dd>{ago(it.lastActivityAt)}</dd>
                {it.createdAt && <><dt>Created</dt><dd>{when(it.createdAt)}</dd></>}
                <dt>Version</dt><dd>v{it.version}</dd>
              </dl>
            </div>
          </section>
        </aside>
      </div>

      {dialog && <ActionDialog dialog={dialog} item={it} id={id} onClose={() => setDialog(null)} act={act} msg={msg} />}
    </article>
  );
}

function PageHeaderTitle({ number, title }) {
  useEffect(() => { document.title = `#${number} ${title} · OpsDesk`; }, [number, title]);
  return <h1 className="detail-title"><span className="num">#{number}</span><span>{title}</span></h1>;
}

const DIALOG_NOTE = {
  release: 'Releasing puts the item back in the team’s queue so someone else can take it. A reason is optional.',
  assign: 'Choose who should own this item. A reason is required and is saved in the history.',
  priority: 'A reason is required and is saved in the history.',
  edit: 'Your changes are saved as a new version of this item.',
};

function ActionDialog({ dialog, item, id, onClose, act, msg }) {
  const [text, setText] = useState('');
  const [value, setValue] = useState('');
  const [title, setTitle] = useState(dialog.base?.title ?? '');
  const [desc, setDesc] = useState(dialog.base?.description ?? '');
  const [busy, setBusy] = useState(false);
  const members = useApi(dialog.kind === 'assign' ? `/teams/${item.teamId}/members` : null);
  const v = dialog.base?.version ?? item.version;

  const run = async (fn) => {
    setBusy(true);
    const ok = await act(fn);
    setBusy(false);
    if (ok) onClose();
  };
  const submit = (e) => {
    e.preventDefault();
    if (dialog.kind === 'transition') {
      const t = dialog.t;
      return run(() => mutate('POST', `/items/${id}/transition`, { expectedVersion: item.version, to: t.to, ...(t.needs.includes('reason') ? { reason: text } : {}), ...(t.needs.includes('resolution') ? { resolution: text } : {}) }));
    }
    if (dialog.kind === 'release') return run(() => mutate('POST', `/items/${id}/release`, { expectedVersion: item.version, ...(text.trim().length >= 3 ? { reason: text } : {}) }));
    if (dialog.kind === 'assign') return run(() => mutate('POST', `/items/${id}/assign`, { expectedVersion: item.version, assigneeId: value, reason: text }));
    if (dialog.kind === 'priority') return run(() => mutate('POST', `/items/${id}/priority`, { expectedVersion: item.version, priority: value, reason: text }));
    if (dialog.kind === 'edit') return run(() => mutate('PATCH', `/items/${id}`, { expectedVersion: v, title, description: desc }));
  };
  const heading = { transition: dialog.t?.label, release: 'Release this item', assign: 'Assign to someone', priority: 'Change priority', edit: 'Edit item' }[dialog.kind];
  const needsResolution = dialog.kind === 'transition' && dialog.t.needs.includes('resolution');
  const label = needsResolution ? 'How was it resolved?' : dialog.kind === 'release' ? 'Reason (optional, recorded in the history)' : 'Reason (recorded in the history)';
  const note = dialog.kind === 'transition'
    ? (needsResolution ? 'Describe how this was resolved. It is saved with the item.' : 'A reason is required and is saved in the history.')
    : DIALOG_NOTE[dialog.kind];
  const danger = dialog.kind === 'transition' && dialog.t.tone === 'danger';
  return (
    <Dialog title={heading} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="dialog-note">{note}</p>
        {dialog.kind === 'assign' && (
          <div className="field"><label htmlFor="d-assignee">Assignee</label><select id="d-assignee" required value={value} onChange={(e) => setValue(e.target.value)}><option value="">Choose…</option>{(members.data ?? []).filter((m) => m.roles.some((r) => r !== 'approver')).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
        )}
        {dialog.kind === 'priority' && (
          <div className="field"><label htmlFor="d-priority">New priority</label><select id="d-priority" required value={value} onChange={(e) => setValue(e.target.value)}><option value="">Choose…</option>{PRIORITIES.filter((p) => p !== item.priority).map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select></div>
        )}
        {dialog.kind === 'edit' ? (
          <>
            <div className="field"><label htmlFor="d-title">Title</label><input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} required /></div>
            <div className="field"><label htmlFor="d-desc">Description</label><textarea id="d-desc" rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
            {dialog.base?.version !== item.version && <p className="hint">Applying on top of the latest version (v{item.version}).</p>}
          </>
        ) : (
          <div className="field"><label htmlFor="d-text">{label}</label><textarea id="d-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} required={dialog.kind !== 'release'} minLength={dialog.kind === 'release' ? undefined : 3} autoFocus />
            {dialog.kind !== 'release' && <p className="hint">At least 3 characters.</p>}
          </div>
        )}
        {msg?.tone === 'error' && <ErrorBox error={{ message: msg.text }} />}
        {msg?.tone === 'warn' && <Banner tone="warn">{msg.text}</Banner>}
        <div className="dialog-foot">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button disabled={busy} className={danger ? 'danger solid' : ''}>{busy ? 'Working…' : dialog.kind === 'edit' ? 'Save changes' : 'Confirm'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------- notifications ----
const NOTE_TEXT = { created: 'created', claimed: 'took ownership of', assigned: 'assigned', released: 'released', status_changed: 'changed the status of', comment: 'commented on', updated: 'edited', priority_changed: 'changed the priority of', stale_flagged: 'flagged as going quiet:' };
export function Notifications() {
  const { data, error, loading } = useApi('/notifications?limit=50');
  const [err, setErr] = useState(null);
  const readAll = async () => { try { await mutate('POST', '/notifications/read', {}); } catch (e) { setErr(e); } };
  const readOne = async (n) => { if (!n.readAt) await mutate('POST', '/notifications/read', { ids: [n.id] }).catch(() => {}); };
  return (
    <>
      <PageHeader title="Notifications" subtitle="Changes to work you requested, own or approve." actions={<button type="button" className="secondary" onClick={readAll}>Mark all read</button>} />
      <ErrorBox error={error ?? err} />
      <section className="panel" aria-label="Notifications">
        {loading && !data ? <Loading rows={6} /> : data?.items.length === 0 ? (
          <EmptyState bordered={false} title="You’re all caught up">New activity on your work will show up here.</EmptyState>
        ) : (
          <ul className="notes">
            {data?.items.map((n) => (
              <li key={n.id} className={`note${n.readAt ? '' : ' unread'}`}>
                <span className="note-dot" aria-hidden="true" />
                <a className="note-main" href={`#/items/${n.item.id}`} onClick={() => readOne(n)}>
                  <span>{!n.readAt && <span className="sr-only">Unread: </span>}<strong>{n.actor?.name ?? 'System'}</strong> {NOTE_TEXT[n.eventType] ?? n.eventType} <span className="num">#{n.item.number}</span>{n.item.title}</span>
                  <span className="sub"><time dateTime={n.createdAt} title={when(n.createdAt)}>{ago(n.createdAt)}</time>{n.reason && <span>· Reason: {n.reason}</span>}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- members ----
const ROLE_HELP = {
  member: 'Works on items: claim, comment, move them along.',
  lead: 'Triages new work, assigns it and changes priority.',
  approver: 'Approves or rejects work that needs a second person. Cannot be assigned work.',
  admin: 'Everything above, plus manages the team’s members.',
};
export function Members({ me }) {
  const adminTeams = me.teams.filter((t) => t.roles.includes('admin'));
  const [teamId, setTeamId] = useState(adminTeams[0]?.id ?? me.teams[0]?.id ?? '');
  const { data, error, loading } = useApi(teamId ? `/teams/${teamId}/members` : null);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState(['member']);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [removing, setRemoving] = useState(null);
  const isAdmin = adminTeams.some((t) => t.id === teamId);
  // Resolves true only after the server confirmed the change.
  const save = async (mail, rs) => {
    setErr(null);
    setNotice(null);
    try {
      await mutate('PUT', `/teams/${teamId}/members`, { email: mail, roles: rs });
      setNotice(rs.length === 0 ? `Removed ${mail} from this team.` : `Saved roles for ${mail}.`);
      return true;
    } catch (e) {
      setErr(e);
      return false;
    }
  };
  const toggle = (r) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  const teamPicker = (
    <div className="field"><label htmlFor="m-team">Team</label><select id="m-team" value={teamId} onChange={(e) => { setTeamId(e.target.value); setErr(null); setNotice(null); }}>{me.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
  );
  return (
    <>
      <PageHeader title="Team members" subtitle="Who is on each team and what they are allowed to do. Roles are enforced by the server." actions={teamPicker} documentTitle="Members" />
      <ErrorBox error={error ?? (removing ? null : err)} />
      {notice && <Banner tone="info">{notice}</Banner>}
      {!isAdmin && <Banner tone="info">You can see who is on this team. Only team admins can add, change or remove members.</Banner>}
      <section className="panel" aria-label="Members">
        {loading && !data ? <Loading rows={4} /> : (
          <div className="table-wrap">
            <table className="data members">
              <caption className="sr-only">Members of this team</caption>
              <thead><tr><th scope="col" className="c-title">Member</th><th scope="col">Roles</th>{isAdmin && <th scope="col" className="c-act"><span className="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                {data?.map((m) => (
                  <tr key={m.userId}>
                    <td className="c-title"><span className="person"><span className="avatar" aria-hidden="true">{m.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()}</span><span><strong>{m.name}</strong><span className="sub">{m.email}</span></span></span></td>
                    <td><span className="roles">{m.roles.map((r) => <span key={r} className="chip">{ROLE_LABELS[r]}</span>)}</span></td>
                    {isAdmin && <td className="c-act"><button className="danger small" onClick={() => { setErr(null); setRemoving(m); }}>Remove</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {isAdmin && (
        <form className="panel form-panel" onSubmit={(e) => { e.preventDefault(); save(email, roles); }}>
          <div className="panel-head"><div><h2>Add or change a member</h2><p>Enter the email of an existing user. The roles you tick replace their current roles in this team.</p></div></div>
          <div className="panel-body form">
            <div className="field"><label htmlFor="m-email">Email</label><input id="m-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <fieldset><legend>Roles</legend>
              <div className="role-options">
                {ROLES.map((r) => (
                  <div key={r} className="role-option">
                    <label className="check"><input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} /> {ROLE_LABELS[r]}</label>
                    <p className="hint">{ROLE_HELP[r]}</p>
                  </div>
                ))}
              </div>
            </fieldset>
            <div className="form-foot"><button>Save</button></div>
          </div>
        </form>
      )}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.name}?`} confirmLabel="Remove from team" tone="danger" error={err} onClose={() => setRemoving(null)} onConfirm={() => save(removing.email, [])}>
          {removing.name} will lose access to this team’s items immediately. Items they hold that can be released will go back to the team’s queue, and the change is recorded in the history. This is refused if they are the last admin or hold an item waiting for approval.
        </ConfirmDialog>
      )}
    </>
  );
}
