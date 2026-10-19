// The outbox worker. Jobs are rows in `outbox_jobs`, written in the same transaction as the business change.
//   claim   : UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)  → many workers never take the same job
//   process : handler effects + "mark done" commit together               → no "effect without completion"
//   fail    : retry with exponential backoff + jitter, dead-letter after max_attempts
//   crash   : a job stuck in 'processing' past the visibility timeout is re-queued (attempts already counted)
// Handlers must be idempotent: delivery is at-least-once.

import type { Config } from '../config.js';
import { rows, tx, type Pool, type Tx } from '../db.js';
import { errFields, log } from '../log.js';
import { handlers as defaultHandlers, PermanentError, type Handler, type Job } from './handlers.js';
import { scanStale } from './stale.js';

export type Handlers = Record<string, Handler>;

/** Re-queue (or dead-letter) jobs whose worker vanished. Returns how many were touched. */
export async function reapStuck(pool: Pool, visibilityMs: number): Promise<number> {
  const r = await pool.query(
    `UPDATE outbox_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
            run_at = now(), locked_at = NULL,
            last_error = coalesce(last_error, 'worker did not finish (visibility timeout)')
      WHERE status = 'processing' AND locked_at < now() - make_interval(secs => $1::double precision)`,
    [visibilityMs / 1000],
  );
  return r.rowCount ?? 0;
}

async function claimBatch(pool: Pool, n: number): Promise<Job[]> {
  return rows<Job>(
    pool,
    `UPDATE outbox_jobs SET status = 'processing', locked_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM outbox_jobs WHERE status = 'pending' AND run_at <= now()
                    ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, type, payload, attempts, max_attempts`,
    [n],
  );
}

export const backoffSeconds = (attempts: number): number => Math.min(2 ** attempts * 5, 900) * (0.8 + Math.random() * 0.4);

async function runOne(pool: Pool, job: Job, handlers: Handlers): Promise<'done' | 'retry' | 'dead'> {
  try {
    const handler = handlers[job.type];
    if (!handler) throw new PermanentError(`unknown job type: ${job.type}`);
    await tx(pool, async (c: Tx) => {
      await handler(c, job);
      await c.query(`UPDATE outbox_jobs SET status = 'done', completed_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [job.id]);
    });
    return 'done';
  } catch (err) {
    const permanent = err instanceof PermanentError;
    const dead = permanent || job.attempts >= job.max_attempts;
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    log.warn('job failed', { jobId: job.id, type: job.type, attempts: job.attempts, dead, ...errFields(err) });
    await pool.query(
      `UPDATE outbox_jobs
          SET status = $2, last_error = $3, locked_at = NULL,
              run_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $4::double precision) ELSE run_at END
        WHERE id = $1`,
      [job.id, dead ? 'dead' : 'pending', msg, backoffSeconds(job.attempts)],
    );
    return dead ? 'dead' : 'retry';
  }
}

/** One polling round: reap, claim a batch, process it. Returns the number of jobs handled. */
export async function processOnce(pool: Pool, config: Pick<Config, 'jobVisibilityTimeoutMs'>, handlers: Handlers = defaultHandlers, batch = 20): Promise<number> {
  await reapStuck(pool, config.jobVisibilityTimeoutMs);
  const jobs = await claimBatch(pool, batch);
  for (const job of jobs) await runOne(pool, job, handlers);
  return jobs.length;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

export function startWorker(pool: Pool, config: Config, handlers: Handlers = defaultHandlers): WorkerHandle {
  let stopped = false;
  let wake: (() => void) | null = null;
  let lastStale = 0;
  let lastHousekeeping = 0;

  const loop = (async () => {
    while (!stopped) {
      let worked = 0;
      try {
        worked = await processOnce(pool, config, handlers);
        const now = Date.now();
        if (now - lastStale >= config.staleScanIntervalMs) {
          lastStale = now;
          const n = await scanStale(pool, config.staleAfterHours);
          if (n) log.info('stale scan flagged items', { n });
        }
        if (now - lastHousekeeping >= 5 * 60_000) {
          lastHousekeeping = now;
          await housekeeping(pool);
        }
      } catch (err) {
        log.error('worker round failed', errFields(err));
      }
      if (worked === 0 && !stopped) await new Promise<void>((r) => { wake = r; setTimeout(r, config.workerPollMs).unref(); });
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}

export async function housekeeping(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  await pool.query(`DELETE FROM outbox_jobs WHERE status = 'done' AND completed_at < now() - interval '7 days'`);
}
