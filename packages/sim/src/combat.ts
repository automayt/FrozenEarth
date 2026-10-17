import { ANIMALS, FISTS, WEAPON_KEYS, weaponOf, type WeaponDef } from '@fe/defs';
import { effectsOf, injure } from './health';
import { HOSTILE_AT, settlerAttacked } from './settlements';
import type { Faction, Pawn } from './types';
import { NEIGHBORS8, type World } from './world';

/** Ticks spent aiming after coming into reach, before the first attack. */
const WARMUP_MELEE = 20;
const WARMUP_RANGED = 45;

export function isRaider(w: World, faction: number): boolean {
  return !!w.factions.get(faction)?.raid;
}

/** A settlement that has turned against a player colony. */
function settlementHates(s: Faction | undefined, player: Faction | undefined): boolean {
  const st = s?.settlement;
  return !!st && !!player?.isPlayer && (st.goodwill[player.id] ?? st.temper) <= HOSTILE_AT;
}

/**
 * Factions that fight on sight: raiders against everyone else, and settlements against colonies
 * they've turned on. Two players are never hostile here; their pawns only fight each other on an
 * explicit attack order.
 */
export function hostile(w: World, a: number, b: number): boolean {
  if (a === b) return false;
  const fa = w.factions.get(a);
  const fb = w.factions.get(b);
  // Grazing animals never start fights; predators are everyone's enemy (but each other's).
  if (fa?.wild === 'prey' || fb?.wild === 'prey') return false;
  if (fa?.wild === 'predator' || fb?.wild === 'predator') return !(fa?.wild && fb?.wild);
  if (fa?.raid || fb?.raid) return !!fa?.raid !== !!fb?.raid;
  return settlementHates(fa, fb) || settlementHates(fb, fa);
}

const NATURAL = new Map<string, WeaponDef>();

/** What a pawn fights with: its weapon, or an animal's teeth and hooves. */
export function weaponFor(p: Pawn): WeaponDef {
  if (!p.species) return weaponOf(p.weapon);
  let wd = NATURAL.get(p.species);
  if (!wd) {
    const sp = ANIMALS[p.species];
    wd = { ...FISTS, label: sp?.predator ? 'Teeth' : 'Hooves', damage: sp?.bite ?? 0.05, cooldown: sp?.cooldown ?? 70, injury: 'cut', accuracy: 0.8 };
    NATURAL.set(p.species, wd);
  }
  return wd;
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
    if (c !== from && m.wall[c] && !m.seeThru[c]) return false;
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

/**
 * Share of shots stopped by the best cover right next to the target on the shooter's side:
 * walls and rock 0.75, embrasures 0.8, sandbags 0.55, doors 0.5, trees 0.25. None at point blank.
 */
export function coverAgainst(w: World, shooter: number, target: number): number {
  if (w.dist(shooter, target) <= 1) return 0;
  const m = w.map;
  const tx = m.cx(target);
  const ty = m.cy(target);
  const vx = m.cx(shooter) - tx;
  const vy = m.cy(shooter) - ty;
  // Firing slits and doors are built to protect the people inside, not whoever is outside them.
  const indoors = m.roomAt[target] !== 0;
  let best = 0;
  for (const [dx, dy] of NEIGHBORS8) {
    if (!m.inBounds(tx + dx, ty + dy)) continue;
    const n = m.idx(tx + dx, ty + dy);
    let c = m.cover[n];
    if (!indoors && (m.seeThru[n] || m.doorFaction[n])) c = 0;
    // A shooter right beside the cover shoots past it.
    if (c && w.dist(shooter, n) <= 1) c = 0;
    // Only cover that faces the shooter: its offset points roughly toward them.
    if (c > best && dx * vx + dy * vy > 0) best = c;
  }
  return best / 100;
}

/**
 * For an AI fighter in reach of `target`: the best covered cell within a few steps that still
 * has a shot, if it's clearly better than where they stand. Null if there's nothing worth moving to.
 */
export function coverSpot(w: World, p: Pawn, target: number): number | null {
  const wd = weaponFor(p);
  if (wd.melee) return null;
  const m = w.map;
  const here = w.cellOf(p);
  const comp = m.component(here);
  let best = -1;
  let bestScore = coverAgainst(w, target, here) + 0.15;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (!m.inBounds(x, y)) continue;
      const c = m.idx(x, y);
      if (!w.passable(c, p.faction) || m.component(c) !== comp || !inReach(w, wd, c, target)) continue;
      const cover = coverAgainst(w, target, c);
      if (cover < 0.25) continue;
      const score = cover - w.dist(here, c) * 0.03;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  return best >= 0 ? best : null;
}

/** AI fighters with a ranged weapon look for cover; your drafted or steered colonists stay where you put them. */
export function seeksCover(p: Pawn, t: Pawn): boolean {
  return !p.drafted && !p.possessed && !p.species && !t.species && !weaponFor(p).melee;
}

/** True when anything right next to the target on the shooter's side gives cover. */
export function inCover(w: World, shooter: number, target: number): boolean {
  return coverAgainst(w, shooter, target) > 0;
}

/** Can this weapon hit the target cell from here right now? */
export function inReach(w: World, wd: WeaponDef, from: number, to: number): boolean {
  if (wd.melee) return w.dist(from, to) <= 1;
  return cellDistance(w, from, to) <= wd.range && lineOfSight(w, from, to);
}

export function hitChance(w: World, p: Pawn, t: Pawn): number {
  const wd = weaponFor(p);
  const from = w.cellOf(p);
  const to = w.cellOf(t);
  // Hurt, sick or exhausted fighters aim worse.
  let c = wd.accuracy * (0.6 + 0.4 * Math.min(1, effectsOf(w, p).work));
  if (!wd.melee) {
    c *= 1 - (0.5 * cellDistance(w, from, to)) / wd.range;
    c *= 1 - coverAgainst(w, from, to);
  }
  if (t.downed) c *= 1.5;
  return Math.max(0.05, Math.min(0.95, c));
}

/** One swing or shot. Records it for clients to draw and applies the wound. */
export function strike(w: World, p: Pawn, t: Pawn): void {
  const wd = weaponFor(p);
  const hit = w.rng.chance(hitChance(w, p, t));
  w.dirty.shots.push(p.id, t.id, p.x, p.y, t.x, t.y, hit ? 1 : 0, Math.max(0, WEAPON_KEYS.indexOf(p.weapon)));
  if (w.factions.get(t.faction)?.settlement) settlerAttacked(w, t, p, hit);
  if (!hit) return;
  const dmg = wd.damage * w.rng.range(0.7, 1.3);
  // Raids keep score, to judge whether to press on.
  const ours = w.factions.get(p.faction)?.raid;
  if (ours && t.faction === ours.target) ours.dealt = (ours.dealt ?? 0) + dmg;
  const theirs = w.factions.get(t.faction)?.raid;
  if (theirs) theirs.taken = (theirs.taken ?? 0) + dmg;
  injure(w, t, wd.injury, dmg, p);
}

/** Start the aim delay for a fighter that has just come into reach. */
export function warmup(w: World, p: Pawn): number {
  return w.tick + (weaponFor(p).melee ? WARMUP_MELEE : WARMUP_RANGED);
}

/** Nearest hostile, standing pawn this pawn could hit from where it stands. */
export function hostileInReach(w: World, p: Pawn): Pawn | null {
  const wd = weaponFor(p);
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
