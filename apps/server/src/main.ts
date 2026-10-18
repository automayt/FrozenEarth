import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isatty } from 'node:tty';
import { parseArgs } from 'node:util';
import { attachSockets } from './edge';
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
const http = createServer(
  staticHandler(resolve(import.meta.dirname, '../../client/dist'), {
    base,
    health: () => ({ day: game.world.day(), online: [...game.players.values()].filter((p) => p.ws).length, halted: !!game.halted }),
  }),
);
http.headersTimeout = 20_000;
http.requestTimeout = 30_000;
const wss = attachSockets(http, (ws, ip) => game.onConnect(ws, ip), {
  base,
  trustProxy: args['trust-proxy']!,
  allowOrigins: args['allow-origin']!.split(','),
  maxConnections: Number(args['max-connections']) || 32,
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
