import { BUILDINGS, ITEMS } from '@fe/defs';
import { cellDistance, lineOfSight } from './combat';
import { endJob, learn } from './pawns';
import type { Building, Pawn } from './types';
import type { World } from './world';

/**
 * Sight and sound. Awake people see thieves; anyone can hear them. Sneaking and the stealth
 * skill make a thief harder to spot and quieter, and darkness shortens everyone's sight.
 */

/** How far an awake person sees, in cells. */
export const SIGHT_DAY = 13;
export const SIGHT_NIGHT = 6;
/** How loud things are: the radius they carry over, in cells, before walls muffle them. */
export const NOISE = { pickup: 7, walk: 3, sneak: 1, drop: 4 } as const;
/** A thief is safe once this far from where they took the goods. */
const CLEAR_DIST = 22;
/** Chance per look (every 15 ticks) that someone who can see a thief realises what they're up to. */
const SPOT_CHANCE = 0.35;
/** Chance a sleeper right next to a noise wakes; falls off with distance. */
const WAKE_CHANCE = 0.6;

/** Sneaking walks slowly. */
export const SNEAK_SPEED = 0.55;

/** How much harder a pawn is to see or hear: 1 normally, much less sneaking with a high stealth skill. */
export function stealthMult(p: Pawn): number {
  const level = p.skills.stealth?.level ?? 0;
  return (p.sneaking ? 0.45 : 1) * (1 - Math.min(0.6, level * 0.03));
}

/** Lit by a fire, heater or anything else that glows, within a few cells. */
export function litAt(w: World, cell: number): boolean {
  const m = w.map;
  const x = m.cx(cell);
  const y = m.cy(cell);
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    const d = BUILDINGS[b.def];
    if (!d.radiant && !(d.heat && d.heat > 0)) continue;
    const r = d.radiant ? d.radiant[1] + 2 : 4;
    if (Math.abs(b.x - x) <= r && Math.abs(b.y - y) <= r) return true;
  }
  return false;
}

/** How far `observer` can see something at `cell` right now. */
export function sightRange(w: World, cell: number): number {
  return w.isNight() && !litAt(w, cell) ? SIGHT_NIGHT : SIGHT_DAY;
}

/** Can this awake pawn see that one? Sneakers are only seen closer in. */
export function canSee(w: World, observer: Pawn, target: Pawn, range = sightRange(w, w.cellOf(target))): boolean {
  if (observer.asleep || observer.downed) return false;
  const a = w.cellOf(observer);
  const b = w.cellOf(target);
  const r = range * (target.sneaking ? 0.4 + 0.6 * stealthMult(target) : 1);
  return cellDistance(w, a, b) <= r && lineOfSight(w, a, b);
}

/** Walls between two cells, up to `cap`: each muffles a noise by half. */
function wallsBetween(w: World, from: number, to: number, cap: number): number {
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
  let n = 0;
  while (!(x === x1 && y === y1) && n < cap) {
    const c = m.idx(x, y);
    if (c !== from && m.wall[c]) n++;
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
  return n;
}

/** Can this pawn drop what it's doing to go look? */
function canInvestigate(w: World, o: Pawn): boolean {
  if (o.downed || o.prisoner || o.drafted || o.possessed || o.species) return false;
  const t = o.job?.type;
  return t !== 'attack' && t !== 'flee' && t !== 'rescue' && t !== 'tend' && t !== 'extinguish';
}

/**
 * A noise `loudness` cells loud, made by `maker`. Listeners it reaches (walls muffle it) go and
 * look; sleepers may wake first. Returns how many heard it.
 */
export function makeNoise(w: World, maker: Pawn, loudness: number, listens: (o: Pawn) => boolean): number {
  const here = w.cellOf(maker);
  const r = loudness * (1 - Math.min(0.6, (maker.skills.stealth?.level ?? 0) * 0.03));
  if (r < 0.5) return 0;
  let heard = 0;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o === maker || !listens(o)) continue;
    const c = w.cellOf(o);
    const d = cellDistance(w, c, here);
    if (d > r) continue;
    const reach = r / (1 << wallsBetween(w, here, c, 3));
    if (d > reach) continue;
    if (o.asleep && !w.rng.chance(WAKE_CHANCE * (1 - d / (reach + 1)))) continue;
    heard++;
    if (!canInvestigate(w, o)) continue;
    // Up and over to have a look.
    endJob(w, o);
    o.job = { type: 'goto', stage: 0, dest: here };
    w.markDirty(o);
  }
  return heard;
}

// ---------------------------------------------------------------- theft

/** Whose stockpiles a colony may steal from: a living settlement's, or another player's. */
export function canStealFrom(w: World, thief: number, owner: number): boolean {
  if (!owner || owner === thief) return false;
  const f = w.factions.get(owner);
  return !!f && (f.isPlayer || (!!f.settlement && f.settlement.state !== 'fallen'));
}

/** Goods picked up from someone's stockpile: the clatter can carry. */
export function theftPickupNoise(w: World, thief: Pawn, owner: number): void {
  makeNoise(w, thief, NOISE.pickup * (thief.sneaking ? 0.6 : 1), (o) => o.faction === owner);
}

/**
 * A colonist carrying goods stolen from `owner`, taken at cell `from`. Footsteps carry to
 * anyone nearby; anyone of theirs who's awake and can see the thief may raise the alarm.
 * `onCaught` handles the consequences (goodwill, dropped goods).
 */
export function thiefCheck(w: World, thief: Pawn, owner: number, from: number, onCaught: (spotter: Pawn) => void): 'risk' | 'clear' | 'caught' {
  const f = w.factions.get(owner);
  const s = f?.settlement;
  if (!f || (s && s.state !== 'home')) return 'clear';
  const here = w.cellOf(thief);
  if (cellDistance(w, here, from) > CLEAR_DIST) return 'clear';
  // Footsteps, now and then.
  if (thief.path && w.rng.chance(0.25)) makeNoise(w, thief, thief.sneaking ? NOISE.sneak : NOISE.walk, (o) => o.faction === owner);
  const range = sightRange(w, here);
  let near = false;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction !== owner || o.prisoner || o.species) continue;
    if (cellDistance(w, w.cellOf(o), here) < 10) near = true;
    if (!canSee(w, o, thief, range) || !w.rng.chance(SPOT_CHANCE * stealthMult(thief))) continue;
    const colony = w.factions.get(thief.faction)?.name ?? 'a colony';
    w.message(0, `${o.name} of ${f.name} caught ${thief.name} of ${colony} stealing!`, 'bad', here);
    onCaught(o);
    return 'caught';
  }
  // Slipping past people is how you get good at it.
  if (near) learn(w, thief, 'stealth', thief.sneaking ? 6 : 3);
  return 'risk';
}

/** A colony finds goods gone from its stockpile, with no idea who took them. */
export function noticeTheft(w: World, owner: number, def: string, count: number, at: number): void {
  if (!w.factions.get(owner)?.isPlayer) return;
  w.message(owner, `${count} ${ITEMS[def]?.label.toLowerCase() ?? def} has gone missing from your stockpile. Nobody saw who took it.`, 'bad', at);
}
