// Minimal structured (JSON-lines) logger. Good enough for `docker logs` and any log shipper.

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let threshold = order.info;

export function setLogLevel(level: Level | 'silent'): void {
  threshold = order[level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
};

export function errFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { err: err.message, code: (err as { code?: unknown }).code, stack: err.stack };
  return { err: String(err) };
}
