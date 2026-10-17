import { BUILDINGS, PLANTS, TREE_COVER, WALL_COVER } from '@fe/defs';
import { NEIGHBORS8, type Building, type Plant } from '@fe/sim';
import type { Mirror } from '@fe/protocol';

/**
 * Graded cover as the sim works it out (world.ts refreshCell and combat.ts coverAgainst), from
 * the client's mirror, so the renderer can show who is in cover and from what. The sim's cover
 * layers aren't replicated; they follow from rock, buildings and trees, which are.
 */

/** Cover cell `c` gives someone right behind it, in percent of shots stopped (as the sim's map.cover). */
export function coverAt(m: Mirror, c: number): number {
  let cover = m.rock[c] > 0 ? WALL_COVER : 0;
  const b = m.buildingAt[c] ? (m.entities.get(m.buildingAt[c]) as Building | undefined) : undefined;
  const d = b ? BUILDINGS[b.def] : undefined;
  if (d) cover = d.cover ?? (d.wall ? WALL_COVER : 0);
  const p = m.plantAt[c] ? (m.entities.get(m.plantAt[c]) as Plant | undefined) : undefined;
  if (p && PLANTS[p.def]?.tree && p.growth > 0.4) cover = Math.max(cover, TREE_COVER);
  return Math.round(cover * 100);
}

/** Firing slits and doors only shelter whoever is indoors. */
function insideOnly(m: Mirror, c: number): boolean {
  const b = m.buildingAt[c] ? (m.entities.get(m.buildingAt[c]) as Building | undefined) : undefined;
  const d = b ? BUILDINGS[b.def] : undefined;
  return !!d && (!!d.seeThrough || !!d.door);
}

function dist(w: number, a: number, b: number): number {
  return Math.max(Math.abs((a % w) - (b % w)), Math.abs(((a / w) | 0) - ((b / w) | 0)));
}

export interface CoverHit {
  /** Share of shots stopped, 0..1. */
  cover: number;
  /** The neighbouring cell giving it, or -1. */
  cell: number;
}

/**
 * The sim's coverAgainst: the best cover right next to `target` on the shooter's side (none at point
 * blank), plus which cell gives it. `out` is reused when passed.
 */
export function coverFrom(m: Mirror, shooter: number, target: number, out: CoverHit = { cover: 0, cell: -1 }): CoverHit {
  out.cover = 0;
  out.cell = -1;
  const w = m.w;
  if (dist(w, shooter, target) <= 1) return out;
  const tx = target % w;
  const ty = (target / w) | 0;
  const vx = (shooter % w) - tx;
  const vy = ((shooter / w) | 0) - ty;
  const indoors = m.roomAt[target] !== 0;
  let best = 0;
  for (const [dx, dy] of NEIGHBORS8) {
    if (!m.inBounds(tx + dx, ty + dy)) continue;
    const n = (ty + dy) * w + tx + dx;
    let c = coverAt(m, n);
    if (c && !indoors && insideOnly(m, n)) c = 0;
    // A shooter right beside the cover shoots past it.
    if (c && dist(w, shooter, n) <= 1) c = 0;
    if (c > best && dx * vx + dy * vy > 0) {
      best = c;
      out.cell = n;
    }
  }
  out.cover = best / 100;
  return out;
}

/** How well-covered, as a colour: green for walls and slits, yellow for sandbags and doors, amber for trees, red for none. */
export function coverColor(cover: number): number {
  return cover >= 0.7 ? 0x6ad46a : cover >= 0.5 ? 0xd8d050 : cover > 0 ? 0xf0a040 : 0xff5040;
}
