import { milestone, tell } from './chronicle';
import { ITEM_CATEGORIES, ITEMS, TERRAINS } from '@fe/defs';
import { RARE_TICK, TICKS_PER_DAY } from './constants';
import { cellDistance, gaveUpOn, hostile, hostileInReach, lineOfSight, weaponFor } from './combat';
import { frostDistance } from './frost';
import { pawnName } from './names';
import { maybeReachable } from './pathfinding';
import { findSleep } from './pawns';
import { needsTending } from './health';
import { offerChoice, registerChoice } from './choices';
import { storedCount, takeStored } from './eventHandlers';
import { allied, setPact, type RelView } from './pacts';
import { theftGrievance } from './diplomacy';
import { CONTRACT_CHANCE, contractsTick, hasContract, offerContract, voidContracts } from './contracts';
import { hash2 } from './rng';
import type { Building, Faction, Item, Job, Pawn, SettlementRequest, SettlementState } from './types';
import { NEIGHBORS4, type World } from './world';

/** Goodwill at or below this and the settlement's people fight a colony's colonists on sight. */
export const HOSTILE_AT = -40;
/** Goodwill at or above this and they're friendly: better prices. */
export const FRIENDLY_AT = 30;
/** How close one of your colonists must be to trade. */
export const TRADE_RANGE = 14;
/**
 * How much each thing a colony does moves a settlement's goodwill toward it. Exported so the
 * client can show the stakes before an order rather than repeat the numbers.
 */
export const GOODWILL = {
  /** One of their people catches your colonist stealing. */
  caughtStealing: -45,
  /** Your colonist shoots or swings at one of theirs and misses... */
  attackMiss: -8,
  /** ...or hurts them. */
  attackHit: -25,
  /** You agreed to bring something and never came. */
  brokenPromise: -12,
  /** You brought what they asked for. */
  keptPromise: 15,
  /** Any fair trade. */
  fairTrade: 1,
  /** Value given beyond a fair price per point of goodwill, up to giftMax a trade. */
  giftValue: 12,
  giftMax: 20,
} as const;
/** Their people attack hostile colonists this many cells beyond the ring of their land. */
export const GUARD_REACH = 4;
/** Compound footprint: walls from (x-HW, y-HH) to (x+HW, y+HH). */
const HW = 4;
const HH = 3;
/** Settlements keep at least this far apart, and from player colonies. */
const GAP = 40;

const NAME_A = ['Hollow', 'Ember', 'Ash', 'Cold', 'Stone', 'Pine', 'Salt', 'Rime', 'Kettle', 'Wolf', 'Lantern', 'Thorn', 'Birch', 'Hearth', 'Iron', 'Crow'];
const NAME_B = ['mere', 'ford', 'stead', 'hold', 'wick', 'haven', 'gate', 'cairn', 'reach', 'fall', 'watch', 'well'];
const COLORS = [0x9a8a6a, 0x7a9a8a, 0x8a7aa0, 0xa08a7a, 0x6a8aa0, 0xa0a07a, 0x8a9a6a, 0xa07a8a];

export type Disposition = 'friendly' | 'wary' | 'hostile';

export function goodwillOf(s: SettlementState, faction: number): number {
  return s.goodwill[faction] ?? s.temper;
}

export function dispositionOf(s: SettlementState, faction: number): Disposition {
  const g = goodwillOf(s, faction);
  return g <= HOSTILE_AT ? 'hostile' : g >= FRIENDLY_AT ? 'friendly' : 'wary';
}

/** Most remembered reasons a settlement keeps (all colonies together). */
const MEMORIES = 30;
/** Share of goodwill a town's rivals feel the other way: help their enemy and they cool on you; hurt it and they warm. */
const RIVAL_RIPPLE_HELP = 0.3;
const RIVAL_RIPPLE_HURT = 0.25;

/**
 * Change a settlement's feelings toward a colony, with a letter when it crosses a line. `why`
 * is remembered and shown to the player. Big swings ripple to the town's rivals, who hear of it.
 */
export function shiftGoodwill(w: World, f: Faction, faction: number, by: number, why?: string, ripple = true): void {
  const s = f.settlement;
  const pf = w.factions.get(faction);
  if (!s || !pf?.isPlayer || s.state === 'fallen') return;
  const before = dispositionOf(s, faction);
  const old = goodwillOf(s, faction);
  s.goodwill[faction] = Math.max(-100, Math.min(100, Math.round(old + by)));
  w.dirty.factions.add(f.id);
  if (why && s.goodwill[faction] !== old) {
    const mem = (s.memories ??= []);
    mem.push({ f: faction, why, by: s.goodwill[faction] - old, tick: w.tick });
    if (mem.length > MEMORIES) mem.splice(0, mem.length - MEMORIES);
  }
  if (ripple && Math.abs(by) >= 5) {
    for (const r of rivalsOf(w, f)) {
      if (!r.settlement!.met.includes(faction)) continue;
      const echo = by > 0 ? -Math.round(by * RIVAL_RIPPLE_HELP) : Math.round(-by * RIVAL_RIPPLE_HURT);
      if (echo) shiftGoodwill(w, r, faction, echo, by > 0 ? `Befriended ${f.name}, our rival` : `Hurt ${f.name}, our rival`, false);
    }
  }
  // An alliance needs friendship to hold.
  if (allied(w, f.id, faction) && s.goodwill[faction] < FRIENDLY_AT) {
    setPact(w, f.id, faction, null);
    w.message(faction, `${f.name} has ended its alliance with you.`, 'bad', w.map.idx(f.home.x, f.home.y));
  }
  const after = dispositionOf(s, faction);
  if (before === after) return;
  const at = w.map.idx(f.home.x, f.home.y);
  if (after === 'hostile') w.message(faction, `${f.name} now considers you enemies. Their people will attack your colonists on sight.`, 'bad', at);
  else if (after === 'friendly') w.message(faction, `${f.name} now counts you as friends. They'll trade on better terms.`, 'good', at);
  else w.message(faction, `${f.name} is ${before === 'hostile' ? 'willing to talk again' : 'no longer as friendly'}.`, 'neutral', at);
}

/** Your colonist shot or swung at one of theirs: bad; actually hurting them: much worse. */
export function settlerAttacked(w: World, victim: Pawn, attacker: Pawn, hit: boolean): void {
  const f = w.factions.get(victim.faction);
  if (f?.settlement) shiftGoodwill(w, f, attacker.faction, hit ? GOODWILL.attackHit : GOODWILL.attackMiss, hit ? `Wounded ${victim.name.split(' ')[0]}` : 'Attacked our people');
}

// ---------------------------------------------------------------- towns and each other

/** How two towns feel about each other before anything happens: like tempers get along, a hostile town feuds, and old grudges vary. */
export function baseOpinion(w: RelView, a: Faction, b: Faction): number {
  const ta = a.settlement?.temper ?? 0;
  const tb = b.settlement?.temper ?? 0;
  const grudge = Math.round(hash2(Math.min(a.id, b.id), Math.max(a.id, b.id), w.seed) * 40) - 20;
  return Math.max(-100, Math.min(100, Math.round((ta + tb) / 4 - Math.abs(ta - tb) / 2 + grudge)));
}

/** How town `a` feels about town `b`. */
export function opinionBetween(w: RelView, a: Faction, b: Faction): number {
  return a.settlement?.goodwill[b.id] ?? baseOpinion(w, a, b);
}

/** Towns that are still standing. */
export function liveTowns(w: RelView): Faction[] {
  return [...w.factions.values()].filter((f) => f.settlement && f.settlement.state !== 'fallen');
}

export function areRivals(w: RelView, a: Faction, b: Faction): boolean {
  return a.id !== b.id && !!a.settlement && !!b.settlement && Math.min(opinionBetween(w, a, b), opinionBetween(w, b, a)) <= HOSTILE_AT;
}

/** Rivals: towns on either side of a feud (feeling at or below the hostile line, either way). */
export function rivalsOf(w: RelView, f: Faction): Faction[] {
  if (!f.settlement) return [];
  return liveTowns(w).filter((o) => areRivals(w, f, o));
}

/** Move how two towns feel about each other (both ways), telling colonies that know them when a feud starts or ends. */
export function shiftOpinion(w: World, a: Faction, b: Faction, by: number): void {
  if (!a.settlement || !b.settlement) return;
  const was = areRivals(w, a, b);
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    x.settlement!.goodwill[y.id] = Math.max(-100, Math.min(100, Math.round(opinionBetween(w, x, y) + by)));
    w.dirty.factions.add(x.id);
  }
  const now = areRivals(w, a, b);
  if (was === now) return;
  const known = new Set([...a.settlement.met, ...b.settlement.met]);
  for (const p of known) w.message(p, now ? `${a.name} and ${b.name} have fallen out. They are rivals now.` : `${a.name} and ${b.name} have put their feud behind them.`, now ? 'bad' : 'good');
}

/** Once a day: feelings fade back toward where they started, so grudges and favours both wear off. */
function driftFeelings(w: World, f: Faction): void {
  const s = f.settlement!;
  for (const [k, g] of Object.entries(s.goodwill)) {
    const o = w.factions.get(Number(k));
    if (!o) continue;
    // Allies come to rest at firm friendship at worst; anyone else at the town's own temper.
    const rest = o.settlement ? baseOpinion(w, f, o) : allied(w, f.id, o.id) ? Math.max(s.temper, FRIENDLY_AT + 20) : s.temper;
    if (g === rest) continue;
    s.goodwill[Number(k)] = g + Math.sign(rest - g);
    w.dirty.factions.add(f.id);
  }
}

/** Land held by settlements hostile to this colony, as circles: places workers should stay out of. */
export function dangerZones(w: World, faction: number): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  for (const f of w.factions.values()) {
    const s = f.settlement;
    if (s?.state === 'home' && hostile(w, f.id, faction)) out.push({ x: f.home.x, y: f.home.y, r: s.radius + 6 });
  }
  return out;
}

// ---------------------------------------------------------------- founding

function residentsOf(w: World, faction: number): Pawn[] {
  const out: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && !p.prisoner) out.push(p);
  }
  return out;
}

/** Room for a compound centred at (x, y): open, buildable, dry ground with a margin. */
function compoundFits(w: World, x: number, y: number): boolean {
  const m = w.map;
  if (x - HW - 2 < 0 || y - HH - 2 < 0 || x + HW + 2 >= m.w || y + HH + 2 >= m.h) return false;
  for (let yy = y - HH - 1; yy <= y + HH + 1; yy++) {
    for (let xx = x - HW - 1; xx <= x + HW + 1; xx++) {
      const i = m.idx(xx, yy);
      if (m.solid[i] || m.rock[i] || m.buildingAt[i] || m.constructAt[i] || m.zoneAt[i] || !TERRAINS[m.terrain[i]].buildable) return false;
    }
  }
  return true;
}

function farFromOthers(w: World, x: number, y: number, self = 0): boolean {
  for (const f of w.factions.values()) {
    if (f.id === self || !(f.isPlayer || (f.settlement && f.settlement.state !== 'fallen'))) continue;
    if (Math.hypot(f.home.x - x, f.home.y - y) < GAP) return false;
  }
  return true;
}

/** A spot for a compound between frost distances lo and hi, or null. */
function findSite(w: World, lo: number, hi: number, self = 0): { x: number; y: number } | null {
  const m = w.map;
  const half = Math.min(m.w, m.h) / 2;
  for (let tries = 0; tries < 400; tries++) {
    const a = w.rng.next() * Math.PI * 2;
    const d = (lo + w.rng.next() * (hi - lo)) * half;
    const x = Math.round(m.w / 2 + Math.cos(a) * d);
    const y = Math.round(m.h / 2 + Math.sin(a) * d);
    if (compoundFits(w, x, y) && farFromOthers(w, x, y, self)) return { x, y };
  }
  return null;
}

/** Walls, a door, beds, a fire and a stockpile, built on the spot. */
function buildCompound(w: World, f: Faction, residents: number): void {
  const m = w.map;
  const { x, y } = f.home;
  // Clear the ground first.
  for (let yy = y - HH - 1; yy <= y + HH + 1; yy++) {
    for (let xx = x - HW - 1; xx <= x + HW + 1; xx++) {
      const i = m.idx(xx, yy);
      if (m.plantAt[i]) w.despawn(m.plantAt[i]);
      if (m.itemAt[i]) w.despawn(m.itemAt[i]);
    }
  }
  const wall = w.rng.chance(0.5) ? 'stone_wall' : 'wood_wall';
  for (let yy = y - HH; yy <= y + HH; yy++) {
    for (let xx = x - HW; xx <= x + HW; xx++) {
      const edge = xx === x - HW || xx === x + HW || yy === y - HH || yy === y + HH;
      if (!edge) continue;
      // A gate at the front with a firing slit either side of it, and one in each other wall.
      const slit = (yy === y && (xx === x - HW || xx === x + HW)) || (xx === x && yy === y - HH) || (yy === y + HH && (xx === x - 1 || xx === x + 1));
      w.spawnBuilding(xx === x && yy === y + HH ? 'door' : slit ? 'embrasure' : wall, m.idx(xx, yy), f.id);
    }
  }
  // Beds along the back wall, the fire in the middle, stores along the front.
  for (let k = 0; k < Math.min(residents, HW * 2 - 1); k++) w.spawnBuilding('bed', m.idx(x - HW + 1 + k, y - HH + 1), f.id);
  w.spawnBuilding('campfire', m.idx(x, y), f.id);
  const z = w.createZone(f.id, 'stockpile');
  for (let yy = y + 1; yy <= y + HH - 1; yy++) {
    for (let xx = x - HW + 1; xx <= x + HW - 1; xx++) if (xx !== x) w.addZoneCell(z, m.idx(xx, yy));
  }
  m.roomsDirty = true;
}

/** Goods a settlement keeps, scaled by how many live there. */
function stockUp(w: World, f: Faction, residents: number): void {
  const m = w.map;
  const drop = m.idx(f.home.x - HW + 1, f.home.y + HH - 1);
  const goods: [string, number, number][] = [
    ['steel', 15, 45],
    ['cloth', 15, 40],
    ['survival_meal', 6, 16],
    ['wood', 30, 60],
    ['gold', 2, 8],
  ];
  if (w.rng.chance(0.5)) goods.push(['parka', 1, 2]);
  if (w.rng.chance(0.35)) goods.push(['rifle', 1, 1]);
  if (w.rng.chance(0.5)) goods.push([w.rng.pick(['rice', 'corn', 'potato']), 30, 70]);
  const scale = 0.6 + residents * 0.1;
  for (const [def, lo, hi] of goods) w.placeItemNear(def, Math.max(1, Math.round((lo + w.rng.int(hi - lo + 1)) * scale)), drop);
}

function settlementName(w: World): string {
  const used = new Set([...w.factions.values()].map((f) => f.name));
  for (let k = 0; k < 20; k++) {
    const n = w.rng.pick(NAME_A) + w.rng.pick(NAME_B);
    if (!used.has(n)) return n;
  }
  return `${w.rng.pick(NAME_A)}${w.rng.pick(NAME_B)} ${w.factions.size}`;
}

/** Arms by temperament: mostly bows and rifles, for holding the walls, and a blade or two for the gate. */
const WEAPONS_BY_TEMPER: [number, string[]][] = [
  [HOSTILE_AT, ['rifle', 'rifle', 'bow', 'club', 'rifle', 'knife']],
  [0, ['bow', 'rifle', 'club', 'bow', 'knife']],
  [100, ['bow', 'bow', 'knife', 'rifle', 'club']],
];

/**
 * Found the world's NPC settlements, in the warmer rings toward the center. Further in, they're
 * more likely to be hostile: the center is worth guarding. Returns how many were placed.
 */
export function placeSettlements(w: World, count?: number): number {
  const m = w.map;
  const n = count ?? Math.max(2, Math.min(6, Math.round((m.w * m.h) / 10_000)));
  let placed = 0;
  for (let k = 0; k < n; k++) {
    // Never on land the frost has already taken (older worlds get settlements late).
    const hi = Math.min(0.7, w.frostRadius() - 0.12);
    const site = hi > 0.25 ? findSite(w, 0.22, hi) : null;
    if (!site) break;
    const d = frostDistance(site.x, site.y, m.w, m.h);
    const roll = w.rng.next();
    const pHostile = 0.15 + 0.35 * (1 - d / 0.7);
    const temper = roll < pHostile ? -60 : roll < pHostile + 0.35 ? 0 : 45;
    foundSettlement(w, site, temper, 3 + w.rng.int(4));
    placed++;
  }
  return placed;
}

export function foundSettlement(w: World, at: { x: number; y: number }, temper: number, residents: number): Faction {
  const m = w.map;
  const id = Math.max(0, ...w.factions.keys()) + 1;
  const used = [...w.factions.values()].filter((f) => f.settlement).length;
  const f: Faction = {
    id,
    name: settlementName(w),
    color: COLORS[used % COLORS.length],
    home: { x: at.x, y: at.y },
    isPlayer: false,
    settlement: { temper, goodwill: {}, radius: 12, state: 'home', dest: -1, until: 0, met: [] },
  };
  w.factions.set(id, f);
  w.dirty.factions.add(id);
  buildCompound(w, f, residents);
  stockUp(w, f, residents);
  const arms = WEAPONS_BY_TEMPER.find(([t]) => temper <= t)![1];
  for (let k = 0; k < residents; k++) {
    const c = m.idx(at.x - HW + 1 + (k % (HW * 2 - 1)), at.y - HH + 2);
    w.spawnPawn(id, c, uniqueName(w, id), undefined, arms[k % arms.length]);
  }
  return f;
}

/** A name nobody else in the faction has. */
function uniqueName(w: World, faction: number): string {
  const taken = new Set(residentsOf(w, faction).map((p) => p.name.split(' ')[0]));
  let name = pawnName(w.rng);
  for (let k = 0; k < 10 && taken.has(name.split(' ')[0]); k++) name = pawnName(w.rng);
  return name;
}

// ---------------------------------------------------------------- residents

/** What a settler does next: defend their land, sleep at night, potter about the compound by day. */
export function settlerThink(w: World, p: Pawn): Job {
  const f = w.factions.get(p.faction)!;
  const s = f.settlement!;
  const m = w.map;
  const here = w.cellOf(p);
  const home = m.idx(f.home.x, f.home.y);
  if (s.state === 'leaving') return { type: 'goto', stage: 0, dest: s.dest };
  const help = aidThink(w, p);
  if (help) return help;
  const defend = garrisonThink(w, p, f);
  if (defend) return defend;
  // Intruders: hostile pawns on their land.
  let best: Pawn | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.downed || o.prisoner || !hostile(w, p.faction, o.faction)) continue;
    const c = w.cellOf(o);
    if (cellDistance(w, c, home) > s.radius + GUARD_REACH) continue;
    const d = cellDistance(w, here, c);
    if (d < bestD && !gaveUpOn(w, p, o) && maybeReachable(w, here, c, true)) {
      best = o;
      bestD = d;
    }
  }
  if (best) return { type: 'attack', stage: 0, target: best.id, forced: false, chase: true, next: 0, until: w.tick + 300 };
  // Between fights, they bind each other's wounds (left alone, the downed bleed out).
  const patient = woundedNeighbour(w, p, home, s.radius * 1.5);
  if (patient) return { type: 'tend', stage: 0, patient: patient.id, progress: 0 };
  // Don't wander off chasing someone across the map.
  if (cellDistance(w, here, home) > s.radius * 1.5) return { type: 'goto', stage: 0, dest: home };
  if (w.isNight() || p.needs.rest < 0.2) {
    const sleep = findSleep(w, p, false);
    if (sleep) return sleep;
  }
  for (let tries = 0; tries < 10; tries++) {
    const x = f.home.x + w.rng.int(HW * 2 + 5) - HW - 2;
    const y = f.home.y + w.rng.int(HH * 2 + 5) - HH - 2;
    if (!m.inBounds(x, y)) continue;
    const c = m.idx(x, y);
    if (w.passable(c, p.faction) && m.component(c) === m.component(here)) return { type: 'wander', stage: 0, dest: c, until: w.tick + 200 + w.rng.int(400) };
  }
  return { type: 'hold', stage: 0, until: w.tick + 300 };
}

/** Sent to help an ally: fight the raiders attacking them, then go home once they're beaten or time's up. */
function aidThink(w: World, p: Pawn): Job | null {
  if (!p.aid) return null;
  const [ally, until] = p.aid;
  const raiders: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    const raid = w.factions.get(o.faction)?.raid;
    if (raid && raid.target === ally && !raid.fled && !o.downed) raiders.push(o);
  }
  const f = w.factions.get(ally);
  if (!raiders.length || !f || w.tick >= until) {
    delete p.aid;
    w.markDirty(p);
    return null;
  }
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestD = Infinity;
  for (const o of raiders) {
    const c = w.cellOf(o);
    const d = cellDistance(w, here, c);
    if (d < bestD && !gaveUpOn(w, p, o) && maybeReachable(w, here, c, true)) {
      best = o;
      bestD = d;
    }
  }
  if (best) return { type: 'attack', stage: 0, target: best.id, forced: false, chase: true, next: 0, until: w.tick + 300 };
  return { type: 'goto', stage: 0, dest: w.map.idx(f.home.x, f.home.y) };
}

/** A fellow resident near home who is bleeding, and nobody else is already seeing to. */
function woundedNeighbour(w: World, p: Pawn, home: number, range: number): Pawn | null {
  let best: Pawn | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction !== p.faction || !needsTending(o) || cellDistance(w, w.cellOf(o), home) > range) continue;
    let taken = false;
    for (const oid of w.kinds.pawn) {
      const q = w.get<Pawn>(oid)!;
      if (q !== p && q.job?.type === 'tend' && q.job.patient === o.id) taken = true;
    }
    if (taken) continue;
    const d = cellDistance(w, w.cellOf(p), w.cellOf(o));
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

/** How far out a settlement watches for trouble. */
export const WATCH = 10;

/** The nearest hostile on or near their land, if any. */
function threatTo(w: World, f: Faction, range: number): Pawn | null {
  const home = w.map.idx(f.home.x, f.home.y);
  let best: Pawn | null = null;
  let bestD = range;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.downed || o.prisoner || !hostile(w, f.id, o.faction)) continue;
    const d = cellDistance(w, w.cellOf(o), home);
    if (d <= bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * Under threat, a settlement holds out: archers and riflemen man the firing slits facing the
 * trouble, and fighters with blades hold the gate from inside. Null when there's no threat.
 */
function garrisonThink(w: World, p: Pawn, f: Faction): Job | null {
  const s = f.settlement!;
  const threat = threatTo(w, f, s.radius + WATCH);
  if (!threat) return null;
  const m = w.map;
  const here = w.cellOf(p);
  const there = w.cellOf(threat);
  const wd = weaponFor(p);
  const inReach = hostileInReach(w, p);
  if (!wd.melee) {
    const post = garrisonPost(w, p, f, there);
    if (post >= 0 && post !== here) return { type: 'goto', stage: 0, dest: post };
    if (inReach) return { type: 'attack', stage: 0, target: inReach.id, forced: false, chase: false, next: 0, until: w.tick + 300, spot: -1 };
    if (post === here) return { type: 'hold', stage: 0, until: w.tick + 120 };
    return null;
  }
  // Blades: stand just inside the gate and cut down whoever gets in. Don't step out to meet them.
  const gate = m.idx(f.home.x, f.home.y + HH - 1);
  const inside = m.roomAt[there] !== 0 && m.roomAt[there] === m.roomAt[gate];
  if (inside || cellDistance(w, here, there) <= 1) return { type: 'attack', stage: 0, target: threat.id, forced: false, chase: inside, next: 0, until: w.tick + 200 };
  if (here !== gate) return { type: 'goto', stage: 0, dest: gate };
  return { type: 'hold', stage: 0, until: w.tick + 120 };
}

/** The free spot behind a firing slit closest to the threat. -1 if the compound has none. */
function garrisonPost(w: World, p: Pawn, f: Faction, threat: number): number {
  const m = w.map;
  let best = -1;
  let bestScore = Infinity;
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    if (b.faction !== f.id || b.def !== 'embrasure') continue;
    const slit = w.cellOf(b);
    for (const [dx, dy] of NEIGHBORS4) {
      if (!m.inBounds(b.x + dx, b.y + dy)) continue;
      const c = m.idx(b.x + dx, b.y + dy);
      if (!m.roomAt[c] || !w.passable(c, f.id)) continue;
      // Someone else already has it.
      let taken = false;
      for (const oid of w.kinds.pawn) {
        const o = w.get<Pawn>(oid)!;
        if (o === p || o.faction !== f.id) continue;
        if (w.cellOf(o) === c || (o.job?.type === 'goto' && o.job.dest === c)) taken = true;
      }
      // Best: a post that can actually see the trouble through its slit.
      const sees = lineOfSight(w, c, threat);
      const score = cellDistance(w, slit, threat) + (taken ? 40 : 0) + (sees ? 0 : 25);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  return best;
}

/** For an idle settler: is anyone hostile on their land? */
export function intruderNear(w: World, p: Pawn): boolean {
  const f = w.factions.get(p.faction);
  const s = f?.settlement;
  if (!f || !s || s.state !== 'home') return false;
  return !!threatTo(w, f, s.radius + WATCH);
}

// ---------------------------------------------------------------- the settlement over time

/** Give up the compound: buildings and whatever stores are left belong to nobody now. */
function abandon(w: World, f: Faction, keep: number): void {
  for (const id of [...w.kinds.building]) {
    const b = w.get<Building>(id)!;
    if (b.faction !== f.id) continue;
    b.faction = 0;
    b.owner = 0;
    w.refreshCell(w.cellOf(b));
    w.markDirty(b);
  }
  for (const z of [...w.zones.values()]) {
    if (z.faction !== f.id) continue;
    for (const c of [...z.cells]) {
      const it = w.map.itemAt[c] ? w.get<Item>(w.map.itemAt[c]) : undefined;
      // They carry off some of it.
      if (it && it.kind === 'item' && !w.rng.chance(keep)) w.despawn(it.id);
      w.removeZoneCell(c);
    }
  }
}

function notifyAll(w: World, f: Faction, text: string, tone: 'good' | 'neutral' | 'bad'): void {
  w.message(0, text, tone, w.map.idx(f.home.x, f.home.y));
}

/** Once a day or so: first contact, the frost driving them out, arriving somewhere new, falling. */
export function settlementsTick(w: World): void {
  contractsTick(w);
  if (w.tick % (RARE_TICK * 4) !== 0) return;
  const daily = w.tick % TICKS_PER_DAY === 0;
  for (const f of w.factions.values()) {
    const s = f.settlement;
    if (!s || s.state === 'fallen') continue;
    if (daily) driftFeelings(w, f);
    const people = residentsOf(w, f.id);
    if (!people.length) {
      s.state = 'fallen';
      w.dirty.factions.add(f.id);
      voidRequests(w, f);
      abandon(w, f, 1);
      notifyAll(w, f, `${f.name} has fallen. Whatever they had is there for the taking.`, 'neutral');
      continue;
    }
    expireRequests(w, f);
    if (s.state === 'home') {
      meetNeighbours(w, f, people);
      if (w.frostAt(w.map.idx(f.home.x, f.home.y)) > 0.25) leave(w, f);
    } else if (s.state === 'leaving') {
      const dx = w.map.cx(s.dest);
      const dy = w.map.cy(s.dest);
      const arrived = people.filter((p) => Math.hypot(p.x - dx, p.y - dy) < 6).length;
      if (arrived * 2 >= people.length || w.tick >= s.until) resettle(w, f, people);
    }
  }
}

/** The first time a colony's colonists come near, they get a letter about who lives here. */
function meetNeighbours(w: World, f: Faction, people: Pawn[]): void {
  const s = f.settlement!;
  const home = w.map.idx(f.home.x, f.home.y);
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (s.met.includes(p.faction) || !w.factions.get(p.faction)?.isPlayer) continue;
    if (cellDistance(w, w.cellOf(p), home) > s.radius + 10) continue;
    s.met.push(p.faction);
    w.dirty.factions.add(f.id);
    const d = dispositionOf(s, p.faction);
    const how =
      d === 'hostile'
        ? 'They want no visitors: their guards will attack anyone who comes close.'
        : d === 'friendly'
          ? 'They seem glad of company, and willing to trade.'
          : 'They watch your people warily, but will trade.';
    w.message(p.faction, `Your colonists have come upon ${f.name}, a settlement of ${people.length}. ${how}`, d === 'hostile' ? 'bad' : 'good', home);
  }
}

function leave(w: World, f: Faction): void {
  const s = f.settlement!;
  const r = w.frostRadius();
  const site = findSite(w, Math.max(0.05, r - 0.5), Math.max(0.12, r - 0.15), f.id);
  if (!site) {
    // Nowhere left to go: they scatter into the wilds.
    s.state = 'fallen';
    w.dirty.factions.add(f.id);
    voidRequests(w, f);
    for (const p of residentsOf(w, f.id)) w.despawn(p.id);
    abandon(w, f, 0.5);
    notifyAll(w, f, `The frost has reached ${f.name}. With nowhere left to go, its people scatter, leaving some stores behind.`, 'neutral');
    return;
  }
  abandon(w, f, 0.4);
  s.state = 'leaving';
  s.dest = w.map.idx(site.x, site.y);
  s.until = w.tick + TICKS_PER_DAY * 3;
  w.dirty.factions.add(f.id);
  for (const p of residentsOf(w, f.id)) {
    p.job = null;
    p.path = null;
    w.markDirty(p);
  }
  notifyAll(w, f, `The frost has reached ${f.name}. Its people are abandoning their homes and heading inward, leaving some stores behind.`, 'neutral');
}

function resettle(w: World, f: Faction, people: Pawn[]): void {
  const s = f.settlement!;
  const m = w.map;
  let x = m.cx(s.dest);
  let y = m.cy(s.dest);
  if (!compoundFits(w, x, y) || !farFromOthers(w, x, y, f.id)) {
    const r = w.frostRadius();
    const site = findSite(w, Math.max(0.05, r - 0.5), Math.max(0.12, r - 0.15), f.id);
    if (!site) {
      s.until = w.tick + TICKS_PER_DAY;
      return;
    }
    x = site.x;
    y = site.y;
  }
  f.home = { x, y };
  s.state = 'home';
  s.dest = -1;
  w.dirty.factions.add(f.id);
  buildCompound(w, f, people.length);
  // Stragglers catch up.
  for (const p of people) {
    if (Math.hypot(p.x - x, p.y - y) > 25) {
      const c = m.idx(x, y + HH + 2);
      p.x = m.cx(c);
      p.y = m.cy(c);
      p.path = null;
    }
    p.job = null;
    w.markDirty(p);
  }
  notifyAll(w, f, `The people of ${f.name} have made a new home further in.`, 'neutral');
}

// ---------------------------------------------------------------- trade

export type TradeLine = [item: string, count: number];


/** What they ask over the value of what you give: 1.5 for strangers, 1.0 for close friends. */
export function priceFactor(s: SettlementState, faction: number): number {
  return 1.5 - Math.max(0, goodwillOf(s, faction)) / 200;
}

export function lineValue(lines: TradeLine[]): number {
  return lines.reduce((a, [d, n]) => a + (ITEMS[d]?.marketValue ?? 0) * n, 0);
}

/** The colonist close enough to the settlement to do the trading, if any. */
export function traderAt(w: World, faction: number, f: Faction): Pawn | null {
  const home = w.map.idx(f.home.x, f.home.y);
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && !p.downed && !p.prisoner && cellDistance(w, w.cellOf(p), home) <= TRADE_RANGE) return p;
  }
  return null;
}

export function cleanLines(v: unknown): TradeLine[] | null {
  if (!Array.isArray(v) || v.length > 6) return null;
  const out: TradeLine[] = [];
  for (const l of v) {
    if (!Array.isArray(l) || typeof l[0] !== 'string' || !Object.hasOwn(ITEMS, l[0])) return null;
    const n = Math.round(Number(l[1]));
    if (!(n >= 1 && n <= 9999)) return null;
    out.push([l[0], n]);
  }
  return out;
}

/** Swap goods with a settlement: yours come out of your stockpiles, theirs are left by your colonist. */
export function settlementTrade(w: World, faction: number, settlement: number, give: unknown, want: unknown): void {
  const f = w.factions.get(settlement);
  const s = f?.settlement;
  const g = cleanLines(give);
  const wa = cleanLines(want);
  if (!f || !s || !g || !wa || (!g.length && !wa.length) || !w.factions.get(faction)?.isPlayer) return;
  const say = (t: string) => w.message(faction, t, 'neutral');
  if (s.state !== 'home') return say(`${f.name} isn't trading while they're on the move.`);
  // Enemies won't trade, but a gift might change their minds.
  if (dispositionOf(s, faction) === 'hostile' && wa.length) return say(`${f.name} won't trade with you. They might accept a gift.`);
  const trader = traderAt(w, faction, f);
  if (!trader) return say(`Send a colonist to ${f.name} to trade. They need to be within ${TRADE_RANGE} cells.`);
  for (const [d, n] of g) if (storedCount(w, faction, d) < n) return say(`You don't have ${n} ${ITEMS[d].label.toLowerCase()} in your stockpiles.`);
  for (const [d, n] of wa) if (storedCount(w, f.id, d) < n) return say(`${f.name} doesn't have ${n} ${ITEMS[d].label.toLowerCase()}.`);
  const factor = priceFactor(s, faction);
  if (lineValue(g) + 1e-9 < lineValue(wa) * factor) return say(`${f.name} wants more for that.`);
  const drop = w.map.idx(f.home.x - HW + 1, f.home.y + HH - 1);
  for (const [d, n] of g) {
    const got = takeStored(w, faction, d, n);
    w.placeItemNear(d, got, drop);
  }
  for (const [d, n] of wa) {
    const got = takeStored(w, f.id, d, n);
    w.placeItemNear(d, got, w.cellOf(trader));
  }
  // Fair trades warm relations a little; generous ones (and gifts) a lot more.
  const surplus = lineValue(g) - lineValue(wa) * factor;
  const gift = Math.min(GOODWILL.giftMax, Math.floor(surplus / GOODWILL.giftValue));
  shiftGoodwill(w, f, faction, (wa.length ? GOODWILL.fairTrade : 0) + gift, gift > 0 ? (wa.length ? 'A generous trade' : 'A gift') : 'A fair trade');
  if (wa.length) {
    w.message(faction, `Trade done with ${f.name}. ${trader.name} has the goods.`, 'good', w.cellOf(trader));
    milestone(w, faction, 'first_trade', `Traded with ${f.name} for the first time.`);
  }
  else w.message(faction, `${f.name} accepts your gift.`, 'good', w.cellOf(trader));
}

// ---------------------------------------------------------------- requests

/** Days to deliver once accepted. */
const REQUEST_DAYS = 4;

const NEEDS: { item: string; lo: number; hi: number; why: string }[] = [
  { item: 'wood', lo: 40, hi: 90, why: 'to shore up their walls before the cold comes' },
  { item: 'cat:raw_food', lo: 40, hi: 80, why: 'because their harvest failed' },
  { item: 'cat:meal', lo: 6, hi: 14, why: 'because their cook fell sick and stores are running low' },
  { item: 'cloth', lo: 20, hi: 45, why: 'to sew winter clothes' },
  { item: 'steel', lo: 25, hi: 50, why: 'to mend their tools' },
  { item: 'parka', lo: 1, hi: 2, why: 'because a child has nothing warm to wear' },
  { item: 'stone', lo: 40, hi: 80, why: 'to build a proper hearth' },
];
/** What towns pay for help, picked to fit what it's worth. */
export const REWARDS = ['gold', 'steel', 'cloth', 'survival_meal', 'parka', 'rifle', 'bow'];

/** Label for a request's goods: "40 wood", "10 meals". */
export function requestText(item: string, n: number): string {
  if (item.startsWith('cat:')) return `${n} ${ITEM_CATEGORIES.find((c) => c.key === item.slice(4))?.label.toLowerCase() ?? item.slice(4)}`;
  return `${n} ${ITEMS[item]?.label.toLowerCase() ?? item}`;
}

function rewardText(r: SettlementRequest['reward']): string {
  return r === 'recruit' ? 'one of their people, who wants to join your colony' : requestText(r[0], r[1]);
}

/** How many of an item (or "cat:x") a faction has stored. */
export function storedOf(w: World, faction: number, of: string): number {
  if (!of.startsWith('cat:')) return storedCount(w, faction, of);
  const cat = of.slice(4);
  let n = 0;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (z && z.faction === faction && z.kind === 'stockpile' && ITEMS[it.def].category === cat) n += it.count;
  }
  return n;
}

function itemValue(of: string): number {
  if (!of.startsWith('cat:')) return ITEMS[of]?.marketValue ?? 1;
  const vals = Object.values(ITEMS)
    .filter((d) => d.category === of.slice(4))
    .map((d) => d.marketValue);
  return Math.min(...vals);
}

/** Settlements that could ask this colony for help: they've met, aren't enemies, nothing already pending. */
export function settlementsThatCouldAsk(w: World, faction: number): Faction[] {
  return [...w.factions.values()].filter((f) => f.settlement?.state === 'home' && canAsk(w, f).includes(faction));
}

function canAsk(w: World, f: Faction): number[] {
  const s = f.settlement!;
  const asking = new Set([...w.choices.values()].filter((c) => c.event === 'settlement_request' && w.choiceData.get(c.id)?.settlement === f.id).map((c) => c.faction));
  const open = new Set((s.requests ?? []).map((r) => r.faction));
  return s.met.filter((p) => w.factions.get(p)?.isPlayer && dispositionOf(s, p) !== 'hostile' && !asking.has(p) && !open.has(p) && !hasContract(w, f, p));
}

/**
 * A town asks a colony for help (the storyteller's settlement_plea): sometimes a job to do
 * (contracts.ts), otherwise goods to bring. Returns whether it asked.
 */
export function townAsks(w: World, f: Faction, faction: number): boolean {
  if (f.settlement?.state === 'home' && canAsk(w, f).includes(faction) && w.rng.chance(CONTRACT_CHANCE) && offerContract(w, f, faction)) return true;
  return askForHelp(w, f, faction);
}

/**
 * Ask a colony this settlement knows (and doesn't hate) for goods: `only` if given, else any of them.
 * The storyteller fires this as the settlement_plea event. Returns whether it asked.
 */
export function askForHelp(w: World, f: Faction, only?: number): boolean {
  const s = f.settlement!;
  if (s.state !== 'home') return false;
  const people = residentsOf(w, f.id);
  const who = canAsk(w, f).filter((p) => only === undefined || p === only);
  if (!who.length) return false;
  const faction = w.rng.pick(who);
  const need = w.rng.pick(NEEDS);
  const count = need.lo + w.rng.int(need.hi - need.lo + 1);
  const worth = itemValue(need.item) * count * w.rng.range(1.5, 2.2);
  let reward: SettlementRequest['reward'];
  if (people.length >= 3 && w.rng.chance(0.12)) reward = 'recruit';
  else {
    const affordable = REWARDS.filter((d) => ITEMS[d].marketValue <= worth);
    const def = affordable.length ? w.rng.pick(affordable) : 'gold';
    reward = [def, Math.max(1, Math.round(worth / ITEMS[def].marketValue))];
  }
  offerChoice(
    w,
    faction,
    'settlement_request',
    `${f.name} asks for help`,
    `${f.name} asks you for ${requestText(need.item, count)} ${need.why}. Bring it within ${REQUEST_DAYS} days and they'll give you ${rewardText(reward)}. If you agree and don't come, they'll remember.`,
    [
      { key: 'accept', label: 'Agree' },
      { key: 'decline', label: 'Decline' },
    ],
    12,
    { settlement: f.id, item: need.item, count, reward, why: need.why },
    w.map.idx(f.home.x, f.home.y),
  );
  return true;
}

registerChoice('settlement_request', (w, c, option, d) => {
  const f = w.factions.get(Number(d.settlement));
  const s = f?.settlement;
  if (!f || !s || s.state === 'fallen' || option !== 'accept') return;
  const r: SettlementRequest = {
    id: w.nextChoiceId++,
    faction: c.faction,
    item: String(d.item),
    count: Number(d.count),
    reward: d.reward as SettlementRequest['reward'],
    goodwill: GOODWILL.keptPromise,
    until: w.tick + REQUEST_DAYS * TICKS_PER_DAY,
    why: String(d.why),
  };
  (s.requests ??= []).push(r);
  w.dirty.factions.add(f.id);
  w.message(c.faction, `You agreed to bring ${f.name} ${requestText(r.item, r.count)}. Send a colonist there and deliver it from the Trade panel.`, 'neutral', w.map.idx(f.home.x, f.home.y));
});

function expireRequests(w: World, f: Faction): void {
  const s = f.settlement!;
  if (!s.requests?.length) return;
  if (s.state === 'leaving') {
    // Nobody can deliver to people on the move, so the clock stops until they settle again.
    for (const r of s.requests) r.until += RARE_TICK * 4;
    w.dirty.factions.add(f.id);
    return;
  }
  const keep: SettlementRequest[] = [];
  for (const r of s.requests) {
    if (w.tick < r.until) {
      keep.push(r);
      continue;
    }
    w.message(r.faction, `You promised ${f.name} ${requestText(r.item, r.count)} and never came. They won't forget it.`, 'bad', w.map.idx(f.home.x, f.home.y));
    shiftGoodwill(w, f, r.faction, GOODWILL.brokenPromise, `Never brought the ${requestText(r.item, r.count)}`);
  }
  if (keep.length !== s.requests.length) {
    s.requests = keep;
    w.dirty.factions.add(f.id);
  }
}

/** A settlement that is gone can't be helped: promises to it lapse, with no hard feelings. */
function voidRequests(w: World, f: Faction): void {
  const s = f.settlement!;
  for (const r of s.requests ?? []) w.message(r.faction, `${f.name} is gone. Your promise to bring them ${requestText(r.item, r.count)} no longer stands.`, 'neutral');
  s.requests = [];
  voidContracts(w, f);
  // Their letters asking for help go too: agreeing would do nothing.
  for (const c of [...w.choices.values()]) {
    if (c.event !== 'settlement_request' || Number(w.choiceData.get(c.id)?.settlement) !== f.id) continue;
    w.choices.delete(c.id);
    w.choiceData.delete(c.id);
    w.dirty.choices = true;
  }
}

/** Hand over what a settlement asked for, in person, and collect the reward. */
export function deliverRequest(w: World, faction: number, settlement: number, request: number): void {
  const f = w.factions.get(settlement);
  const s = f?.settlement;
  const r = s?.requests?.find((x) => x.id === request && x.faction === faction);
  if (!f || !s || !r) return;
  const say = (t: string) => w.message(faction, t, 'neutral');
  if (s.state !== 'home') return say(`${f.name} is on the move; there's nobody to take it.`);
  const trader = traderAt(w, faction, f);
  if (!trader) return say(`Send a colonist to ${f.name} to deliver. They need to be within ${TRADE_RANGE} cells.`);
  if (storedOf(w, faction, r.item) < r.count) return say(`You don't have ${requestText(r.item, r.count)} in your stockpiles.`);
  const drop = w.map.idx(f.home.x - HW + 1, f.home.y + HH - 1);
  // Item by item, so a category hands over whatever's in stock.
  const cat = r.item.startsWith('cat:') ? r.item.slice(4) : null;
  let left = r.count;
  for (const id of [...w.kinds.item]) {
    if (left <= 0) break;
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (!z || z.faction !== faction || z.kind !== 'stockpile' || (cat ? ITEMS[it.def].category !== cat : it.def !== r.item)) continue;
    const def = it.def;
    const got = w.takeFromItem(it, left);
    left -= got;
    w.placeItemNear(def, got, drop);
  }
  s.requests = s.requests!.filter((x) => x !== r);
  w.dirty.factions.add(f.id);
  const at = w.cellOf(trader);
  if (r.reward === 'recruit') {
    const joiner = residentsOf(w, f.id).find((p) => !p.downed);
    if (joiner) {
      if (joiner.bed) {
        const bed = w.get<Building>(joiner.bed);
        if (bed && bed.kind === 'building') {
          bed.owner = 0;
          w.markDirty(bed);
        }
      }
      joiner.faction = faction;
      joiner.job = null;
      joiner.path = null;
      joiner.bed = 0;
      w.markDirty(joiner);
      w.message(faction, `${joiner.name} of ${f.name} has joined your colony, grateful for your help.`, 'good', at);
      tell(w, faction, `${joiner.name} left ${f.name} to join the colony.`, 'first_colonist');
    }
  } else {
    w.placeItemNear(r.reward[0], r.reward[1], at);
    w.message(faction, `${f.name} thanks you for the ${requestText(r.item, r.count)}. ${trader.name} has ${requestText(r.reward[0], r.reward[1])}.`, 'good', at);
  }
  shiftGoodwill(w, f, faction, r.goodwill, `Brought the ${requestText(r.item, r.count)} we asked for`);
}

// ---------------------------------------------------------------- theft

/** One of their people caught a colony's colonist stealing from them. */
export function caughtStealing(w: World, owner: number, thiefFaction: number, worth = 0): void {
  const f = w.factions.get(owner);
  if (f?.settlement) shiftGoodwill(w, f, thiefFaction, GOODWILL.caughtStealing, 'Caught stealing from us');
  else if (f?.isPlayer && w.factions.get(thiefFaction)?.isPlayer) theftGrievance(w, owner, thiefFaction, worth);
}
