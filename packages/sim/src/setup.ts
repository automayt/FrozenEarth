import { TERRAINS } from '@fe/defs';
import { generateMap } from './mapgen';
import { FACTION_COLORS, pawnName } from './names';
import type { Faction } from './types';
import { World } from './world';

export interface WorldOptions {
  seed?: number;
  width?: number;
  height?: number;
}

export function createWorld(opts: WorldOptions = {}): World {
  const seed = opts.seed ?? (Math.random() * 0x7fffffff) | 0;
  const w = new World(seed, opts.width ?? 200, opts.height ?? 200);
  generateMap(w);
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

export function addPlayerFaction(w: World, name: string, colonists = 3): Faction {
  const id = Math.max(0, ...w.factions.keys()) + 1;
  const home = findSpawn(w);
  const f: Faction = { id, name, color: FACTION_COLORS[(id - 1) % FACTION_COLORS.length], home, isPlayer: true };
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
  w.message(0, `${name} has settled on the outer band.`, 'neutral', m.idx(home.x, home.y));
  return f;
}
