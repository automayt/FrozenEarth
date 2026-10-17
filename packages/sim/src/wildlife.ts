import { ANIMALS, PREY, WEAPONS, type AnimalDef } from '@fe/defs';
import { RARE_TICK, START_TICK, TICKS_PER_DAY } from './constants';
import { cellDistance } from './combat';
import { maybeReachable } from './pathfinding';
import { dangerZones } from './settlements';
import type { Faction, Job, Pawn } from './types';
import { rk, type World } from './world';

/** Prey on the map per this many cells of area. */
const CELLS_PER_PREY = 1100;
/** Wolf packs per this many cells of area (doubled in winter). */
const CELLS_PER_PACK = 40_000;
/** No wolves until this many days in. */
const WOLVES_FROM_DAY = 6;
/** How far a hunting wolf looks for something to kill. */
const HUNT_RANGE = 30;

export function speciesOf(p: Pawn): AnimalDef | undefined {
  return p.species ? ANIMALS[p.species] : undefined;
}

/** The faction that owns all prey, or all predators; made on first use. */
export function wildFaction(w: World, predator: boolean): Faction {
  const kind = predator ? 'predator' : 'prey';
  let f = [...w.factions.values()].find((x) => x.wild === kind);
  if (!f) {
    const id = Math.max(0, ...w.factions.keys()) + 1;
    f = { id, name: predator ? 'Wolves' : 'Wildlife', color: predator ? 0x7a7a80 : 0x9a8a6a, home: { x: w.map.w >> 1, y: w.map.h >> 1 }, isPlayer: false, wild: kind };
    w.factions.set(id, f);
    w.dirty.factions.add(id);
  }
  return f;
}

export function spawnAnimal(w: World, species: string, cell: number): Pawn {
  const def = ANIMALS[species];
  const p = w.spawnPawn(wildFaction(w, def.predator).id, cell, def.label, [], '');
  p.species = species;
  p.apparel = [];
  for (const k of Object.keys(p.priorities) as (keyof Pawn['priorities'])[]) p.priorities[k] = 0;
  p.needs = { food: 1, rest: 1, mood: 0.6 };
  w.markDirty(p);
  return p;
}

function isPerson(w: World, p: Pawn): boolean {
  return !p.species && !p.downed && !p.prisoner;
}

/** An open cell near (x, y) this pawn can walk to, or -1. */
function openNear(w: World, p: Pawn, x: number, y: number, spread: number): number {
  const m = w.map;
  const comp = m.component(w.cellOf(p));
  for (let tries = 0; tries < 10; tries++) {
    const cx = Math.max(1, Math.min(m.w - 2, Math.round(x) + w.rng.int(spread * 2 + 1) - spread));
    const cy = Math.max(1, Math.min(m.h - 2, Math.round(y) + w.rng.int(spread * 2 + 1) - spread));
    const c = m.idx(cx, cy);
    if (w.passable(c, p.faction) && m.component(c) === comp) return c;
  }
  return -1;
}

function fleeFrom(w: World, p: Pawn, from: number, dist: number): Job | null {
  const m = w.map;
  let dx = p.x - m.cx(from);
  let dy = p.y - m.cy(from);
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const c = openNear(w, p, p.x + dx * dist, p.y + dy * dist, 3);
  return c >= 0 ? { type: 'goto', stage: 0, dest: c } : null;
}

/** Somewhere to amble to: near the rest of the group, drifting inward ahead of the frost. */
function grazeJob(w: World, p: Pawn, def: AnimalDef): Job {
  const m = w.map;
  const here = w.cellOf(p);
  let cx = p.x;
  let cy = p.y;
  // The cold drives them toward the warm middle.
  if (w.frostAt(here) > 0.05) {
    const dx = m.w / 2 - p.x;
    const dy = m.h / 2 - p.y;
    const len = Math.hypot(dx, dy) || 1;
    cx += (dx / len) * 14;
    cy += (dy / len) * 14;
  } else {
    // Keep together: head for the middle of the group.
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const id of w.kinds.pawn) {
      const o = w.get<Pawn>(id)!;
      if (o.species !== p.species || Math.abs(o.x - p.x) > 14 || Math.abs(o.y - p.y) > 14) continue;
      sx += o.x;
      sy += o.y;
      n++;
    }
    cx = sx / n;
    cy = sy / n;
  }
  if (w.isNight() && w.rng.chance(0.6)) return { type: 'hold', stage: 0, until: w.tick + 900 };
  const c = openNear(w, p, cx, cy, def.predator ? 7 : 5);
  if (c < 0) return { type: 'hold', stage: 0, until: w.tick + 300 };
  return { type: 'wander', stage: 0, dest: c, until: w.tick + 200 + w.rng.int(600) };
}

/** Prey bolt from people who come close; the defending kind turn on whoever hurt them. */
export function animalThink(w: World, p: Pawn): Job {
  const def = speciesOf(p)!;
  const here = w.cellOf(p);
  if (p.aggro) {
    const a = w.get<Pawn>(p.aggro);
    if (!a || a.kind !== 'pawn' || a.downed || cellDistance(w, here, w.cellOf(a)) > 25) p.aggro = 0;
  }
  if (def.predator) return predatorThink(w, p, def);
  const attacker = p.aggro ? w.get<Pawn>(p.aggro) : undefined;
  if (attacker && def.defends && def.bite > 0) return { type: 'attack', stage: 0, target: attacker.id, forced: true, chase: true, next: 0, until: w.tick + 500 };
  let threat = attacker ? w.cellOf(attacker) : -1;
  if (threat < 0) {
    let bestD = def.shy;
    for (const id of w.kinds.pawn) {
      const o = w.get<Pawn>(id)!;
      if (!(isPerson(w, o) || speciesOf(o)?.predator)) continue;
      const d = cellDistance(w, here, w.cellOf(o));
      if (d < bestD) {
        bestD = d;
        threat = w.cellOf(o);
      }
    }
  }
  if (threat >= 0) {
    const flee = fleeFrom(w, p, threat, 12);
    if (flee) return flee;
  }
  return grazeJob(w, p, def);
}

/** Wolves: roam as a pack, and hunt when hungry or once winter bites. People are fair game then too. */
function predatorThink(w: World, p: Pawn, def: AnimalDef): Job {
  const here = w.cellOf(p);
  const attacker = p.aggro ? w.get<Pawn>(p.aggro) : undefined;
  if (attacker) return { type: 'attack', stage: 0, target: attacker.id, forced: true, chase: true, next: 0, until: w.tick + 500 };
  const winter = w.seasonIndex() === 3 || w.frostAt(here) > 0.3;
  if (winter || p.needs.food < 0.5) {
    let best: Pawn | null = null;
    let bestScore = HUNT_RANGE;
    for (const id of w.kinds.pawn) {
      const o = w.get<Pawn>(id)!;
      const sp = speciesOf(o);
      if (o.downed || o.prisoner || sp?.predator) continue;
      // People only in winter, and they look further away than they are.
      if (!sp && !winter) continue;
      const c = w.cellOf(o);
      const score = cellDistance(w, here, c) * (sp ? 1 : 1.5);
      if (score < bestScore && maybeReachable(w, here, c, true)) {
        best = o;
        bestScore = score;
      }
    }
    if (best) return { type: 'attack', stage: 0, target: best.id, forced: true, chase: true, next: 0, until: w.tick + 900 };
  }
  return grazeJob(w, p, def);
}

/** A wolf (or a pack) made a kill: they've eaten. */
export function predatorFed(w: World, wolf: Pawn): void {
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction === wolf.faction && Math.abs(o.x - wolf.x) < 12 && Math.abs(o.y - wolf.y) < 12) o.needs.food = 1;
  }
}

/** Wolves get hungry over a couple of days. */
export function animalNeeds(w: World, p: Pawn): void {
  if (speciesOf(p)?.predator) p.needs.food = Math.max(0, p.needs.food - RARE_TICK / (TICKS_PER_DAY * 2));
}

// ---------------------------------------------------------------- population

/** A random open spot just inside the frost line (or anywhere fair, before it moves), away from people. */
function arrivalSpot(w: World): number {
  const m = w.map;
  const half = Math.min(m.w, m.h) / 2;
  const r = Math.min(0.95, w.frostRadius());
  for (let tries = 0; tries < 60; tries++) {
    const a = w.rng.next() * Math.PI * 2;
    const d = Math.max(0.15, r - 0.05 - w.rng.next() * 0.35) * half;
    const x = Math.round(m.w / 2 + Math.cos(a) * d);
    const y = Math.round(m.h / 2 + Math.sin(a) * d);
    if (x < 2 || y < 2 || x >= m.w - 2 || y >= m.h - 2) continue;
    const c = m.idx(x, y);
    if (m.solid[c] || w.frostAt(c) > 0) continue;
    let near = false;
    for (const f of w.factions.values()) {
      if ((f.isPlayer || f.settlement) && Math.hypot(f.home.x - x, f.home.y - y) < 25) near = true;
    }
    if (!near) return c;
  }
  return -1;
}

function spawnGroup(w: World, def: AnimalDef): number {
  const at = arrivalSpot(w);
  if (at < 0) return 0;
  const m = w.map;
  const n = def.group[0] + w.rng.int(def.group[1] - def.group[0] + 1);
  let made = 0;
  for (let k = 0; k < n; k++) {
    const c = m.idx(Math.max(0, Math.min(m.w - 1, m.cx(at) + w.rng.int(5) - 2)), Math.max(0, Math.min(m.h - 1, m.cy(at) + w.rng.int(5) - 2)));
    if (m.solid[c]) continue;
    spawnAnimal(w, def.key, c);
    made++;
  }
  return made;
}

function pickPrey(w: World): AnimalDef {
  const total = PREY.reduce((a, d) => a + d.weight, 0);
  let r = w.rng.next() * total;
  for (const d of PREY) {
    r -= d.weight;
    if (r <= 0) return d;
  }
  return PREY[0];
}

/** Stock a new world with a scattering of prey. */
export function populateWildlife(w: World): void {
  wildFaction(w, false);
  const target = Math.round((w.map.w * w.map.h) / CELLS_PER_PREY);
  let n = 0;
  for (let tries = 0; tries < 40 && n < target * 0.6; tries++) n += spawnGroup(w, pickPrey(w));
}

/** Now and then: new herds wander in to replace what's been hunted, and in time, wolves. */
export function wildlifeTick(w: World): void {
  if (w.tick % (RARE_TICK * 8) !== 0) return;
  // Only worlds made with wildlife (or given it on load) keep it topped up.
  if (![...w.factions.values()].some((f) => f.wild)) return;
  let prey = 0;
  let wolves = 0;
  for (const id of w.kinds.pawn) {
    const sp = speciesOf(w.get<Pawn>(id)!);
    if (sp?.predator) wolves++;
    else if (sp) prey++;
  }
  const area = w.map.w * w.map.h;
  if (prey < area / CELLS_PER_PREY && w.rng.chance(0.4)) spawnGroup(w, pickPrey(w));
  const day = (w.tick - START_TICK) / TICKS_PER_DAY;
  const packs = Math.max(1, Math.round(area / CELLS_PER_PACK)) * (w.seasonIndex() === 3 ? 2 : 1);
  if (day >= WOLVES_FROM_DAY && wolves < packs * 3 && w.rng.chance(0.15)) {
    if (spawnGroup(w, ANIMALS.wolf)) {
      const pack = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.species === 'wolf');
      const at = pack[pack.length - 1];
      for (const f of w.factions.values()) {
        if (f.isPlayer && Math.hypot(f.home.x - at.x, f.home.y - at.y) < 60) w.message(f.id, 'A wolf pack has come into the area. They hunt when they are hungry, and in winter they will hunt people.', 'bad', w.cellOf(at));
      }
    }
  }
}

// ---------------------------------------------------------------- hunting

/** Mark animals for a colony's hunters, or clear the mark. */
export function markHunt(w: World, faction: number, ids: unknown, on: boolean): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids.slice(0, 100)) {
    const p = w.get<Pawn>(Number(id));
    if (!p || p.kind !== 'pawn' || !p.species) continue;
    if (on) p.hunted = faction;
    else if (p.hunted === faction) p.hunted = 0;
    w.markDirty(p);
  }
}

/** Hunters with a bow or rifle go after marked animals. */
export function giveHunt(w: World, p: Pawn): Job | null {
  const wd = WEAPONS[p.weapon];
  if (!wd || wd.melee) return null;
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestD = Infinity;
  const danger = dangerZones(w, p.faction);
  for (const id of w.kinds.pawn) {
    const a = w.get<Pawn>(id)!;
    if (a.hunted !== p.faction || !a.species || w.reservedByOther(rk.e(a.id), p.id)) continue;
    if (danger.some((z) => Math.hypot(a.x - z.x, a.y - z.y) <= z.r)) continue;
    const c = w.cellOf(a);
    const d = w.dist(here, c);
    if (d < bestD && !w.isUnreachable(p.faction, c) && maybeReachable(w, here, c, true)) {
      best = a;
      bestD = d;
    }
  }
  if (!best) return null;
  w.reserve(rk.e(best.id), p.id);
  return { type: 'attack', stage: 0, target: best.id, forced: true, chase: true, next: 0, until: w.tick + 3000 };
}
