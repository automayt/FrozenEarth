import { ITEMS, type ItemCategory } from '@fe/defs';
import { TICKS_PER_HOUR } from './constants';
import { findPath, makePathState } from './pathfinding';
import { pawnSpeed } from './pawns';
import { siteProblem } from './setup';
import { calendar } from './time';
import type { Caravan, Command, EntityId, Faction, Item, Job, Pawn } from './types';
import { NEIGHBORS8, rk, type World } from './world';
import { roadEncounters, nightShelter } from './road';

/**
 * Moving the colony inward as one journey. The player picks who goes, where to, and what to
 * take. The members gather at home while the goods are loaded (up to what they can carry:
 * sledges carry far more), then walk the route together, eating from the packs, making camp
 * around a fire at night. On arrival the goods are unloaded and the colony's home moves there.
 */

/** What a colonist carries on their back, and a sledge one of them pulls, in bulk (a full stack is 50). */
export const MEMBER_CARRY = 75;
export const SLEDGE_CARRY = 300;
/** Goods are loaded from the colony's stockpiles within this many cells of the muster point. */
export const LOAD_RADIUS = 30;
/** Waypoints along the route, this many cells apart. The group regroups at each. */
const LEG = 6;
/** Everyone within this many cells of the waypoint and the group moves on. */
const NEAR = 4;
/** Stragglers don't hold the group up forever. */
const LEG_TIMEOUT = 900;
/** Mustering ends when everyone is there, or after this long. */
const MUSTER_HOURS = 2;
/** Camp from this hour until dawn. */
const CAMP_FROM = 21;
const DAWN = 6;
/** Most waypoints a route may take you through. */
export const MAX_VIA = 4;
/** How heavy a full load is on the legs: a fully loaded caravan moves at this share of a light one's pace. */
const FULL_LOAD_PACE = 0.6;

/** Bulk of some goods: a full stack is 50, single big things (kits, apparel, weapons) at most 25 each. */
export function bulkOf(def: string, n: number): number {
  const d = ITEMS[def];
  if (!d || def === 'sledge') return 0;
  return n * Math.min(25, 50 / d.stackLimit);
}

export function cargoBulk(cargo: [string, number][]): number {
  return cargo.reduce((a, [d, n]) => a + bulkOf(d, n), 0);
}

export function sledgesIn(cargo: [string, number][]): number {
  return cargo.reduce((a, [d, n]) => a + (d === 'sledge' ? n : 0), 0);
}

/** How much a group can carry: everyone's back, plus a sledge for each who has one to pull. */
export function carryCapacity(members: number, sledges: number): number {
  return members * MEMBER_CARRY + Math.min(sledges, members) * SLEDGE_CARRY;
}

/** Walk-speed factor for a caravan member: heavier loads, slower going. 1 outside a caravan. */
export function caravanPace(w: World, p: Pawn): number {
  const c = w.factions.get(p.faction)?.caravan;
  if (!c || c.phase !== 'travel' || !c.members.includes(p.id)) return 1;
  const cap = carryCapacity(c.members.length, sledgesIn(c.cargo));
  return 1 - (1 - FULL_LOAD_PACE) * Math.min(1, cap ? cargoBulk(c.cargo) / cap : 1);
}

export function inCaravan(w: World, p: Pawn): Caravan | undefined {
  const c = w.factions.get(p.faction)?.caravan;
  return c && c.members.includes(p.id) ? c : undefined;
}

// ---------------------------------------------------------------- commands

type CaravanCmd = Extract<Command, { c: 'caravan' }>;

export function caravanCommand(w: World, faction: number, cmd: CaravanCmd): void {
  const f = w.factions.get(faction);
  if (!f?.isPlayer) return;
  const say = (t: string) => w.message(faction, t, 'neutral');
  switch (cmd.act) {
    case 'form':
      return form(w, f, cmd, say);
    case 'halt':
      if (f.caravan?.phase === 'travel') {
        f.caravan.phase = 'halt';
        w.dirty.factions.add(faction);
        endJobs(w, f.caravan);
        say('The caravan stops where it is. Resume when you are ready.');
      }
      return;
    case 'resume':
      if (f.caravan?.phase === 'halt') {
        f.caravan.phase = 'travel';
        f.caravan.legSince = w.tick;
        w.dirty.factions.add(faction);
        endJobs(w, f.caravan);
      }
      return;
    case 'disband':
      if (f.caravan) {
        const at = leaderCell(w, f.caravan);
        unload(w, f, at);
        say('The caravan is called off. Its goods are set down where it stood.');
      }
      return;
  }
}

function form(w: World, f: Faction, cmd: CaravanCmd, say: (t: string) => void): void {
  if (f.caravan) return say('A caravan is already on its way. Call it off first to plan a new one.');
  const members: Pawn[] = [];
  for (const id of new Set(cmd.pawns ?? [])) {
    const p = w.get<Pawn>(id);
    if (p && p.kind === 'pawn' && p.faction === f.id && !p.downed && !p.prisoner && !p.species) members.push(p);
  }
  if (!members.length) return say('Pick who goes on the journey.');
  const m = w.map;
  const x = Math.round(Number(cmd.x));
  const y = Math.round(Number(cmd.y));
  if (!m.inBounds(x, y)) return;
  const problem = siteProblem(w, x, y, f.id);
  if (problem) return say(`Can't settle there: ${problem}`);
  const muster = m.idx(f.home.x, f.home.y);
  const dest = m.idx(x, y);
  const via = (cmd.via ?? []).slice(0, MAX_VIA).filter(([vx, vy]) => m.inBounds(vx, vy)).map(([vx, vy]) => m.idx(vx, vy));
  const route = planRoute(w, f.id, muster, dest, via);
  if (!route) return say('There is no way through to there. Try another spot, or route it through a waypoint.');
  const take = (cmd.take ?? []).filter((k) => typeof k === 'string') as ItemCategory[];
  f.caravan = {
    phase: 'muster',
    members: members.map((p) => p.id),
    muster,
    dest,
    via,
    route,
    leg: 0,
    cargo: [],
    take,
    until: w.tick + MUSTER_HOURS * TICKS_PER_HOUR,
    legSince: w.tick,
    started: w.tick,
    dealt: [],
    met: [],
  };
  w.dirty.factions.add(f.id);
  endJobs(w, f.caravan);
  say(`${members.length === 1 ? members[0].name.split(' ')[0] + ' is' : `${members.length} colonists are`} gathering at home to load up for the journey.`);
}

/** Waypoints from start through each via point to dest, LEG cells apart. Null if there's no way. */
export function planRoute(w: World, faction: number, start: number, dest: number, via: number[] = []): number[] | null {
  const stops = [...via, dest];
  const out: number[] = [];
  let from = start;
  for (const to of stops) {
    const cells = findPath(w, from, to, false, faction, 400_000);
    if (!cells) return null;
    for (let k = LEG - 1; k < cells.length - 1; k += LEG) out.push(cells[k]);
    out.push(to);
    from = to;
  }
  return out;
}

function endJobs(w: World, c: Caravan): void {
  for (const id of c.members) {
    const p = w.get<Pawn>(id);
    if (!p || p.kind !== 'pawn') continue;
    p.job = null;
    p.path = null;
    p.asleep = false;
    w.markDirty(p);
  }
}

// ---------------------------------------------------------------- members

/** What a caravan member does now: gather, walk the route, sleep by the fire, or wait. */
export function caravanJob(w: World, p: Pawn, c: Caravan): Job {
  if (c.phase === 'camp' && isNightAt(w)) {
    // Inside a friendly town's walls if they offered; otherwise round the fire.
    const town = c.shelter ? w.factions.get(c.shelter) : undefined;
    const fire = c.fire ? w.get(c.fire) : undefined;
    const around = town ? w.map.idx(town.home.x, town.home.y) : fire ? w.cellOf(fire) : -1;
    // (Once rested they just wait by it: a sleep job that ends at once would be handed out every tick.)
    if (around >= 0 && p.needs.rest < 0.9) return { type: 'sleep', stage: 0, bed: 0, cell: campSpot(w, around, p), rest: false };
  }
  return { type: 'trek', stage: 0, phase: c.phase };
}

/** Run one tick of the trek job. */
export function trekTick(w: World, p: Pawn, phase: Caravan['phase']): 'continue' | 'done' {
  const c = inCaravan(w, p);
  if (!c || c.phase !== phase) return 'done';
  if (p.needs.food < 0.35) eatFromPacks(w, c, p);
  if (c.phase === 'muster') {
    goToward(w, p, c.muster);
    return 'continue';
  }
  if (c.phase === 'travel') {
    goToward(w, p, c.route[Math.min(c.leg, c.route.length - 1)]);
    return 'continue';
  }
  if (c.phase === 'camp') {
    // Rested already: wait inside the friendly town that took them in, or by the fire.
    const town = c.shelter ? w.factions.get(c.shelter) : undefined;
    const fire = c.fire ? w.get(c.fire) : undefined;
    if (town) goToward(w, p, w.map.idx(town.home.x, town.home.y));
    else if (fire) goToward(w, p, w.cellOf(fire));
  }
  // Halted: wait where they stand.
  return 'continue';
}

function goToward(w: World, p: Pawn, cell: number): void {
  const here = w.cellOf(p);
  if (w.dist(here, cell) <= 1) return;
  if (p.path && p.path.goal === cell) return;
  const cells = findPath(w, here, cell, true, p.faction, 60_000);
  if (!cells) return;
  // A shared waypoint: the cell next to it is close enough.
  p.path = makePathState(w, here, cells, cell, true, pawnSpeed(w, p));
  w.markDirty(p);
}

/** Meals first, then raw food: they eat from the packs on the road. */
function eatFromPacks(w: World, c: Caravan, p: Pawn): void {
  const foods = c.cargo
    .map((line, i) => ({ line, i, d: ITEMS[line[0]] }))
    .filter((x) => x.d?.nutrition && x.line[1] > 0)
    .sort((a, b) => (b.d.nutrition ?? 0) - (a.d.nutrition ?? 0));
  const pick = foods[0];
  if (!pick) return;
  const per = pick.d.nutrition!;
  const units = Math.min(pick.line[1], Math.max(1, Math.ceil((1 - p.needs.food) / per)));
  pick.line[1] -= units;
  if (pick.line[1] <= 0) c.cargo.splice(pick.i, 1);
  p.needs.food = Math.min(1, p.needs.food + units * per);
  w.dirty.factions.add(p.faction);
  w.markDirty(p);
}

function isNightAt(w: World): boolean {
  const h = calendar(w.tick).hour;
  return h >= CAMP_FROM || h < DAWN;
}

/** A free spot near the fire for one sleeper. */
function campSpot(w: World, fire: number, p: Pawn): number {
  const m = w.map;
  const x = m.cx(fire);
  const y = m.cy(fire);
  const k = p.id % NEIGHBORS8.length;
  for (let r = 1; r <= 3; r++) {
    for (let i = 0; i < NEIGHBORS8.length; i++) {
      const [dx, dy] = NEIGHBORS8[(i + k) % NEIGHBORS8.length];
      const nx = x + dx * r;
      const ny = y + dy * r;
      if (!m.inBounds(nx, ny)) continue;
      const c = m.idx(nx, ny);
      if (w.passable(c, p.faction) && !m.buildingAt[c]) return c;
    }
  }
  return fire;
}

function leaderCell(w: World, c: Caravan): number {
  for (const id of c.members) {
    const p = w.get<Pawn>(id);
    if (p && p.kind === 'pawn' && !p.downed) return w.cellOf(p);
  }
  return c.at ?? c.muster;
}

// ---------------------------------------------------------------- the journey over time

/** Every half second or so: drop the fallen, load, move on, camp, break camp, arrive. */
export function caravanTick(w: World): void {
  if (w.tick % 30 !== 0) return;
  for (const f of w.factions.values()) {
    const c = f.caravan;
    if (!c) continue;
    roll(w, f, c);
    if (!f.caravan) continue;
    c.at = leaderCell(w, c);
    if (c.phase === 'muster') musterTick(w, f, c);
    else if (c.phase === 'travel') travelTick(w, f, c);
    else if (c.phase === 'camp') campTick(w, f, c);
  }
}

/** Who's still with the caravan: the dead are gone; the downed are left behind (with a letter). */
function roll(w: World, f: Faction, c: Caravan): void {
  const keep: EntityId[] = [];
  for (const id of c.members) {
    const p = w.get<Pawn>(id);
    if (!p || p.kind !== 'pawn' || p.faction !== f.id || p.prisoner) continue;
    if (p.downed && c.phase !== 'muster') {
      w.message(f.id, `${p.name} is down and has been left behind by the caravan. Send someone back, or halt the caravan.`, 'bad', w.cellOf(p));
      continue;
    }
    keep.push(id);
  }
  if (keep.length === c.members.length) return;
  c.members = keep;
  w.dirty.factions.add(f.id);
  if (!keep.length) {
    const at = c.at ?? c.muster;
    unload(w, f, at);
    w.message(f.id, 'Nobody is left to carry on with the caravan. Its goods lie where it last stood.', 'bad', at);
  }
}

function membersNear(w: World, c: Caravan, cell: number, r: number): boolean {
  for (const id of c.members) {
    const p = w.get<Pawn>(id);
    if (!p || p.kind !== 'pawn' || p.drafted) continue;
    if (w.dist(w.cellOf(p), cell) > r) return false;
  }
  return true;
}

function musterTick(w: World, f: Faction, c: Caravan): void {
  if (!membersNear(w, c, c.muster, 3) && w.tick < c.until) return;
  load(w, f, c);
  // The route is planned again now: walls may have come down while they packed.
  const route = planRoute(w, f.id, c.muster, c.dest, c.via);
  if (route) c.route = route;
  c.phase = 'travel';
  c.leg = 0;
  c.legSince = w.tick;
  w.dirty.factions.add(f.id);
  endJobs(w, c);
  const cap = carryCapacity(c.members.length, sledgesIn(c.cargo));
  w.message(f.id, `The caravan sets out: ${c.members.length} ${c.members.length === 1 ? 'colonist' : 'colonists'}, carrying ${Math.round(cargoBulk(c.cargo))} of ${cap}.`, 'good', c.muster);
}

/** Order goods are loaded in: sledges (they add room), kits, food, clothes, weapons, then materials. */
const LOAD_ORDER: ItemCategory[] = ['gear', 'kit', 'meal', 'raw_food', 'apparel', 'weapon', 'resource'];

/** Take goods from the colony's stockpiles near the muster point, up to what the group can carry. */
export function load(w: World, f: Faction, c: Caravan): void {
  const m = w.map;
  const mx = m.cx(c.muster);
  const my = m.cy(c.muster);
  const allowed = c.take.length ? new Set(c.take) : null;
  const near: Item[] = [];
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    if (Math.abs(it.x - mx) > LOAD_RADIUS || Math.abs(it.y - my) > LOAD_RADIUS) continue;
    const cat = ITEMS[it.def]?.category;
    if (!cat || (allowed && !allowed.has(cat) && cat !== 'gear')) continue;
    const z = w.zoneAt(w.cellOf(it));
    // Their own stockpiles; and their packed kits and sledges lying about the old site.
    const ours = z && z.faction === f.id && z.kind === 'stockpile';
    const packed = !z && (cat === 'kit' || cat === 'gear') && Math.hypot(it.x - mx, it.y - my) <= LOAD_RADIUS;
    if (!ours && !packed) continue;
    if (w.reservedByOther(rk.e(it.id), -1)) continue;
    near.push(it);
  }
  near.sort((a, b) => LOAD_ORDER.indexOf(ITEMS[a.def].category) - LOAD_ORDER.indexOf(ITEMS[b.def].category) || ITEMS[b.def].marketValue - ITEMS[a.def].marketValue);
  for (const it of near) {
    const cap = carryCapacity(c.members.length, sledgesIn(c.cargo));
    const room = cap - cargoBulk(c.cargo);
    const per = bulkOf(it.def, 1);
    const n = it.def === 'sledge' ? (sledgesIn(c.cargo) < c.members.length ? 1 : 0) : per > 0 ? Math.min(it.count, Math.floor(room / per)) : it.count;
    if (n <= 0) continue;
    const def = it.def;
    const got = w.takeFromItem(it, n);
    const line = c.cargo.find((l) => l[0] === def);
    if (line) line[1] += got;
    else c.cargo.push([def, got]);
  }
}

function travelTick(w: World, f: Faction, c: Caravan): void {
  if (isNightAt(w) && calendar(w.tick).hour >= CAMP_FROM) return makeCamp(w, f, c);
  // Waiting on the player's answer to a toll.
  if (c.waiting !== undefined) {
    if (w.choices.has(c.waiting)) return;
    c.waiting = undefined;
  }
  const target = c.route[c.leg];
  if (!membersNear(w, c, target, NEAR) && w.tick - c.legSince < LEG_TIMEOUT) return;
  c.leg++;
  c.legSince = w.tick;
  w.dirty.factions.add(f.id);
  if (c.leg >= c.route.length) return arrive(w, f, c);
  roadEncounters(w, f, c);
}

function makeCamp(w: World, f: Faction, c: Caravan): void {
  const m = w.map;
  const at = leaderCell(w, c);
  let spot = -1;
  for (let r = 0; r <= 4 && spot < 0; r++) {
    for (const [dx, dy] of [[0, 0], ...NEIGHBORS8]) {
      const x = m.cx(at) + dx * r;
      const y = m.cy(at) + dy * r;
      if (!m.inBounds(x, y)) continue;
      const cell = m.idx(x, y);
      if (!m.solid[cell] && !m.buildingAt[cell] && !m.constructAt[cell] && !m.itemAt[cell] && !m.roomAt[cell]) {
        spot = cell;
        break;
      }
    }
  }
  c.phase = 'camp';
  const h = calendar(w.tick).hour;
  c.until = w.tick + Math.round(((24 - h + DAWN) % 24 || 24) * TICKS_PER_HOUR) - (w.tick % TICKS_PER_HOUR);
  if (spot >= 0) c.fire = w.spawnBuilding('campfire', spot, f.id).id;
  w.dirty.factions.add(f.id);
  endJobs(w, c);
  nightShelter(w, f, c);
  w.message(f.id, 'The caravan makes camp for the night.', 'neutral', spot >= 0 ? spot : at);
}

function campTick(w: World, f: Faction, c: Caravan): void {
  if (w.tick < c.until) return;
  breakCamp(w, c);
  c.phase = 'travel';
  c.legSince = w.tick;
  c.shelter = undefined;
  w.dirty.factions.add(f.id);
  endJobs(w, c);
}

function breakCamp(w: World, c: Caravan): void {
  if (c.fire && w.entities.has(c.fire)) w.despawn(c.fire);
  c.fire = undefined;
}

function arrive(w: World, f: Faction, c: Caravan): void {
  const n = c.cargo.reduce((a, [, k]) => a + k, 0);
  unload(w, f, c.dest);
  f.home = { x: w.map.cx(c.dest), y: w.map.cy(c.dest) };
  if (w.story.frostNotice) w.story.frostNotice[f.id] = 0;
  w.dirty.factions.add(f.id);
  w.message(f.id, `The caravan has arrived. ${n ? 'The goods are unpacked by the new home: make a stockpile, and place buildings you have kits for to set them up quickly.' : ''} This is home now.`, 'good', c.dest);
}

/** Set the goods down around a cell and end the caravan. */
function unload(w: World, f: Faction, at: number): void {
  const c = f.caravan;
  if (!c) return;
  breakCamp(w, c);
  for (const [def, n] of c.cargo) if (n > 0) w.placeItemNear(def, n, at);
  f.caravan = undefined;
  w.dirty.factions.add(f.id);
  for (const id of c.members) {
    const p = w.get<Pawn>(id);
    if (p && p.kind === 'pawn') {
      p.job = null;
      p.path = null;
      w.markDirty(p);
    }
  }
}
