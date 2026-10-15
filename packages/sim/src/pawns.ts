import { BUILDINGS, COMFORT_MAX, COMFORT_MIN, ITEMS } from '@fe/defs';
import { conditionOf, effectsOf, type Effects } from './health';
import { atGoal, findPath, makePathState } from './pathfinding';
import { runJob } from './jobs';
import { findWork } from './work';
import { hostileInReach, isRaider } from './combat';
import { raiderThink } from './raids';
import type { Building, Item, Job, Pawn } from './types';
import { NEIGHBORS8, type World } from './world';

export function tickPawn(w: World, p: Pawn): void {
  if (p.downed) return;
  tickMovement(w, p);
  if (!p.job) {
    think(w, p);
    if (!p.job) return;
  }
  const r = runJob(w, p);
  if (r !== 'continue') endJob(w, p);
}

/** Walk speed multiplier. */
export function pawnSpeed(w: World, p: Pawn): number {
  let s = Math.max(0.15, effectsOf(w, p).move);
  if (p.needs.rest < 0.1) s *= 0.8;
  return s;
}

/** Work speed multiplier. */
export function workSpeed(w: World, p: Pawn): number {
  let s = Math.max(0.1, effectsOf(w, p).work);
  if (p.needs.mood < 0.2) s *= 0.8;
  if (p.needs.rest < 0.1) s *= 0.8;
  return s;
}

function tickMovement(w: World, p: Pawn): void {
  const ps = p.path;
  if (!ps) return;
  const m = w.map;
  while (ps.idx < ps.cells.length && w.tick >= ps.times[ps.idx]) {
    const c = ps.cells[ps.idx];
    if (!w.passable(c, p.faction)) {
      p.path = null;
      w.markDirty(p);
      return;
    }
    p.x = m.cx(c);
    p.y = m.cy(c);
    ps.idx++;
  }
  if (ps.idx >= ps.cells.length) {
    p.path = null;
    w.markDirty(p);
  }
}

export type GoResult = 'arrived' | 'moving' | 'fail';

/** Drive the pawn toward a goal. Call every tick until it returns 'arrived' or 'fail'. */
export function goTo(w: World, p: Pawn, goal: number, adj: boolean): GoResult {
  const here = w.cellOf(p);
  if (atGoal(w, here, goal, adj)) {
    if (p.path) {
      p.path = null;
      w.markDirty(p);
    }
    return 'arrived';
  }
  if (p.path && p.path.goal === goal && p.path.adj === adj) return 'moving';
  if (w.isUnreachable(p.faction, goal)) return 'fail';
  const cells = findPath(w, here, goal, adj, p.faction);
  if (!cells) {
    w.markUnreachable(p.faction, goal);
    return 'fail';
  }
  p.path = makePathState(w, here, cells, goal, adj, pawnSpeed(w, p));
  w.markDirty(p);
  return 'moving';
}

/** Finish the current job, releasing reservations and dropping anything carried. */
export function endJob(w: World, p: Pawn): void {
  const job = p.job;
  w.releaseAll(p.id);
  p.job = null;
  const here = w.cellOf(p);
  if (job?.type === 'bill') {
    for (const g of job.gathered) w.placeItemNear(g.def, g.count, here, g.rot);
  }
  if (p.carrying) {
    w.placeItemNear(p.carrying.def, p.carrying.count, here, p.carrying.rot);
    p.carrying = null;
  }
  p.asleep = false;
  p.path = null;
  w.markDirty(p);
}

function think(w: World, p: Pawn): void {
  if (isRaider(w, p.faction) || p.drafted) {
    p.job = p.drafted ? draftedThink(w, p) : raiderThink(w, p);
    w.markDirty(p);
    return;
  }
  const n = p.needs;
  const e = effectsOf(w, p);
  let job: Job | null = null;
  if (n.food < 0.3 || (e.binge && n.food < 0.95)) job = findFood(w, p);
  // Severe exposure beats everything else: get somewhere survivable first.
  if (!job && exposureSeverity(p) > 0.3 && needsWarmth(w, p, e)) job = warmthJob(w, p, e);
  if (!job && e.bedRest) job = findSleep(w, p, true);
  if (!job && needsWarmth(w, p, e)) job = warmthJob(w, p, e);
  if (!job && (n.rest < 0.2 || (w.isNight() && n.rest < 0.8))) job = findSleep(w, p, false);
  if (!job && !e.noWork) job = findWork(w, p);
  if (!job) job = wanderJob(w, p);
  p.job = job;
  w.markDirty(p);
}

/** Drafted pawns hold position and fire at hostiles in reach. They never start a fight with another player. */
function draftedThink(w: World, p: Pawn): Job {
  const t = hostileInReach(w, p);
  if (t) return { type: 'attack', stage: 0, target: t.id, forced: false, chase: false, next: 0, until: 0 };
  return { type: 'hold', stage: 0, until: 0 };
}

/** Draft or undraft a pawn, dropping whatever it was doing. */
export function setDrafted(w: World, p: Pawn, on: boolean): void {
  if (p.downed || p.drafted === on) return;
  endJob(w, p);
  p.drafted = on;
  w.markDirty(p);
}

export function exposureSeverity(p: Pawn): number {
  return Math.max(conditionOf(p, 'hypothermia')?.severity ?? 0, conditionOf(p, 'heatstroke')?.severity ?? 0);
}

/** Cold or hot enough here that the pawn should go somewhere better. */
export function needsWarmth(w: World, p: Pawn, e: Effects): boolean {
  const hypo = conditionOf(p, 'hypothermia')?.severity ?? 0;
  const heat = conditionOf(p, 'heatstroke')?.severity ?? 0;
  if (hypo < 0.12 && heat < 0.12) return false;
  const t = w.tempAt(w.cellOf(p));
  return t < COMFORT_MIN + e.coldShift + 2 || t > COMFORT_MAX + e.heatShift - 2;
}

/** Walk to the nearest comfortable spot: a warm room, or near a radiant relic. */
export function warmthJob(w: World, p: Pawn, e: Effects): Job | null {
  const here = w.cellOf(p);
  const lo = COMFORT_MIN + e.coldShift + 4;
  const hi = COMFORT_MAX + e.heatShift - 4;
  let best = -1;
  let bestD = Infinity;
  const consider = (c: number) => {
    const d = w.dist(here, c);
    if (d < bestD && d < 60 && w.passable(c, p.faction) && !w.isUnreachable(p.faction, c)) {
      const t = w.tempAt(c);
      if (t >= lo && t <= hi) {
        best = c;
        bestD = d;
      }
    }
  };
  for (const room of w.rooms.values()) {
    // Sample a few cells per room rather than all of them.
    const step = Math.max(1, Math.floor(room.cells.length / 6));
    for (let k = 0; k < room.cells.length; k += step) consider(room.cells[k]);
  }
  for (const r of w.radiant.keys()) {
    const x = w.map.cx(r);
    const y = w.map.cy(r);
    for (const [dx, dy] of NEIGHBORS8) if (w.map.inBounds(x + dx * 2, y + dy * 2)) consider(w.map.idx(x + dx * 2, y + dy * 2));
  }
  if (best < 0) return null;
  return { type: 'warm', stage: 0, dest: best, until: 0 };
}

/** True when this pawn may take this item: not reserved, not rotten, not in someone else's stockpile. */
export function canUseItem(w: World, p: Pawn, it: Item): boolean {
  if (it.rot >= 1) return false;
  if (w.reservedByOther('e' + it.id, p.id)) return false;
  const z = w.zoneAt(w.cellOf(it));
  if (z && z.kind === 'stockpile' && z.faction !== p.faction) return false;
  return true;
}

function findFood(w: World, p: Pawn): Job | null {
  const here = w.cellOf(p);
  let best: Item | null = null;
  let bestScore = Infinity;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const def = ITEMS[it.def];
    if (!def.nutrition || !canUseItem(w, p, it)) continue;
    const c = w.cellOf(it);
    if (w.isUnreachable(p.faction, c)) continue;
    const score = w.dist(here, c) - (def.category === 'meal' ? 25 : 0) + it.rot * 20;
    if (score < bestScore) {
      bestScore = score;
      best = it;
    }
  }
  if (!best) return null;
  const def = ITEMS[best.def];
  const count = def.category === 'meal' ? 1 : Math.min(best.count, Math.ceil((1 - p.needs.food) / def.nutrition!));
  w.reserve('e' + best.id, p.id);
  return { type: 'eat', stage: 0, item: best.id, count, progress: 0 };
}

function findSleep(w: World, p: Pawn, rest: boolean): Job | null {
  let bed = p.bed ? w.get<Building>(p.bed) : undefined;
  if (!bed || bed.owner !== p.id) {
    bed = undefined;
    p.bed = 0;
    const here = w.cellOf(p);
    let bestD = Infinity;
    for (const id of w.kinds.building) {
      const b = w.get<Building>(id)!;
      if (b.faction !== p.faction || !BUILDINGS[b.def].bed || b.owner) continue;
      const d = w.dist(here, w.cellOf(b));
      if (d < bestD && !w.isUnreachable(p.faction, w.cellOf(b))) {
        bestD = d;
        bed = b;
      }
    }
    if (bed) {
      bed.owner = p.id;
      p.bed = bed.id;
      w.markDirty(bed);
    }
  }
  let cell = bed ? w.cellOf(bed) : w.cellOf(p);
  if (!bed) {
    // No bed: at least lie down somewhere with a bearable temperature.
    const e = effectsOf(w, p);
    const t = w.tempAt(cell);
    if (t < COMFORT_MIN + e.coldShift || t > COMFORT_MAX + e.heatShift) {
      const spot = warmthJob(w, p, e);
      if (spot && spot.type === 'warm') cell = spot.dest;
    }
  }
  return { type: 'sleep', stage: 0, bed: bed ? bed.id : 0, cell, rest };
}

function wanderJob(w: World, p: Pawn): Job {
  const m = w.map;
  const here = w.cellOf(p);
  const home = w.factions.get(p.faction)?.home;
  let cx = p.x;
  let cy = p.y;
  let radius = 6;
  if (home && Math.max(Math.abs(home.x - p.x), Math.abs(home.y - p.y)) > 20) {
    // Drift back toward home in long hops.
    const dx = home.x - p.x;
    const dy = home.y - p.y;
    const len = Math.hypot(dx, dy);
    cx = Math.round(p.x + (dx / len) * 15);
    cy = Math.round(p.y + (dy / len) * 15);
    radius = 3;
  }
  const comp = m.component(here);
  for (let tries = 0; tries < 12; tries++) {
    const x = cx + w.rng.int(radius * 2 + 1) - radius;
    const y = cy + w.rng.int(radius * 2 + 1) - radius;
    if (!m.inBounds(x, y)) continue;
    const c = m.idx(x, y);
    if (!w.passable(c, p.faction) || m.comp[c] !== comp) continue;
    return { type: 'wander', stage: 0, dest: c, until: 0 };
  }
  return { type: 'wander', stage: 0, dest: here, until: 0 };
}

/** Move a pawn standing in a now-solid cell to the nearest open neighbour. */
export function pushOut(w: World, p: Pawn): void {
  const m = w.map;
  for (const [dx, dy] of NEIGHBORS8) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (m.inBounds(x, y) && w.passable(m.idx(x, y), p.faction)) {
      p.x = x;
      p.y = y;
      p.path = null;
      w.markDirty(p);
      return;
    }
  }
}
