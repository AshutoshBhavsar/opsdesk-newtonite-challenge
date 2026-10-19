import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
const applied = await migrate(pool, config.migrationsDir);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
await pool.end();
