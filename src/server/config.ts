// All runtime configuration in one place, read from environment variables with safe defaults
// for local development. Nothing else in the code base touches process.env.

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  poolMax: number;
  sessionTtlHours: number;
  cookieSecure: boolean;
  /** Extra origins (besides the request's own Host) allowed to make state-changing requests. */
  allowedOrigins: string[];
  /** An active item with no human activity for this long is flagged as "going quiet". */
  staleAfterHours: number;
  staleScanIntervalMs: number;
  workerPollMs: number;
  /** A job locked longer than this is assumed to belong to a crashed worker and is re-queued. */
  jobVisibilityTimeoutMs: number;
  migrationsDir: string;
  webDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

const int = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer in environment: ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const level = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/opsdesk',
    poolMax: int(env.DB_POOL_MAX, 20),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    cookieSecure: env.COOKIE_SECURE === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    staleAfterHours: int(env.STALE_AFTER_HOURS, 72),
    staleScanIntervalMs: int(env.STALE_SCAN_INTERVAL_MS, 60_000),
    workerPollMs: int(env.WORKER_POLL_MS, 1_000),
    jobVisibilityTimeoutMs: int(env.JOB_VISIBILITY_TIMEOUT_MS, 60_000),
    migrationsDir: env.MIGRATIONS_DIR ?? 'migrations',
    webDir: env.WEB_DIR ?? 'dist/web',
    logLevel: ['debug', 'info', 'warn', 'error', 'silent'].includes(level) ? level : 'info',
  };
}
