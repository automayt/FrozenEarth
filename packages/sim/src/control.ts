import { ITEMS } from '@fe/defs';
import { theftTick, type JobResult } from './jobs';
import { makePathState } from './pathfinding';
import { endJob, pawnSpeed, setDrafted } from './pawns';
import { canStealFrom, NOISE, makeNoise, theftPickupNoise } from './stealth';
import type { Item, Job, Pawn } from './types';
import { NEIGHBORS8, rk, type World } from './world';

/**
 * Direct control: a player steers one of their colonists cell by cell (WASD), sneaks, and picks
 * things up or puts them down by hand. Commands only set intent (a held direction); the sim
 * moves the pawn, so every client sees the same thing.
 */

export function setPossessed(w: World, p: Pawn, on: boolean): void {
  if (p.downed || p.prisoner) return;
  if (on) {
    if (!p.drafted) setDrafted(w, p, true);
    endJob(w, p);
    p.possessed = true;
    p.job = { type: 'control', stage: 0 };
  } else {
    p.possessed = false;
    p.steer = undefined;
    p.sneaking = false;
    if (p.job?.type === 'control') endJob(w, p);
  }
  w.markDirty(p);
}

/** Each tick while possessed: take a step in the held direction, and if carrying stolen goods, risk being seen. */
export function controlTick(w: World, p: Pawn, j: Extract<Job, { type: 'control' }>): JobResult {
  if (!p.possessed) return 'done';
  if (theftTick(w, p, j) === 'dropped') return 'continue';
  if (!p.path && p.steer) {
    const m = w.map;
    const [dx, dy] = p.steer;
    const x = p.x + dx;
    const y = p.y + dy;
    if (m.inBounds(x, y)) {
      const c = m.idx(x, y);
      // No squeezing diagonally between two walls.
      const corner = dx && dy && (!w.passable(m.idx(p.x + dx, p.y), p.faction) || !w.passable(m.idx(p.x, p.y + dy), p.faction));
      if (w.passable(c, p.faction) && !corner) {
        p.path = makePathState(w, w.cellOf(p), [c], c, false, pawnSpeed(w, p));
        w.markDirty(p);
      }
    }
  }
  return 'continue';
}

/** E: put down what you're carrying, or pick up what's at your feet or beside you. */
export function interact(w: World, p: Pawn): void {
  const m = w.map;
  const here = w.cellOf(p);
  const j = p.job?.type === 'control' ? p.job : null;
  if (p.carrying) {
    const c = p.carrying;
    const placed = w.dropInto(here, c.def, c.count, c.rot);
    if (placed < c.count) w.placeItemNear(c.def, c.count - placed, here, c.rot);
    p.carrying = null;
    w.markDirty(p);
    makeNoise(w, p, NOISE.drop * (p.sneaking ? 0.5 : 1), (o) => o.faction !== p.faction);
    return;
  }
  // What's here, then the neighbours; someone else's stockpile counts (that's stealing).
  const cells = [here, ...NEIGHBORS8.map(([dx, dy]) => (m.inBounds(p.x + dx, p.y + dy) ? m.idx(p.x + dx, p.y + dy) : -1)).filter((c) => c >= 0)];
  for (const c of cells) {
    const it = m.itemAt[c] ? w.get<Item>(m.itemAt[c]) : undefined;
    if (!it || it.kind !== 'item' || w.reservedByOther(rk.e(it.id), p.id)) continue;
    const z = w.zoneAt(c);
    const owner = z && z.kind === 'stockpile' ? z.faction : 0;
    if (owner && owner !== p.faction && !canStealFrom(w, p.faction, owner)) continue;
    const def = it.def;
    const rot = it.rot;
    const got = w.takeFromItem(it, Math.min(it.count, ITEMS[def].stackLimit));
    p.carrying = { def, count: got, rot };
    w.markDirty(p);
    if (owner && owner !== p.faction && j) {
      j.stolen = owner;
      j.stolenAt = c;
      theftPickupNoise(w, p, owner);
    }
    return;
  }
}
