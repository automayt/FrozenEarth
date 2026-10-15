/**
 * Headless load/sync test: N bots join a running server, issue random valid commands,
 * then check that every bot's mirror agrees on the world.
 *
 *   npm run bots -- --url ws://localhost:8090/ws --bots 8 --minutes 2
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { decode, encode, Mirror, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import { BUILDINGS, SOWABLE_PLANTS, WORK_TYPES } from '@fe/defs';
import type { Command, Entity } from '@fe/sim';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:8090/ws' },
    bots: { type: 'string', default: '8' },
    minutes: { type: 'string', default: '2' },
    password: { type: 'string' },
    speed: { type: 'string', default: '3' },
  },
});

interface Bot {
  name: string;
  ws: WebSocket;
  mirror: Mirror;
  faction: number;
  bytes: number;
  deltas: number;
  errors: string[];
  welcomed: boolean;
}

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: readonly T[]) => a[rand(a.length)];

function randomCommand(b: Bot): Command | null {
  const f = b.mirror.factions.get(b.faction);
  if (!f) return null;
  const x = f.home.x + rand(31) - 15;
  const y = f.home.y + rand(31) - 15;
  const r = { x0: x, y0: y, x1: x + rand(6), y1: y + rand(6) };
  const pawns = [...b.mirror.entities.values()].filter((e) => e.kind === 'pawn' && e.faction === b.faction);
  switch (rand(7)) {
    case 0:
      return { c: 'designate', kind: pick(['mine', 'chop', 'cut', 'harvest'] as const), ...r };
    case 1:
      return { c: 'build', def: pick(Object.keys(BUILDINGS)), hollow: true, ...r };
    case 2:
      return { c: 'zone', kind: 'stockpile', ...r };
    case 3:
      return { c: 'zone', kind: 'grow', plant: pick(SOWABLE_PLANTS).key, ...r };
    case 4:
      return pawns.length ? { c: 'setPriority', pawn: pick(pawns).id, work: pick(WORK_TYPES), prio: rand(5) } : null;
    case 5:
      return { c: 'designate', kind: 'cancel', ...r };
    default: {
      // Deliberately invalid: poke at another faction's pawn. The server must ignore it.
      const foreign = [...b.mirror.entities.values()].find((e) => e.kind === 'pawn' && e.faction !== b.faction);
      return foreign ? { c: 'setPriority', pawn: foreign.id, work: 'haul', prio: 0 } : null;
    }
  }
}

function connectBot(i: number): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(args.url!);
    const b: Bot = { name: `Bot${i}-${rand(1e4)}`, ws, mirror: new Mirror(), faction: 0, bytes: 0, deltas: 0, errors: [], welcomed: false };
    const send = (m: ClientMsg) => ws.readyState === ws.OPEN && ws.send(encode(m));
    ws.on('open', () => send({ t: 'hello', v: PROTOCOL_VERSION, name: b.name, password: args.password }));
    ws.on('message', (data: Buffer) => {
      b.bytes += data.length;
      const msg = decode<ServerMsg>(data);
      if (msg.t === 'welcome') {
        b.mirror.applySnapshot(msg.snap);
        b.faction = msg.faction;
        b.welcomed = true;
        send({ t: 'speed', speed: Number(args.speed) });
        resolve(b);
      } else if (msg.t === 'delta') {
        b.mirror.applyDelta(msg.d);
        b.deltas++;
      } else if (msg.t === 'error') {
        b.errors.push(msg.msg);
        if (msg.fatal) reject(new Error(`${b.name}: ${msg.msg}`));
      }
    });
    ws.on('error', reject);
  });
}

/** Stable fingerprint of the coarse-grained state every client must agree on. */
function fingerprint(m: Mirror): string {
  const ents = [...m.entities.values()]
    .sort((a, b) => a.id - b.id)
    .map((e: Entity) => (e.kind === 'pawn' ? `${e.id}:pawn:${e.faction}` : e.kind === 'item' ? `${e.id}:item:${e.def}:${e.count}:${e.x},${e.y}` : `${e.id}:${e.kind}:${e.def}:${e.x},${e.y}`));
  let h = 0x811c9dc5;
  const s = ents.join('|') + '#' + Array.from(m.rock).join('') + '#' + Array.from(m.desig).join('');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${m.entities.size} ents, hash ${(h >>> 0).toString(16)}`;
}

async function main() {
  const n = Number(args.bots);
  const minutes = Number(args.minutes);
  console.log(`Connecting ${n} bots to ${args.url} for ${minutes} min…`);
  const bots = await Promise.all(Array.from({ length: n }, (_, i) => connectBot(i + 1)));
  const end = Date.now() + minutes * 60_000;
  let cmds = 0;
  const timer = setInterval(() => {
    for (const b of bots) {
      if (Math.random() < 0.5) continue;
      const cmd = randomCommand(b);
      if (cmd) {
        b.ws.send(encode({ t: 'cmd', cmd }));
        cmds++;
      }
    }
  }, 500);
  const report = setInterval(() => {
    const kb = bots.reduce((a, b) => a + b.bytes, 0) / 1024;
    console.log(`tick ${bots[0].mirror.tick} · ${cmds} cmds · ${kb.toFixed(0)} KB received total · ${bots[0].mirror.entities.size} entities`);
  }, 10_000);
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
  clearInterval(timer);
  // Pause so the world stops changing, then let the last deltas arrive.
  for (const b of bots) b.ws.send(encode({ t: 'speed', speed: 0 }));
  await new Promise((r) => setTimeout(r, 2500));
  clearInterval(report);

  const prints = bots.map((b) => fingerprint(b.mirror));
  const agree = prints.every((p) => p === prints[0]);
  for (const b of bots) {
    const own = [...b.mirror.entities.values()].filter((e) => e.kind === 'pawn' && e.faction === b.faction).length;
    console.log(`${b.name.padEnd(12)} faction ${b.faction} · ${own} pawns · ${b.deltas} deltas · ${(b.bytes / 1024).toFixed(0)} KB · ${b.errors.length} errors`);
  }
  console.log(agree ? `PASS: all ${n} clients agree (${prints[0]})` : `FAIL: clients disagree:\n${prints.join('\n')}`);
  for (const b of bots) b.ws.close();
  process.exit(agree ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
