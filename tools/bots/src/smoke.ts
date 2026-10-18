/**
 * End-to-end smoke test: start the real server on a free port, connect headless clients, settle
 * them, have them play (including direct control, sneaking, stealing, hunting and trading with
 * settlements, with raids on colonies and settlements), then pause, have the server save, and
 * check that every client's mirror matches the saved world on everything clients see.
 *
 *   npm run smoke            (about 30 s)
 *   npm run smoke -- --seconds 60 --bots 6
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { decode, encode, Mirror, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import { deserializeWorld, Rng, type Pawn } from '@fe/sim';
import { loadWorldFile, worldPath } from '../../../apps/server/src/persistence';
import { Chaos, type ChaosKind } from './chaos';
import { differences } from './visible';

const { values: args } = parseArgs({
  options: {
    bots: { type: 'string', default: '4' },
    seconds: { type: 'string', default: '20' },
    seed: { type: 'string', default: '7' },
    'port-from': { type: 'string', default: '8110' },
    'port-to': { type: 'string', default: '8130' },
  },
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const log = (s: string) => console.log(`[smoke] ${s}`);

async function freePort(from: number, to: number): Promise<number> {
  for (let p = from; p <= to; p++) {
    const ok = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(p, () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`No free port in ${from}-${to}`);
}

function startServer(port: number, saves: string): Promise<ChildProcess> {
  const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(
    process.execPath,
    [tsx, 'apps/server/src/main.ts', '--port', String(port), '--world', 'smoke', '--saves', saves, '--seed', args.seed!, '--size', '110', '--frost-start', '0', '--frost-pace', '40'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Server did not start within 20 s')), 20_000);
    let out = '';
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.includes(`localhost:${port}`)) {
        clearTimeout(timer);
        res(child);
      }
    });
    child.stderr!.on('data', (b: Buffer) => process.stderr.write(b));
    child.once('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`Server exited early (${code}):\n${out}`));
    });
  });
}

interface Client {
  name: string;
  ws: WebSocket;
  mirror: Mirror;
  faction: number;
  errors: string[];
  sent: Map<ChaosKind, number>;
  /** Newer pawn states seen arriving in deltas. */
  seen: Set<string>;
  send(m: ClientMsg): void;
}

function connect(url: string, name: string): Promise<Client> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const c: Client = {
      name,
      ws,
      mirror: new Mirror(),
      faction: 0,
      errors: [],
      sent: new Map(),
      seen: new Set(),
      send: (m) => {
        if (ws.readyState === ws.OPEN) ws.send(encode(m));
      },
    };
    ws.on('open', () => c.send({ t: 'hello', v: PROTOCOL_VERSION, name }));
    ws.on('message', (data: Buffer) => {
      const msg = decode<ServerMsg>(data);
      if (msg.t === 'welcome') {
        c.mirror.applySnapshot(msg.snap);
        c.faction = msg.faction;
        c.send({ t: 'speed', speed: 3 });
        if (!msg.faction) c.send({ t: 'settle' });
      } else if (msg.t === 'settled') {
        // Ready once the colony itself has arrived in a delta.
        c.faction = msg.faction;
      } else if (msg.t === 'delta') {
        c.mirror.applyDelta(msg.d);
        if (c.faction && c.mirror.factions.has(c.faction)) res(c);
        for (const e of [...msg.d.ents, ...(msg.d.patches ?? []).map((p) => c.mirror.get(p.id)!)]) {
          if (e?.kind !== 'pawn') continue;
          if (e.possessed) c.seen.add('possessed');
          if (e.sneaking) c.seen.add('sneaking');
          if (e.hunted) c.seen.add('hunted');
          if (e.job?.type === 'haul' && e.job.stolen) c.seen.add('stealing');
        }
        for (const f of msg.d.factions) if (f.raid) c.seen.add(c.mirror.factions.get(f.raid.target)?.settlement ? 'settlement-raid' : 'raid');
      } else if (msg.t === 'error') {
        c.errors.push(msg.msg);
        if (msg.fatal) rej(new Error(`${name}: ${msg.msg}`));
        if (!c.faction) c.send({ t: 'settle' });
      }
    });
    ws.on('error', rej);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kinds every run must send at least once (when there is something to do it with). */
const MUST: ChaosKind[] = ['possess', 'steer', 'sneak', 'interact', 'steal', 'hunt', 'settlementTrade', 'attack', 'move', 'build'];

async function main() {
  const t0 = Date.now();
  const saves = mkdtempSync(join(tmpdir(), 'fe-smoke-'));
  const port = await freePort(Number(args['port-from']), Number(args['port-to']));
  const url = `ws://127.0.0.1:${port}/ws`;
  let server: ChildProcess | null = null;
  const clients: Client[] = [];
  let failed = false;
  try {
    server = await startServer(port, saves);
    log(`server up on port ${port} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const n = Math.max(2, Number(args.bots));
    for (let i = 0; i < n - 1; i++) clients.push(await connect(url, `Smoke${i + 1}`));
    const host = clients[0];
    const rng = new Rng(Number(args.seed));
    const chaosFor = (c: Client) =>
      new Chaos(rng, {
        get w() {
          return c.mirror.w;
        },
        get h() {
          return c.mirror.h;
        },
        entities: c.mirror.entities,
        factions: c.mirror.factions,
        zones: c.mirror.zones,
        zoneAt: c.mirror.zoneAt,
        get choices() {
          return c.mirror.choices;
        },
      });
    const chaos = new Map(clients.map((c) => [c, chaosFor(c)]));
    const order = (c: Client, kind: ChaosKind) => {
      const cmd = chaos.get(c)!.make(c.faction, kind);
      if (!cmd) return false;
      c.send({ t: 'cmd', cmd });
      c.sent.set(kind, (c.sent.get(kind) ?? 0) + 1);
      return true;
    };
    // Give every colony a stockpile, and set raiders on the host and on a settlement.
    for (const c of clients) {
      const f = c.mirror.factions.get(c.faction)!;
      c.send({ t: 'cmd', cmd: { c: 'zone', kind: 'stockpile', x0: f.home.x - 2, y0: f.home.y - 2, x1: f.home.x + 2, y1: f.home.y + 2 } });
    }
    host.send({ t: 'admin', action: 'event', key: 'raid' });
    host.send({ t: 'admin', action: 'event', key: 'settlement_raid' });

    const end = Date.now() + Number(args.seconds) * 1000;
    let tick = 0;
    while (Date.now() < end) {
      tick++;
      for (const c of clients) {
        // Work through the must-haves first, then play at random.
        const todo = MUST.filter((k) => !c.sent.has(k));
        if (!(todo.length && order(c, todo[0]))) {
          const got = chaos.get(c)!.random(c.faction);
          if (got) {
            c.send({ t: 'cmd', cmd: got.cmd });
            c.sent.set(got.kind, (c.sent.get(got.kind) ?? 0) + 1);
          }
        }
        // Keep steering anyone possessed.
        if (tick % 3 === 0) order(c, 'steer');
      }
      // Someone joins late, from a snapshot of a world in full swing.
      if (clients.length < n && Date.now() > end - Number(args.seconds) * 500) {
        const late = await connect(url, `Smoke${clients.length + 1}`);
        clients.push(late);
        chaos.set(late, chaosFor(late));
        log(`late joiner at tick ${late.mirror.tick}`);
      }
      await sleep(150);
    }

    // Stop the world, let the last deltas land, then have the server write it out.
    for (const c of clients) c.send({ t: 'speed', speed: 0 });
    await sleep(800);
    host.send({ t: 'admin', action: 'save' });
    await sleep(800);
    const file = loadWorldFile(worldPath(saves, 'smoke'));
    if (!file) throw new Error('Server did not save');
    const world = deserializeWorld(file.save);

    for (const c of clients) {
      const diffs = differences(c.mirror, world, c.faction);
      const own = [...c.mirror.entities.values()].filter((e): e is Pawn => e.kind === 'pawn' && e.faction === c.faction).length;
      const sent = [...c.sent.values()].reduce((a, b) => a + b, 0);
      log(`${c.name}: faction ${c.faction}, ${own} pawns, ${sent} commands, saw ${[...c.seen].sort().join('/') || 'nothing new'}, ${diffs.length ? `${diffs.length} DIFFERENCES` : 'in sync'}`);
      for (const d of diffs.slice(0, 8)) log(`  ${d}`);
      if (diffs.length) failed = true;
      if (c.errors.some((e) => !/Too close|already frozen|Not enough open/.test(e))) log(`  errors: ${c.errors.join(' | ')}`);
    }
    const sentAll = new Set(clients.flatMap((c) => [...c.sent.keys()]));
    const missing = MUST.filter((k) => !sentAll.has(k));
    if (missing.length) {
      log(`never had a chance to send: ${missing.join(', ')}`);
      failed = true;
    }
    if (!clients.some((c) => c.seen.has('possessed'))) {
      log('no client ever saw a possessed colonist');
      failed = true;
    }
    log(`world at tick ${world.tick}, ${world.entities.size} entities; ${failed ? 'FAIL' : 'PASS'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    for (const c of clients) c.ws.close();
    server?.kill();
    await sleep(300);
    rmSync(saves, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

void main();
