// Process entry: migrate → listen (→ optionally run the worker in-process for local development).

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { errFields, log, setLogLevel } from './log.js';
import { startWorker } from './worker/loop.js';

const config = loadConfig();
setLogLevel(config.logLevel);
const pool = createPool(config.databaseUrl, config.poolMax);

async function main(): Promise<void> {
  await migrate(pool, config.migrationsDir);
  const app = createApp(config, pool);
  const port = await app.listen();
  log.info('opsdesk api listening', { port });
  const worker = (process.env.RUN_WORKER === 'true' || process.argv.includes('--worker')) ? startWorker(pool, config) : null;
  if (worker) log.info('worker running in-process (RUN_WORKER=true or --worker)');

  let closing = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { sig });
    await worker?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('fatal startup error', errFields(err));
  process.exit(1);
});
