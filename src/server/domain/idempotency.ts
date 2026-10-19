// Idempotency keys: a client that is unsure whether a request succeeded may repeat it with the
// same `Idempotency-Key` and gets the ORIGINAL response back instead of a second effect.
//
// How it stays correct:
//   * The key row is inserted in the SAME transaction as the operation it protects, so the key exists
//     if and only if the operation committed (a failed attempt leaves no trace and can be retried).
//   * Two requests racing with the same key both try to insert; the unique index makes the second one
//     WAIT until the first commits or rolls back. After a commit it sees the stored response; after a
//     rollback it simply proceeds as the first. No application-level locking is needed.

import { createHash } from 'node:crypto';
import { conflict, unprocessable } from '../http/errors.js';
import { one, type Db } from '../db.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;

/** JSON with sorted keys, so semantically identical bodies hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function fingerprint(method: string, pathname: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${pathname}\n${stableStringify(body)}`).digest('hex');
}

export type IdempotencyStart = { replay: StoredResponse } | { owned: true };

export async function beginIdempotent(db: Db, userId: string, key: string, fp: string): Promise<IdempotencyStart> {
  const inserted = await db.query(
    `INSERT INTO idempotency_keys (user_id, key, fingerprint) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING RETURNING 1 AS ok`,
    [userId, key, fp],
  );
  if (inserted.rowCount === 1) return { owned: true };

  const existing = await one<{ fingerprint: string; response_status: number | null; response_body: unknown }>(
    db,
    'SELECT fingerprint, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  if (!existing) {
    // The row was purged between our two statements (only possible for keys older than the TTL).
    throw conflict('IDEMPOTENCY_RETRY', 'Please retry the request.');
  }
  if (existing.fingerprint !== fp) {
    throw unprocessable(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request. Use a new key for a new action.',
    );
  }
  if (existing.response_status === null) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed.');
  return { replay: { status: existing.response_status, body: existing.response_body } };
}

export async function completeIdempotent(db: Db, userId: string, key: string, status: number, body: unknown): Promise<void> {
  await db.query('UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2', [
    userId,
    key,
    status,
    JSON.stringify(body ?? null),
  ]);
}
