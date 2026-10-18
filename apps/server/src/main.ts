import { createServer, type IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isatty } from 'node:tty';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer } from './game';
import { listBackups, restoreBackup, worldPath } from './persistence';
import { normalizeBase, staticHandler } from './static';

const env = process.env;
const { values: args } = parseArgs({
  options: {
    world: { type: 'string', default: 'default' },
    port: { type: 'string', default: env.FE_PORT ?? '8090' },
    /** Address to listen on: all interfaces by default; 127.0.0.1 when only a local tunnel or proxy should reach it. */
    host: { type: 'string', default: env.FE_HOST },
    password: { type: 'string', default: env.FE_PASSWORD },
    'clear-password': { type: 'boolean', default: false },
    seed: { type: 'string' },
    size: { type: 'string', default: '200' },
    'frost-start': { type: 'string', default: env.FE_FROST_START },
    'frost-pace': { type: 'string', default: env.FE_FROST_PACE },
    saves: { type: 'string', default: env.FE_SAVES ?? 'saves' },
    /** Path prefix when a reverse proxy serves the game under one, e.g. /frozen. */
    base: { type: 'string', default: env.FE_BASE },
    /** Take client addresses from X-Forwarded-For / CF-Connecting-IP / Host headers (only behind a proxy or tunnel). */
    'trust-proxy': { type: 'boolean', default: env.FE_TRUST_PROXY === '1' },
    /** Extra page origins allowed to open the websocket, comma-separated. */
    'allow-origin': { type: 'string', default: env.FE_ALLOW_ORIGIN ?? '' },
    'max-connections': { type: 'string', default: env.FE_MAX_CONNECTIONS ?? '32' },
    'host-key': { type: 'string', default: env.FE_HOST_KEY },
    'keep-backups': { type: 'string', default: env.FE_KEEP_BACKUPS ?? '48' },
    backups: { type: 'boolean', default: false },
    restore: { type: 'string' },
    /** Don't read host commands from the terminal. */
    'no-console': { type: 'boolean', default: false },
  },
});

// FE_WORLD wins over --world, so a second dev server can run a different world from the same scripts.
const worldName = env.FE_WORLD || args.world!;
const savePath = worldPath(resolve(args.saves!), worldName);

if (args.backups) {
  const list = listBackups(savePath);
  console.log(list.length ? list.map((b) => `${b.name}  ${(b.bytes / 1024).toFixed(0)} KB`).join('\n') : `No backups in ${savePath}`);
  process.exit(0);
}
if (args.restore) {
  // Done before the world loads, so the server starts on the restored world. The current one is kept as a backup.
  console.log(`Restored ${restoreBackup(savePath, args.restore)} into ${savePath}`);
}

const game = new GameServer({
  savePath,
  password: args['clear-password'] ? '' : args.password || undefined,
  seed: args.seed ? Number(args.seed) : undefined,
  size: Math.max(60, Math.min(400, Number(args.size) || 200)),
  frostStart: args['frost-start'] !== undefined ? Number(args['frost-start']) : undefined,
  frostPace: args['frost-pace'] !== undefined ? Number(args['frost-pace']) : undefined,
  hostKey: args['host-key'] || undefined,
  keepBackups: Math.max(1, Number(args['keep-backups']) || 48),
});

const base = normalizeBase(args.base);
if (!/^(\/[A-Za-z0-9._~-]+)*$/.test(base)) {
  // Git Bash on Windows turns "/frozen" into "C:/Program Files/Git/frozen"; write it as "frozen" there.
  console.error(`--base must be a URL path like /frozen, got "${args.base}"`);
  process.exit(2);
}
const trustProxy = args['trust-proxy']!;
const allowedOrigins = new Set(
  args['allow-origin']!
    .split(',')
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
const maxConnections = Math.max(2, Number(args['max-connections']) || 32);
const PER_IP = 12;

const http = createServer(
  staticHandler(resolve(import.meta.dirname, '../../client/dist'), {
    base,
    health: () => ({ day: game.world.day(), online: [...game.players.values()].filter((p) => p.ws).length, halted: !!game.halted }),
  }),
);
http.headersTimeout = 20_000;
http.requestTimeout = 30_000;
// Commands are tiny (the largest, a trade offer, is well under 4 KB); 64 KB leaves plenty of room.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024 } });

const isLoopback = (h: string) => h === 'localhost' || h === '[::1]' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');

function clientIp(req: IncomingMessage): string {
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
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.has(u.origin)) return true;
  const fwd = req.headers['x-forwarded-host'];
  const hosts = [req.headers.host, trustProxy && typeof fwd === 'string' ? fwd.split(',')[0].trim() : undefined];
  if (hosts.some((h) => h && h.toLowerCase() === u.host.toLowerCase())) return true;
  // The Vite dev server proxies the socket from another port on this machine.
  return isLoopback(u.hostname);
}

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
  if (!originOk(req)) {
    console.log(`[net] Refused a websocket from origin ${String(req.headers.origin).slice(0, 100)} (allow it with --allow-origin)`);
    return reject(403, 'Forbidden');
  }
  const ip = clientIp(req);
  if (sockets.size >= maxConnections) return reject(503, 'Service Unavailable');
  if (!isLoopback(ip) && [...sockets.values()].filter((x) => x === ip).length >= PER_IP) return reject(429, 'Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.set(ws, ip);
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => ws.terminate());
    game.onConnect(ws, ip);
  });
});

const port = Number(args.port);
const listenHost = args.host || undefined;
http.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another with --port.` : e);
  process.exit(1);
});
http.listen(port, listenHost, () => {
  const shown = !listenHost || listenHost === '0.0.0.0' || listenHost === '::' ? 'localhost' : listenHost;
  console.log(`FrozenEarth server on http://${shown}:${port}${base}/  (world "${worldName}"${game.passwordProtected ? ', password protected' : ', no password'})`);
  if (!listenHost || listenHost === '0.0.0.0' || listenHost === '::') {
    // Addresses other machines on the network can use.
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${port}${base}/`);
    }
  }
  console.log(`  host key for /claim: in ${game.hostKeyPath}`);
  if (ownConsole) console.log('  type "help" here for host commands (or /help in the game chat)');
});
game.start();

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down…');
  game.stop();
  game.save();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  wss.close();
  http.close();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => shutdown(0));

// Anything that escapes here is a server bug outside the sim (the tick loop catches its own). The
// world is between ticks, so it is consistent: save it (the previous save stays as world.bak) and exit
// non-zero so a supervisor restarts the server.
process.on('uncaughtException', (e) => {
  console.error('FATAL: uncaught exception:', e);
  shutdown(1);
});
process.on('unhandledRejection', (e) => console.error('Unhandled promise rejection:', e));

// The host's console: the same commands as /commands in chat, with the console as host. Only in a
// real terminal: isatty() looks at the descriptors without touching process.stdin, because merely
// opening process.stdin on an inherited pipe (as under `npm run dev` with concurrently) blocks the
// whole process on Windows.
const ownConsole = isatty(0) && isatty(1) && !args['no-console'] && !env.npm_lifecycle_event?.startsWith('dev');
if (ownConsole) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    const cmd = line.trim();
    if (!cmd) return;
    if (/^(quit|exit|stop)$/i.test(cmd)) return shutdown(0);
    for (const out of game.command(cmd.replace(/^\//, ''), null)) console.log(`  ${out}`);
  });
  // With readline on a terminal, Ctrl+C arrives here instead of as a process signal (Windows too).
  rl.on('SIGINT', () => shutdown(0));
}
