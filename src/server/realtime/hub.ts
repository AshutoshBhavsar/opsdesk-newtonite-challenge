// Live updates over Server-Sent Events. A single dedicated connection LISTENs on the `ops_changes` channel
// (fed by pg_notify inside the mutating transactions, delivered only on COMMIT) and fans each message out to
// the connected browsers that are allowed to see it. Messages carry ids/types only, never content: clients
// re-fetch through the normal, authorised API.

import pg from 'pg';
import type { RealtimeMessage } from '../../shared/contract.js';
import { authenticate, type Principal } from '../auth/principal.js';
import { readToken } from '../auth/guard.js';
import { CHANGE_CHANNEL } from '../domain/events.js';
import type { Pool } from '../db.js';
import type { Ctx } from '../http/router.js';
import { errFields, log } from '../log.js';

interface Client {
  res: Ctx['res'];
  token: string;
  userId: string;
  teams: Set<string>;
  timers: NodeJS.Timeout[];
}

export class Hub {
  private clients = new Set<Client>();
  private listener: pg.Client | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;
  private backoffMs = 500;

  constructor(
    private readonly pool: Pool,
    private readonly databaseUrl: string,
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      client.on('notification', (msg) => this.onNotification(msg.payload));
      client.on('error', (err) => this.onListenerLost(client, err));
      client.on('end', () => this.onListenerLost(client));
      await client.query(`LISTEN ${CHANGE_CHANNEL}`);
      this.listener = client;
      this.backoffMs = 500;
      // Anything that happened while we were not listening is unknown: tell clients to re-fetch.
      this.broadcast({ kind: 'resync' });
    } catch (err) {
      await client.end().catch(() => undefined);
      this.onListenerLost(client, err);
    }
  }

  private onListenerLost(client: pg.Client, err?: unknown): void {
    if (this.listener !== null && this.listener !== client) return; // an old connection
    if (this.listener === client) this.listener = null;
    if (this.stopped || this.retry) return;
    log.warn('realtime listener lost; reconnecting', { ...(err ? errFields(err) : {}), inMs: this.backoffMs });
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
  }

  private onNotification(payload: string | undefined): void {
    if (!payload) return;
    try {
      this.broadcast(JSON.parse(payload) as RealtimeMessage);
    } catch (err) {
      log.warn('bad realtime payload', errFields(err));
    }
  }

  private broadcast(m: RealtimeMessage): void {
    for (const c of this.clients) {
      if (m.kind === 'item' && !c.teams.has(m.teamId)) continue;
      if (m.kind === 'notification' && !m.userIds.includes(c.userId)) continue;
      c.res.write(`data: ${JSON.stringify(m)}\n\n`);
    }
  }

  /** Handler for GET /api/stream (already authenticated by the route guard). */
  attach(ctx: Ctx): void {
    const p: Principal = ctx.user;
    const res = ctx.res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 3000\n\n');
    const client: Client = { res, token: readToken(ctx) ?? '', userId: p.userId, teams: new Set(p.roles.keys()), timers: [] };
    this.clients.add(client);

    const close = (): void => {
      for (const t of client.timers) clearInterval(t);
      this.clients.delete(client);
      if (!res.writableEnded) res.end();
    };
    client.timers.push(setInterval(() => res.write(': hb\n\n'), 25_000));
    // Re-authenticate periodically: a revoked session or changed roles must not keep a stream (or its team set) alive.
    client.timers.push(
      setInterval(() => {
        authenticate(this.pool, client.token)
          .then((fresh) => {
            if (!fresh) return close();
            client.teams = new Set(fresh.roles.keys());
          })
          .catch(() => undefined);
      }, 60_000),
    );
    ctx.req.on('close', close);
    res.write(`data: ${JSON.stringify({ kind: 'resync' } satisfies RealtimeMessage)}\n\n`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    for (const c of [...this.clients]) {
      for (const t of c.timers) clearInterval(t);
      c.res.end();
    }
    this.clients.clear();
    const l = this.listener;
    this.listener = null;
    if (l) await l.end().catch(() => undefined);
  }
}
