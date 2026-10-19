// Standalone worker process (docker-compose `worker` service): `npm run start:worker`.
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { log, setLogLevel } from '../log.js';
import { startWorker } from './loop.js';

const config = loadConfig();
setLogLevel(config.logLevel);
const pool = createPool(config.databaseUrl, 5);
const worker = startWorker(pool, config);
log.info('worker started');
const stop = async (): Promise<void> => {
  await worker.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
