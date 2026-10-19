import { useCallback, useEffect, useRef, useState } from 'react';
import { bus, get } from './api.js';

/** GET `path` and keep it fresh: reloads whenever the invalidation bus fires (after mutations and SSE messages). */
export function useApi(path) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    try {
      const data = await get(path);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
    const on = () => load();
    bus.addEventListener('invalidate', on);
    return () => {
      seq.current++;
      bus.removeEventListener('invalidate', on);
    };
  }, [load]);
  return { ...state, reload: load };
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Hash router: '#/items/123?x=1' -> { path: ['items','123'], params } */
export function useRoute() {
  const parse = () => {
    const raw = location.hash.replace(/^#\/?/, '');
    const [p, q] = raw.split('?');
    return { path: p.split('/').filter(Boolean), params: new URLSearchParams(q ?? '') };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
export const go = (path) => {
  location.hash = path;
};
