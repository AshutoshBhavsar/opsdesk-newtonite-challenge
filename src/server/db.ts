// Database access: one pool, a transaction helper, and a tiny migration runner.
// This is the only module that imports the `pg` driver.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { Pool as PgPool, PoolClient } from 'pg';
import { errFields, log } from './log.js';

/** Anything that can run a query: the pool itself or a checked-out transaction client. */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export type Pool = PgPool;
export type Tx = PoolClient;

// bigint (int8) columns hold identities and counters well inside Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v: string) => Number(v));

export function createPool(connectionString: string, max: number): Pool {
  // Every connection gets guard rails (so one bad query or lock cannot wedge the app). They are sent as
  // startup parameters, which needs no extra round trip and no un-awaited query on a fresh client.
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: '-c statement_timeout=15000 -c lock_timeout=8000 -c idle_in_transaction_session_timeout=30000',
  });
  // An idle client erroring (e.g. the database restarted) must not crash the process.
  pool.on('error', (err) => log.error('idle database client error', errFields(err)));
  return pool;
}

/** Run a query and return typed rows. */
export async function rows<T>(db: Db, text: string, values?: unknown[]): Promise<T[]> {
  return (await db.query(text, values)).rows as T[];
}

/** Run a query and return the first row, if any. */
export async function one<T>(db: Db, text: string, values?: unknown[]): Promise<T | undefined> {
  return (await rows<T>(db, text, values))[0];
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock detected

/**
 * Run `fn` inside a transaction. Commits on success, rolls back on any error. Deadlocks and
 * serialization failures are retried a couple of times (the callback must be safe to re-run,
 * which holds because all side effects live inside the transaction).
 */
export async function tx<T>(pool: Pool, fn: (c: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true; // the connection is unusable; do not hand it back to the pool
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 2) {
        log.warn('retrying transaction', { code, attempt });
        continue;
      }
      throw err;
    } finally {
      client.release(destroy);
    }
  }
}

/** Apply any new migrations/*.sql files, in name order. Safe to call from several processes at once. */
export async function migrate(pool: Pool, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // A session-level advisory lock makes concurrent starts (api + worker) take turns.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await rows<{ name: string }>(client, 'SELECT name FROM schema_migrations')).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log.info('applied migration', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}
