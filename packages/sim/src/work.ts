import { BUILDINGS, ITEMS, PLANTS, RECIPES, TERRAINS, WORK_TYPES, type RecipeDef, type WorkType } from '@fe/defs';
import { fullyDelivered, constructCost } from './jobs';
import { maybeReachable } from './pathfinding';
import { canUseItem, endJob, findFoodItem, portion } from './pawns';
import { bedBound, effectsOf, hoursToBleedOut, inBed, needsTending, type Effects } from './health';
import type { Building, Construct, Item, Job, Pawn, Plant, Zone } from './types';
import { DESIG } from './types';
import { giveHunt } from './wildlife';
import { dangerZones } from './settlements';
import { canStealFrom } from './stealth';
import { rk, type World } from './world';

type Giver = (w: World, p: Pawn) => Job | null;

const GIVERS: Record<WorkType, Giver> = {
  firefight: giveFirefight,
  doctor: giveDoctor,
  cook: (w, p) => giveBill(w, p, 'cook'),
  hunt: giveHunt,
  construct: giveConstruct,
  grow: giveGrow,
  mine: giveMine,
  plantcut: giveCut,
  craft: (w, p) => giveBill(w, p, 'craft'),
  haul: giveHaul,
};

export function findWork(w: World, p: Pawn): Job | null {
  // A colony-mate in danger comes before anything else this pawn would do, unless they never doctor.
  if (p.priorities.doctor > 0) {
    const j = giveDoctor(w, p, URGENT);
    if (j) return j;
  }
  for (let prio = 1; prio <= 4; prio++) {
    for (const wt of WORK_TYPES) {
      if (p.priorities[wt] !== prio) continue;
      const j = GIVERS[wt](w, p);
      if (j) return j;
    }
  }
  return null;
}

/**
 * The `limit` closest candidates (stable on ties, like a sort), skipping known-unreachable cells
 * and anything on the land of a settlement that would shoot the worker.
 * A bounded insertion keeps this O(n * limit) with no full sort or per-item allocation.
 */
function nearest<T>(w: World, p: Pawn, items: T[], cellOf: (t: T) => number, adj: boolean, limit = 25): T[] {
  const here = w.cellOf(p);
  const m = w.map;
  const danger = dangerZones(w, p.faction);
  const top: T[] = [];
  const dists: number[] = [];
  const cells: number[] = [];
  for (const t of items) {
    const c = cellOf(t);
    const d = w.dist(here, c);
    if (top.length === limit && d >= dists[limit - 1]) continue;
    if (w.isUnreachable(p.faction, c)) continue;
    if (danger.length && danger.some((z) => Math.hypot(m.cx(c) - z.x, m.cy(c) - z.y) <= z.r)) continue;
    let k = top.length;
    while (k > 0 && dists[k - 1] > d) k--;
    top.splice(k, 0, t);
    dists.splice(k, 0, d);
    cells.splice(k, 0, c);
    if (top.length > limit) {
      top.pop();
      dists.pop();
      cells.pop();
    }
  }
  const out: T[] = [];
  for (let k = 0; k < top.length; k++) if (maybeReachable(w, here, cells[k], adj)) out.push(top[k]);
  return out;
}

// ---------------------------------------------------------------- firefighting

/** Fires worth fighting: near home, or next to something this faction owns. */
function giveFirefight(w: World, p: Pawn): Job | null {
  if (w.fireCells.size === 0) return null;
  const f = w.factions.get(p.faction);
  if (!f) return null;
  const m = w.map;
  const home = m.idx(f.home.x, f.home.y);
  const fires: number[] = [];
  for (const c of w.fireCells) {
    if (w.reservedByOther(rk.f(c), p.id)) continue;
    let ours = w.dist(c, home) <= 25;
    if (!ours) {
      const x = m.cx(c);
      const y = m.cy(c);
      for (let dy = -3; dy <= 3 && !ours; dy++) {
        for (let dx = -3; dx <= 3 && !ours; dx++) {
          if (!m.inBounds(x + dx, y + dy)) continue;
          const n = m.idx(x + dx, y + dy);
          const b = m.buildingAt[n] ? w.get<Building>(m.buildingAt[n]) : undefined;
          const z = w.zoneAt(n);
          if ((b && b.faction === p.faction) || (z && z.faction === p.faction)) ours = true;
        }
      }
    }
    if (ours) fires.push(c);
  }
  const best = nearest(w, p, fires, (c) => c, true, 10)[0];
  if (best === undefined) return null;
  w.reserve(rk.f(best), p.id);
  return { type: 'extinguish', stage: 0, cell: best, progress: 0 };
}

// ---------------------------------------------------------------- doctoring

/** Patients lying in a bed get seen before ones this many cells closer. */
const IN_BED_PREFERENCE = 20;
/** A bleeding colony-mate who will die within this many hours is urgent: doctors drop lower work for them. */
export const URGENT_BLEED_HOURS = 24;
/** Within this many hours a patient is critical: a sleeping doctor gets up if nobody awake can help. */
export const CRITICAL_BLEED_HOURS = 6;
/** Patients who can't get up to eat are brought food below this. */
export const FEED_BELOW = 0.3;

/** Care urgency levels: routine, urgent (pre-empts other work), critical (worth waking for). */
export const ROUTINE = 0;
export const URGENT = 1;
export const CRITICAL = 2;

/**
 * How urgently a colony-mate needs a doctor. Bleeding out soon is urgent, and critical when it's
 * within a few hours; so is lying downed and bleeding, downed out of bed, or starving while bed-bound.
 */
export function careUrgency(w: World, o: Pawn): number {
  const bleeding = needsTending(o);
  const hours = bleeding ? hoursToBleedOut(o) : Infinity;
  if (hours < CRITICAL_BLEED_HOURS) return CRITICAL;
  if (hours < URGENT_BLEED_HOURS || (o.downed && (bleeding || !inBed(w, o)))) return URGENT;
  if (o.needs.food <= 0 && bedBound(w, o)) return URGENT;
  return ROUTINE;
}

/**
 * Carry downed colony-mates to bed, dress bleeding wounds (patients in bed first, then other
 * colony-mates, yourself if nobody else needs it), then feed those who can't get up to eat.
 * With `min` above ROUTINE, only patients at least that urgent are seen.
 */
function giveDoctor(w: World, p: Pawn, min = ROUTINE): Job | null {
  const patients: Pawn[] = [];
  const downed: Pawn[] = [];
  const hungry: Pawn[] = [];
  let self = false;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction !== p.faction) continue;
    if (min > ROUTINE && careUrgency(w, o) < min) continue;
    if (o.id !== p.id && !w.reservedByOther(rk.e(o.id), p.id)) {
      if (o.downed && !inBed(w, o) && !w.reservedByOther(rk.t(o.id), p.id)) downed.push(o);
      if (o.needs.food < FEED_BELOW && bedBound(w, o)) hungry.push(o);
    }
    if (!needsTending(o) || w.reservedByOther(rk.t(o.id), p.id)) continue;
    if (o.id === p.id) self = true;
    else patients.push(o);
  }
  for (const o of nearest(w, p, downed, (x) => w.cellOf(x), true, 5)) {
    const bed = bedFor(w, o, p);
    // No bed to take them to: tend them where they lie.
    if (!bed) break;
    w.reserve(rk.e(o.id), p.id);
    w.reserve(rk.t(o.id), p.id);
    w.reserve(rk.e(bed.id), p.id);
    return { type: 'rescue', stage: 0, patient: o.id, bed: bed.id, capture: false };
  }
  const here = w.cellOf(p);
  let best: Pawn | undefined;
  let bestScore = Infinity;
  for (const o of nearest(w, p, patients, (x) => w.cellOf(x), true, 10)) {
    const score = w.dist(here, w.cellOf(o)) - (inBed(w, o) ? IN_BED_PREFERENCE : 0);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  best ??= self ? p : undefined;
  if (best) {
    w.reserve(rk.t(best.id), p.id);
    return { type: 'tend', stage: 0, patient: best.id, progress: 0 };
  }
  const o = nearest(w, p, hungry, (x) => w.cellOf(x), true, 5)[0];
  const food = o && findFoodItem(w, p, here);
  if (!o || !food) return null;
  w.reserve(rk.e(o.id), p.id);
  w.reserve(rk.e(food.id), p.id);
  return { type: 'feed', stage: 0, patient: o.id, item: food.id, count: portion(food, o.needs.food), progress: 0 };
}

/** Jobs a doctor drops for an urgent patient. Player orders, needs, fighting and other care are left alone. */
const PREEMPTIBLE = new Set<Job['type']>(['wander', 'haul', 'deliver', 'build', 'mine', 'cut', 'sow', 'bill', 'repair', 'wear']);

/** Able to see to a patient right now: a doctor who is up, free to work, and not under orders. */
function canDoctor(p: Pawn, e: Effects): boolean {
  return p.priorities.doctor > 0 && !p.downed && !p.drafted && !p.prisoner && !e.noWork && !e.bedRest;
}

/**
 * Slow-tick check for one colonist: drop lower-urgency work to rescue, tend or feed a colony-mate
 * in danger. A sleeping doctor is woken only for a critical patient, and only when no other doctor is awake.
 */
export function answerUrgentCare(w: World, p: Pawn, e: Effects): void {
  const j = p.job;
  if (!j || !canDoctor(p, e)) return;
  const sleeping = j.type === 'sleep' && !j.rest;
  if (!sleeping && !PREEMPTIBLE.has(j.type)) return;
  const min = sleeping ? CRITICAL : URGENT;
  if (sleeping && awakeDoctor(w, p)) return;
  // Look before dropping anything: only give up the current job if there is care to give.
  if (!giveDoctor(w, p, min)) return;
  endJob(w, p);
  const care = giveDoctor(w, p, min);
  if (!care) return;
  p.job = care;
  w.markDirty(p);
  if (sleeping && 'patient' in care) {
    const pt = w.get<Pawn>(care.patient);
    w.message(p.faction, `${p.name} has been woken to help ${pt?.name ?? 'a patient'}.`, 'neutral', w.cellOf(p));
  }
}

/** Another colony-mate who is awake and could see to a patient. */
function awakeDoctor(w: World, p: Pawn): boolean {
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.id === p.id || o.faction !== p.faction || o.asleep || o.priorities.doctor <= 0) continue;
    if (o.job?.type === 'sleep') continue;
    if (canDoctor(o, effectsOf(w, o))) return true;
  }
  return false;
}

/**
 * A bed of the carrier's colony to lay a downed pawn in: their own, or the nearest free one.
 * Reachability is checked from where the patient lies.
 */
export function bedFor(w: World, patient: Pawn, carrier: Pawn): Building | null {
  const own = patient.bed ? w.get<Building>(patient.bed) : undefined;
  if (own && own.kind === 'building' && own.owner === patient.id && own.faction === carrier.faction && !w.reservedByOther(rk.e(own.id), carrier.id)) return own;
  const from = w.cellOf(patient);
  let best: Building | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    if (b.faction !== carrier.faction || !BUILDINGS[b.def].bed || b.owner || w.reservedByOther(rk.e(b.id), carrier.id)) continue;
    const c = w.cellOf(b);
    const d = w.dist(from, c);
    if (d < bestD && !w.isUnreachable(carrier.faction, c) && maybeReachable(w, from, c, false)) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

// ---------------------------------------------------------------- hauling

export function isStored(w: World, it: Item): boolean {
  const z = w.zoneAt(w.cellOf(it));
  return !!z && z.kind === 'stockpile' && z.allow.includes(ITEMS[it.def].category);
}

/** Best stockpile cell for an item, or -1. Prefers topping up existing stacks. */
export function findStorageCell(w: World, faction: number, it: Item, pawn: number): number {
  const from = w.cellOf(it);
  const cat = ITEMS[it.def].category;
  let best = -1;
  let bestScore = Infinity;
  for (const z of w.zones.values()) {
    if (z.faction !== faction || z.kind !== 'stockpile' || !z.allow.includes(cat)) continue;
    for (const c of z.cells) {
      if (c === from || w.reservedByOther(rk.c(c), pawn) || w.map.constructAt[c]) continue;
      if (w.roomFor(c, it.def) <= 0) continue;
      const score = w.dist(from, c) - (w.map.itemAt[c] ? 3 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  return best;
}

let looseCache: { world: World; version: number; items: Item[] } | null = null;

/** Items sitting outside any stockpile that accepts them. Cached until items or zones change. */
function looseItems(w: World): Item[] {
  if (looseCache && looseCache.world === w && looseCache.version === w.haulVersion) return looseCache.items;
  const items: Item[] = [];
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    if (!isStored(w, it)) items.push(it);
  }
  looseCache = { world: w, version: w.haulVersion, items };
  return items;
}

function giveHaul(w: World, p: Pawn): Job | null {
  let hasStockpile = false;
  for (const z of w.zones.values()) if (z.faction === p.faction && z.kind === 'stockpile') hasStockpile = true;
  if (!hasStockpile) return null;
  const steal = giveSteal(w, p);
  if (steal) return steal;
  const cands: Item[] = [];
  const others = otherColonyHomes(w, p.faction);
  for (const it of looseItems(w)) if (canUseItem(w, p, it) && !nearOtherColony(w, others, it)) cands.push(it);
  for (const it of nearest(w, p, cands, (i) => w.cellOf(i), false, 12)) {
    const dest = findStorageCell(w, p.faction, it, p.id);
    if (dest < 0) continue;
    w.reserve(rk.e(it.id), p.id);
    w.reserve(rk.c(dest), p.id);
    return { type: 'haul', stage: 0, item: it.id, dest };
  }
  return null;
}

/** Loose goods this close to another colony's home are theirs (starting supplies, trade goods), not a neighbour's to tidy away. */
const CLAIM_RADIUS = 15;

function otherColonyHomes(w: World, faction: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const f of w.factions.values()) if (f.isPlayer && f.id !== faction) out.push(f.home);
  return out;
}

function nearOtherColony(w: World, homes: { x: number; y: number }[], it: Item): boolean {
  if (!homes.length) return false;
  const c = w.cellOf(it);
  const x = w.map.cx(c);
  const y = w.map.cy(c);
  return homes.some((h) => Math.max(Math.abs(h.x - x), Math.abs(h.y - y)) <= CLAIM_RADIUS);
}

/** Goods marked for stealing from a settlement's or another colony's stores, carried home to our stockpile. Only after dark. */
function giveSteal(w: World, p: Pawn): Job | null {
  if (!w.isNight()) return null;
  const m = w.map;
  const cands: Item[] = [];
  for (const c of w.desigCells) {
    if (m.desig[c] !== DESIG.steal || m.desigFaction[c] !== p.faction) continue;
    const it = m.itemAt[c] ? w.get<Item>(m.itemAt[c]) : undefined;
    const z = w.zoneAt(c);
    if (!it || it.kind !== 'item' || !z || z.kind !== 'stockpile' || !canStealFrom(w, p.faction, z.faction)) {
      w.setDesig(c, 0, 0);
      continue;
    }
    if (it.rot < 1 && !w.reservedByOther(rk.e(it.id), p.id)) cands.push(it);
  }
  for (const it of nearest(w, p, cands, (i) => w.cellOf(i), false, 6)) {
    const dest = findStorageCell(w, p.faction, it, p.id);
    if (dest < 0) continue;
    w.reserve(rk.e(it.id), p.id);
    w.reserve(rk.c(dest), p.id);
    return { type: 'haul', stage: 0, item: it.id, dest };
  }
  return null;
}

// ---------------------------------------------------------------- construction

/** Nearest usable item matching a key or "cat:<category>". */
function findMaterial(w: World, p: Pawn, of: string, near: number, exclude?: Set<number>): Item | null {
  const cat = of.startsWith('cat:') ? of.slice(4) : null;
  let best: Item | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.item) {
    if (exclude?.has(id)) continue;
    const it = w.get<Item>(id)!;
    if (cat ? ITEMS[it.def].category !== cat : it.def !== of) continue;
    if (!canUseItem(w, p, it)) continue;
    const c = w.cellOf(it);
    if (w.isUnreachable(p.faction, c)) continue;
    const d = w.dist(near, c);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

function giveConstruct(w: World, p: Pawn): Job | null {
  return giveBuild(w, p) ?? giveRepair(w, p);
}

/** Mend this faction's damaged buildings. */
function giveRepair(w: World, p: Pawn): Job | null {
  if (w.damaged.size === 0) return null;
  const hurt: Building[] = [];
  for (const id of w.damaged) {
    const b = w.get<Building>(id);
    if (b && b.faction === p.faction && !w.reservedByOther(rk.e(b.id), p.id)) hurt.push(b);
  }
  const best = nearest(w, p, hurt, (b) => w.cellOf(b), true, 10)[0];
  if (!best) return null;
  w.reserve(rk.e(best.id), p.id);
  return { type: 'repair', stage: 0, target: best.id };
}

function giveBuild(w: World, p: Pawn): Job | null {
  const mine: Construct[] = [];
  for (const id of w.kinds.construct) {
    const c = w.get<Construct>(id)!;
    if (c.faction === p.faction) mine.push(c);
  }
  if (mine.length === 0) return null;
  for (const con of nearest(w, p, mine, (c) => w.cellOf(c), true, 40)) {
    const cell = w.cellOf(con);
    if (fullyDelivered(con)) {
      if (w.reservedByOther(rk.e(con.id), p.id)) continue;
      const plantId = w.map.plantAt[cell];
      if (plantId && BUILDINGS[con.def].blocksMovement) {
        const plant = w.get<Plant>(plantId)!;
        if (PLANTS[plant.def].tree) {
          if (!w.map.desig[cell]) w.setDesig(cell, DESIG.cut, p.faction);
          continue;
        }
      }
      w.reserve(rk.e(con.id), p.id);
      return { type: 'build', stage: 0, target: con.id };
    }
    if (w.reservedByOther(rk.d(con.id), p.id)) continue;
    const cost = constructCost(con);
    for (const def in cost) {
      const rem = cost[def] - (con.delivered[def] ?? 0);
      if (rem <= 0) continue;
      const it = findMaterial(w, p, def, cell);
      if (!it) continue;
      w.reserve(rk.d(con.id), p.id);
      w.reserve(rk.e(it.id), p.id);
      return { type: 'deliver', stage: 0, item: it.id, target: con.id, count: Math.min(rem, it.count, ITEMS[def].stackLimit) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- mining & cutting

function giveMine(w: World, p: Pawn): Job | null {
  const m = w.map;
  const cells: number[] = [];
  for (const c of w.desigCells) {
    if (m.desig[c] !== DESIG.mine || m.desigFaction[c] !== p.faction || !m.rock[c]) continue;
    if (w.reservedByOther(rk.c(c), p.id)) continue;
    cells.push(c);
  }
  const best = nearest(w, p, cells, (c) => c, true, 15)[0];
  if (best === undefined) return null;
  w.reserve(rk.c(best), p.id);
  return { type: 'mine', stage: 0, cell: best, progress: 0 };
}

function giveCut(w: World, p: Pawn): Job | null {
  const m = w.map;
  const plants: Plant[] = [];
  for (const c of w.desigCells) {
    const k = m.desig[c];
    if ((k !== DESIG.cut && k !== DESIG.harvest) || m.desigFaction[c] !== p.faction) continue;
    const plant = m.plantAt[c] ? w.get<Plant>(m.plantAt[c]) : undefined;
    if (!plant || w.reservedByOther(rk.e(plant.id), p.id)) continue;
    if (k === DESIG.harvest && plant.growth < PLANTS[plant.def].harvestMin) continue;
    plants.push(plant);
  }
  const best = nearest(w, p, plants, (pl) => w.cellOf(pl), true, 15)[0];
  if (!best) return null;
  w.reserve(rk.e(best.id), p.id);
  return { type: 'cut', stage: 0, target: best.id, progress: 0, harvest: m.desig[w.cellOf(best)] === DESIG.harvest };
}

// ---------------------------------------------------------------- growing

export function canSowAt(w: World, z: Zone, c: number): boolean {
  const m = w.map;
  if (m.plantAt[c] || m.buildingAt[c] || m.constructAt[c] || m.solid[c]) return false;
  const def = PLANTS[z.plant];
  if (!def || TERRAINS[m.terrain[c]].fertility < def.minFertility) return false;
  return w.tempAt(c) > 2;
}

function giveGrow(w: World, p: Pawn): Job | null {
  const m = w.map;
  const harvest: Plant[] = [];
  const clear: Plant[] = [];
  const sow: number[] = [];
  for (const z of w.zones.values()) {
    if (z.faction !== p.faction || z.kind !== 'grow') continue;
    for (const c of z.cells) {
      const plant = m.plantAt[c] ? w.get<Plant>(m.plantAt[c]) : undefined;
      if (plant) {
        if (w.reservedByOther(rk.e(plant.id), p.id)) continue;
        if (plant.def !== z.plant) clear.push(plant);
        else if (plant.growth >= 1 || plant.blighted) harvest.push(plant);
      } else if (!w.reservedByOther(rk.c(c), p.id) && canSowAt(w, z, c)) {
        sow.push(c);
      }
    }
  }
  const h = nearest(w, p, [...harvest, ...clear], (pl) => w.cellOf(pl), true, 10)[0];
  if (h) {
    w.reserve(rk.e(h.id), p.id);
    return { type: 'cut', stage: 0, target: h.id, progress: 0, harvest: h.def === w.zoneAt(w.cellOf(h))?.plant };
  }
  const s = nearest(w, p, sow, (c) => c, false, 10)[0];
  if (s !== undefined) {
    w.reserve(rk.c(s), p.id);
    return { type: 'sow', stage: 0, cell: s, plant: w.zoneAt(s)!.plant, progress: 0 };
  }
  return null;
}

// ---------------------------------------------------------------- bills

/** Count of an item stored in a faction's stockpiles. */
export function storedCount(w: World, faction: number, def: string): number {
  let n = 0;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    if (it.def !== def) continue;
    const z = w.zoneAt(w.cellOf(it));
    if (z && z.faction === faction && z.kind === 'stockpile') n += it.count;
  }
  return n;
}

function billWanted(w: World, faction: number, mode: string, target: number, recipe: RecipeDef): boolean {
  if (mode === 'forever') return true;
  if (mode === 'count') return target > 0;
  return storedCount(w, faction, recipe.product.item) < target;
}

function giveBill(w: World, p: Pawn, type: WorkType): Job | null {
  const benches: Building[] = [];
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    if (b.faction === p.faction && b.bills.length && !w.reservedByOther(rk.e(b.id), p.id)) benches.push(b);
  }
  for (const bench of nearest(w, p, benches, (b) => w.cellOf(b), true, 10)) {
    for (const bill of bench.bills) {
      const recipe = RECIPES[bill.recipe];
      if (bill.suspended || recipe.workType !== type || !billWanted(w, p.faction, bill.mode, bill.target, recipe)) continue;
      const sources = gatherSources(w, p, recipe, w.cellOf(bench));
      if (!sources) continue;
      w.reserve(rk.e(bench.id), p.id);
      for (const s of sources) w.reserve(rk.e(s.item), p.id);
      return { type: 'bill', stage: 0, bench: bench.id, bill: bill.id, sources, gathered: [], progress: 0 };
    }
  }
  return null;
}

function gatherSources(w: World, p: Pawn, recipe: RecipeDef, near: number): { item: number; count: number }[] | null {
  const used = new Set<number>();
  const out: { item: number; count: number }[] = [];
  for (const ing of recipe.ingredients) {
    let need = ing.count;
    while (need > 0) {
      const it = findMaterial(w, p, ing.of, near, used);
      if (!it) return null;
      used.add(it.id);
      const n = Math.min(need, it.count);
      out.push({ item: it.id, count: n });
      need -= n;
    }
  }
  return out;
}
