import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

export interface EdgeOptions {
  /** Path prefix ("/frozen") a proxy may keep; /ws is accepted either way. */
  base?: string;
  /** Read client addresses and the forwarded host from proxy headers. */
  trustProxy?: boolean;
  /** Extra page origins allowed to open the socket. */
  allowOrigins?: string[];
  maxConnections?: number;
  /** Sockets one (non-loopback) address may hold. */
  perIp?: number;
  log?: (msg: string) => void;
}

/** Commands are tiny (the largest, a trade offer, is well under 4 KB); 64 KB leaves plenty of room. */
export const MAX_PAYLOAD = 64 * 1024;

export const isLoopback = (h: string) => h === 'localhost' || h === '[::1]' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    // The last entry is the one our own proxy added; earlier ones are whatever the client claimed.
    if (typeof xff === 'string' && xff) return xff.split(',').at(-1)!.trim();
  }
  return (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
}

/**
 * Browsers always send Origin on websockets. Only pages from this server (or a listed origin) may
 * connect, so a web page someone visits can't quietly join or flood a friends server on their
 * network. Non-browser clients (bots) send no Origin and are let through to the password check.
 */
export function originOk(req: IncomingMessage, trustProxy: boolean, allowed: Set<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.has(u.origin)) return true;
  const fwd = req.headers['x-forwarded-host'];
  const hosts = [req.headers.host, trustProxy && typeof fwd === 'string' ? fwd.split(',')[0].trim() : undefined];
  if (hosts.some((h) => h && h.toLowerCase() === u.host.toLowerCase())) return true;
  // The Vite dev server proxies the socket from another port on this machine.
  return isLoopback(u.hostname);
}

/** Accept game websockets on the HTTP server: path, origin and connection limits are checked before the upgrade. */
export function attachSockets(http: Server, onConnect: (ws: WebSocket, ip: string) => void, opts: EdgeOptions = {}): WebSocketServer {
  const base = opts.base ?? '';
  const trustProxy = !!opts.trustProxy;
  const maxConnections = Math.max(2, opts.maxConnections ?? 32);
  const perIp = opts.perIp ?? 12;
  const log = opts.log ?? ((m: string) => console.log(`[net] ${m}`));
  const allowed = new Set(
    (opts.allowOrigins ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return new URL(s).origin;
        } catch {
          return s;
        }
      }),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: { threshold: 1024 } });
  const sockets = new Map<WebSocket, string>();
  http.on('upgrade', (req, socket, head) => {
    const reject = (code: number, why: string) => {
      socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    let path = '';
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (path !== '/ws' && path !== `${base}/ws`) return reject(404, 'Not Found');
    if (!originOk(req, trustProxy, allowed)) {
      log(`Refused a websocket from origin ${String(req.headers.origin).slice(0, 100)} (allow it with --allow-origin)`);
      return reject(403, 'Forbidden');
    }
    const ip = clientIp(req, trustProxy);
    if (sockets.size >= maxConnections) return reject(503, 'Service Unavailable');
    if (!isLoopback(ip) && [...sockets.values()].filter((x) => x === ip).length >= perIp) return reject(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, ip);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => ws.terminate());
      onConnect(ws, ip);
    });
  });
  return wss;
}
