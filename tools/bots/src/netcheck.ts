/**
 * Multiplayer under real network conditions. Runs the game server in this process (so every
 * client can be compared with the true world at any moment), puts each bot behind its own lag
 * proxy (latency, jitter, TCP-style loss), plays a busy game at 3x with raids, and along the way:
 *
 *   - checks every few deltas that each bot's pawns hash the same as the server's did at that tick,
 *   - stalls two links for 3 and 5 s, cuts one mid-raid (with a pact, a trade offer and a steered
 *     colonist in play) and checks what comes back on reconnect, and black-holes one (open but
 *     silent) to see how long the server keeps counting it as online,
 *   - pauses for full field-by-field comparisons (the smoke test's check) a few times,
 *   - renders each bot's pawns at 30 fps the way the client does and counts clock backsteps,
 *     freezes, jumps, and how far drawn pawns are from where the server has them.
 *
 *   npm run netcheck -- [--seconds 90] [--seed 7] [--size 160] [--quiet]
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import { decode, encode, Mirror, pawnPosition, PROTOCOL_VERSION, TickClock, type ClientMsg, type ServerMsg } from '@fe/protocol';
import type { Choice, Entity, Pawn } from '@fe/sim';
import { GameServer } from '../../../apps/server/src/game';
import { worldPath } from '../../../apps/server/src/persistence';
import { Chaos } from './chaos';
import { LagProxy, PROFILES, type LagProfile } from './lagproxy';
import { differences, visibleEntity } from './visible';

const { values: args } = parseArgs({
  options: {
    seconds: { type: 'string', default: '90' },
    seed: { type: 'string', default: '7' },
    size: { type: 'string', default: '160' },
    quiet: { type: 'boolean', default: false },
    /** 'old' draws with protocol 8's clock (extrapolate up to 0.3 s past the newest delta, pull back on arrival). */
    clock: { type: 'string', default: 'new' },
  },
});

const SECONDS = Number(args.seconds);

/** The client clock before TickClock, for before/after comparisons. */
class OldClock {
  private lastTick = 0;
  private lastAt = 0;
  private t = { speed: 0, paused: true };
  setTime(t: { speed: number; paused: boolean }): void {
    this.t = t;
  }
  estTick(): number {
    if (this.t.paused) return this.lastTick;
    return this.lastTick + Math.min((performance.now() - this.lastAt) / 1000, 0.3) * 60 * this.t.speed;
  }
  setServerTick(tick: number): void {
    const est = this.estTick();
    this.lastTick = Math.abs(est - tick) > 120 ? tick : Math.max(tick, Math.min(est, tick + 20));
    this.lastAt = performance.now();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[net] ${s}`);
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

/** Pawns as a client sees them, hashed. */
function pawnHash(ents: Iterable<Entity>): string {
  const ps = [...ents].filter((e): e is Pawn => e.kind === 'pawn').sort((a, b) => a.id - b.id);
  let h = 0x811c9dc5;
  const s = JSON.stringify(ps.map(visibleEntity));
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${ps.length}:${(h >>> 0).toString(16)}`;
}

interface Stats {
  hashOk: number;
  hashBad: number;
  hashSkipped: number;
  firstBad: string;
  frames: number;
  backsteps: number;
  backTicks: number;
  freezes: number;
  jumps: number;
  pawnFrames: number;
  errSum: number;
  lagSum: number;
  errs: number[];
  reconnects: number;
}

interface Bot {
  name: string;
  profileName: string;
  proxy: LagProxy;
  ws: WebSocket;
  mirror: Mirror;
  clock: Pick<TickClock, 'estTick' | 'setServerTick' | 'setTime'>;
  time: { speed: number; paused: boolean };
  faction: number;
  token: string;
  bytes: number;
  deltas: number;
  lastMsgAt: number;
  chaos: Chaos;
  stats: Stats;
  prevEst: number;
  prevPos: Map<number, { x: number; y: number }>;
  welcomed: Promise<void>;
  /** Mirror rebuilt from a snapshot since the last frame: no jump counting across it. */
  fresh: boolean;
}

async function main() {
  const saves = mkdtempSync(join(tmpdir(), 'fe-net-'));
  const game = new GameServer({ savePath: worldPath(saves, 'net'), seed: Number(args.seed), size: Number(args.size), frostStart: 99, log: args.quiet ? () => {} : (m) => log(`server: ${m}`) });
  const world = () => game.world;
  // What every pawn looked like at each broadcast tick, to check bots against as their deltas land.
  const truth = new Map<number, string>();
  /** Ticks broadcast more than once (commands applied while paused): which state a bot saw is ambiguous. */
  const ambiguous = new Set<number>();
  const truthJson = new Map<number, Map<number, string>>();
  const broadcast = game.broadcast.bind(game);
  let hashEvery = 0;
  game.broadcast = (msg: ServerMsg) => {
    if (msg.t === 'delta' && (truth.has(world().tick) || hashEvery++ % 3 === 0)) {
      if (truth.has(world().tick)) ambiguous.add(world().tick);
      truth.set(world().tick, pawnHash(world().entities.values()));
      if (process.env.NET_DEBUG) {
        truthJson.set(world().tick, new Map([...world().kinds.pawn].map((id) => [id, JSON.stringify(visibleEntity(world().get(id)!))])));
        if (truthJson.size > 60) truthJson.delete(truthJson.keys().next().value!);
      }
      if (truth.size > 3000) truth.delete(truth.keys().next().value!);
    }
    broadcast(msg);
  };
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/ws', perMessageDeflate: { threshold: 1024 } });
  wss.on('connection', (ws) => game.onConnect(ws));
  const port = await new Promise<number>((res) => http.listen(0, '127.0.0.1', () => res((http.address() as { port: number }).port)));
  game.start();

  const profiles: [string, LagProfile][] = [
    ['lan', PROFILES.lan],
    ['good', PROFILES.good],
    ['good', PROFILES.good],
    ['far', PROFILES.far],
    ['far', PROFILES.far],
    ['wifi', PROFILES.wifi],
    ['wifi', PROFILES.wifi],
    ['bad', PROFILES.bad],
  ];
  const bots: Bot[] = [];


  function open(b: Bot, proxyPort: number, token?: string): Promise<void> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`, { perMessageDeflate: true });
      b.ws = ws;
      b.mirror = new Mirror();
      b.fresh = true;
      const send = (m: ClientMsg) => ws.readyState === ws.OPEN && ws.send(encode(m));
      ws.on('open', () => send({ t: 'hello', v: PROTOCOL_VERSION, name: b.name, token }));
      ws.on('message', (data: Buffer) => {
        if (b.ws !== ws) return;
        b.bytes += data.length;
        b.lastMsgAt = Date.now();
        const msg = decode<ServerMsg>(data);
        if (msg.t === 'welcome') {
          b.mirror.applySnapshot(msg.snap);
          b.clock.setServerTick(msg.snap.tick);
          b.faction = msg.faction;
          b.token = msg.token;
          b.fresh = true;
          // Like the real client, a bot votes once; a rejoin keeps whatever the server kept.
          if (!b.token || b.token !== msg.token || !b.deltas) send({ t: 'speed', speed: 3 });
          if (!msg.faction) send({ t: 'settle' });
          else res();
        } else if (msg.t === 'settled') {
          b.faction = msg.faction;
          res();
        } else if (msg.t === 'delta') {
          b.mirror.applyDelta(msg.d);
          b.clock.setServerTick(msg.d.tick);
          b.clock.setTime(msg.time);
          b.time = msg.time;
          b.mirror.changedEnts.clear();
          b.mirror.removedEnts.clear();
          b.mirror.changedCells.clear();
          b.mirror.shots.length = 0;
          b.deltas++;
          const want = truth.get(msg.d.tick);
          if (want === undefined || ambiguous.has(msg.d.tick)) b.stats.hashSkipped++;
          else {
            const got = pawnHash(b.mirror.entities.values());
            if (got === want) b.stats.hashOk++;
            else {
              b.stats.hashBad++;
              const tj = truthJson.get(msg.d.tick);
              if (tj && b.stats.hashBad < 3) {
                for (const [id, z] of tj) {
                  const a = JSON.stringify(visibleEntity(b.mirror.get(id)!));
                  if (a !== z) {
                    let i = 0;
                    while (a[i] === z[i]) i++;
                    log(`  ${b.name} pawn ${id} differs at ...${a.slice(Math.max(0, i - 100), i + 60)}
     vs ...${z.slice(Math.max(0, i - 100), i + 60)}`);
                    break;
                  }
                }
              }
              b.stats.firstBad ||= `tick ${msg.d.tick}: ${got} vs ${want}`;
            }
          }
        } else if (msg.t === 'players') {
          b.clock.setTime(msg.time);
          b.time = msg.time;
        } else if (msg.t === 'error' && msg.fatal) rej(new Error(`${b.name}: ${msg.msg}`));
      });
      ws.on('error', () => {});
    });
  }

  const stats = (): Stats => ({ hashOk: 0, hashBad: 0, hashSkipped: 0, firstBad: '', frames: 0, backsteps: 0, backTicks: 0, freezes: 0, jumps: 0, pawnFrames: 0, errSum: 0, lagSum: 0, errs: [], reconnects: 0 });
  const proxyPorts = new Map<Bot, number>();
  for (let i = 0; i < profiles.length; i++) {
    const [pn, profile] = profiles[i];
    const proxy = new LagProxy(port, { ...profile });
    const pport = await proxy.listen(0);
    const b = {
      name: `Net${i + 1}-${pn}`,
      profileName: pn,
      proxy,
      clock: args.clock === 'old' ? new OldClock() : new TickClock(),
      time: { speed: 0, paused: true },
      faction: 0,
      token: '',
      bytes: 0,
      deltas: 0,
      lastMsgAt: Date.now(),
      stats: stats(),
      prevEst: 0,
      prevPos: new Map(),
      fresh: true,
    } as unknown as Bot;
    b.chaos = new Chaos(
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
    proxyPorts.set(b, pport);
    await open(b, pport);
    bots.push(b);
  }
  log(`${bots.length} bots settled through lag proxies in ${elapsed()} s; world ${args.size}x${args.size}`);
  const send = (b: Bot, m: ClientMsg) => b.ws.readyState === b.ws.OPEN && b.ws.send(encode(m));
  const reconnect = async (b: Bot) => {
    b.stats.reconnects++;
    await open(b, proxyPorts.get(b)!, b.token);
  };

  for (const b of bots) {
    const f = b.mirror.factions.get(b.faction) ?? world().factions.get(b.faction)!;
    send(b, { t: 'cmd', cmd: { c: 'zone', kind: 'stockpile', x0: f.home.x - 2, y0: f.home.y - 2, x1: f.home.x + 2, y1: f.home.y + 2 } });
  }
  send(bots[0], { t: 'admin', action: 'event', key: 'raid' });
  send(bots[0], { t: 'admin', action: 'event', key: 'settlement_raid' });

  // Play: every bot sends a command now and then, and keeps steering anyone it possesses.
  let playing = true;
  const player = setInterval(() => {
    if (!playing) return;
    for (const b of bots) {
      if (b.ws.readyState !== b.ws.OPEN || !b.faction || Math.random() < 0.4) continue;
      const got = b.chaos.random(b.faction);
      if (got && got.kind !== 'choose') send(b, { t: 'cmd', cmd: got.cmd });
      const steer = b.chaos.make(b.faction, 'steer');
      if (steer) send(b, { t: 'cmd', cmd: steer });
    }
  }, 500);

  // Render: what a client draws, 30 times a second.
  const truthPos = (p: Pawn) => pawnPosition(p, world().tick, world().map.w);
  // The same jump detector on the server's own pawns: jumps the sim itself makes (none expected).
  const truthPrev = new Map<number, { x: number; y: number }>();
  let truthJumps = 0;
  let truthPawnFrames = 0;
  const frame = setInterval(() => {
    for (const id of world().kinds.pawn) {
      const e = world().get<Pawn>(id)!;
      if (e.species || !world().factions.get(e.faction)?.isPlayer) continue;
      const pos = truthPos(e);
      const prev = truthPrev.get(id);
      if (prev && Math.hypot(pos.x - prev.x, pos.y - prev.y) > 1.5) truthJumps++;
      truthPrev.set(id, pos);
      truthPawnFrames++;
    }
    for (const b of bots) {
      if (!b.mirror.w) continue;
      const s = b.stats;
      const est = b.clock.estTick();
      s.frames++;
      if (b.fresh) {
        b.fresh = false;
        b.prevEst = est;
        b.prevPos.clear();
        continue;
      }
      if (est < b.prevEst - 1e-6) {
        s.backsteps++;
        s.backTicks += b.prevEst - est;
      } else if (!b.time.paused && est === b.prevEst) s.freezes++;
      b.prevEst = est;
      for (const e of b.mirror.entities.values()) {
        if (e.kind !== 'pawn' || e.species || !world().factions.get(e.faction)?.isPlayer) continue;
        const pos = pawnPosition(e, est, b.mirror.w);
        const prev = b.prevPos.get(e.id);
        if (prev && Math.hypot(pos.x - prev.x, pos.y - prev.y) > 1.5) {
          s.jumps++;
          if (process.env.NET_DEBUG && b.profileName === 'lan') {
            const r = world().get<Pawn>(e.id);
            log(`  jump ${e.id} ${prev.x.toFixed(1)},${prev.y.toFixed(1)} -> ${pos.x.toFixed(1)},${pos.y.toFixed(1)} est ${est.toFixed(0)} srv ${world().tick} job ${e.job?.type}/${r?.job?.type} poss ${!!e.possessed} path ${e.path ? `t0 ${e.path.t0} ${e.path.times.length}` : '-'} / ${r?.path ? `t0 ${r.path.t0}` : '-'} xy ${e.x},${e.y}/${r?.x},${r?.y} drafted ${e.drafted} downed ${e.downed}`);
          }
        }
        b.prevPos.set(e.id, pos);
        const real = world().get<Pawn>(e.id);
        if (real && !b.time.paused) {
          // Where the server had this pawn at the tick being drawn.
          const tp = pawnPosition(real, Math.min(est, world().tick), world().map.w);
          s.lagSum += Math.max(0, world().tick - est) / (60 * Math.max(1, b.time.speed));
          const err = Math.hypot(pos.x - tp.x, pos.y - tp.y);
          s.pawnFrames++;
          s.errSum += err;
          if (s.errs.length < 200_000) s.errs.push(err);
        }
      }
    }
  }, 33);

  const pauseAndCompare = async (label: string) => {
    playing = false;
    for (const b of bots) send(b, { t: 'speed', speed: 0 });
    // Long enough for the slowest link (and any stall) to deliver everything.
    const until = Date.now() + 15_000;
    await sleep(1500);
    while (Date.now() < until) {
      const tick = world().tick;
      if (bots.every((b) => b.mirror.tick === tick && Date.now() - b.lastMsgAt < 2500)) break;
      if (process.env.NET_DEBUG) log(`  waiting: tick ${tick} ${JSON.stringify(game.computeTime())} mirrors ${bots.map((b) => b.mirror.tick).join(',')}`);
      await sleep(250);
    }
    await sleep(1200);
    let bad = 0;
    for (const b of bots) {
      const diffs = differences(b.mirror, world());
      if (diffs.length) {
        bad++;
        log(`  ${label}: ${b.name} ${diffs.length} differences: ${diffs.slice(0, 4).join(' | ')}`);
      }
    }
    log(`${label} at ${elapsed()} s, tick ${world().tick}: ${bad ? `${bad} bots OUT OF SYNC` : 'all bots match the server field for field'}`);
    for (const b of bots) send(b, { t: 'speed', speed: 3 });
    playing = true;
    return bad;
  };

  let failures = 0;
  const at = (frac: number) => sleep(Math.max(0, t0 + frac * SECONDS * 1000 - Date.now()));

  // Stalls: a 3 s and a 5 s hiccup on the wifi and bad links.
  await at(0.15);
  bots[5].proxy.stall(3000);
  log(`stall 3 s on ${bots[5].name}`);
  await at(0.22);
  bots[7].proxy.stall(5000);
  log(`stall 5 s on ${bots[7].name}`);
  await at(0.3);
  failures += await pauseAndCompare('checkpoint 1');

  // A cut mid-raid, with a steered colonist, a pending trade offer, and an alliance on the go.
  const victim = bots[1];
  const partner = bots[2];
  send(bots[0], { t: 'admin', action: 'event', key: 'raid' });
  const mine = [...victim.mirror.entities.values()].find((e): e is Pawn => e.kind === 'pawn' && e.faction === victim.faction && !e.downed);
  if (mine) send(victim, { t: 'cmd', cmd: { c: 'possess', pawn: mine.id, on: true } });
  send(partner, { t: 'cmd', cmd: { c: 'offerTrade', to: victim.faction, give: [], want: [['wood', 1]], note: 'net' } });
  send(victim, { t: 'cmd', cmd: { c: 'diplomacy', act: 'ally', target: partner.faction } });
  await sleep(2500);
  const pactLetter = partner.mirror.choices.find((c) => c.event === 'pact_offer' && c.faction === partner.faction);
  if (pactLetter) send(partner, { t: 'cmd', cmd: { c: 'choose', choice: pactLetter.id, option: 'accept' } });
  await sleep(2000);
  const before = {
    possessed: mine ? !!victim.mirror.get<Pawn>(mine.id)?.possessed : false,
    offers: victim.mirror.choices.filter((c: Choice) => c.faction === victim.faction).map((c) => c.id),
    pact: victim.mirror.factions.get(victim.faction)?.pacts?.[partner.faction]?.kind,
    raid: [...victim.mirror.factions.values()].some((f) => f.raid && !f.raid.fled),
  };
  victim.proxy.cut();
  log(`cut ${victim.name} mid-raid: before ${JSON.stringify(before)}`);
  await sleep(2000);
  await reconnect(victim);
  await sleep(1500);
  const w = world();
  const after = {
    possessed: mine ? !!victim.mirror.get<Pawn>(mine.id)?.possessed : false,
    offers: victim.mirror.choices.filter((c: Choice) => c.faction === victim.faction).map((c) => c.id),
    pact: victim.mirror.factions.get(victim.faction)?.pacts?.[partner.faction]?.kind,
    raid: [...victim.mirror.factions.values()].some((f) => f.raid && !f.raid.fled),
  };
  const server = {
    possessed: mine ? !!w.get<Pawn>(mine.id)?.possessed : false,
    offers: [...w.choices.values()].filter((c) => c.faction === victim.faction).map((c) => c.id),
    pact: w.factions.get(victim.faction)?.pacts?.[partner.faction]?.kind,
    raid: [...w.factions.values()].some((f) => f.raid && !f.raid.fled),
  };
  const restored = JSON.stringify(after) === JSON.stringify(server);
  log(`rejoined ${victim.name}: client ${JSON.stringify(after)}, server ${JSON.stringify(server)} ${restored ? 'OK' : 'MISMATCH'}`);
  if (!restored) failures++;
  const p = game.players.get([...game.players.values()].find((x) => x.name === victim.name)!.id)!;
  log(`  ${victim.name}'s speed vote after rejoin: ${p.speed} (was 3)`);

  // A dead link: the connection stays open but nothing gets through.
  await at(0.55);
  const ghost = bots[4];
  const ghostPlayer = [...game.players.values()].find((x) => x.name === ghost.name)!;
  send(ghost, { t: 'speed', speed: 1 });
  await sleep(1500);
  ghost.proxy.blackhole(true);
  const holeAt = Date.now();
  log(`black-holed ${ghost.name} (voting speed 1)`);
  let serverDropped = -1;
  let clientNoticed = -1;
  while (Date.now() - holeAt < 30_000) {
    await sleep(250);
    if (serverDropped < 0 && !ghostPlayer.ws) serverDropped = Date.now() - holeAt;
    // The client's watchdog (net.ts): nothing heard for 10 s while the server sends players at 1 Hz.
    if (clientNoticed < 0 && Date.now() - ghost.lastMsgAt > 10_000) {
      clientNoticed = Date.now() - holeAt;
      ghost.ws.terminate();
    }
  }
  const speedDuringHole = game.computeTime().speed;
  ghost.proxy.blackhole(false);
  log(`  server ${serverDropped < 0 ? 'still counted it online after 30 s' : `dropped it after ${(serverDropped / 1000).toFixed(1)} s`}; game speed during the outage ${speedDuringHole}; client noticed after ${(clientNoticed / 1000).toFixed(1)} s`);
  await reconnect(ghost);
  send(ghost, { t: 'speed', speed: 3 });
  await sleep(2000);
  failures += await pauseAndCompare('checkpoint 2');

  await at(1);
  playing = false;
  clearInterval(player);
  failures += await pauseAndCompare('final');
  clearInterval(frame);

  console.log('');
  console.log('bot              profile  wire KB/s  deltas  hash ok/bad  backsteps(ticks)  freeze%  jumps/min/pawn  err mean/p95 (cells)  lag ms  rejoins');
  const secs = (Date.now() - t0) / 1000;
  for (const b of bots) {
    const s = b.stats;
    const errs = s.errs.sort((x, y) => x - y);
    const p95 = errs.length ? errs[Math.floor(errs.length * 0.95)] : 0;
    const pawnMinutes = s.pawnFrames / 30 / 60;
    console.log(
      `${b.name.padEnd(16)} ${b.profileName.padEnd(7)} ${(b.proxy.down / 1024 / secs).toFixed(1).padStart(5)} ${String(b.deltas).padStart(7)}  ${`${s.hashOk}/${s.hashBad}`.padStart(11)}  ${`${s.backsteps}(${s.backTicks.toFixed(0)})`.padStart(16)}  ${((s.freezes / Math.max(1, s.frames)) * 100).toFixed(1).padStart(7)}  ${(s.jumps / Math.max(1e-9, pawnMinutes)).toFixed(2).padStart(14)}  ${`${(s.errSum / Math.max(1, s.pawnFrames)).toFixed(2)} / ${p95.toFixed(2)}`.padStart(20)}  ${((s.lagSum / Math.max(1, s.pawnFrames)) * 1000).toFixed(0).padStart(6)}  ${s.reconnects}`,
    );
    if (s.firstBad) console.log(`    first hash mismatch ${s.firstBad}`);
    if (s.hashBad) failures++;
  }
  console.log(`server's own pawns: ${(truthJumps / Math.max(1e-9, truthPawnFrames / 30 / 60)).toFixed(2)} jumps/min/pawn`);
  console.log(failures ? `FAIL: ${failures} problems` : 'PASS');
  for (const b of bots) b.ws.terminate();
  game.stop();
  for (const b of bots) await b.proxy.close();
  wss.close();
  http.close();
  rmSync(saves, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
