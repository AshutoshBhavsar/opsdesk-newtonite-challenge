// Tiny data layer: fetch wrapper, per-action idempotency keys with safe retries, an invalidation bus,
// and the SSE connection that feeds it.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
    this.details = body?.error?.details;
  }
}

export const bus = new EventTarget();
export const invalidate = () => bus.dispatchEvent(new Event('invalidate'));

const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(method, path, body, key) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export async function get(path) {
  return once('GET', path);
}

/**
 * One user action = ONE idempotency key, reused for automatic retries after network failures / 5xx / 503,
 * so a retried request can never be applied twice. A definitive answer (2xx/4xx) ends the action.
 */
export async function mutate(method, path, body) {
  const key = newKey();
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await once(method, path, body, key);
      invalidate();
      return out;
    } catch (err) {
      const transient = !(err instanceof ApiError) || err.status >= 500;
      if (!transient || attempt >= 2) {
        if (err instanceof ApiError && err.status === 409) invalidate();
        throw err;
      }
      await sleep(400 * (attempt + 1));
    }
  }
}

export function connectStream(onMessage) {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      bus.dispatchEvent(new CustomEvent('sse', { detail: m }));
      if (m.kind === 'resync' || m.kind === 'notification' || m.kind === 'item') invalidate();
      onMessage?.(m);
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => es.close();
}
