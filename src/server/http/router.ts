// A deliberately small HTTP layer on node:http: routing, JSON bodies validated with zod,
// uniform error responses, security headers, and static file serving for the web app.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import type { ApiErrorBody } from '../../shared/contract.js';
import type { Principal } from '../auth/principal.js';
import { errFields, log } from '../log.js';
import { AppError, badRequest } from './errors.js';

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export class Ctx {
  params: Record<string, string> = {};
  principal: Principal | null = null;
  readonly url: URL;
  readonly requestId: string;
  private bodyPromise: Promise<unknown> | undefined;

  constructor(
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
  ) {
    this.url = new URL(req.url ?? '/', 'http://localhost');
    const incoming = req.headers['x-request-id'];
    this.requestId = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  }

  header(name: string): string | undefined {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }

  /** The authenticated principal; routes registered with `auth: true` can rely on it. */
  get user(): Principal {
    if (!this.principal) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in.');
    return this.principal;
  }

  /** Parse and validate the JSON body. */
  async json<T>(schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    this.bodyPromise ??= readJson(this.req);
    return validate(schema, await this.bodyPromise, 'body');
  }

  /** Validate the query string (single values only; lists are comma-separated). */
  query<T>(schema: ZodType<T, ZodTypeDef, unknown>): T {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.url.searchParams) obj[k] = v;
    return validate(schema, obj, 'query');
  }

  /** Validate path parameters. */
  paramsAs<T>(schema: ZodType<T, ZodTypeDef, unknown>): T {
    return validate(schema, this.params, 'path');
  }
}

export function validate<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown, where: string): T {
  try {
    return schema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest(
        'VALIDATION_ERROR',
        `Invalid ${where}: ${err.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }
}

const MAX_BODY_BYTES = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    // Requiring JSON also makes the API immune to classic cross-site form posts.
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('INVALID_JSON', 'The request body is not valid JSON.');
  }
}

export type Handler = (ctx: Ctx) => Promise<Reply | void> | Reply | void;
/** A handler that takes over the response stream itself (server-sent events). */
export type RawHandler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler | RawHandler;
  raw: boolean;
  /** Runs before the handler; used for authentication. */
  guard?: (ctx: Ctx) => Promise<void>;
  staticCount: number;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, guard?: Route['guard']): void {
    this.push(method, pattern, handler, false, guard);
  }

  addRaw(method: string, pattern: string, handler: RawHandler, guard?: Route['guard']): void {
    this.push(method, pattern, handler, true, guard);
  }

  private push(method: string, pattern: string, handler: Handler | RawHandler, raw: boolean, guard?: Route['guard']): void {
    const segments = pattern.split('/').filter(Boolean);
    const route: Route = { method, segments, handler, raw, staticCount: segments.filter((s) => !s.startsWith(':')).length };
    if (guard) route.guard = guard;
    this.routes.push(route);
  }

  /** Most specific match wins: `/items/similar` beats `/items/:id` regardless of registration order. */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | { allow: string[] } | null {
    const parts = pathname.split('/').filter(Boolean);
    let best: { route: Route; params: Record<string, string> } | null = null;
    const allow = new Set<string>();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        allow.add(route.method);
        continue;
      }
      if (!best || route.staticCount > best.route.staticCount) best = { route, params };
    }
    if (best) return best;
    return allow.size ? { allow: [...allow] } : null;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.headersSent) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) } : {}),
    ...headers,
  });
  res.end(payload);
}

/** Map any thrown value to an HTTP error response. Unknown errors are logged and hidden from the client. */
export function toErrorReply(err: unknown, requestId: string): { status: number; body: ApiErrorBody; headers?: Record<string, string> } {
  if (err instanceof AppError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    return err.headers ? { status: err.status, body, headers: err.headers } : { status: err.status, body };
  }
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case '23505':
      return { status: 409, body: { error: { code: 'CONFLICT', message: 'That conflicts with something that already exists.' } } };
    case '23514':
    case '23503':
      return { status: 409, body: { error: { code: 'INVARIANT_VIOLATION', message: 'The change would leave the data in an invalid state.' } } };
    case '22P02':
    case '22007':
    case '22008':
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'A value had an invalid format.' } } };
    case '57014':
    case '55P03':
      return {
        status: 503,
        body: { error: { code: 'BUSY', message: 'The system is busy. Please try again in a moment.' } },
        headers: { 'Retry-After': '2' },
      };
  }
  log.error('unhandled error', { requestId, ...errFields(err) });
  return { status: 500, body: { error: { code: 'INTERNAL', message: `Something went wrong. Reference: ${requestId}` } } };
}

export interface ServerOptions {
  router: Router;
  /** Extra origins allowed to send state-changing requests, besides same-origin. */
  allowedOrigins: string[];
  webDir: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

async function serveStatic(webDir: string, ctx: Ctx): Promise<boolean> {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
  const root = path.resolve(webDir);
  let rel = decodeURIComponent(ctx.url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return false; // path traversal guard
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Single-page-app fallback: any extension-less path serves the app shell.
    if (path.extname(rel)) return false;
    file = path.join(root, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;
  }
  const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`;
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (ctx.header('if-none-match') === etag) {
    ctx.res.writeHead(304, headers).end();
    return true;
  }
  headers['Content-Length'] = String(info.size);
  ctx.res.writeHead(200, headers);
  if (ctx.req.method === 'HEAD') ctx.res.end();
  else createReadStream(file).pipe(ctx.res);
  return true;
}

function sameOrigin(ctx: Ctx, allowed: string[]): boolean {
  const origin = ctx.header('origin');
  if (!origin) return true; // non-browser clients (curl, tests, server-to-server)
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === ctx.header('host');
  } catch {
    return false;
  }
}

/** The single entry point: wire this into http.createServer. */
export function createRequestHandler(opts: ServerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    const ctx = new Ctx(req, res);
    res.setHeader('X-Request-Id', ctx.requestId);
    let status = 500;
    try {
      const method = req.method ?? 'GET';
      if (ctx.url.pathname.startsWith('/api/')) {
        // Cross-site state changes are rejected even though cookies are SameSite=Lax (defence in depth).
        if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(ctx, opts.allowedOrigins)) {
          throw new AppError(403, 'CROSS_ORIGIN', 'Cross-origin requests are not allowed.');
        }
        const found = opts.router.match(method, ctx.url.pathname);
        if (!found) throw new AppError(404, 'NOT_FOUND', 'No such endpoint.');
        if ('allow' in found) {
          throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', undefined, { Allow: found.allow.join(', ') });
        }
        ctx.params = found.params;
        if (found.route.guard) await found.route.guard(ctx);
        if (found.route.raw) {
          await (found.route.handler as RawHandler)(ctx);
          status = res.statusCode;
        } else {
          const reply = (await (found.route.handler as Handler)(ctx)) ?? { status: 204 };
          status = reply.status ?? 200;
          send(res, status, reply.body, reply.headers);
        }
      } else if (!(await serveStatic(opts.webDir, ctx))) {
        status = 404;
        send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
      } else {
        status = res.statusCode;
      }
    } catch (err) {
      const reply = toErrorReply(err, ctx.requestId);
      status = reply.status;
      send(res, reply.status, reply.body, reply.headers);
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.info('request', { requestId: ctx.requestId, method: req.method, path: ctx.url.pathname, status, ms: Math.round(ms) });
    }
  };
}
