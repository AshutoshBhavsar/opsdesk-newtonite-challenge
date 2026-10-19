// Application factory: wires config + pool + routes into an http.Server. Used by main.ts and by the tests
// (which call it with port 0 and a throw-away database).

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { RateLimiter } from './auth/rate-limit.js';
import { createRequestHandler, Router } from './http/router.js';
import { Hub } from './realtime/hub.js';
import { register as registerAuth } from './routes/auth.js';
import type { Deps } from './routes/context.js';
import { register as registerItems } from './routes/items.js';
import { register as registerMisc } from './routes/misc.js';

export interface App {
  server: http.Server;
  hub: Hub;
  /** Start listening; resolves with the bound port (use port 0 in tests). */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createApp(config: Config, pool: Pool): App {
  const hub = new Hub(pool, config.databaseUrl);
  const deps: Deps = { config, pool, hub, loginLimiter: new RateLimiter(10, 15 * 60_000) };
  const router = new Router();
  registerAuth(router, deps);
  registerItems(router, deps);
  registerMisc(router, deps);

  const server = http.createServer(createRequestHandler({ router, allowedOrigins: config.allowedOrigins, webDir: config.webDir }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  return {
    server,
    hub,
    async listen(port = config.port) {
      await hub.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, resolve);
      });
      return (server.address() as AddressInfo).port;
    },
    async close() {
      await hub.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
