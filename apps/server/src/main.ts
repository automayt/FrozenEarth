import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import { GameServer } from './game';
import { worldPath } from './persistence';
import { staticHandler } from './static';

const { values: args } = parseArgs({
  options: {
    world: { type: 'string', default: 'default' },
    port: { type: 'string', default: process.env.FE_PORT ?? '8090' },
    password: { type: 'string', default: process.env.FE_PASSWORD },
    seed: { type: 'string' },
    size: { type: 'string', default: '200' },
    'frost-start': { type: 'string', default: process.env.FE_FROST_START },
    'frost-pace': { type: 'string', default: process.env.FE_FROST_PACE },
    saves: { type: 'string', default: 'saves' },
  },
});

const savePath = worldPath(resolve(args.saves!), args.world!);
const game = new GameServer({
  savePath,
  password: args.password || undefined,
  seed: args.seed ? Number(args.seed) : undefined,
  size: Math.max(60, Math.min(400, Number(args.size) || 200)),
  frostStart: args['frost-start'] !== undefined ? Number(args['frost-start']) : undefined,
  frostPace: args['frost-pace'] !== undefined ? Number(args['frost-pace']) : undefined,
});

const http = createServer(staticHandler(resolve(import.meta.dirname, '../../client/dist')));
const wss = new WebSocketServer({ server: http, path: '/ws', perMessageDeflate: { threshold: 1024 } });
wss.on('connection', (ws) => game.onConnect(ws));

const port = Number(args.port);
http.listen(port, () => {
  console.log(`FrozenEarth server on http://localhost:${port}  (world "${args.world}"${args.password ? ', password protected' : ''})`);
  // Addresses other machines on the network can use.
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${port}`);
  }
});
game.start();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  game.stop();
  try {
    game.save();
  } catch (e) {
    console.error('Save failed on shutdown:', e);
  }
  wss.close();
  http.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, shutdown);
