import { BUILDINGS, ITEMS, PLANTS, RECIPES, ROCKS, T } from '@fe/defs';
import { goTo, needsWarmth, pushOut, workSpeed } from './pawns';
import { addCondition, effectsOf } from './health';
import type { Building, Construct, Item, Job, Pawn, Plant } from './types';
import { DESIG } from './types';
import type { World } from './world';

export type JobResult = 'continue' | 'done' | 'fail';

/** Ticks to sow one crop cell. */
export const SOW_WORK = 170;
/** Ticks spent eating. */
export const EAT_TICKS = 150;

export function runJob(w: World, p: Pawn): JobResult {
  const j = p.job!;
  switch (j.type) {
    case 'wander':
      return wander(w, p, j);
    case 'haul':
      return haul(w, p, j);
    case 'deliver':
      return deliver(w, p, j);
    case 'build':
      return build(w, p, j);
    case 'mine':
      return mine(w, p, j);
    case 'cut':
      return cut(w, p, j);
    case 'sow':
      return sow(w, p, j);
    case 'eat':
      return eat(w, p, j);
    case 'sleep':
      return sleep(w, p, j);
    case 'bill':
      return bill(w, p, j);
    case 'extinguish':
      return extinguish(w, p, j);
    case 'warm':
      return warm(w, p, j);
  }
}

/** Ticks of beating at a fire to knock it down one level. */
export const EXTINGUISH_WORK = 45;

function extinguish(w: World, p: Pawn, j: J<'extinguish'>): JobResult {
  if (!w.map.fire[j.cell]) return 'done';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  j.progress += workSpeed(w, p);
  if (j.progress < EXTINGUISH_WORK) return 'continue';
  j.progress = 0;
  w.setFire(j.cell, w.map.fire[j.cell] - 1);
  if (w.rng.chance(0.04)) addCondition(w, p, 'burns');
  return w.map.fire[j.cell] ? 'continue' : 'done';
}

function warm(w: World, p: Pawn, j: J<'warm'>): JobResult {
  if (j.stage === 0) {
    const r = goTo(w, p, j.dest, false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
    j.until = w.tick + 600;
  }
  if (w.tick >= j.until || !needsWarmth(w, p, effectsOf(w, p))) return 'done';
  return 'continue';
}

type J<K extends Job['type']> = Extract<Job, { type: K }>;

/** Mark dirty only when progress crosses a tenth, to keep deltas small. */
function bumpProgress(w: World, owner: Parameters<World['markDirty']>[0], before: number, after: number, total: number) {
  if (Math.floor((before / total) * 10) !== Math.floor((after / total) * 10)) w.markDirty(owner);
}

function pickUp(w: World, p: Pawn, it: Item, n: number): void {
  const rot = it.rot;
  const def = it.def;
  const got = w.takeFromItem(it, n);
  p.carrying = { def, count: got, rot };
  w.markDirty(p);
}

function wander(w: World, p: Pawn, j: J<'wander'>): JobResult {
  if (j.stage === 0) {
    const r = goTo(w, p, j.dest, false);
    if (r === 'fail') return 'done';
    if (r === 'arrived') {
      j.stage = 1;
      j.until = w.tick + 120 + w.rng.int(240);
    }
    return 'continue';
  }
  return w.tick >= j.until ? 'done' : 'continue';
}

function haul(w: World, p: Pawn, j: J<'haul'>): JobResult {
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, Math.min(it.count, w.roomFor(j.dest, it.def) || ITEMS[it.def].stackLimit));
    j.stage = 1;
    return 'continue';
  }
  const r = goTo(w, p, j.dest, false);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  const c = p.carrying!;
  const placed = w.dropInto(j.dest, c.def, c.count, c.rot);
  if (placed < c.count) w.placeItemNear(c.def, c.count - placed, j.dest, c.rot);
  p.carrying = null;
  w.markDirty(p);
  return 'done';
}

function deliver(w: World, p: Pawn, j: J<'deliver'>): JobResult {
  const con = w.get<Construct>(j.target);
  if (!con || con.kind !== 'construct') return 'fail';
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, j.count);
    j.stage = 1;
    return 'continue';
  }
  const r = goTo(w, p, w.cellOf(con), true);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  const c = p.carrying!;
  const need = (BUILDINGS[con.def].cost[c.def] ?? 0) - (con.delivered[c.def] ?? 0);
  const put = Math.max(0, Math.min(need, c.count));
  con.delivered[c.def] = (con.delivered[c.def] ?? 0) + put;
  c.count -= put;
  if (c.count > 0) w.placeItemNear(c.def, c.count, w.cellOf(p), c.rot);
  p.carrying = null;
  w.markDirty(p);
  w.markDirty(con);
  return 'done';
}

export function fullyDelivered(con: Construct): boolean {
  const cost = BUILDINGS[con.def].cost;
  for (const k in cost) if ((con.delivered[k] ?? 0) < cost[k]) return false;
  return true;
}

function build(w: World, p: Pawn, j: J<'build'>): JobResult {
  const con = w.get<Construct>(j.target);
  if (!con || con.kind !== 'construct' || !fullyDelivered(con)) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, w.cellOf(con), true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const total = BUILDINGS[con.def].work;
  const before = con.progress;
  con.progress += workSpeed(w, p);
  bumpProgress(w, con, before, con.progress, total);
  if (con.progress < total) return 'continue';
  completeConstruct(w, con);
  return 'done';
}

export function completeConstruct(w: World, con: Construct): Building | null {
  const d = BUILDINGS[con.def];
  const m = w.map;
  const cell = w.cellOf(con);
  w.despawn(con.id);
  if (d.floorTerrain) {
    w.setTerrain(cell, T[d.floorTerrain]);
    return null;
  }
  if (m.plantAt[cell]) w.despawn(m.plantAt[cell]);
  const b = w.spawnBuilding(con.def, cell, con.faction);
  if (d.blocksMovement) {
    const itemId = m.itemAt[cell];
    if (itemId) {
      const it = w.get<Item>(itemId)!;
      w.despawn(itemId);
      w.placeItemNear(it.def, it.count, cell, it.rot);
    }
    for (const id of w.kinds.pawn) {
      const p = w.get<Pawn>(id)!;
      if (p.x === con.x && p.y === con.y) pushOut(w, p);
    }
  }
  return b;
}

function mine(w: World, p: Pawn, j: J<'mine'>): JobResult {
  const m = w.map;
  const rock = m.rock[j.cell];
  if (!rock || m.desig[j.cell] !== DESIG.mine) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const rd = ROCKS[rock];
  j.progress += workSpeed(w, p);
  if (j.progress < rd.mineWork) return 'continue';
  w.setRock(j.cell, 0);
  w.setDesig(j.cell, 0, 0);
  if (rd.yieldItem && w.rng.chance(0.85)) w.placeItemNear(rd.yieldItem, rd.yieldCount, j.cell);
  return 'done';
}

function cut(w: World, p: Pawn, j: J<'cut'>): JobResult {
  const plant = w.get<Plant>(j.target);
  if (!plant || plant.kind !== 'plant') return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, w.cellOf(plant), true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const def = PLANTS[plant.def];
  j.progress += workSpeed(w, p);
  if (j.progress < def.work) return 'continue';
  harvestPlant(w, plant, j.harvest);
  return 'done';
}

export function harvestPlant(w: World, plant: Plant, harvest: boolean): void {
  const def = PLANTS[plant.def];
  const cell = w.cellOf(plant);
  const gives = def.yieldItem && plant.growth >= def.harvestMin && !plant.blighted && (def.tree || def.sowable || harvest);
  if (gives) {
    const count = Math.max(1, Math.round(def.yieldCount! * (def.tree ? plant.growth : 1)));
    w.placeItemNear(def.yieldItem!, count, cell);
  }
  if (harvest && def.regrows) {
    plant.growth = 0.2;
    w.markDirty(plant);
    w.setDesig(cell, 0, 0);
  } else {
    w.despawn(plant.id);
  }
}

function sow(w: World, p: Pawn, j: J<'sow'>): JobResult {
  const z = w.zoneAt(j.cell);
  if (!z || z.kind !== 'grow' || z.faction !== p.faction || w.map.plantAt[j.cell]) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  j.progress += workSpeed(w, p);
  if (j.progress < SOW_WORK) return 'continue';
  w.spawnPlant(j.plant, j.cell, 0.05);
  return 'done';
}

function eat(w: World, p: Pawn, j: J<'eat'>): JobResult {
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, j.count);
    j.stage = 1;
    return 'continue';
  }
  j.progress++;
  if (j.progress < EAT_TICKS) return 'continue';
  const c = p.carrying;
  if (c) {
    const def = ITEMS[c.def];
    p.needs.food = Math.min(1, p.needs.food + (def.nutrition ?? 0) * c.count);
    p.carrying = null;
    // Rotten food (and, rarely, raw food) can make people sick.
    const risk = c.rot > 0.5 ? 0.35 : def.category === 'raw_food' ? 0.02 : 0;
    if (risk && w.rng.chance(risk) && addCondition(w, p, 'food_poisoning')) {
      w.message(p.faction, `${p.name} got food poisoning from ${c.rot > 0.5 ? 'rotting' : 'raw'} ${def.label.toLowerCase()}.`, 'bad', w.cellOf(p));
    }
  }
  w.markDirty(p);
  return 'done';
}

function sleep(w: World, p: Pawn, j: J<'sleep'>): JobResult {
  if (j.stage === 0) {
    if (j.bed && !w.get(j.bed)) return 'fail';
    const r = goTo(w, p, j.cell, false);
    if (r === 'fail') {
      // Can't reach the bed; sleep where we stand.
      j.bed = 0;
      j.cell = w.cellOf(p);
      return 'continue';
    }
    if (r !== 'arrived') return 'continue';
    j.stage = 1;
    p.asleep = true;
    w.markDirty(p);
    return 'continue';
  }
  if (p.needs.food < 0.08) return 'done';
  if (j.rest) {
    // Bed rest lasts while a condition calls for it. Check now and then, not every tick.
    if (w.tick % 60 === p.id % 60 && !effectsOf(w, p).bedRest) return 'done';
    return 'continue';
  }
  if (p.needs.rest >= 1) return 'done';
  if (!w.isNight() && p.needs.rest > 0.95) return 'done';
  return 'continue';
}

function bill(w: World, p: Pawn, j: J<'bill'>): JobResult {
  const bench = w.get<Building>(j.bench);
  if (!bench || bench.kind !== 'building' || bench.faction !== p.faction) return 'fail';
  const b = bench.bills.find((x) => x.id === j.bill);
  if (!b) return 'fail';
  const recipe = RECIPES[b.recipe];
  const benchCell = w.cellOf(bench);
  if (j.stage === 0) {
    // Fetch the next ingredient.
    if (j.sources.length === 0) {
      j.stage = 2;
      return 'continue';
    }
    const src = j.sources[0];
    const it = w.get<Item>(src.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, src.count);
    j.stage = 1;
    return 'continue';
  }
  if (j.stage === 1 || j.stage === 2) {
    const r = goTo(w, p, benchCell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    if (j.stage === 1) {
      if (p.carrying) j.gathered.push(p.carrying);
      p.carrying = null;
      j.sources.shift();
      j.stage = 0;
      w.markDirty(p);
      return 'continue';
    }
    j.stage = 3;
  }
  j.progress += workSpeed(w, p);
  if (j.progress < recipe.work) return 'continue';
  j.gathered = [];
  w.placeItemNear(recipe.product.item, recipe.product.count, benchCell);
  if (b.mode === 'count') {
    b.target--;
    if (b.target <= 0) bench.bills = bench.bills.filter((x) => x.id !== b.id);
  }
  w.markDirty(bench);
  return 'done';
}
