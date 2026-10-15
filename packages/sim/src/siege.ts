import { BUILDINGS, maxHp } from '@fe/defs';
import { BREACH, findPath } from './pathfinding';
import type { Building, Job, Pawn, RaidState } from './types';
import type { World } from './world';

/** How long a raider keeps at one wall before looking around again. */
export const BASH_TICKS = 3000;

/** Knock hit points off a building, wrecking it at zero. Returns true if it was destroyed. */
export function damageBuilding(w: World, b: Building, dmg: number): boolean {
  b.hp = Math.max(0, b.hp - dmg);
  w.markDirty(b);
  if (b.hp > 0) {
    w.damaged.add(b.id);
    return false;
  }
  const cell = w.cellOf(b);
  const d = BUILDINGS[b.def];
  w.despawn(b.id);
  // Some of the materials survive as scrap.
  for (const [def, n] of Object.entries(d.cost)) {
    const back = Math.floor(n * 0.25);
    if (back > 0) w.placeItemNear(def, back, cell);
  }
  w.message(b.faction, `Raiders have smashed through your ${d.label.toLowerCase()}!`, 'bad', cell);
  return true;
}

/** Restore hit points. Returns true once the building is whole again. */
export function repairBuilding(w: World, b: Building, amount: number): boolean {
  const max = maxHp(b.def);
  b.hp = Math.min(max, b.hp + amount);
  if (b.hp < max) return false;
  w.damaged.delete(b.id);
  w.markDirty(b);
  return true;
}

/**
 * For a raider who can't walk to anyone: the first wall or door (or, for sappers, rock) on the
 * cheapest way through to the nearest colonist. If nothing stands in the way after all (a wall
 * just came down), go straight for them.
 */
export function breachJob(w: World, p: Pawn, raid: RaidState): Job | null {
  const here = w.cellOf(p);
  let target: Pawn | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction !== raid.target || o.downed || o.prisoner) continue;
    const d = w.dist(here, w.cellOf(o));
    if (d < bestD) {
      bestD = d;
      target = o;
    }
  }
  if (!target) return null;
  const cells = findPath(w, here, w.cellOf(target), true, p.faction, 50_000, raid.sapper ? BREACH.rock : BREACH.walls);
  if (!cells) return null;
  for (const c of cells) {
    if (!w.passable(c, p.faction)) return { type: 'bash', stage: 0, cell: c, next: 0, progress: 0, until: w.tick + BASH_TICKS };
  }
  return { type: 'attack', stage: 0, target: target.id, forced: false, chase: true, next: 0, until: w.tick + 600 };
}
