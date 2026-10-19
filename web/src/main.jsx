import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, connectStream, get, mutate } from './api.js';
import { go, useApi, useRoute } from './hooks.js';
import { Attention, ItemPage, Items, Login, Members, NewItem, Notifications } from './pages.jsx';
import { Icon, Loading } from './ui.jsx';

function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [navOpen, setNavOpen] = useState(false);
  const route = useRoute();
  const mainRef = useRef(null);
  const firstRoute = useRef(true);

  const loadMe = useCallback(async () => {
    try {
      setMe(await get('/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setMe(null);
    }
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);
  // Keep the unread badge fresh via the same invalidation bus used by pages.
  const unread = useApi(me ? '/me' : null);
  useEffect(() => { if (unread.data) setMe(unread.data); }, [unread.data]);
  useEffect(() => (me ? connectStream() : undefined), [me?.user.id]);

  // On navigation: close the mobile drawer and move focus to the page so keyboard and screen-reader users land on it.
  const routeKey = route.path.join('/');
  useEffect(() => {
    setNavOpen(false);
    if (firstRoute.current) { firstRoute.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [routeKey]);
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (me === undefined) return <main><Loading rows={5} /></main>;
  if (me === null) return <Login onLoggedIn={(m) => { setMe(m); if (!location.hash) go('/'); }} />;

  const [page, id] = route.path;
  const isAdmin = me.teams.some((t) => t.roles.includes('admin'));
  const unreadCount = me.unreadNotifications;
  const link = (to, icon, label, extra) => (
    <a href={`#/${to}`} aria-current={(page ?? '') === to ? 'page' : undefined}>
      <Icon name={icon} />{label}{extra}
    </a>
  );
  const logout = async () => { await mutate('POST', '/auth/logout', {}).catch(() => {}); setMe(null); location.hash = ''; };
  const badge = unreadCount > 0 ? <span className="nav-count" aria-label={`${unreadCount} unread`}>{unreadCount}</span> : null;

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <a className="skip" href="#content" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Open navigation" aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen(true)}><Icon name="menu" /></button>
        <a className="brand" href="#/"><span className="brand-mark" aria-hidden="true">O</span>OpsDesk</a>
        <span className="topbar-spacer" />
        <a className="bell" href="#/notifications" aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}><Icon name="bell" />{unreadCount > 0 && <span className="nav-count">{unreadCount}</span>}</a>
      </header>
      <aside className="sidebar" id="sidebar">
        <a className="brand" href="#/"><span className="brand-mark" aria-hidden="true">O</span>OpsDesk</a>
        <nav aria-label="Main">
          <div className="nav-label">Work</div>
          {link('', 'attention', 'Needs attention')}
          {link('items', 'items', 'Items')}
          {link('new', 'plus', 'New item')}
          <div className="nav-label nav-gap">Updates</div>
          {link('notifications', 'bell', 'Notifications', badge)}
          <div className="nav-label nav-gap">Team</div>
          {link('members', 'users', 'Members')}
        </nav>
        <div className="side-foot">
          <div className="me">
            <span className="avatar" aria-hidden="true">{me.user.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()}</span>
            <div className="me-text">
              <div className="me-name">{me.user.name}</div>
              <div className="me-role">{isAdmin ? 'Admin · ' : ''}{me.teams.length} team{me.teams.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          <button type="button" className="signout" onClick={logout}><Icon name="logout" />Sign out</button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="content">
        <main id="content" ref={mainRef} tabIndex={-1}>
          {page === 'items' && id ? <ItemPage key={id} id={id} me={me} /> : page === 'items' ? <Items me={me} params={route.params} /> : page === 'new' ? <NewItem me={me} /> : page === 'notifications' ? <Notifications /> : page === 'members' ? <Members me={me} /> : <Attention me={me} />}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
