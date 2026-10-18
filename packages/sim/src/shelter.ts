import { cellDistance, hostile, lineOfSight, weaponFor } from './combat';
import { maybeReachable } from './pathfinding';
import type { Job, Pawn } from './types';
import type { World } from './world';

/**
 * Colonists who aren't drafted don't stand and work while raiders, wolves or an enemy colony's
 * people close in: they break off and shelter somewhere away from the threat, preferably
 * indoors, and only fight back when it's on top of them. Drafting is how a player sends them in.
 */

/** How close a hostile has to be (and in sight, unless very close) before a colonist breaks off. */
export const THREAT_RANGE = 12;
/** This close, running is pointless: they fight back with whatever they hold. */
const CORNERED = 1.6;
/** Where they head should be at least this far from the threat. */
const SAFE_DISTANCE = 16;
/** Job types that already deal with danger (or are the player's direct orders). */
const BUSY_WITH_IT = new Set(['shelter', 'attack', 'control', 'goto', 'hold', 'rescue', 'tend', 'flee']);

/** The nearest standing hostile that should worry this colonist, if any. */
export function threatTo(w: World, p: Pawn): Pawn | null {
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestD = THREAT_RANGE + 0.01;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.downed || o.prisoner || o.faction === p.faction) continue;
    if (Math.abs(o.x - p.x) > THREAT_RANGE || Math.abs(o.y - p.y) > THREAT_RANGE) continue;
    if (!hostile(w, p.faction, o.faction)) continue;
    const c = w.cellOf(o);
    const d = cellDistance(w, here, c);
    if (d >= bestD || (d > 4 && !lineOfSight(w, c, here))) continue;
    best = o;
    bestD = d;
  }
  return best;
}

/** Should this colonist drop what they're doing and look to their safety? */
export function shouldShelter(w: World, p: Pawn): boolean {
  if (p.drafted || p.possessed || p.prisoner || p.species || p.downed) return false;
  if (p.job && BUSY_WITH_IT.has(p.job.type)) return false;
  return !!w.factions.get(p.faction)?.isPlayer;
}

/** Get away from the threat: indoors and out of its way if possible; fight back if cornered. */
export function shelterJob(w: World, p: Pawn, threat: Pawn): Job | null {
  const m = w.map;
  const here = w.cellOf(p);
  const there = w.cellOf(threat);
  const d = cellDistance(w, here, there);
  if (d <= CORNERED) return { type: 'attack', stage: 0, target: threat.id, forced: false, chase: false, next: 0, until: w.tick + 120 };
  let best = -1;
  let bestScore = -Infinity;
  const home = w.factions.get(p.faction)?.home;
  for (let k = 0; k < 40; k++) {
    // Mostly around here; some samples around home, where the walls are.
    const around = k < 28 || !home ? { x: p.x, y: p.y } : home;
    const r = k < 28 ? 6 + w.rng.int(20) : w.rng.int(8);
    const a = w.rng.next() * Math.PI * 2;
    const x = Math.round(around.x + Math.cos(a) * r);
    const y = Math.round(around.y + Math.sin(a) * r);
    if (!m.inBounds(x, y)) continue;
    const c = m.idx(x, y);
    if (!w.passable(c, p.faction) || w.isUnreachable(p.faction, c)) continue;
    const away = cellDistance(w, c, there);
    if (away < Math.min(SAFE_DISTANCE, d + 4)) continue;
    // Walls between them and the threat, a roof over their head, not too far to run.
    const score = Math.min(away, 30) + (m.roomAt[c] ? 12 : 0) + (lineOfSight(w, there, c) ? 0 : 8) - cellDistance(w, here, c) * 0.4;
    if (score > bestScore && maybeReachable(w, here, c, false)) {
      best = c;
      bestScore = score;
    }
  }
  if (best < 0) {
    // Nowhere to go: stand and fight if they can, otherwise just keep away as best they can.
    if (!weaponFor(p).melee || p.weapon) return { type: 'attack', stage: 0, target: threat.id, forced: false, chase: false, next: 0, until: w.tick + 120 };
    return null;
  }
  return { type: 'shelter', stage: 0, dest: best, from: threat.id, until: w.tick + 600 };
}
