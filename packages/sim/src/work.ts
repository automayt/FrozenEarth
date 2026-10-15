import { BUILDINGS, ITEMS, PLANTS, RECIPES, TERRAINS, WORK_TYPES, type RecipeDef, type WorkType } from '@fe/defs';
import { fullyDelivered } from './jobs';
import { maybeReachable } from './pathfinding';
import { canUseItem } from './pawns';
import { needsTending } from './health';
import type { Building, Construct, Item, Job, Pawn, Plant, Zone } from './types';
import { DESIG } from './types';
import type { World } from './world';

type Giver = (w: World, p: Pawn) => Job | null;

const GIVERS: Record<WorkType, Giver> = {
  firefight: giveFirefight,
  doctor: giveDoctor,
  cook: (w, p) => giveBill(w, p, 'cook'),
  construct: giveConstruct,
  grow: giveGrow,
  mine: giveMine,
  plantcut: giveCut,
  craft: (w, p) => giveBill(w, p, 'craft'),
  haul: giveHaul,
};

export function findWork(w: World, p: Pawn): Job | null {
  for (let prio = 1; prio <= 4; prio++) {
    for (const wt of WORK_TYPES) {
      if (p.priorities[wt] !== prio) continue;
      const j = GIVERS[wt](w, p);
      if (j) return j;
    }
  }
  return null;
}

/** Candidates sorted by distance from the pawn, skipping known-unreachable cells. */
function nearest<T>(w: World, p: Pawn, items: T[], cellOf: (t: T) => number, adj: boolean, limit = 25): T[] {
  const here = w.cellOf(p);
  return items
    .map((t) => ({ t, c: cellOf(t), d: w.dist(here, cellOf(t)) }))
    .filter((x) => !w.isUnreachable(p.faction, x.c))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .filter((x) => maybeReachable(w, here, x.c, adj))
    .map((x) => x.t);
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
    if (w.reservedByOther('f' + c, p.id)) continue;
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
  w.reserve('f' + best, p.id);
  return { type: 'extinguish', stage: 0, cell: best, progress: 0 };
}

// ---------------------------------------------------------------- doctoring

/** Dress bleeding wounds: colony-mates first, yourself if nobody else needs it. */
function giveDoctor(w: World, p: Pawn): Job | null {
  const patients: Pawn[] = [];
  let self = false;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction !== p.faction || !needsTending(o) || w.reservedByOther('t' + o.id, p.id)) continue;
    if (o.id === p.id) self = true;
    else patients.push(o);
  }
  const best = nearest(w, p, patients, (o) => w.cellOf(o), true, 10)[0] ?? (self ? p : undefined);
  if (!best) return null;
  w.reserve('t' + best.id, p.id);
  return { type: 'tend', stage: 0, patient: best.id, progress: 0 };
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
      if (c === from || w.reservedByOther('c' + c, pawn) || w.map.constructAt[c]) continue;
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

function giveHaul(w: World, p: Pawn): Job | null {
  let hasStockpile = false;
  for (const z of w.zones.values()) if (z.faction === p.faction && z.kind === 'stockpile') hasStockpile = true;
  if (!hasStockpile) return null;
  const cands: Item[] = [];
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    if (!canUseItem(w, p, it) || isStored(w, it)) continue;
    cands.push(it);
  }
  for (const it of nearest(w, p, cands, (i) => w.cellOf(i), false, 12)) {
    const dest = findStorageCell(w, p.faction, it, p.id);
    if (dest < 0) continue;
    w.reserve('e' + it.id, p.id);
    w.reserve('c' + dest, p.id);
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
  const mine: Construct[] = [];
  for (const id of w.kinds.construct) {
    const c = w.get<Construct>(id)!;
    if (c.faction === p.faction) mine.push(c);
  }
  if (mine.length === 0) return null;
  for (const con of nearest(w, p, mine, (c) => w.cellOf(c), true, 40)) {
    const cell = w.cellOf(con);
    if (fullyDelivered(con)) {
      if (w.reservedByOther('e' + con.id, p.id)) continue;
      const plantId = w.map.plantAt[cell];
      if (plantId && BUILDINGS[con.def].blocksMovement) {
        const plant = w.get<Plant>(plantId)!;
        if (PLANTS[plant.def].tree) {
          if (!w.map.desig[cell]) w.setDesig(cell, DESIG.cut, p.faction);
          continue;
        }
      }
      w.reserve('e' + con.id, p.id);
      return { type: 'build', stage: 0, target: con.id };
    }
    if (w.reservedByOther('d' + con.id, p.id)) continue;
    const cost = BUILDINGS[con.def].cost;
    for (const def in cost) {
      const rem = cost[def] - (con.delivered[def] ?? 0);
      if (rem <= 0) continue;
      const it = findMaterial(w, p, def, cell);
      if (!it) continue;
      w.reserve('d' + con.id, p.id);
      w.reserve('e' + it.id, p.id);
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
    if (w.reservedByOther('c' + c, p.id)) continue;
    cells.push(c);
  }
  const best = nearest(w, p, cells, (c) => c, true, 15)[0];
  if (best === undefined) return null;
  w.reserve('c' + best, p.id);
  return { type: 'mine', stage: 0, cell: best, progress: 0 };
}

function giveCut(w: World, p: Pawn): Job | null {
  const m = w.map;
  const plants: Plant[] = [];
  for (const c of w.desigCells) {
    const k = m.desig[c];
    if ((k !== DESIG.cut && k !== DESIG.harvest) || m.desigFaction[c] !== p.faction) continue;
    const plant = m.plantAt[c] ? w.get<Plant>(m.plantAt[c]) : undefined;
    if (!plant || w.reservedByOther('e' + plant.id, p.id)) continue;
    if (k === DESIG.harvest && plant.growth < PLANTS[plant.def].harvestMin) continue;
    plants.push(plant);
  }
  const best = nearest(w, p, plants, (pl) => w.cellOf(pl), true, 15)[0];
  if (!best) return null;
  w.reserve('e' + best.id, p.id);
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
        if (w.reservedByOther('e' + plant.id, p.id)) continue;
        if (plant.def !== z.plant) clear.push(plant);
        else if (plant.growth >= 1 || plant.blighted) harvest.push(plant);
      } else if (!w.reservedByOther('c' + c, p.id) && canSowAt(w, z, c)) {
        sow.push(c);
      }
    }
  }
  const h = nearest(w, p, [...harvest, ...clear], (pl) => w.cellOf(pl), true, 10)[0];
  if (h) {
    w.reserve('e' + h.id, p.id);
    return { type: 'cut', stage: 0, target: h.id, progress: 0, harvest: h.def === w.zoneAt(w.cellOf(h))?.plant };
  }
  const s = nearest(w, p, sow, (c) => c, false, 10)[0];
  if (s !== undefined) {
    w.reserve('c' + s, p.id);
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
    if (b.faction === p.faction && b.bills.length && !w.reservedByOther('e' + b.id, p.id)) benches.push(b);
  }
  for (const bench of nearest(w, p, benches, (b) => w.cellOf(b), true, 10)) {
    for (const bill of bench.bills) {
      const recipe = RECIPES[bill.recipe];
      if (bill.suspended || recipe.workType !== type || !billWanted(w, p.faction, bill.mode, bill.target, recipe)) continue;
      const sources = gatherSources(w, p, recipe, w.cellOf(bench));
      if (!sources) continue;
      w.reserve('e' + bench.id, p.id);
      for (const s of sources) w.reserve('e' + s.item, p.id);
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
