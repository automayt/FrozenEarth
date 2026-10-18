/**
 * Network benchmark: what an 8-player game sends. A busy world (8 colonies playing through the
 * bots' command generator, raids, wildlife, settlements) runs at 3x speed with the server's real
 * broadcast cadence (15 Hz, so each delta covers 12 ticks), and every delta is encoded, deflated
 * the way the ws server does it (one shared context per client), and applied to a Mirror.
 *
 *   npm run bench:net -- --days 1.5 [--colonies 8] [--size 250] [--seed 5]
 *
 * Prints bytes/s per client (raw and deflated), where the bytes go (by entity kind, pawn field,
 * factions, choices, messages...), server tick ms, Mirror.applyDelta ms, and snapshot sizes.
 */
import { constants, createDeflateRaw, type DeflateRaw } from 'node:zlib';
import { parseArgs } from 'node:util';
import { decode, DeltaPacker, encode, Mirror, type ServerMsg, type WireDelta } from '@fe/protocol';
import { addPlayerFaction, createWorld, fireEvent, Rng, snapshot, TICKS_PER_DAY, TICKS_PER_HOUR, type World } from '@fe/sim';
import { Chaos } from '../bots/src/chaos';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '1.5' },
    colonies: { type: 'string', default: '8' },
    size: { type: 'string', default: '250' },
    seed: { type: 'string', default: '5' },
    speed: { type: 'string', default: '3' },
    /** Player commands per real second across all colonies. */
    cps: { type: 'string', default: '8' },
    /** Colonists per colony at the start. */
    pawns: { type: 'string', default: '8' },
    /** Send whole entities, as protocol 8 did, to compare. */
    raw: { type: 'boolean', default: false },
    top: { type: 'string', default: '30' },
  },
});

const SPEED = Number(args.speed);
/** Ticks per broadcast: 60 ticks/s x speed / 15 Hz. */
const PER_DELTA = Math.round((60 * SPEED) / 15);
const DELTAS_PER_SEC = 15;

function setup(): World {
  const w = createWorld({ seed: Number(args.seed), width: Number(args.size), height: Number(args.size) });
  for (let i = 0; i < Number(args.colonies); i++) {
    const f = addPlayerFaction(w, `C${i}`, Number(args.pawns));
    const { x, y } = f.home;
    const r = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', ...r(x - 3, y - 3, x + 3, y + 3) });
    w.enqueue(f.id, { c: 'zone', kind: 'grow', plant: 'potato', ...r(x - 12, y + 5, x - 5, y + 11) });
    w.enqueue(f.id, { c: 'build', def: 'wood_wall', hollow: true, ...r(x + 5, y - 5, x + 12, y + 2) });
    w.enqueue(f.id, { c: 'designate', kind: 'chop', ...r(x - 20, y - 20, x + 20, y + 20) });
    w.enqueue(f.id, { c: 'designate', kind: 'mine', ...r(x - 25, y - 25, x + 25, y + 25) });
  }
  return w;
}

/** A persistent raw-deflate stream, flushed per message: what permessage-deflate with context takeover sends. */
class Deflater {
  private z: DeflateRaw = createDeflateRaw({ level: 1, memLevel: 8, windowBits: 15 });
  bytes = 0;
  ms = 0;
  async push(buf: Uint8Array): Promise<void> {
    const t0 = performance.now();
    await new Promise<void>((res) => {
      let got = 0;
      const on = (c: Buffer) => (got += c.length);
      this.z.on('data', on);
      this.z.write(buf);
      this.z.flush(constants.Z_SYNC_FLUSH, () => {
        this.z.off('data', on);
        this.bytes += Math.max(0, got - 4);
        res();
      });
    });
    this.ms += performance.now() - t0;
  }
}

const size = (v: unknown) => (v === undefined ? 0 : encode(v as never).length);

const w = setup();
const rng = new Rng(Number(args.seed) * 31 + 7);
const chaos = new Chaos(rng, {
  w: w.map.w,
  h: w.map.h,
  entities: w.entities,
  factions: w.factions,
  zones: w.zones,
  zoneAt: w.map.zoneAt,
  get choices() {
    return w.choices.values();
  },
});
const players = [...w.factions.values()].filter((f) => f.isPlayer).map((f) => f.id);
const snap0 = encode({ t: 'welcome', playerId: 1, faction: players[0], token: '', snap: snapshot(w) }).length;
const mirror = new Mirror();
mirror.applySnapshot(decode<Extract<ServerMsg, { t: 'welcome' }>>(encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) })).snap);
w.takeDelta();

const deflate = new Deflater();
const packer = new DeltaPacker();
const cat = new Map<string, number>();
const add = (k: string, n: number) => cat.set(k, (cat.get(k) ?? 0) + n);
const counts = new Map<string, number>();
const addN = (k: string, n: number) => counts.set(k, (counts.get(k) ?? 0) + n);
let raw = 0;
let deltas = 0;
let biggest = 0;
let tickMs = 0;
let worstTick = 0;
let applyMs = 0;
let worstApply = 0;
let encodeMs = 0;
let events = 0;
const ticks = Math.round(Number(args.days) * TICKS_PER_DAY);
const cmdChance = Number(args.cps) / (60 * SPEED);
const EVENTS_ = ['raid', 'settlement_raid', 'settlement_plea', 'peddler', 'night_raid', 'raid'];

function account(d: WireDelta, bytes: number): void {
  for (const p of d.patches ?? []) {
    const e = w.get(p.id);
    const k = e?.kind === 'pawn' ? (e.species ? 'animal' : 'pawn') : (e?.kind ?? 'gone');
    add(`patch.${k}`, size(p));
    addN(`patch.${k}`, 1);
    for (const [f, v] of Object.entries(p.set)) add(`${k}.${f}`, size(v) + f.length + 1);
  }
  raw += bytes;
  biggest = Math.max(biggest, bytes);
  for (const e of d.ents) {
    const k = e.kind === 'pawn' ? (e.species ? 'animal' : 'pawn') : e.kind;
    const n = size(e);
    add(`ents.${k}`, n);
    addN(`ents.${k}`, 1);
    if (e.kind === 'pawn') for (const [f, v] of Object.entries(e)) add(`${k}.${f}`, size(v) + f.length + 1);
  }
  add('removed', size(d.removed));
  add('cells', size(d.cells));
  add('zones', size(d.zones));
  for (const f of d.factions) {
    add('factions', size(f));
    addN('factions', 1);
    if (f.settlement) for (const [k, v] of Object.entries(f.settlement)) add(`settlement.${k}`, size(v));
    if (f.raid) add('faction.raid', size(f.raid));
    if (f.pacts) add('faction.pacts', size(f.pacts));
  }
  add('msgs', size(d.msgs));
  add('rooms', size(d.rooms));
  add('roomTemps', size(d.roomTemps));
  add('conditions', size(d.conditions));
  add('choices', size(d.choices));
  if (d.choices) addN('choices', 1);
  add('shots', size(d.shots));
}

const t0 = performance.now();
for (let t = 1; t <= ticks; t++) {
  if (rng.chance(cmdChance)) {
    const who = rng.pick(players);
    const got = chaos.random(who);
    if (got) w.enqueue(who, got.cmd);
  }
  if (t % (TICKS_PER_DAY / 4) === 0) {
    const ev = EVENTS_[rng.int(EVENTS_.length)];
    if (fireEvent(w, ev, ev === 'settlement_raid' ? 0 : rng.pick(players))) events++;
  }
  // Players answer some letters; the rest expire.
  if (t % TICKS_PER_HOUR === 0) for (const c of [...w.choices.values()]) if (rng.chance(0.3)) w.enqueue(c.faction, { c: 'choose', choice: c.id, option: c.options[0].key });
  const s = performance.now();
  w.step();
  const dt = performance.now() - s;
  tickMs += dt;
  worstTick = Math.max(worstTick, dt);
  if (t % PER_DELTA === 0) {
    const e0 = performance.now();
    const d = args.raw ? w.takeDelta() : packer.pack(w.takeDelta());
    const bytes = encode({ t: 'delta', d, time: { speed: SPEED, paused: false, reason: '' } });
    // Packing is part of the server's cost of a delta.
    encodeMs += performance.now() - e0;
    deltas++;
    account(d, bytes.length);
    await deflate.push(bytes);
    const msg = decode<Extract<ServerMsg, { t: 'delta' }>>(bytes);
    const a0 = performance.now();
    mirror.applyDelta(msg.d);
    const da = performance.now() - a0;
    applyMs += da;
    worstApply = Math.max(worstApply, da);
    mirror.changedEnts.clear();
    mirror.removedEnts.clear();
    mirror.changedCells.clear();
    mirror.shots.length = 0;
  }
}
const wall = (performance.now() - t0) / 1000;
const secs = deltas / DELTAS_PER_SEC;
const snapEnd = snapshot(w);
const snapEndBytes = encode({ t: 'welcome', playerId: 1, faction: players[0], token: '', snap: snapEnd });
const snapDeflate = new Deflater();
await snapDeflate.push(snapEndBytes);
const kbps = (n: number) => +(n / secs / 1024).toFixed(2);
const top = [...cat].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top));
console.log(
  JSON.stringify(
    {
      days: Number(args.days),
      realSecondsAt3x: Math.round(secs),
      benchSeconds: +wall.toFixed(1),
      events,
      pawns: w.kinds.pawn.size,
      entities: w.entities.size,
      factions: w.factions.size,
      perClientKBps: kbps(raw),
      perClientDeflatedKBps: kbps(deflate.bytes),
      avgDeltaB: Math.round(raw / deltas),
      biggestDeltaKB: +(biggest / 1024).toFixed(1),
      tickMs: +(tickMs / ticks).toFixed(4),
      serverMsPerRealSecond: +((tickMs / ticks) * 60 * SPEED).toFixed(1),
      worstTickMs: +worstTick.toFixed(1),
      packed: { full: packer.full, patched: packer.patched, skipped: packer.skipped },
      missedPatches: mirror.missedPatches,
      encodeMsPerDelta: +(encodeMs / deltas).toFixed(3),
      deflateMsPerDeltaPerClient: +(deflate.ms / deltas).toFixed(3),
      applyMsPerDelta: +(applyMs / deltas).toFixed(3),
      worstApplyMs: +worstApply.toFixed(2),
      snapshotStartKB: Math.round(snap0 / 1024),
      snapshotEndKB: Math.round(snapEndBytes.length / 1024),
      snapshotEndDeflatedKB: Math.round(snapDeflate.bytes / 1024),
      snapshotParts: Object.fromEntries(Object.entries(snapEnd).map(([k, v]) => [k, Math.round(size(v) / 1024)]).filter(([, v]) => (v as number) > 0)),
    },
    null,
    1,
  ),
);
console.log('bytes per second by part (raw msgpack, per client):');
for (const [k, v] of top) console.log(`  ${k.padEnd(24)} ${(v / secs / 1024).toFixed(2).padStart(7)} KB/s${counts.has(k) ? `  (${(counts.get(k)! / secs).toFixed(1)}/s)` : ''}`);
