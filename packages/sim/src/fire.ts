import { BUILDINGS, PLANTS, TERRAINS, WEATHER } from '@fe/defs';
import { RARE_TICK, TICKS_PER_HOUR } from './constants';
import { addCondition } from './health';
import type { Building, Item, Pawn, Plant } from './types';
import { NEIGHBORS8, type World } from './world';

/** Fire updates this often, in ticks. */
export const FIRE_TICK = 60;

const FLAMMABLE_ITEMS = new Set(['wood', 'cloth', 'berries', 'rice', 'corn', 'potato', 'simple_meal']);

/** What would burn in this cell, or null. */
export function fuelAt(w: World, cell: number): 'plant' | 'building' | 'item' | null {
  const m = w.map;
  if (m.plantAt[cell]) return 'plant';
  const b = m.buildingAt[cell] ? w.get<Building>(m.buildingAt[cell]) : undefined;
  if (b && isFlammableBuilding(b.def)) return 'building';
  const it = m.itemAt[cell] ? w.get<Item>(m.itemAt[cell]) : undefined;
  if (it && FLAMMABLE_ITEMS.has(it.def)) return 'item';
  return null;
}

function isFlammableBuilding(def: string): boolean {
  const d = BUILDINGS[def];
  if (!d || d.special) return false;
  return (d.cost.wood ?? 0) > 0 && !d.cost.stone && !(d.cost.steel && d.cost.steel > (d.cost.wood ?? 0));
}

export function startFire(w: World, cell: number): boolean {
  const m = w.map;
  if (m.fire[cell] || !TERRAINS[m.terrain[cell]].passable || m.rock[cell] || !fuelAt(w, cell)) return false;
  w.setFire(cell, 1);
  return true;
}

function weather(w: World) {
  let rain = false;
  let dry = false;
  for (const c of w.conditions) {
    const d = WEATHER[c.key];
    if (d?.rain) rain = true;
    if (d?.dry) dry = true;
  }
  return { rain, dry };
}

/** Burn, grow and spread fires. Also rolls lightning strikes during storms. */
export function fireTick(w: World): void {
  if (w.tick % RARE_TICK === 0) lightning(w);
  if (w.tick % FIRE_TICK !== 0 || w.fireCells.size === 0) return;
  const m = w.map;
  const { rain, dry } = weather(w);
  const spreadChance = 0.05 * (dry ? 1.8 : 1) * (rain ? 0.25 : 1);
  const ignite: number[] = [];
  const burntFactions = new Set<number>();
  // In cell order: a loaded save rebuilds the set in cell order, and the dice must fall the same way.
  for (const cell of [...w.fireCells].sort((a, b) => a - b)) {
    let level = m.fire[cell];
    const fuel = fuelAt(w, cell);
    if (!fuel) {
      w.setFire(cell, level - 1);
      continue;
    }
    if (rain && w.rng.chance(0.35)) level--;
    else if (level < 3 && w.rng.chance(0.3)) level++;
    // Consume the fuel; trees take longer.
    const tree = fuel === 'plant' && PLANTS[w.get<Plant>(m.plantAt[cell])!.def].tree;
    if (w.rng.chance(0.07 * level * (tree ? 0.5 : 1))) {
      if (fuel === 'plant') w.despawn(m.plantAt[cell]);
      else if (fuel === 'building') {
        const b = w.get<Building>(m.buildingAt[cell])!;
        if (b.faction) burntFactions.add(b.faction);
        w.despawn(b.id);
      } else w.despawn(m.itemAt[cell]);
    }
    w.setFire(cell, level);
    if (level <= 0) continue;
    const x = m.cx(cell);
    const y = m.cy(cell);
    for (const [dx, dy] of NEIGHBORS8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!m.inBounds(nx, ny)) continue;
      const n = m.idx(nx, ny);
      if (!m.fire[n] && w.rng.chance(spreadChance * level) && fuelAt(w, n)) ignite.push(n);
    }
  }
  for (const c of ignite) startFire(w, c);
  for (const f of burntFactions) w.message(f, 'Fire is destroying your buildings! Set colonists to firefight.', 'bad');
  // Anyone standing in flames gets burned.
  if (w.fireCells.size) {
    for (const id of w.kinds.pawn) {
      const p = w.get<Pawn>(id)!;
      if (m.fire[w.cellOf(p)] && w.rng.chance(0.4)) addCondition(w, p, 'burns');
    }
  }
}

function lightning(w: World): void {
  let hours = Infinity;
  for (const c of w.conditions) {
    const d = WEATHER[c.key];
    if (d?.lightningHours) hours = Math.min(hours, d.lightningHours);
  }
  if (hours === Infinity || !w.rng.chance(RARE_TICK / (hours * TICKS_PER_HOUR))) return;
  strike(w, w.rng.int(w.map.n));
}

/** A lightning bolt. Starts a fire if something can burn, unless the rain douses it. */
export function strike(w: World, cell: number): void {
  const { rain } = weather(w);
  const lit = (!rain || w.rng.chance(0.4)) && startFire(w, cell);
  // Tell anyone with a home nearby.
  for (const f of w.factions.values()) {
    if (!f.isPlayer) continue;
    const d = Math.max(Math.abs(f.home.x - w.map.cx(cell)), Math.abs(f.home.y - w.map.cy(cell)));
    if (d <= 25) w.message(f.id, lit ? 'Lightning struck nearby and started a fire!' : 'Lightning struck nearby.', lit ? 'bad' : 'neutral', cell);
  }
}
