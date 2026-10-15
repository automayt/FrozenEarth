import { WEAPON_KEYS, weaponOf, type WeaponDef } from '@fe/defs';
import { effectsOf, injure } from './health';
import type { Pawn } from './types';
import { NEIGHBORS8, type World } from './world';

/** Hit chance multiplier for a target crouched behind a wall or rock between it and the shooter. */
export const COVER_MULT = 0.5;
/** Ticks spent aiming after coming into reach, before the first attack. */
const WARMUP_MELEE = 20;
const WARMUP_RANGED = 45;

export function isRaider(w: World, faction: number): boolean {
  return !!w.factions.get(faction)?.raid;
}

/**
 * Factions that fight on sight: raiders against everyone else. Two players are never hostile
 * here; their pawns only fight each other on an explicit attack order.
 */
export function hostile(w: World, a: number, b: number): boolean {
  return a !== b && isRaider(w, a) !== isRaider(w, b);
}

/** Straight-line distance between two cells, in cells. */
export function cellDistance(w: World, a: number, b: number): number {
  const m = w.map;
  return Math.hypot(m.cx(a) - m.cx(b), m.cy(a) - m.cy(b));
}

/** Bresenham line between two cell centres; walls, doors and rock in between block it. */
export function lineOfSight(w: World, from: number, to: number): boolean {
  const m = w.map;
  let x = m.cx(from);
  let y = m.cy(from);
  const x1 = m.cx(to);
  const y1 = m.cy(to);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x === x1 && y === y1) return true;
    const c = m.idx(x, y);
    if (c !== from && m.wall[c]) return false;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** True when a wall or rock right next to the target sits on the shooter's side of it. */
export function inCover(w: World, shooter: number, target: number): boolean {
  if (w.dist(shooter, target) <= 1) return false;
  const m = w.map;
  const tx = m.cx(target);
  const ty = m.cy(target);
  const vx = m.cx(shooter) - tx;
  const vy = m.cy(shooter) - ty;
  for (const [dx, dy] of NEIGHBORS8) {
    if (!m.inBounds(tx + dx, ty + dy) || !m.wall[m.idx(tx + dx, ty + dy)]) continue;
    // Only cover that faces the shooter: the wall's offset points roughly toward them.
    if (dx * vx + dy * vy > 0) return true;
  }
  return false;
}

/** Can this weapon hit the target cell from here right now? */
export function inReach(w: World, wd: WeaponDef, from: number, to: number): boolean {
  if (wd.melee) return w.dist(from, to) <= 1;
  return cellDistance(w, from, to) <= wd.range && lineOfSight(w, from, to);
}

export function hitChance(w: World, p: Pawn, t: Pawn): number {
  const wd = weaponOf(p.weapon);
  const from = w.cellOf(p);
  const to = w.cellOf(t);
  // Hurt, sick or exhausted fighters aim worse.
  let c = wd.accuracy * (0.6 + 0.4 * Math.min(1, effectsOf(w, p).work));
  if (!wd.melee) {
    c *= 1 - (0.5 * cellDistance(w, from, to)) / wd.range;
    if (inCover(w, from, to)) c *= COVER_MULT;
  }
  if (t.downed) c *= 1.5;
  return Math.max(0.05, Math.min(0.95, c));
}

/** One swing or shot. Records it for clients to draw and applies the wound. */
export function strike(w: World, p: Pawn, t: Pawn): void {
  const wd = weaponOf(p.weapon);
  const hit = w.rng.chance(hitChance(w, p, t));
  w.dirty.shots.push(p.id, t.id, p.x, p.y, t.x, t.y, hit ? 1 : 0, Math.max(0, WEAPON_KEYS.indexOf(p.weapon)));
  if (hit) injure(w, t, wd.injury, wd.damage * w.rng.range(0.7, 1.3), p);
}

/** Start the aim delay for a fighter that has just come into reach. */
export function warmup(w: World, p: Pawn): number {
  return w.tick + (weaponOf(p.weapon).melee ? WARMUP_MELEE : WARMUP_RANGED);
}

/** Nearest hostile, standing pawn this pawn could hit from where it stands. */
export function hostileInReach(w: World, p: Pawn): Pawn | null {
  const wd = weaponOf(p.weapon);
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.downed || o.prisoner || !hostile(w, p.faction, o.faction)) continue;
    const c = w.cellOf(o);
    const d = cellDistance(w, here, c);
    if (d >= bestD || d > wd.range + 0.01 || !inReach(w, wd, here, c)) continue;
    best = o;
    bestD = d;
  }
  return best;
}
