import { TERRAINS } from '@fe/defs';
import { generateMap } from './mapgen';
import { FACTION_COLORS, pawnName } from './names';
import type { Building, Faction } from './types';
import { Rng } from './rng';
import { FROST_MAX, frostLevel } from './frost';
import { World } from './world';
import { placeSettlements } from './settlements';
import { populateWildlife } from './wildlife';

export interface WorldOptions {
  seed?: number;
  width?: number;
  height?: number;
  /** Found NPC settlements (default true). */
  settlements?: boolean;
  /** Stock the map with wild animals (default true). */
  wildlife?: boolean;
}

export function createWorld(opts: WorldOptions = {}): World {
  const seed = opts.seed ?? (Math.random() * 0x7fffffff) | 0;
  const w = new World(seed, opts.width ?? 200, opts.height ?? 200);
  generateMap(w);
  if (opts.settlements !== false) placeSettlements(w);
  if (opts.wildlife !== false) populateWildlife(w);
  return w;
}

/** Score a candidate home cell: open, buildable ground away from other colonies. */
function spawnScore(w: World, cx: number, cy: number): number {
  const m = w.map;
  let open = 0;
  let total = 0;
  for (let y = cy - 6; y <= cy + 6; y++) {
    for (let x = cx - 6; x <= cx + 6; x++) {
      total++;
      if (!m.inBounds(x, y)) continue;
      const i = m.idx(x, y);
      if (!m.solid[i] && TERRAINS[m.terrain[i]].buildable && !m.buildingAt[i]) open++;
    }
  }
  if (open / total < 0.8) return -1;
  let minDist = Infinity;
  for (const f of w.factions.values()) if (f.isPlayer) minDist = Math.min(minDist, Math.hypot(f.home.x - cx, f.home.y - cy));
  if (minDist < 45) return -1;
  // Nearby rock and trees are good for an early colony.
  let resources = 0;
  for (let y = cy - 18; y <= cy + 18; y += 3) {
    for (let x = cx - 18; x <= cx + 18; x += 3) {
      if (!m.inBounds(x, y)) continue;
      const i = m.idx(x, y);
      if (m.rock[i]) resources += 1;
      if (m.plantAt[i]) resources += 0.5;
    }
  }
  return open / total + Math.min(resources, 40) / 40 + Math.min(minDist, 100) / 200;
}

/** Minimum distance between a new colony and existing ones, when a player picks the spot. */
export const MIN_COLONY_GAP = 35;
/** Minimum distance between a colony and an NPC settlement. */
const SETTLEMENT_GAP = 28;

/**
 * Why a colony can't be founded (or moved) at (x, y), or null if it can.
 * `self` is the faction moving: its own home, zones and buildings don't count against it.
 */
export function siteProblem(w: World, x: number, y: number, self = 0): string | null {
  const m = w.map;
  // Written so NaN fails it too (every comparison with NaN is false).
  if (!(x >= 6 && y >= 6 && x < m.w - 6 && y < m.h - 6)) return 'Too close to the edge of the map.';
  if (frostLevel(x, y, m.w, m.h, w.frostRadius()) > 0) return 'That land has already frozen over.';
  let open = 0;
  let total = 0;
  for (let yy = y - 5; yy <= y + 5; yy++) {
    for (let xx = x - 5; xx <= x + 5; xx++) {
      total++;
      const i = m.idx(xx, yy);
      const z = m.zoneAt[i] ? w.zones.get(m.zoneAt[i]) : undefined;
      const b = m.buildingAt[i] ? w.get<Building>(m.buildingAt[i]) : undefined;
      const mine = (z && z.faction === self) || (b && b.faction === self);
      if (TERRAINS[m.terrain[i]].buildable && ((!m.solid[i] && !b && !z) || (self && mine))) open++;
    }
  }
  if (open / total < 0.6) return 'Not enough open, buildable ground here.';
  for (const f of w.factions.values()) {
    if (f.isPlayer && f.id !== self && Math.hypot(f.home.x - x, f.home.y - y) < MIN_COLONY_GAP) return `Too close to ${f.name}.`;
    if (f.settlement && f.settlement.state !== 'fallen' && Math.hypot(f.home.x - x, f.home.y - y) < SETTLEMENT_GAP) return `Too close to ${f.name}.`;
  }
  return null;
}

/** Which ring of the map a cell is in. Further in is harder now but freezes last. */
export function regionOf(w: World, x: number, y: number): 'outer band' | 'middle lands' | 'center' {
  const m = w.map;
  const edge = Math.min(x, y, m.w - 1 - x, m.h - 1 - y) / (Math.min(m.w, m.h) / 2);
  return edge < 0.4 ? 'outer band' : edge < 0.7 ? 'middle lands' : 'center';
}

/** A spread of good starting spots in the outer band, best first. Doesn't touch the world's RNG. */
export function suggestSites(w: World, count = 5): { x: number; y: number; region: string }[] {
  const m = w.map;
  const rng = new Rng(w.seed ^ (w.tick * 2654435761) ^ (w.factions.size * 97));
  const band = Math.max(12, Math.floor(Math.min(m.w, m.h) * 0.2));
  const cands: { x: number; y: number; score: number }[] = [];
  // Once the frost is moving, suggest the band just inside it rather than the map edge.
  const r = w.frostRadius();
  const half = Math.min(m.w, m.h) / 2;
  for (let tries = 0; tries < 600; tries++) {
    let x: number;
    let y: number;
    if (r < FROST_MAX - 0.05) {
      const a = rng.next() * Math.PI * 2;
      const d = Math.max(0.15, r - 0.45 + rng.next() * 0.33) * half;
      x = Math.round(m.w / 2 + Math.cos(a) * d);
      y = Math.round(m.h / 2 + Math.sin(a) * d);
      if (x < 8 || y < 8 || x >= m.w - 8 || y >= m.h - 8) continue;
    } else {
      const side = rng.int(4);
      const along = 10 + rng.int((side < 2 ? m.w : m.h) - 20);
      const depth = 10 + rng.int(band);
      x = side < 2 ? along : side === 2 ? depth : m.w - 1 - depth;
      y = side === 0 ? depth : side === 1 ? m.h - 1 - depth : along;
    }
    if (siteProblem(w, x, y)) continue;
    const score = spawnScore(w, x, y);
    if (score > 0) cands.push({ x, y, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const out: { x: number; y: number; region: string }[] = [];
  for (const c of cands) {
    if (out.length >= count) break;
    if (out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 30)) continue;
    out.push({ x: c.x, y: c.y, region: regionOf(w, c.x, c.y) });
  }
  return out;
}

/**
 * Pick a start location in the outer band of the map. The outer band is easier now
 * and is where winter will arrive first.
 */
export function findSpawn(w: World): { x: number; y: number } {
  const m = w.map;
  let best = { x: m.w >> 1, y: m.h >> 1 };
  let bestScore = -Infinity;
  const band = Math.max(12, Math.floor(Math.min(m.w, m.h) * 0.2));
  for (let tries = 0; tries < 500; tries++) {
    const side = w.rng.int(4);
    const along = 10 + w.rng.int((side < 2 ? m.w : m.h) - 20);
    const depth = 10 + w.rng.int(band);
    const x = side === 0 ? along : side === 1 ? along : side === 2 ? depth : m.w - 1 - depth;
    const y = side === 0 ? depth : side === 1 ? m.h - 1 - depth : along;
    const s = spawnScore(w, x, y);
    if (s > bestScore) {
      bestScore = s;
      best = { x, y };
    }
  }
  return best;
}

/** What the first colonists carry, in order. */
const STARTING_WEAPONS = ['rifle', 'bow', 'knife'];

export function addPlayerFaction(w: World, name: string, colonists = 3, at?: { x: number; y: number }): Faction {
  const id = Math.max(0, ...w.factions.keys()) + 1;
  const home = at ? { x: at.x, y: at.y } : findSpawn(w);
  const players = [...w.factions.values()].filter((x) => x.isPlayer).length;
  const f: Faction = { id, name, color: FACTION_COLORS[players % FACTION_COLORS.length], home, isPlayer: true };
  w.factions.set(id, f);
  w.dirty.factions.add(id);
  const m = w.map;
  const open: number[] = [];
  for (let y = home.y - 3; y <= home.y + 3; y++) {
    for (let x = home.x - 3; x <= home.x + 3; x++) {
      if (m.inBounds(x, y) && !m.solid[m.idx(x, y)]) open.push(m.idx(x, y));
    }
  }
  for (let k = 0; k < colonists; k++) {
    w.spawnPawn(id, open[k % open.length] ?? m.idx(home.x, home.y), pawnName(w.rng), undefined, STARTING_WEAPONS[k] ?? 'club');
  }
  const supplies: [string, number][] = [
    ['survival_meal', 30],
    ['wood', 150],
    ['steel', 80],
    ['potato', 40],
    ['cloth', 30],
  ];
  const drop = m.idx(Math.min(m.w - 1, home.x + 2), Math.min(m.h - 1, home.y + 2));
  for (const [def, n] of supplies) w.placeItemNear(def, n, drop);
  const region = regionOf(w, home.x, home.y);
  w.message(0, `${name} has settled ${region === 'center' ? 'near the center' : `in the ${region}`}.`, 'neutral', m.idx(home.x, home.y));
  return f;
}
