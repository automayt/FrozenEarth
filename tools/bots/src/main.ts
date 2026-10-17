/**
 * Headless load/sync test: N bots join a running server and play it with the same command
 * generator the fuzz tests and smoke test use (every command the client can send: building,
 * fighting, steering and sneaking, stealing, hunting, trading, letters), plus a share of
 * cross-colony and malformed commands the server must shrug off. Now and then a bot drops its
 * connection mid-game and comes back with its token. At the end every bot's mirror must agree.
 *
 *   npm run bots -- --url ws://localhost:8090/ws --bots 8 --minutes 2 [--hostile 0.1] [--churn 20]
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { decode, encode, Mirror, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import type { Command, Entity } from '@fe/sim';
import { Chaos, type ChaosKind } from './chaos';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:8090/ws' },
    bots: { type: 'string', default: '8' },
    minutes: { type: 'string', default: '2' },
    password: { type: 'string' },
    speed: { type: 'string', default: '3' },
    /** Share of commands that are deliberately invalid: another colony's pawns, garbage fields. */
    hostile: { type: 'string', default: '0.1' },
    /** Seconds between one bot dropping and rejoining (0 = never). */
    churn: { type: 'string', default: '20' },
  },
});

interface Bot {
  name: string;
  ws: WebSocket;
  mirror: Mirror;
  chaos: Chaos;
  faction: number;
  token: string;
  bytes: number;
  deltas: number;
  errors: string[];
  welcomed: boolean;
  sent: Map<string, number>;
}

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: readonly T[]) => a[rand(a.length)];

/** A bot's generator reads its own mirror; getters, because a rejoin replaces the mirror's maps. */
function chaosFor(b: Bot): Chaos {
  return new Chaos(
    { next: Math.random },
    {
      get w() {
        return b.mirror.w;
      },
      get h() {
        return b.mirror.h;
      },
      get entities() {
        return b.mirror.entities;
      },
      get factions() {
        return b.mirror.factions;
      },
      get zones() {
        return b.mirror.zones;
      },
      get zoneAt() {
        return b.mirror.zoneAt;
      },
      get choices() {
        return b.mirror.choices;
      },
    },
  );
}

/** Values that have broken naive validation somewhere. */
const JUNK: unknown[] = [null, -1, 0, NaN, 1e308, '', '__proto__', 'constructor', [], {}, [['__proto__', 1]], { toString: 1, valueOf: 1 }];

/** Orders aimed at someone else's colonists or letters, or with fields of the wrong type. */
function hostileCommand(b: Bot): Command | null {
  const foreign = [...b.mirror.entities.values()].filter((e): e is Extract<Entity, { kind: 'pawn' }> => e.kind === 'pawn' && e.faction !== b.faction && !e.species);
  const theirs = foreign.length ? pick(foreign).id : 1;
  const letter = b.mirror.choices.find((c) => c.faction !== b.faction);
  const options: unknown[] = [
    { c: 'possess', pawn: theirs, on: true },
    { c: 'steer', pawn: theirs, dx: 1, dy: 0 },
    { c: 'sneak', pawn: theirs, on: true },
    { c: 'interact', pawn: theirs },
    { c: 'draft', pawns: [theirs], on: true },
    { c: 'setPriority', pawn: theirs, work: 'haul', prio: 0 },
    { c: 'release', pawn: theirs },
    { c: 'equip', pawn: theirs, item: 0 },
    letter ? { c: 'choose', choice: letter.id, option: letter.options[0].key } : null,
    { c: pick(['build', 'zone', 'setPriority', 'settlementTrade', 'offerTrade', 'steal', 'move'] as const), def: pick(JUNK), kind: pick(JUNK), pawn: pick(JUNK), pawns: pick(JUNK), give: pick(JUNK), want: pick(JUNK), x0: pick(JUNK), y0: 0, x1: 3, y1: 3, x: pick(JUNK), y: 1 },
  ];
  return pick(options) as Command | null;
}

function connectBot(name: string, token?: string, into?: Bot): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(args.url!);
    const b: Bot = into ?? ({ name, mirror: new Mirror(), faction: 0, token: '', bytes: 0, deltas: 0, errors: [], welcomed: false, sent: new Map() } as unknown as Bot);
    b.ws = ws;
    b.mirror = new Mirror();
    b.chaos ??= chaosFor(b);
    const send = (m: ClientMsg) => ws.readyState === ws.OPEN && ws.send(encode(m));
    ws.on('open', () => send({ t: 'hello', v: PROTOCOL_VERSION, name: b.name, password: args.password, token }));
    ws.on('message', (data: Buffer) => {
      b.bytes += data.length;
      const msg = decode<ServerMsg>(data);
      if (msg.t === 'welcome') {
        b.mirror.applySnapshot(msg.snap);
        b.faction = msg.faction;
        b.token = msg.token;
        b.welcomed = true;
        send({ t: 'speed', speed: Number(args.speed) });
        // Half the bots take a suggested site, half let the server choose.
        if (!msg.faction) send(msg.sites?.length && Math.random() < 0.5 ? { t: 'settle', ...msg.sites[0] } : { t: 'settle' });
        else resolve(b);
      } else if (msg.t === 'settled') {
        b.faction = msg.faction;
        resolve(b);
      } else if (msg.t === 'delta') {
        b.mirror.applyDelta(msg.d);
        // Nothing renders here, so drain what a renderer would.
        b.mirror.changedEnts.clear();
        b.mirror.removedEnts.clear();
        b.mirror.changedCells.clear();
        b.mirror.shots.length = 0;
        b.deltas++;
      } else if (msg.t === 'error') {
        b.errors.push(msg.msg);
        if (msg.fatal) reject(new Error(`${b.name}: ${msg.msg}`));
        // Suggested site got taken by another bot: let the server choose.
        if (!b.faction) send({ t: 'settle' });
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
  const hostile = Number(args.hostile);
  const churn = Number(args.churn) * 1000;
  console.log(`Connecting ${n} bots to ${args.url} for ${minutes} min…`);
  const bots = await Promise.all(Array.from({ length: n }, (_, i) => connectBot(`Bot${i + 1}-${rand(1e4)}`)));
  const end = Date.now() + minutes * 60_000;
  // The first bot on a fresh world is the host: set raiders on it and on a settlement so raids get sync-checked too.
  bots[0].ws.send(encode({ t: 'admin', action: 'event', key: 'raid' }));
  bots[0].ws.send(encode({ t: 'admin', action: 'event', key: 'settlement_raid' }));
  let cmds = 0;
  let rejoins = 0;
  const kinds = new Map<ChaosKind | 'hostile', number>();
  const timer = setInterval(() => {
    for (const b of bots) {
      if (b.ws.readyState !== b.ws.OPEN || !b.faction || Math.random() < 0.5) continue;
      let cmd: Command | null = null;
      let kind: ChaosKind | 'hostile' = 'hostile';
      if (Math.random() < hostile) cmd = hostileCommand(b);
      else {
        const got = b.chaos.random(b.faction);
        if (got) ({ cmd, kind } = got);
      }
      if (!cmd) continue;
      b.ws.send(encode({ t: 'cmd', cmd }));
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      cmds++;
      // Keep steering anyone possessed, as a player holding WASD would.
      const steer = b.chaos.make(b.faction, 'steer');
      if (steer) b.ws.send(encode({ t: 'cmd', cmd: steer }));
    }
  }, 500);
  // Players come and go: one drops (maybe mid-steer, mid-theft) and rejoins with its token.
  const churner =
    churn > 0
      ? setInterval(() => {
          const b = pick(bots.slice(1));
          if (!b || b.ws.readyState !== b.ws.OPEN) return;
          b.ws.close();
          setTimeout(() => {
            connectBot(b.name, b.token, b)
              .then(() => rejoins++)
              .catch((e) => b.errors.push(String(e)));
          }, 1500);
        }, churn)
      : null;
  const report = setInterval(() => {
    const kb = bots.reduce((a, b) => a + b.bytes, 0) / 1024;
    console.log(`tick ${bots[0].mirror.tick} · ${cmds} cmds · ${rejoins} rejoins · ${kb.toFixed(0)} KB received total · ${bots[0].mirror.entities.size} entities`);
  }, 10_000);
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
  clearInterval(timer);
  if (churner) clearInterval(churner);
  // Let any rejoin finish, pause so the world stops changing, then let the last deltas arrive.
  await new Promise((r) => setTimeout(r, 2500));
  for (const b of bots) if (b.ws.readyState === b.ws.OPEN) b.ws.send(encode({ t: 'speed', speed: 0 }));
  await new Promise((r) => setTimeout(r, 2500));
  clearInterval(report);

  const live = bots.filter((b) => b.ws.readyState === b.ws.OPEN);
  const prints = live.map((b) => fingerprint(b.mirror));
  const agree = live.length === bots.length && prints.every((p) => p === prints[0]);
  for (const b of bots) {
    const own = [...b.mirror.entities.values()].filter((e) => e.kind === 'pawn' && e.faction === b.faction).length;
    console.log(`${b.name.padEnd(12)} faction ${b.faction} · ${own} pawns · ${b.deltas} deltas · ${(b.bytes / 1024).toFixed(0)} KB · ${b.errors.length} errors${b.ws.readyState === b.ws.OPEN ? '' : ' · DISCONNECTED'}`);
  }
  console.log(`commands: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(agree ? `PASS: all ${n} clients agree (${prints[0]})` : `FAIL: clients disagree or dropped:\n${prints.join('\n')}`);
  for (const b of bots) b.ws.close();
  process.exit(agree ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
