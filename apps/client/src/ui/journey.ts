import { BUILDINGS, ITEMS, TERRAINS } from '@fe/defs';
import {
  bulkOf,
  carryCapacity,
  chooseLoad,
  dispositionOf,
  GUARD_REACH,
  LOAD_RADIUS,
  MIN_COLONY_GAP,
  SETTLEMENT_GAP,
  frostLevel,
  frostRadius,
  type Building,
  PAWN_TICKS_PER_CELL,
  pactOf,
  TICKS_PER_HOUR,
  tollFor,
  type Faction,
  type Item,
  type Pawn,
} from '@fe/sim';
import type { Mirror } from '@fe/protocol';

/** Rough walking ticks per cell on the road (terrain and regrouping included). */
const ROAD_TICKS_PER_CELL = PAWN_TICKS_PER_CELL * 1.8;
/** Rock cells within 4 of a road cell (of 81) that make it a pass, as in the sim. */
const PASS_ROCK = 25;

export interface Point {
  x: number;
  y: number;
}

/** Goods a caravan from here could load: stockpiles near home, and kits and sledges lying about there. Same rule as the sim. */
export function loadable(m: Mirror, faction: number, home: Point): { def: string; count: number }[] {
  const byDef = new Map<string, number>();
  for (const e of m.entities.values()) {
    if (e.kind !== 'item') continue;
    const it = e as Item;
    if (Math.abs(it.x - home.x) > LOAD_RADIUS || Math.abs(it.y - home.y) > LOAD_RADIUS) continue;
    const cat = ITEMS[it.def]?.category;
    if (!cat) continue;
    const z = m.zones.get(m.zoneAt[it.y * m.w + it.x]);
    const ours = z && z.faction === faction && z.kind === 'stockpile';
    const packed = !z && (cat === 'kit' || cat === 'gear');
    if (ours || packed) byDef.set(it.def, (byDef.get(it.def) ?? 0) + it.count);
  }
  return [...byDef.entries()].map(([def, count]) => ({ def, count }));
}

export interface LoadPlan {
  cargo: [string, number][];
  left: [string, number][];
  bulk: number;
  capacity: number;
  sledges: number;
}

/** What the caravan would take and leave behind, by the sim's own loading rule. */
export function planLoad(goods: { def: string; count: number }[], members: number, take: string[]): LoadPlan {
  const n = chooseLoad(goods, members, take);
  const cargo: [string, number][] = [];
  const left: [string, number][] = [];
  goods.forEach((g, i) => {
    if (n[i] > 0) cargo.push([g.def, n[i]]);
    if (g.count - n[i] > 0) left.push([g.def, g.count - n[i]]);
  });
  const sledges = cargo.reduce((a, [d, k]) => a + (d === 'sledge' ? k : 0), 0);
  return { cargo, left, bulk: cargo.reduce((a, [d, k]) => a + bulkOf(d, k), 0), capacity: carryCapacity(members, sledges), sledges };
}

export function routeLength(points: Point[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return d;
}

/** Hours on the road for a route this long, slowed by the load like the sim's caravanPace. */
export function hoursFor(length: number, load: number): number {
  const pace = 1 - 0.4 * Math.min(1, load);
  return (length * ROAD_TICKS_PER_CELL) / pace / TICKS_PER_HOUR;
}

/** Distance from p to the segment a-b. */
function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface Crossing {
  town: Faction;
  /** How they'll greet the caravan. */
  kind: 'ally' | 'friendly' | 'toll' | 'hostile';
  toll?: number;
}

/** Towns whose land the route (as straight legs) crosses, and what each will do. */
export function crossings(m: Mirror, me: number, points: Point[], cargo: [string, number][]): Crossing[] {
  const out: Crossing[] = [];
  for (const f of m.factions.values()) {
    const s = f.settlement;
    if (!s || s.state !== 'home') continue;
    let near = Infinity;
    for (let i = 1; i < points.length; i++) near = Math.min(near, segDist(f.home, points[i - 1], points[i]));
    if (near > s.radius + GUARD_REACH) continue;
    if (pactOf(m, me, f.id)?.kind === 'ally') out.push({ town: f, kind: 'ally' });
    else {
      const mood = dispositionOf(s, me);
      out.push(mood === 'friendly' ? { town: f, kind: 'friendly' } : mood === 'hostile' ? { town: f, kind: 'hostile' } : { town: f, kind: 'toll', toll: tollFor(cargo) });
    }
  }
  return out;
}

/** How many cells of the route run through mountain passes, where raiders may wait. */
export function passCells(m: Mirror, points: Point[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(a.x + ((b.x - a.x) * k) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * k) / steps);
      let rock = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (m.inBounds(x + dx, y + dy) && m.rock[(y + dy) * m.w + x + dx]) rock++;
      if (rock >= PASS_ROCK) n += 3;
    }
  }
  return n;
}

/** Colonists who could go: yours, standing, not prisoners. */
export function candidates(m: Mirror, me: number): Pawn[] {
  const out: Pawn[] = [];
  for (const e of m.entities.values()) if (e.kind === 'pawn' && e.faction === me && !e.downed && !e.prisoner && !e.species) out.push(e);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Why the colony can't settle here, by the server's rule (siteProblem), or null. */
export function siteTrouble(m: Mirror, me: number, tick: number, x: number, y: number): string | null {
  if (!(x >= 6 && y >= 6 && x < m.w - 6 && y < m.h - 6)) return 'Too close to the edge of the map.';
  if (frostLevel(x, y, m.w, m.h, frostRadius(tick, m.frost)) > 0) return 'That land has already frozen over.';
  let open = 0;
  let total = 0;
  for (let yy = y - 5; yy <= y + 5; yy++) {
    for (let xx = x - 5; xx <= x + 5; xx++) {
      total++;
      const i = yy * m.w + xx;
      const z = m.zoneAt[i] ? m.zones.get(m.zoneAt[i]) : undefined;
      const b = m.buildingAt[i] ? (m.entities.get(m.buildingAt[i]) as Building | undefined) : undefined;
      const solid = !!m.rock[i] || !TERRAINS[m.terrain[i]].passable || (!!b && BUILDINGS[b.def]?.blocksMovement);
      const mine = (z && z.faction === me) || (b && b.faction === me);
      if (TERRAINS[m.terrain[i]].buildable && ((!solid && !b && !z) || mine)) open++;
    }
  }
  if (open / total < 0.6) return 'Not enough open, buildable ground there.';
  for (const f of m.factions.values()) {
    if (f.isPlayer && f.id !== me && Math.hypot(f.home.x - x, f.home.y - y) < MIN_COLONY_GAP) return `Too close to ${f.name}.`;
    if (f.settlement && f.settlement.state !== 'fallen' && Math.hypot(f.home.x - x, f.home.y - y) < SETTLEMENT_GAP) return `Too close to ${f.name}.`;
  }
  return null;
}

/**
 * A waypoint that takes the route around a town's land: out from the town, perpendicular to the
 * leg that crosses it, just beyond where its guards reach. Returns the new via list, or null.
 */
export function detourAround(m: Mirror, home: Point, via: Point[], dest: Point, town: Faction): Point[] | null {
  const s = town.settlement;
  if (!s) return null;
  const pts = [home, ...via, dest];
  const reach = s.radius + GUARD_REACH + 6;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (segDist(town.home, a, b) > s.radius + GUARD_REACH) continue;
    // The closest point of the leg to the town, and the way out from the town through it.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((town.home.x - a.x) * dx + (town.home.y - a.y) * dy) / l2));
    let ox = a.x + t * dx - town.home.x;
    let oy = a.y + t * dy - town.home.y;
    if (Math.hypot(ox, oy) < 0.5) {
      // Straight through the middle: go round on the left of the leg.
      ox = -dy;
      oy = dx;
    }
    const len = Math.hypot(ox, oy) || 1;
    for (const side of [1, -1]) {
      const x = Math.round(town.home.x + (ox / len) * reach * side);
      const y = Math.round(town.home.y + (oy / len) * reach * side);
      if (x < 6 || y < 6 || x >= m.w - 6 || y >= m.h - 6 || m.rock[y * m.w + x]) continue;
      const out = [...via];
      out.splice(i - 1, 0, { x, y });
      return out;
    }
  }
  return null;
}
