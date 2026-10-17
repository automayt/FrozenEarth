import { BUILDINGS, DEFAULT_PRIORITY, ITEMS, START_PRIORITY, WEAPONS, WORK_TYPES } from '@fe/defs';
import { RARE_TICK, TICKS_PER_DAY } from './constants';
import { endJob } from './pawns';
import { maybeReachable } from './pathfinding';
import { pawnName } from './names';
import { breachJob } from './siege';
import { shiftGoodwill } from './settlements';
import { cellDistance, coverAgainst, gaveUpOn, hostileInReach } from './combat';
import { fuelAt } from './fire';
import type { Building, Faction, Item, Job, Pawn, RaidGoal, RaidState } from './types';
import { rk, type World } from './world';

export type RaidKind = 'raid' | 'night' | 'scout' | 'sapper';

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
  sapper: [
    ['club', 3],
    ['rifle', 2],
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
  // Walled in or dug into a mountain: come anyway, and break in.
  for (const side of sides) {
    for (let t = 0; t < side.len; t++) {
      const c = side.at((side.along + (t >> 1) * (t & 1 ? -1 : 1) + side.len) % side.len);
      if (!m.solid[c]) return c;
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
  if (!f || !(f.isPlayer || f.settlement?.state === 'home') || !pawnsOf(w, target).length) return null;
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
  rf.raid!.sapper = kind === 'sapper';
  rf.raid!.breakAt = kind === 'scout' ? 1 : Math.max(1, Math.ceil(raiders.length / 2));
  const what =
    kind === 'scout'
      ? `A scouting party of ${rf.name.replace('Raiders of ', '')} (${raiders.length}) is probing your defences from the ${sideName(w, arrive)}.`
      : kind === 'night'
        ? `${rf.name} (${raiders.length}, knives and clubs) are creeping in from the ${sideName(w, arrive)} under cover of dark!`
        : kind === 'sapper'
          ? `${rf.name} (${raiders.length}) have come from the ${sideName(w, arrive)} with picks and hammers. They will dig and smash their way in!`
          : `${rf.name} (${raiders.length}) have arrived from the ${sideName(w, arrive)} edge to attack you!`;
  if (f.isPlayer) w.message(target, `${what} Draft your colonists (R) and right-click to fight.`, 'bad', arrive);
  else raidNews(w, rf.raid!, `${rf.name} (${raiders.length}) are attacking ${f.name}! Help them hold out, and they'll remember it.`, 'bad', m.idx(f.home.x, f.home.y));
  return raiders;
}

/**
 * Raid news goes to the colony being raided; when it's a settlement, to every colony that knows
 * them (they might come and help).
 */
function raidNews(w: World, raid: RaidState, text: string, tone: 'good' | 'neutral' | 'bad', at?: number): void {
  const f = w.factions.get(raid.target);
  if (!f) return;
  if (f.isPlayer) {
    w.message(raid.target, text, tone, at);
    return;
  }
  for (const p of f.settlement?.met ?? []) w.message(p, text, tone === 'good' ? 'neutral' : tone, at);
}

/** A colony's colonist hurt a raider who's attacking a settlement. */
export function helpedDefend(w: World, raider: Pawn, helper: Pawn, dmg: number): void {
  const raid = w.factions.get(raider.faction)?.raid;
  if (!raid || !w.factions.get(raid.target)?.settlement || !w.factions.get(helper.faction)?.isPlayer) return;
  raid.helpers ??= {};
  raid.helpers[helper.faction] = (raid.helpers[helper.faction] ?? 0) + dmg;
}

/** The raid on a settlement is over: thank those who helped. */
function thankHelpers(w: World, raid: RaidState): void {
  const f = w.factions.get(raid.target);
  if (!f?.settlement || !raid.helpers) return;
  for (const [faction, dmg] of Object.entries(raid.helpers)) {
    if (dmg < 0.1) continue;
    shiftGoodwill(w, f, Number(faction), Math.min(30, Math.round(8 + dmg * 12)));
    w.message(Number(faction), `${f.name} thanks you for helping drive off the raiders.`, 'good', w.map.idx(f.home.x, f.home.y));
  }
  raid.helpers = {};
}

function breakRaid(w: World, f: Faction, why: string): void {
  const raid = f.raid!;
  if (raid.fled) return;
  raid.fled = true;
  w.dirty.factions.add(f.id);
  raidNews(w, raid, why, 'good');
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
    const t = w.factions.get(f.raid.target);
    raidNews(w, f.raid, t?.settlement ? `${f.name} are gone. ${t.name} has held out.` : `${f.name} are gone. The raid is over.`, 'neutral');
    thankHelpers(w, f.raid);
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

export function fleeJob(w: World, p: Pawn, item = 0): Job {
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
  switch (raid.goal ?? 'assault') {
    case 'loot':
      return lootThink(w, p, raid);
    case 'burn':
      return burnThink(w, p, raid);
    case 'siege':
      return siegeThink(w, p, raid);
    default:
      return assaultThink(w, p, raid);
  }
}

/** Go for the colonists; break in if they're walled up. */
function assaultThink(w: World, p: Pawn, raid: RaidState): Job {
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestScore = Infinity;
  let anyTarget = false;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.downed || o.prisoner || (o.faction !== raid.target && !w.factions.get(o.faction)?.isPlayer)) continue;
    const c = w.cellOf(o);
    // The people they came for first; others only if they're in the way.
    const score = w.dist(here, c) + (o.faction === raid.target ? 0 : 25);
    if (o.faction === raid.target) anyTarget = true;
    if (score >= bestScore || gaveUpOn(w, p, o) || w.isUnreachable(p.faction, c) || !maybeReachable(w, here, c, true)) continue;
    best = o;
    bestScore = score;
  }
  if (best) return { type: 'attack', stage: 0, target: best.id, forced: false, chase: true, next: 0, until: w.tick + 600 };
  // They're all behind walls: break in.
  if (anyTarget) {
    // A couple of them break in; the rest find cover and shoot at whatever shows.
    if (breachers(w, p.faction) < MAX_BREACHERS) {
      const breach = breachJob(w, p, raid);
      if (breach) return breach;
    } else return siegeThink(w, p, raid);
  }
  // Nobody left to fight, or no way in at all: grab something and go.
  const loot = lootFor(w, p, raid.target);
  if (loot && (!anyTarget || w.rng.chance(0.3))) {
    w.reserve(rk.e(loot.id), p.id);
    return fleeJob(w, p, loot.id);
  }
  if (!anyTarget) return fleeJob(w, p);
  return { type: 'hold', stage: 0, until: w.tick + 300 };
}

// ---------------------------------------------------------------- prisoners

/** Chance per rare tick that a content prisoner agrees to join; about one in three days. */
const RECRUIT_CHANCE = RARE_TICK / (TICKS_PER_DAY * 3);

/** A downed raider, carried to a bed by `captor`, is now held by the captor's colony. */
export function takePrisoner(w: World, p: Pawn, captor: Pawn): void {
  const old = p.faction;
  if (p.carrying) {
    w.placeItemNear(p.carrying.def, p.carrying.count, w.cellOf(p), p.carrying.rot);
    p.carrying = null;
  }
  p.faction = captor.faction;
  p.prisoner = 'held';
  p.drafted = false;
  for (const k of WORK_TYPES) p.priorities[k] = 0;
  p.needs.mood = 0.4;
  w.markDirty(p);
  w.message(captor.faction, `${captor.name} has taken ${p.name} prisoner. In time they may agree to join you, or you can let them go.`, 'good', w.cellOf(p));
  raiderGone(w, old, true);
}

/** Slow-tick prisoner update: a prisoner who is up and about may come round to joining. */
export function prisonerTick(w: World, p: Pawn): void {
  if (p.prisoner !== 'held' || p.downed) return;
  if (!w.rng.chance(RECRUIT_CHANCE * (0.5 + p.needs.mood))) return;
  p.prisoner = '';
  for (const k of WORK_TYPES) p.priorities[k] = START_PRIORITY[k] ?? DEFAULT_PRIORITY;
  endJob(w, p);
  w.message(p.faction, `${p.name} has given up the raiding life and joined the colony.`, 'good', w.cellOf(p));
}

/** Set a prisoner free: they walk off the map. */
export function releasePrisoner(w: World, p: Pawn): void {
  if (p.prisoner !== 'held') return;
  p.prisoner = 'leaving';
  endJob(w, p);
  w.message(p.faction, `${p.name} has been released and is leaving.`, 'neutral', w.cellOf(p));
}

// ---------------------------------------------------------------- shifting goals

/** Raiders smashing at walls at once; the rest give covering fire. */
const MAX_BREACHERS = 2;

function breachers(w: World, faction: number): number {
  let n = 0;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && p.job?.type === 'bash') n++;
  }
  return n;
}

/** How often a raid takes stock, in ticks. */
const REVIEW_TICKS = RARE_TICK;
/** Ticks an assault keeps at it without downing a single defender before trying something else. */
const ASSAULT_PATIENCE = 6000;
/** Most fires one raid will set. */
const MAX_FIRES = 4;

const GOAL_NEWS: Record<RaidGoal, (name: string) => string> = {
  assault: (n) => `${n} smell blood: they're storming in!`,
  loot: (n) => `${n} can't break your defences. They're turning to loot whatever lies outside your walls.`,
  burn: (n) => `${n} are setting fire to your fields and outbuildings!`,
  siege: (n) => `${n} have dug in out of reach to wait you out. Anyone who shows themselves will be shot.`,
};

function standing(w: World, faction: number): number {
  let n = 0;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && !p.downed && !p.prisoner) n++;
  }
  return n;
}

/** Things worth burning: the colony's crops, and its buildings out in the open. */
function burnTargets(w: World, target: number): number[] {
  const out: number[] = [];
  for (const z of w.zones.values()) {
    if (z.faction !== target || z.kind !== 'grow') continue;
    for (const c of z.cells) if (w.map.plantAt[c] && !w.map.fire[c]) out.push(c);
  }
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    const c = w.cellOf(b);
    if (b.faction === target && !w.map.roomAt[c] && !w.map.fire[c] && fuelAt(w, c) === 'building') out.push(c);
  }
  return out;
}

function lootLeft(w: World, faction: number, target: number): boolean {
  const any = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).find((p) => p.faction === faction && !p.downed);
  return !!any && !!lootFor(w, any, target);
}

function setGoal(w: World, f: Faction, goal: RaidGoal): void {
  const raid = f.raid!;
  if ((raid.goal ?? 'assault') === goal) return;
  raid.goal = goal;
  raid.goalSince = w.tick;
  raid.foes = standing(w, raid.target);
  w.dirty.factions.add(f.id);
  const t = w.factions.get(raid.target);
  raidNews(w, raid, t?.settlement ? `${GOAL_NEWS[goal](f.name).replace(/your /g, `${t.name}'s `).replace(/ you\b/g, ` ${t.name}`)}` : GOAL_NEWS[goal](f.name), 'bad');
  // Everyone drops what they were doing and acts on the new plan.
  for (const p of pawnsOf(w, f.id)) if (!p.downed && p.job?.type !== 'flee') endJob(w, p);
}

/** If the fight isn't going their way, try something else; if it's going too well, press on. */
function fallback(w: World, f: Faction, raiders: number): void {
  const raid = f.raid!;
  if (lootLeft(w, f.id, raid.target)) setGoal(w, f, 'loot');
  else if ((raid.fires ?? 0) < MAX_FIRES && burnTargets(w, raid.target).length) setGoal(w, f, 'burn');
  else if (raiders >= 2) setGoal(w, f, 'siege');
  else breakRaid(w, f, `${f.name} have had enough and are leaving.`);
}

/**
 * Every few seconds each raid takes stock: how many are still standing on each side, and who's
 * been getting the worse of the exchange lately. Defenders dug in behind good cover make an
 * assault expensive, so the raid turns to easier pickings; defenders who crumble invite a storm.
 */
export function reviewRaids(w: World): void {
  if (w.tick % REVIEW_TICKS !== 0) return;
  for (const f of w.factions.values()) {
    const raid = f.raid;
    if (!raid || raid.fled) continue;
    const raiders = standing(w, f.id);
    if (!raiders) continue;
    const defenders = standing(w, raid.target);
    const dealt = raid.dealt ?? 0;
    const taken = raid.taken ?? 0;
    // Recent blows count most.
    raid.dealt = dealt * 0.97;
    raid.taken = taken * 0.97;
    const since = w.tick - (raid.goalSince ?? raid.until - Math.round(TICKS_PER_DAY * 1.2));
    const losing = taken > dealt * 1.6 + 0.35;
    const winning = defenders === 0 || dealt > taken * 1.5 + 0.35;
    const goal = raid.goal ?? 'assault';
    if (goal !== 'assault' && winning && raiders >= Math.max(1, defenders)) {
      setGoal(w, f, 'assault');
      continue;
    }
    switch (goal) {
      case 'assault': {
        // Bleeding for nothing, unable to land a blow on people holed up, or hours gone without
        // downing anyone: change plan.
        raid.foes ??= defenders;
        const stalled = since > ASSAULT_PATIENCE && defenders >= raid.foes;
        if ((since > 1500 && losing) || (since > 4000 && dealt < 0.05 && defenders > 0) || stalled) fallback(w, f, raiders);
        break;
      }
      case 'loot':
        if (since > 5000 || !lootLeft(w, f.id, raid.target)) {
          if ((raid.fires ?? 0) < MAX_FIRES && burnTargets(w, raid.target).length) setGoal(w, f, 'burn');
          else if (raiders >= 2 && !losing) setGoal(w, f, 'siege');
          else breakRaid(w, f, `${f.name} are making off with what they could grab.`);
        }
        break;
      case 'burn':
        if (since > 3000 || (raid.fires ?? 0) >= MAX_FIRES || !burnTargets(w, raid.target).length) {
          if (raiders >= 2 && !losing) setGoal(w, f, 'siege');
          else breakRaid(w, f, `${f.name} are leaving your colony to burn.`);
        }
        break;
      case 'siege':
        if (since > 9000 || losing) breakRaid(w, f, `${f.name} have given up the siege.`);
        break;
    }
  }
}

/** Grab something from the colony's stockpiles and make off with it; fight only if cornered. */
function lootThink(w: World, p: Pawn, raid: RaidState): Job {
  if (p.carrying) return fleeJob(w, p);
  const t = hostileInReach(w, p);
  if (t && w.dist(w.cellOf(p), w.cellOf(t)) <= 4) return { type: 'attack', stage: 0, target: t.id, forced: false, chase: false, next: 0, until: w.tick + 200 };
  const loot = lootFor(w, p, raid.target);
  if (loot) {
    w.reserve(rk.e(loot.id), p.id);
    return fleeJob(w, p, loot.id);
  }
  return siegeThink(w, p, raid);
}

/** Torch the nearest crop or outbuilding; shoot back if fired on. */
function burnThink(w: World, p: Pawn, raid: RaidState): Job {
  const t = hostileInReach(w, p);
  if (t) return { type: 'attack', stage: 0, target: t.id, forced: false, chase: false, next: 0, until: w.tick + 300 };
  if ((raid.fires ?? 0) >= MAX_FIRES) return siegeThink(w, p, raid);
  const here = w.cellOf(p);
  let best = -1;
  let bestD = Infinity;
  for (const c of burnTargets(w, raid.target)) {
    const d = w.dist(here, c);
    if (d < bestD && !w.reservedByOther(rk.c(c), p.id) && maybeReachable(w, here, c, true)) {
      bestD = d;
      best = c;
    }
  }
  if (best < 0) return siegeThink(w, p, raid);
  w.reserve(rk.c(best), p.id);
  return { type: 'ignite', stage: 0, cell: best };
}

/** A raider set a fire. */
export function raiderSetFire(w: World, p: Pawn, cell: number): void {
  const f = w.factions.get(p.faction);
  const raid = f?.raid;
  if (!f || !raid) return;
  raid.fires = (raid.fires ?? 0) + 1;
  if (raid.fires === 1) w.message(raid.target, `${p.name} of ${f.name} has started a fire!`, 'bad', cell);
}

/**
 * Dig in: a spot out in the open some way from the colony with cover facing it, then shoot
 * anyone in reach without leaving it.
 */
function siegeThink(w: World, p: Pawn, raid: RaidState): Job {
  const t = hostileInReach(w, p);
  if (t) return { type: 'attack', stage: 0, target: t.id, forced: false, chase: false, next: 0, until: w.tick + 300 };
  const f = w.factions.get(raid.target);
  if (!f) return fleeJob(w, p);
  const m = w.map;
  const home = m.idx(f.home.x, f.home.y);
  const here = w.cellOf(p);
  // Already dug in?
  const d0 = cellDistance(w, here, home);
  if (d0 >= 10 && d0 <= 20 && !m.roomAt[here] && coverAgainst(w, home, here) >= 0.25) return { type: 'hold', stage: 0, until: w.tick + 400 };
  let best = -1;
  let bestScore = -Infinity;
  for (let k = 0; k < 40; k++) {
    const a = w.rng.next() * Math.PI * 2;
    const r = 11 + w.rng.int(8);
    const x = Math.round(f.home.x + Math.cos(a) * r);
    const y = Math.round(f.home.y + Math.sin(a) * r);
    if (!m.inBounds(x, y)) continue;
    const c = m.idx(x, y);
    if (!w.passable(c, p.faction) || m.roomAt[c] || !maybeReachable(w, here, c, false)) continue;
    const score = coverAgainst(w, home, c) * 3 - cellDistance(w, here, c) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best < 0) return { type: 'hold', stage: 0, until: w.tick + 300 };
  return { type: 'goto', stage: 0, dest: best };
}
