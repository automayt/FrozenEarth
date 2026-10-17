import { BUILDINGS, MIN_MOVE_COST, ROCKS, TERRAINS } from '@fe/defs';
import { PAWN_TICKS_PER_CELL } from './constants';
import type { Building, PathState } from './types';
import type { World } from './world';

/** How a path may treat obstacles: walk around them, smash walls and doors, or also dig rock. */
export const BREACH = { none: 0, walls: 1, rock: 2 } as const;
export type Breach = (typeof BREACH)[keyof typeof BREACH];

/** A wall, door or other blocking building that this faction may smash. */
export function breakable(w: World, b: Building, faction: number): boolean {
  if (b.faction === faction || BUILDINGS[b.def]?.special) return false;
  // A player's, or the settlement this raid came for.
  return !!w.factions.get(b.faction)?.isPlayer || w.factions.get(faction)?.raid?.target === b.faction;
}

/**
 * Extra ticks a breach path pays to get through a cell this faction can't walk into, or -1 if
 * it can't be broken. Priced like a detour of a few dozen cells, so raiders look for a way
 * round first and the search stays small.
 */
export function breachCost(w: World, i: number, faction: number, mode: Breach): number {
  const m = w.map;
  if (!TERRAINS[m.terrain[i]].passable) return -1;
  if (m.rock[i]) return mode === BREACH.rock ? PAWN_TICKS_PER_CELL * (4 + ROCKS[m.rock[i]].mineWork / 60) : -1;
  const b = m.buildingAt[i] ? w.get<Building>(m.buildingAt[i]) : undefined;
  if (!b || !breakable(w, b, faction)) return -1;
  return PAWN_TICKS_PER_CELL * (8 + b.hp / 12);
}

/** Binary min-heap keyed by float priority, storing int cell ids. */
class Heap {
  ids: number[] = [];
  keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  clear(): void {
    this.ids.length = 0;
    this.keys.length = 0;
  }

  push(id: number, key: number): void {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

interface Buffers {
  n: number;
  g: Float64Array;
  from: Int32Array;
  stamp: Uint32Array;
  closed: Uint32Array;
  gen: number;
  heap: Heap;
}

let buffers: Buffers | null = null;

function getBuffers(n: number): Buffers {
  if (!buffers || buffers.n !== n) {
    buffers = {
      n,
      g: new Float64Array(n),
      from: new Int32Array(n),
      stamp: new Uint32Array(n),
      closed: new Uint32Array(n),
      gen: 0,
      heap: new Heap(),
    };
  }
  return buffers;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** True when standing in `cell` satisfies the goal. */
export function atGoal(w: World, cell: number, goal: number, adj: boolean): boolean {
  if (cell === goal) return true;
  return adj && w.dist(cell, goal) <= 1;
}

/** Cheap reject: can any goal cell possibly be reached from start? */
export function maybeReachable(w: World, start: number, goal: number, adj: boolean): boolean {
  const m = w.map;
  const sc = m.component(start);
  if (sc < 0) return true; // standing somewhere odd; let A* decide
  if (m.component(goal) === sc) return true;
  if (!adj) return false;
  const gx = m.cx(goal);
  const gy = m.cy(goal);
  for (let k = 0; k < 8; k++) {
    const x = gx + DX[k];
    const y = gy + DY[k];
    if (m.inBounds(x, y) && m.component(m.idx(x, y)) === sc) return true;
  }
  return false;
}

/**
 * A* from start to goal (or any cell next to it when adj). 8-directional, no corner cutting.
 * Returns the cells to walk through, excluding start, or null if unreachable.
 * With `breach`, the path may also run through obstacles (see breachCost), entered orthogonally;
 * the caller finds them as the cells on it that aren't passable.
 */
export function findPath(
  w: World,
  start: number,
  goal: number,
  adj: boolean,
  faction: number,
  maxNodes = 50_000,
  breach: Breach = BREACH.none,
): number[] | null {
  const m = w.map;
  if (atGoal(w, start, goal, adj)) return [];
  if (!breach && !maybeReachable(w, start, goal, adj)) return null;
  const b = getBuffers(m.n);
  b.gen++;
  if (b.gen === 0xffffffff) {
    b.stamp.fill(0);
    b.closed.fill(0);
    b.gen = 1;
  }
  const { g, from, stamp, closed, heap } = b;
  const gen = b.gen;
  heap.clear();
  const gx = m.cx(goal);
  const gy = m.cy(goal);
  const hScale = PAWN_TICKS_PER_CELL * MIN_MOVE_COST;
  const h = (c: number) => {
    let dx = Math.abs(m.cx(c) - gx);
    let dy = Math.abs(m.cy(c) - gy);
    if (adj) {
      dx = Math.max(0, dx - 1);
      dy = Math.max(0, dy - 1);
    }
    return hScale * (Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy));
  };
  g[start] = 0;
  stamp[start] = gen;
  from[start] = -1;
  heap.push(start, h(start));
  let expanded = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    if (closed[c] === gen) continue;
    closed[c] = gen;
    if (atGoal(w, c, goal, adj) && (c === start || w.passable(c, faction))) {
      const path: number[] = [];
      for (let p = c; p !== start; p = from[p]) path.push(p);
      path.reverse();
      return path;
    }
    if (++expanded > maxNodes) return null;
    const cx = m.cx(c);
    const cy = m.cy(c);
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k];
      const ny = cy + DY[k];
      if (!m.inBounds(nx, ny)) continue;
      const ni = ny * m.w + nx;
      if (closed[ni] === gen) continue;
      const diag = k >= 4;
      let extra = 0;
      if (!w.passable(ni, faction)) {
        if (!breach || diag) continue;
        extra = breachCost(w, ni, faction, breach);
        if (extra < 0) continue;
      }
      if (diag && (!w.passable(cy * m.w + nx, faction) || !w.passable(ny * m.w + cx, faction))) continue;
      const ng = g[c] + w.stepCost(ni, diag) + extra;
      if (stamp[ni] === gen && ng >= g[ni]) continue;
      stamp[ni] = gen;
      g[ni] = ng;
      from[ni] = c;
      heap.push(ni, ng + h(ni));
    }
  }
  return null;
}

/** Turn a cell list into a timed walk starting now. */
export function makePathState(w: World, start: number, cells: number[], goal: number, adj: boolean, speed = 1): PathState {
  const m = w.map;
  const times: number[] = [];
  let t = w.tick;
  let prev = start;
  for (const c of cells) {
    const diag = m.cx(c) !== m.cx(prev) && m.cy(c) !== m.cy(prev);
    t += Math.max(1, Math.round(w.stepCost(c, diag) / speed));
    times.push(t);
    prev = c;
  }
  return { cells, times, idx: 0, goal, adj, t0: w.tick, fx: m.cx(start), fy: m.cy(start) };
}
