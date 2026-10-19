// Test helpers. Every test file gets its own throw-away database (opsdesk_t_<name>) on a real PostgreSQL,
// because the behaviours under test (row locks, unique indexes, SKIP LOCKED, triggers) do not exist in mocks.

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../src/server/app.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { createPool, migrate, type Pool } from '../src/server/db.js';
import { hashPassword } from '../src/server/auth/passwords.js';
import { setLogLevel } from '../src/server/log.js';

setLogLevel('silent');

export const PASSWORD = 'Passw0rd!demo';
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export interface TestEnv {
  url: string;
  pool: Pool;
  config: Config;
  app: App;
  base: string;
  users: Record<string, string>;
  teams: Record<string, string>;
  close(): Promise<void>;
}

async function createTestDb(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const db = `opsdesk_t_${name}`;
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  return ADMIN_URL.replace(/\/[^/]*$/, `/${db}`);
}

let cachedHash: Promise<string> | undefined;
export const passwordHash = (): Promise<string> => (cachedHash ??= hashPassword(PASSWORD));

/** Users/teams/roles mirror ARCHITECTURE §9b. */
async function seedBasic(pool: Pool): Promise<{ users: Record<string, string>; teams: Record<string, string> }> {
  const hash = await passwordHash();
  const users: Record<string, string> = {};
  for (const k of ['ava', 'liam', 'noor', 'raj', 'mei', 'sam', 'zoe']) {
    const r = await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [`${k}@acme.test`, k[0]!.toUpperCase() + k.slice(1), hash]);
    users[k] = r.rows[0].id;
  }
  const teams: Record<string, string> = {};
  for (const t of ['Support', 'Platform', 'Finance', 'Legal']) {
    teams[t] = (await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [t])).rows[0].id;
  }
  const m: Array<[string, string, string[]]> = [
    ['ava', 'Support', ['admin']], ['ava', 'Platform', ['admin']], ['ava', 'Finance', ['admin']],
    ['liam', 'Support', ['lead', 'member']], ['noor', 'Support', ['member']], ['noor', 'Platform', ['member']],
    ['raj', 'Finance', ['approver']], ['mei', 'Finance', ['lead', 'member']], ['mei', 'Platform', ['member']],
    ['sam', 'Platform', ['member']], ['zoe', 'Legal', ['member']],
  ];
  for (const [u, t, roles] of m) for (const role of roles) await pool.query('INSERT INTO memberships (team_id, user_id, role) VALUES ($1,$2,$3)', [teams[t], users[u], role]);
  return { users, teams };
}

export async function startEnv(name: string, overrides: Partial<Config> = {}): Promise<TestEnv> {
  const url = await createTestDb(name);
  const config: Config = { ...loadConfig({ DATABASE_URL: url, LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ...overrides };
  const pool = createPool(url, 30);
  await migrate(pool, config.migrationsDir);
  const { users, teams } = await seedBasic(pool);
  const app = createApp(config, pool);
  const port = await app.listen(0);
  return {
    url, pool, config, app, base: `http://127.0.0.1:${port}`, users, teams,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  cookie = '';
  constructor(readonly base: string, readonly email: string) {}

  async login(password = PASSWORD): Promise<this> {
    const r = await this.call('POST', '/api/auth/login', { email: this.email, password });
    if (r.status !== 200) throw new Error(`login failed for ${this.email}: ${r.status} ${JSON.stringify(r.body)}`);
    this.cookie = r.headers.getSetCookie()[0]!.split(';')[0]!;
    return this;
  }

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.call('POST', p, b, h);
  patch = (p: string, b?: unknown, h?: Record<string, string>) => this.call('PATCH', p, b, h);
  put = (p: string, b?: unknown, h?: Record<string, string>) => this.call('PUT', p, b, h);
}

export async function as(env: TestEnv, who: string): Promise<Client> {
  return new Client(env.base, `${who}@acme.test`).login();
}

export const uniqueKey = (): string => `k-${randomUUID()}`;

/** Create an item through the API and return its detail. */
export async function mkItem(c: Client, teamId: string, over: Record<string, unknown> = {}): Promise<any> {
  const r = await c.post('/api/items', { teamId, title: `Test item ${randomUUID().slice(0, 8)}`, kind: 'task', ...over });
  if (r.status !== 201) throw new Error(`mkItem failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const count = async (pool: Pool, sql: string, params: unknown[] = []): Promise<number> => Number((await pool.query(sql, params)).rows[0].n);
