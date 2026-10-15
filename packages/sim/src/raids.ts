import { BUILDINGS, ITEMS, WEAPONS } from '@fe/defs';
import { TICKS_PER_DAY } from './constants';
import { endJob } from './pawns';
import { maybeReachable } from './pathfinding';
import { pawnName } from './names';
import type { Faction, Item, Job, Pawn } from './types';
import { rk, type World } from './world';

export type RaidKind = 'raid' | 'night' | 'scout';

const RAIDER_GROUPS = ['the Red Hand', 'the Ashen Band', 'the Frostbitten', 'the Gallows Crew', 'the Hollow Men', 'the Last Wolves', 'the Iron Debt', 'the Blackwater Gang'];
const RAIDER_COLOR = 0x8a1c1c;
/** Most raiders one raid can bring. */
const MAX_RAIDERS = 12;
/** How long raiders stay before giving up. */
const RAID_TICKS = Math.round(TICKS_PER_DAY * 1.2);

const LOADOUTS: Record<RaidKind, [string, number][]> = {
  raid: [
    ['rifle', 3],
    ['bow', 3],
    ['club', 2],
    ['knife', 2],
  ],
  night: [
    ['knife', 1],
    ['club', 1],
  ],
  scout: [
    ['bow', 2],
    ['knife', 1],
  ],
};

const LOOT: [string, number, number][] = [
  ['steel', 10, 30],
  ['cloth', 10, 25],
  ['survival_meal', 2, 6],
  ['gold', 2, 6],
];

function pawnsOf(w: World, faction: number): Pawn[] {
  const out: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction) out.push(p);
  }
  return out;
}

/** Market value a colony has built up: stockpiled goods plus what its buildings cost. */
export function colonyWealth(w: World, faction: number): number {
  let v = 0;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (z && z.kind === 'stockpile' && z.faction === faction) v += ITEMS[it.def].marketValue * it.count;
  }
  for (const id of w.kinds.building) {
    const b = w.get(id)!;
    if (b.faction !== faction || b.kind !== 'building') continue;
    for (const [def, n] of Object.entries(BUILDINGS[b.def]?.cost ?? {})) v += (ITEMS[def]?.marketValue ?? 1) * n;
  }
  return v;
}

/** How many raid points a colony attracts: grows with its wealth and headcount. */
export function raidPoints(w: World, faction: number): number {
  return 40 + colonyWealth(w, faction) / 30 + pawnsOf(w, faction).length * 20;
}

/** Take points from a colony's threat budget. */
export function spendThreat(w: World, faction: number, points: number): void {
  w.story.threat[faction] = (w.story.threat[faction] ?? 0) - points;
}

/** A passable map-edge cell on the side nearest the colony, from which its home can be reached. */
function arrivalCell(w: World, home: number): number {
  const m = w.map;
  const hx = m.cx(home);
  const hy = m.cy(home);
  const sides = [
    { d: hy, at: (t: number) => m.idx(t, 0), along: hx, len: m.w },
    { d: m.h - 1 - hy, at: (t: number) => m.idx(t, m.h - 1), along: hx, len: m.w },
    { d: hx, at: (t: number) => m.idx(0, t), along: hy, len: m.h },
    { d: m.w - 1 - hx, at: (t: number) => m.idx(m.w - 1, t), along: hy, len: m.h },
  ].sort((a, b) => a.d - b.d);
  for (const side of sides) {
    for (let tries = 0; tries < 60; tries++) {
      const t = Math.max(0, Math.min(side.len - 1, side.along + w.rng.int(61) - 30));
      const c = side.at(t);
      if (!m.solid[c] && maybeReachable(w, c, home, true)) return c;
    }
  }
  return -1;
}

/** An empty raider faction to reuse, or a new one. */
function raiderFaction(w: World, target: number, home: number): Faction {
  const m = w.map;
  const busy = new Set<number>();
  for (const id of w.kinds.pawn) busy.add(w.get<Pawn>(id)!.faction);
  let f = [...w.factions.values()].find((x) => x.raid && !busy.has(x.id));
  if (!f) {
    const id = Math.max(0, ...w.factions.keys()) + 1;
    f = { id, name: '', color: RAIDER_COLOR, home: { x: 0, y: 0 }, isPlayer: false };
    w.factions.set(id, f);
  }
  f.name = `Raiders of ${w.rng.pick(RAIDER_GROUPS)}`;
  f.home = { x: m.cx(home), y: m.cy(home) };
  f.raid = { target, size: 0, breakAt: 1, dead: 0, until: w.tick + RAID_TICKS, fled: false };
  w.dirty.factions.add(f.id);
  return f;
}

function pickWeapon(w: World, kind: RaidKind, budget: number): string | null {
  const options = LOADOUTS[kind].filter(([k]) => WEAPONS[k].raidCost <= budget);
  if (!options.length) return null;
  let r = w.rng.next() * options.reduce((a, [, n]) => a + n, 0);
  for (const [k, n] of options) {
    r -= n;
    if (r <= 0) return k;
  }
  return options[options.length - 1][0];
}

const SIDE_NAMES = ['north', 'south', 'west', 'east'];

function sideName(w: World, c: number): string {
  const m = w.map;
  const y = m.cy(c);
  const x = m.cx(c);
  if (y === 0) return SIDE_NAMES[0];
  if (y === m.h - 1) return SIDE_NAMES[1];
  if (x === 0) return SIDE_NAMES[2];
  return SIDE_NAMES[3];
}

/**
 * Raiders arrive at the map edge nearest the target colony. `points` buys them: richer raids
 * bring more fighters and better guns. Returns the raiders, or null if nobody could arrive.
 */
export function startRaid(w: World, target: number, points: number, kind: RaidKind): Pawn[] | null {
  const f = w.factions.get(target);
  if (!f || !f.isPlayer || !pawnsOf(w, target).length) return null;
  const m = w.map;
  const home = m.idx(f.home.x, f.home.y);
  const arrive = arrivalCell(w, home);
  if (arrive < 0) return null;
  const weapons: string[] = [];
  let budget = points;
  const max = kind === 'scout' ? 2 : MAX_RAIDERS;
  while (weapons.length < max) {
    const wk = pickWeapon(w, kind, budget);
    if (!wk) break;
    weapons.push(wk);
    budget -= WEAPONS[wk].raidCost;
  }
  if (!weapons.length) weapons.push(kind === 'night' ? 'knife' : 'bow');
  const rf = raiderFaction(w, target, arrive);
  const raiders: Pawn[] = [];
  const ax = m.cx(arrive);
  const ay = m.cy(arrive);
  for (const wk of weapons) {
    let cell = arrive;
    for (let tries = 0; tries < 30; tries++) {
      const x = ax + w.rng.int(7) - 3;
      const y = ay + w.rng.int(7) - 3;
      if (!m.inBounds(x, y)) continue;
      const c = m.idx(x, y);
      if (!m.solid[c] && m.component(c) === m.component(arrive)) {
        cell = c;
        break;
      }
    }
    const p = w.spawnPawn(rf.id, cell, pawnName(w.rng), [], wk);
    p.needs = { food: 1, rest: 1, mood: 0.5 };
    if (w.rng.chance(0.4)) {
      const [def, lo, hi] = w.rng.pick(LOOT);
      p.carrying = { def, count: lo + w.rng.int(hi - lo + 1), rot: 0 };
    }
    raiders.push(p);
  }
  rf.raid!.size = raiders.length;
  rf.raid!.breakAt = kind === 'scout' ? 1 : Math.max(1, Math.ceil(raiders.length / 2));
  const what =
    kind === 'scout'
      ? `A scouting party of ${rf.name.replace('Raiders of ', '')} (${raiders.length}) is probing your defences from the ${sideName(w, arrive)}.`
      : kind === 'night'
        ? `${rf.name} (${raiders.length}, knives and clubs) are creeping in from the ${sideName(w, arrive)} under cover of dark!`
        : `${rf.name} (${raiders.length}) have arrived from the ${sideName(w, arrive)} edge to attack you!`;
  w.message(target, `${what} Draft your colonists (R) and right-click to fight.`, 'bad', arrive);
  return raiders;
}

function breakRaid(w: World, f: Faction, why: string): void {
  const raid = f.raid!;
  if (raid.fled) return;
  raid.fled = true;
  w.dirty.factions.add(f.id);
  w.message(raid.target, why, 'good');
  for (const p of pawnsOf(w, f.id)) if (!p.downed) endJob(w, p);
}

function checkBreak(w: World, faction: number): void {
  const f = w.factions.get(faction);
  if (!f?.raid || f.raid.fled) return;
  const down = f.raid.dead + pawnsOf(w, faction).filter((p) => p.downed).length;
  if (down >= f.raid.breakAt) breakRaid(w, f, `${f.name} have lost their nerve and are fleeing!`);
}

export function raiderDowned(w: World, faction: number): void {
  checkBreak(w, faction);
}

/** A raider died or left the map. */
export function raiderGone(w: World, faction: number, killed: boolean): void {
  const f = w.factions.get(faction);
  if (!f?.raid) return;
  if (killed) f.raid.dead++;
  if (pawnsOf(w, faction).length === 0) {
    w.message(f.raid.target, `${f.name} are gone. The raid is over.`, 'neutral');
    return;
  }
  checkBreak(w, faction);
}

// ---------------------------------------------------------------- raider AI

/** The nearest map edge cell this raider can walk to. */
function exitCell(w: World, p: Pawn): number {
  const m = w.map;
  const cands = [
    [p.x, 0],
    [p.x, m.h - 1],
    [0, p.y],
    [m.w - 1, p.y],
  ].sort((a, b) => Math.abs(a[0] - p.x) + Math.abs(a[1] - p.y) - (Math.abs(b[0] - p.x) + Math.abs(b[1] - p.y)));
  const here = w.cellOf(p);
  for (const [x, y] of cands) {
    for (let k = 0; k < 40; k++) {
      // Walk along the edge outward from the closest point until something passable turns up.
      const off = (k >> 1) * (k & 1 ? -1 : 1);
      const ex = x === 0 || x === m.w - 1 ? x : Math.max(0, Math.min(m.w - 1, x + off));
      const ey = y === 0 || y === m.h - 1 ? y : Math.max(0, Math.min(m.h - 1, y + off));
      const c = m.idx(ex, ey);
      if (!m.solid[c] && maybeReachable(w, here, c, false)) return c;
    }
  }
  return here;
}

export function isEdge(w: World, c: number): boolean {
  const m = w.map;
  const x = m.cx(c);
  const y = m.cy(c);
  return x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1;
}

function fleeJob(w: World, p: Pawn, item = 0): Job {
  return { type: 'flee', stage: item ? 0 : 1, dest: exitCell(w, p), item };
}

/** Something worth carrying off from the target's stockpiles, reachable from here. */
function lootFor(w: World, p: Pawn, target: number): Item | null {
  const here = w.cellOf(p);
  let best: Item | null = null;
  let bestScore = -Infinity;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const c = w.cellOf(it);
    const z = w.zoneAt(c);
    if (!z || z.faction !== target || w.reservedByOther(rk.e(it.id), p.id) || w.isUnreachable(p.faction, c)) continue;
    const score = ITEMS[it.def].marketValue * Math.min(it.count, ITEMS[it.def].stackLimit) - w.dist(here, c) * 2;
    if (score > bestScore && maybeReachable(w, here, c, false)) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

export function raiderThink(w: World, p: Pawn): Job {
  const f = w.factions.get(p.faction)!;
  const raid = f.raid!;
  if (!raid.fled && w.tick >= raid.until) breakRaid(w, f, `${f.name} have given up and are leaving.`);
  if (raid.fled) return fleeJob(w, p);
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestScore = Infinity;
  let anyTarget = false;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.downed || !w.factions.get(o.faction)?.isPlayer) continue;
    const c = w.cellOf(o);
    // Colonists of the target colony first; others only if they're in the way.
    const score = w.dist(here, c) + (o.faction === raid.target ? 0 : 25);
    if (o.faction === raid.target) anyTarget = true;
    if (score >= bestScore || w.isUnreachable(p.faction, c) || !maybeReachable(w, here, c, true)) continue;
    best = o;
    bestScore = score;
  }
  if (best) return { type: 'attack', stage: 0, target: best.id, forced: false, chase: true, next: 0, until: w.tick + 600 };
  // Nobody left to fight, or they're all behind walls: grab something and go.
  const loot = lootFor(w, p, raid.target);
  if (loot && (!anyTarget || w.rng.chance(0.3))) {
    w.reserve(rk.e(loot.id), p.id);
    return fleeJob(w, p, loot.id);
  }
  if (!anyTarget) return fleeJob(w, p);
  return { type: 'hold', stage: 0, until: w.tick + 300 };
}
