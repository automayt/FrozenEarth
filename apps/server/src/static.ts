import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

interface Cached {
  mtime: number;
  body: Buffer;
  gz?: Buffer;
}

/** Normalise a base path option ("/game/", "game") to "/game", or "" for the root. */
export function normalizeBase(base: string | undefined): string {
  const b = (base ?? '').trim().replace(/^\/+|\/+$/g, '');
  return b ? `/${b}` : '';
}

/**
 * Serve the built client from dir, falling back to index.html. Files are read once and kept in
 * memory (with a gzip copy of the text ones) until they change on disk: the whole client is a few
 * MB, and over a tunnel the 800 KB main script gzips to a third.
 */
export function staticHandler(dir: string, opts: { base?: string; health?: () => object } = {}) {
  const root = resolve(dir);
  const base = normalizeBase(opts.base);
  const cache = new Map<string, Cached>();

  const read = (file: string): Cached => {
    const mtime = statSync(file).mtimeMs;
    let c = cache.get(file);
    if (!c || c.mtime !== mtime) {
      const body = readFileSync(file);
      c = { mtime, body, gz: COMPRESSIBLE.has(extname(file)) && body.length > 1024 ? gzipSync(body) : undefined };
      cache.set(file, c);
    }
    return c;
  };

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', ...HEADERS }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400, HEADERS).end();
      return;
    }
    // Behind a proxy that keeps the prefix (example.com/frozen/...), strip it. A proxy that strips it is fine too.
    if (base && (pathname === base || pathname.startsWith(base + '/'))) pathname = pathname.slice(base.length) || '/';
    if (base && pathname === '/' && req.url && new URL(req.url, 'http://x').pathname === base) {
      // "/frozen" without the slash: relative asset URLs would resolve against "/", so redirect.
      res.writeHead(301, { location: base + '/', ...HEADERS }).end();
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...HEADERS });
      res.end(JSON.stringify({ ok: true, ...(opts.health?.() ?? {}) }));
      return;
    }
    if (!existsSync(join(root, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...HEADERS });
      res.end('FrozenEarth server is running, but the client is not built.\nRun `npm run build`, or use `npm run dev` and open http://localhost:5180.');
      return;
    }
    let file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403, HEADERS).end();
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      isFile = false;
    }
    // Unknown paths get the app (client-side routes); a missing asset or sprite is a real 404.
    if (!isFile) {
      if (/\.[a-z0-9]+$/i.test(pathname)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...HEADERS }).end('Not found');
        return;
      }
      file = join(root, 'index.html');
    }
    let c: Cached;
    try {
      c = read(file);
    } catch {
      res.writeHead(404, HEADERS).end();
      return;
    }
    const lastModified = new Date(Math.floor(c.mtime / 1000) * 1000).toUTCString();
    const immutable = file.startsWith(join(root, 'assets') + sep);
    const headers: Record<string, string> = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'last-modified': lastModified,
      vary: 'accept-encoding',
      ...HEADERS,
    };
    if (!immutable && req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, headers).end();
      return;
    }
    const gzip = c.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const body = gzip ? c.gz! : c.body;
    if (gzip) headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
