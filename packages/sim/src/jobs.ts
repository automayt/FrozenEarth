import { APPAREL, BUILDINGS, CONDITIONS, ITEMS, maxHp, PLANTS, RECIPES, ROCKS, T, WEAPON_KEYS, WEAPONS } from '@fe/defs';
import { dropWeapon, goTo, needsWarmth, pawnSpeed, pushOut, workSpeed } from './pawns';
import { addCondition, bedBound, effectsOf, inBed, needsTending } from './health';
import { hostileInReach, inReach, isRaider, strike, warmup } from './combat';
import { breakable, findPath, makePathState } from './pathfinding';
import { raiderGone, takePrisoner } from './raids';
import { damageBuilding, repairBuilding } from './siege';
import type { Building, Carried, Construct, Item, Job, Pawn, Plant } from './types';
import { DESIG } from './types';
import { caughtStealing, intruderNear } from './settlements';
import { raiderSetFire } from './raids';
import { canStealFrom, noticeTheft, theftPickupNoise, thiefCheck } from './stealth';
import { coverSpot, seeksCover, weaponFor } from './combat';
import { startFire } from './fire';
import { controlTick } from './control';
import type { World } from './world';

export type JobResult = 'continue' | 'done' | 'fail';

/** Ticks to sow one crop cell. */
export const SOW_WORK = 170;
/** Ticks spent eating. */
export const EAT_TICKS = 150;

export function runJob(w: World, p: Pawn): JobResult {
  const j = p.job!;
  switch (j.type) {
    case 'wander':
      return wander(w, p, j);
    case 'haul':
      return haul(w, p, j);
    case 'deliver':
      return deliver(w, p, j);
    case 'build':
      return build(w, p, j);
    case 'mine':
      return mine(w, p, j);
    case 'cut':
      return cut(w, p, j);
    case 'sow':
      return sow(w, p, j);
    case 'eat':
      return eat(w, p, j);
    case 'sleep':
      return sleep(w, p, j);
    case 'bill':
      return bill(w, p, j);
    case 'extinguish':
      return extinguish(w, p, j);
    case 'warm':
      return warm(w, p, j);
    case 'wear':
      return wear(w, p, j);
    case 'attack':
      return attack(w, p, j);
    case 'ignite': {
      const r = goTo(w, p, j.cell, true);
      if (r === 'moving') return 'continue';
      if (r === 'fail') return 'fail';
      if (startFire(w, j.cell)) raiderSetFire(w, p, j.cell);
      return 'done';
    }
    case 'control':
      return controlTick(w, p, j);
    case 'goto': {
      const r = goTo(w, p, j.dest, false);
      return r === 'moving' ? 'continue' : 'done';
    }
    case 'hold':
      if (j.until && w.tick >= j.until) return 'done';
      // Look around a few times a second, staggered across pawns.
      return (w.tick + p.id) % 20 === 0 && hostileInReach(w, p) ? 'done' : 'continue';
    case 'tend':
      return tend(w, p, j);
    case 'flee':
      return flee(w, p, j);
    case 'bash':
      return bash(w, p, j);
    case 'repair':
      return repair(w, p, j);
    case 'rescue':
      return rescue(w, p, j);
    case 'equip':
      return equip(w, p, j);
    case 'feed':
      return feed(w, p, j);
  }
}

function wear(w: World, p: Pawn, j: J<'wear'>): JobResult {
  const takeOff = () => {
    const old = p.apparel.find((k) => APPAREL[k]?.slot === j.slot);
    if (old) {
      p.apparel = p.apparel.filter((k) => k !== old);
      w.placeItemNear(old, 1, w.cellOf(p));
    }
  };
  if (!j.item) {
    takeOff();
    w.markDirty(p);
    return 'done';
  }
  const it = w.get<Item>(j.item);
  if (!it || it.kind !== 'item' || !APPAREL[it.def]) return 'fail';
  const r = goTo(w, p, w.cellOf(it), false);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  const def = it.def;
  w.takeFromItem(it, 1);
  takeOff();
  p.apparel.push(def);
  w.markDirty(p);
  return 'done';
}

function equip(w: World, p: Pawn, j: J<'equip'>): JobResult {
  if (!j.item) {
    dropWeapon(w, p);
    return 'done';
  }
  const it = w.get<Item>(j.item);
  if (!it || it.kind !== 'item' || !WEAPONS[it.def]) return 'fail';
  const r = goTo(w, p, w.cellOf(it), false);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  const def = it.def;
  w.takeFromItem(it, 1);
  dropWeapon(w, p);
  p.weapon = def;
  w.markDirty(p);
  return 'done';
}

// ---------------------------------------------------------------- combat

/** Walk toward a moving target, repathing only when it has strayed far from where we were heading. */
function chase(w: World, p: Pawn, goal: number): boolean {
  const here = w.cellOf(p);
  const ps = p.path;
  if (ps && ps.idx < ps.cells.length && w.dist(ps.goal, goal) <= Math.max(1, w.dist(here, goal) >> 2)) return true;
  const cells = findPath(w, here, goal, true, p.faction);
  if (!cells) return false;
  p.path = cells.length ? makePathState(w, here, cells, goal, true, pawnSpeed(w, p)) : null;
  w.markDirty(p);
  return true;
}

function attack(w: World, p: Pawn, j: J<'attack'>): JobResult {
  const t = w.get<Pawn>(j.target);
  if (!t || t.kind !== 'pawn' || t.faction === p.faction) return 'done';
  if (t.downed && !j.forced) return 'done';
  if (j.until && w.tick >= j.until) return 'done';
  const here = w.cellOf(p);
  const there = w.cellOf(t);
  if (inReach(w, weaponFor(p), here, there)) {
    // AI fighters get behind something before they open up.
    if (j.spot === undefined && seeksCover(p, t)) j.spot = coverSpot(w, p, there) ?? -1;
    if (j.spot !== undefined && j.spot >= 0 && j.spot !== here) {
      const r = goTo(w, p, j.spot, false);
      if (r === 'moving') return 'continue';
      j.spot = -1;
    }
    if (p.path) {
      p.path = null;
      w.markDirty(p);
    }
    if (j.stage === 0) {
      j.stage = 1;
      j.next = Math.max(j.next, warmup(w, p));
    }
    if (w.tick >= j.next) {
      strike(w, p, t);
      j.next = w.tick + weaponFor(p).cooldown;
    }
    return 'continue';
  }
  j.stage = 0;
  j.spot = undefined;
  if (!j.chase) return 'done';
  if (chase(w, p, there)) return 'continue';
  w.markUnreachable(p.faction, there);
  // Remember who: a moving target looks like a new one cell by cell, and a failed search is costly.
  p.giveUp = [t.id, w.tick + GIVE_UP_TICKS];
  // Holed up behind walls this faction can't get through: the whole room is out of reach for now,
  // not just the cell they happened to be standing in.
  const room = w.map.roomAt[there] ? w.rooms.get(w.map.roomAt[there]) : undefined;
  if (room) for (const c of room.cells) w.markUnreachable(p.faction, c);
  return 'fail';
}

/** Ticks of work to dress a patient's wounds. */
export const TEND_WORK = 240;

function tend(w: World, p: Pawn, j: J<'tend'>): JobResult {
  const pt = w.get<Pawn>(j.patient);
  if (!pt || pt.kind !== 'pawn' || !needsTending(pt)) return 'done';
  if (pt.id !== p.id && w.dist(w.cellOf(p), w.cellOf(pt)) > 1) {
    const r = goTo(w, p, w.cellOf(pt), true);
    return r === 'fail' ? 'fail' : 'continue';
  }
  const before = j.progress;
  j.progress += workSpeed(w, p);
  bumpProgress(w, p, before, j.progress, TEND_WORK);
  if (j.progress < TEND_WORK) return 'continue';
  // Patching yourself up is clumsier than having someone else do it.
  // A patient lying in bed is easier to treat properly.
  const quality = Math.max(0.2, Math.min(1, w.rng.range(0.55, 0.95) * Math.min(1.2, workSpeed(w, p)) * (pt.id === p.id ? 0.7 : 1) * (inBed(w, pt) ? 1.15 : 1)));
  for (const c of pt.conditions) if (c.tended === undefined && CONDITIONS[c.key]?.bleed) c.tended = Math.round(quality * 100) / 100;
  w.markDirty(pt);
  return 'done';
}

function flee(w: World, p: Pawn, j: J<'flee'>): JobResult {
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item' || p.carrying) {
      j.stage = 1;
      return 'continue';
    }
    const r = goTo(w, p, w.cellOf(it), false);
    if (r === 'fail') j.stage = 1;
    if (r !== 'arrived') return 'continue';
    pickUp(w, p, it, Math.min(it.count, ITEMS[it.def].stackLimit));
    j.stage = 1;
    return 'continue';
  }
  const r = goTo(w, p, j.dest, false);
  if (r === 'moving') return 'continue';
  // Off the map, or stuck with no way out, in which case they slip away all the same.
  const f = w.factions.get(p.faction);
  if (p.carrying && f?.raid) w.message(f.raid.target, `A raider escaped with ${p.carrying.count} ${ITEMS[p.carrying.def]?.label.toLowerCase() ?? p.carrying.def}.`, 'bad');
  p.carrying = null;
  w.despawn(p.id);
  raiderGone(w, p.faction, false);
  return 'done';
}

/** Smash the wall or door in the way, or (sappers) dig through the rock. */
/** How long an attacker leaves alone someone it couldn't find a way to. */
const GIVE_UP_TICKS = 2500;

/** How hard raiders without proper tools hit walls and doors, relative to sappers. */
const IMPROVISED_BREACH = 0.3;

function bash(w: World, p: Pawn, j: J<'bash'>): JobResult {
  const m = w.map;
  const b = m.buildingAt[j.cell] ? w.get<Building>(m.buildingAt[j.cell]) : undefined;
  const target = b && breakable(w, b, p.faction) && !w.passable(j.cell, p.faction) ? b : undefined;
  const rock = m.rock[j.cell];
  if ((!target && !rock) || w.tick >= j.until) return 'done';
  // Drop the hammer to fight anyone who shows up.
  if ((w.tick + p.id) % 20 === 0 && hostileInReach(w, p)) return 'done';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
    j.next = warmup(w, p);
  }
  if (target) {
    if (w.tick < j.next) return 'continue';
    const wd = weaponFor(p);
    j.next = w.tick + wd.cooldown;
    // Drawn as a melee swing, whatever they're holding.
    w.dirty.shots.push(p.id, target.id, p.x, p.y, target.x, target.y, 1, wd.melee ? Math.max(0, WEAPON_KEYS.indexOf(p.weapon)) : 0);
    // Without picks and hammers it's slow going: sappers come equipped, everyone else improvises.
    const tools = w.factions.get(p.faction)?.raid?.sapper ? 1 : IMPROVISED_BREACH;
    return damageBuilding(w, target, wd.structDamage * tools * w.rng.range(0.8, 1.2)) ? 'done' : 'continue';
  }
  j.progress += 0.8 * Math.max(0.1, effectsOf(w, p).work);
  if (j.progress < ROCKS[rock].mineWork) return 'continue';
  w.setRock(j.cell, 0);
  if (m.desig[j.cell]) w.setDesig(j.cell, 0, 0);
  return 'done';
}

/** Hit points mended per tick of work. */
export const REPAIR_RATE = 0.35;

function repair(w: World, p: Pawn, j: J<'repair'>): JobResult {
  const b = w.get<Building>(j.target);
  if (!b || b.kind !== 'building' || b.faction !== p.faction) return 'fail';
  const max = maxHp(b.def);
  if (b.hp >= max) return 'done';
  if (j.stage === 0) {
    const r = goTo(w, p, w.cellOf(b), true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const before = b.hp;
  if (repairBuilding(w, b, REPAIR_RATE * workSpeed(w, p, 'construction'))) return 'done';
  bumpProgress(w, b, before, b.hp, max);
  return 'continue';
}

/** Carry a downed pawn to a bed. Captured raiders become prisoners on arrival. */
function rescue(w: World, p: Pawn, j: J<'rescue'>): JobResult {
  const pt = w.get<Pawn>(j.patient);
  if (!pt || pt.kind !== 'pawn' || !pt.downed) return 'done';
  if (j.capture ? !isRaider(w, pt.faction) : pt.faction !== p.faction) return 'fail';
  const bed = w.get<Building>(j.bed);
  if (!bed || bed.kind !== 'building' || bed.faction !== p.faction || (bed.owner && bed.owner !== pt.id)) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, w.cellOf(pt), true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const r = goTo(w, p, w.cellOf(bed), false);
  // The patient is carried along.
  if (pt.x !== p.x || pt.y !== p.y) {
    pt.x = p.x;
    pt.y = p.y;
    w.markDirty(pt);
  }
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  if (j.capture) takePrisoner(w, pt, p);
  layInBed(w, pt, bed);
  return 'done';
}

/** Put a pawn to bed rest in a bed, claiming it. They stay there while downed and after, while they need rest. */
export function layInBed(w: World, p: Pawn, bed: Building): void {
  if (p.bed && p.bed !== bed.id) {
    const old = w.get<Building>(p.bed);
    if (old && old.kind === 'building' && old.owner === p.id) {
      old.owner = 0;
      w.markDirty(old);
    }
  }
  bed.owner = p.id;
  p.bed = bed.id;
  p.x = bed.x;
  p.y = bed.y;
  p.path = null;
  p.job = { type: 'sleep', stage: 1, bed: bed.id, cell: w.cellOf(bed), rest: true };
  p.asleep = true;
  w.markDirty(bed);
  w.markDirty(p);
}

/** Ticks of beating at a fire to knock it down one level. */
export const EXTINGUISH_WORK = 45;

function extinguish(w: World, p: Pawn, j: J<'extinguish'>): JobResult {
  if (!w.map.fire[j.cell]) return 'done';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  j.progress += workSpeed(w, p);
  if (j.progress < EXTINGUISH_WORK) return 'continue';
  j.progress = 0;
  w.setFire(j.cell, w.map.fire[j.cell] - 1);
  if (w.rng.chance(0.04)) addCondition(w, p, 'burns');
  return w.map.fire[j.cell] ? 'continue' : 'done';
}

function warm(w: World, p: Pawn, j: J<'warm'>): JobResult {
  if (j.stage === 0) {
    const r = goTo(w, p, j.dest, false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
    j.until = w.tick + 600;
  }
  if (w.tick >= j.until || !needsWarmth(w, p, effectsOf(w, p))) return 'done';
  return 'continue';
}

type J<K extends Job['type']> = Extract<Job, { type: K }>;

/** Mark dirty only when progress crosses a tenth, to keep deltas small. */
function bumpProgress(w: World, owner: Parameters<World['markDirty']>[0], before: number, after: number, total: number) {
  if (Math.floor((before / total) * 10) !== Math.floor((after / total) * 10)) w.markDirty(owner);
}

function pickUp(w: World, p: Pawn, it: Item, n: number): void {
  const rot = it.rot;
  const def = it.def;
  const got = w.takeFromItem(it, n);
  p.carrying = { def, count: got, rot };
  w.markDirty(p);
}

function wander(w: World, p: Pawn, j: J<'wander'>): JobResult {
  // Settlers glance up from their pottering a couple of times a second.
  if ((w.tick + p.id) % 30 === 0 && intruderNear(w, p)) return 'done';
  if (j.stage === 0) {
    const r = goTo(w, p, j.dest, false);
    if (r === 'fail') return 'done';
    if (r === 'arrived') {
      j.stage = 1;
      j.until = w.tick + 120 + w.rng.int(240);
    }
    return 'continue';
  }
  return w.tick >= j.until ? 'done' : 'continue';
}

/**
 * A thief on the way out with someone's goods: footsteps carry, and anyone awake who sees them
 * raises the alarm. Caught by a colony, the thief drops the goods ('dropped'); a settlement's
 * guards deal with thieves themselves.
 */
export function theftTick(w: World, p: Pawn, j: { stolen?: number; stolenAt?: number }): 'ok' | 'dropped' {
  if (!j.stolen || !p.carrying || (w.tick + p.id) % 15 !== 0) return 'ok';
  const victim = j.stolen;
  const verdict = thiefCheck(w, p, victim, j.stolenAt ?? w.cellOf(p), () => caughtStealing(w, victim, p.faction));
  if (verdict === 'clear') {
    noticeTheft(w, victim, p.carrying.def, p.carrying.count, j.stolenAt ?? w.cellOf(p));
    j.stolen = undefined;
  } else if (verdict === 'caught') {
    j.stolen = undefined;
    if (w.factions.get(victim)?.isPlayer) {
      w.placeItemNear(p.carrying.def, p.carrying.count, w.cellOf(p), p.carrying.rot);
      p.carrying = null;
      w.markDirty(p);
      return 'dropped';
    }
  }
  return 'ok';
}

function haul(w: World, p: Pawn, j: J<'haul'>): JobResult {
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const cell = w.cellOf(it);
    const r = goTo(w, p, cell, false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    const owner = w.zoneAt(cell)?.faction ?? 0;
    pickUp(w, p, it, Math.min(it.count, w.roomFor(j.dest, it.def) || ITEMS[it.def].stackLimit));
    // Ordinary hauling never touches another faction's stockpile, so this is theft.
    if (canStealFrom(w, p.faction, owner)) {
      j.stolen = owner;
      j.stolenAt = cell;
      if (!w.map.itemAt[cell] && w.map.desig[cell] === DESIG.steal) w.setDesig(cell, 0, 0);
      theftPickupNoise(w, p, owner);
    }
    j.stage = 1;
    return 'continue';
  }
  if (theftTick(w, p, j) === 'dropped') return 'done';
  const r = goTo(w, p, j.dest, false);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  const c = p.carrying!;
  if (j.stolen) noticeTheft(w, j.stolen, c.def, c.count, j.stolenAt ?? j.dest);
  const placed = w.dropInto(j.dest, c.def, c.count, c.rot);
  if (placed < c.count) w.placeItemNear(c.def, c.count - placed, j.dest, c.rot);
  p.carrying = null;
  w.markDirty(p);
  return 'done';
}

function deliver(w: World, p: Pawn, j: J<'deliver'>): JobResult {
  const con = w.get<Construct>(j.target);
  if (!con || con.kind !== 'construct') return 'fail';
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, j.count);
    j.stage = 1;
    return 'continue';
  }
  const r = goTo(w, p, w.cellOf(con), true);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  const c = p.carrying!;
  const need = (BUILDINGS[con.def].cost[c.def] ?? 0) - (con.delivered[c.def] ?? 0);
  const put = Math.max(0, Math.min(need, c.count));
  con.delivered[c.def] = (con.delivered[c.def] ?? 0) + put;
  c.count -= put;
  if (c.count > 0) w.placeItemNear(c.def, c.count, w.cellOf(p), c.rot);
  p.carrying = null;
  w.markDirty(p);
  w.markDirty(con);
  return 'done';
}

export function fullyDelivered(con: Construct): boolean {
  const cost = BUILDINGS[con.def].cost;
  for (const k in cost) if ((con.delivered[k] ?? 0) < cost[k]) return false;
  return true;
}

function build(w: World, p: Pawn, j: J<'build'>): JobResult {
  const con = w.get<Construct>(j.target);
  if (!con || con.kind !== 'construct' || !fullyDelivered(con)) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, w.cellOf(con), true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const total = BUILDINGS[con.def].work;
  const before = con.progress;
  con.progress += workSpeed(w, p, 'construction');
  bumpProgress(w, con, before, con.progress, total);
  if (con.progress < total) return 'continue';
  completeConstruct(w, con);
  return 'done';
}

export function completeConstruct(w: World, con: Construct): Building | null {
  const d = BUILDINGS[con.def];
  const m = w.map;
  const cell = w.cellOf(con);
  w.despawn(con.id);
  if (d.floorTerrain) {
    w.setTerrain(cell, T[d.floorTerrain]);
    return null;
  }
  if (m.plantAt[cell]) w.despawn(m.plantAt[cell]);
  const b = w.spawnBuilding(con.def, cell, con.faction);
  if (d.blocksMovement) {
    const itemId = m.itemAt[cell];
    if (itemId) {
      const it = w.get<Item>(itemId)!;
      w.despawn(itemId);
      w.placeItemNear(it.def, it.count, cell, it.rot);
    }
    for (const id of w.kinds.pawn) {
      const p = w.get<Pawn>(id)!;
      if (p.x === con.x && p.y === con.y) pushOut(w, p);
    }
  }
  return b;
}

function mine(w: World, p: Pawn, j: J<'mine'>): JobResult {
  const m = w.map;
  const rock = m.rock[j.cell];
  if (!rock || m.desig[j.cell] !== DESIG.mine) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const rd = ROCKS[rock];
  j.progress += workSpeed(w, p, 'mining');
  if (j.progress < rd.mineWork) return 'continue';
  w.setRock(j.cell, 0);
  w.setDesig(j.cell, 0, 0);
  if (rd.yieldItem && w.rng.chance(0.85)) w.placeItemNear(rd.yieldItem, rd.yieldCount, j.cell);
  return 'done';
}

function cut(w: World, p: Pawn, j: J<'cut'>): JobResult {
  const plant = w.get<Plant>(j.target);
  if (!plant || plant.kind !== 'plant') return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, w.cellOf(plant), true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  const def = PLANTS[plant.def];
  j.progress += workSpeed(w, p, 'plants');
  if (j.progress < def.work) return 'continue';
  harvestPlant(w, plant, j.harvest);
  return 'done';
}

export function harvestPlant(w: World, plant: Plant, harvest: boolean): void {
  const def = PLANTS[plant.def];
  const cell = w.cellOf(plant);
  const gives = def.yieldItem && plant.growth >= def.harvestMin && !plant.blighted && (def.tree || def.sowable || harvest);
  if (gives) {
    const count = Math.max(1, Math.round(def.yieldCount! * (def.tree ? plant.growth : 1)));
    w.placeItemNear(def.yieldItem!, count, cell);
  }
  if (harvest && def.regrows) {
    plant.growth = 0.2;
    w.markDirty(plant);
    w.setDesig(cell, 0, 0);
  } else {
    w.despawn(plant.id);
  }
}

function sow(w: World, p: Pawn, j: J<'sow'>): JobResult {
  const z = w.zoneAt(j.cell);
  if (!z || z.kind !== 'grow' || z.faction !== p.faction || w.map.plantAt[j.cell]) return 'fail';
  if (j.stage === 0) {
    const r = goTo(w, p, j.cell, false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    j.stage = 1;
  }
  j.progress += workSpeed(w, p, 'plants');
  if (j.progress < SOW_WORK) return 'continue';
  w.spawnPlant(j.plant, j.cell, 0.05);
  return 'done';
}

function eat(w: World, p: Pawn, j: J<'eat'>): JobResult {
  if (j.stage === 0) {
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, j.count);
    j.stage = 1;
    return 'continue';
  }
  j.progress++;
  if (j.progress < EAT_TICKS) return 'continue';
  if (p.carrying) consume(w, p, p.carrying);
  p.carrying = null;
  w.markDirty(p);
  return 'done';
}

/** `eater` eats `c`. Rotten food (and, rarely, raw food) can make people sick. */
function consume(w: World, eater: Pawn, c: Carried): void {
  const def = ITEMS[c.def];
  eater.needs.food = Math.min(1, eater.needs.food + (def.nutrition ?? 0) * c.count);
  const risk = c.rot > 0.5 ? 0.35 : def.category === 'raw_food' ? 0.02 : 0;
  if (risk && w.rng.chance(risk) && addCondition(w, eater, 'food_poisoning')) {
    w.message(eater.faction, `${eater.name} got food poisoning from ${c.rot > 0.5 ? 'rotting' : 'raw'} ${def.label.toLowerCase()}.`, 'bad', w.cellOf(eater));
  }
  w.markDirty(eater);
}

/** Fetch food for a patient who can't get up, then feed it to them. */
function feed(w: World, p: Pawn, j: J<'feed'>): JobResult {
  const pt = w.get<Pawn>(j.patient);
  if (!pt || pt.kind !== 'pawn' || pt.faction !== p.faction) return 'done';
  if (j.stage === 0) {
    if (!bedBound(w, pt)) return 'done';
    const it = w.get<Item>(j.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, j.count);
    j.stage = 1;
    return 'continue';
  }
  // Food in hand: a prisoner who got up meanwhile still gets it.
  if (!p.carrying || (!pt.downed && pt.prisoner !== 'held')) return 'done';
  const r = goTo(w, p, w.cellOf(pt), true);
  if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
  j.progress++;
  if (j.progress < EAT_TICKS) return 'continue';
  consume(w, pt, p.carrying);
  p.carrying = null;
  w.markDirty(p);
  return 'done';
}

function sleep(w: World, p: Pawn, j: J<'sleep'>): JobResult {
  if (j.stage === 0) {
    if (j.bed && !w.get(j.bed)) return 'fail';
    const r = goTo(w, p, j.cell, false);
    if (r === 'fail') {
      // Can't reach the bed; sleep where we stand.
      j.bed = 0;
      j.cell = w.cellOf(p);
      return 'continue';
    }
    if (r !== 'arrived') return 'continue';
    j.stage = 1;
    p.asleep = true;
    w.markDirty(p);
    return 'continue';
  }
  if (p.needs.food < 0.08) return 'done';
  if (j.rest) {
    // Bed rest lasts while a condition calls for it. Check now and then, not every tick.
    if (w.tick % 60 === p.id % 60 && !effectsOf(w, p).bedRest) return 'done';
    return 'continue';
  }
  // Settlers keep to the village's hours: abed until morning.
  if (w.isNight() && w.factions.get(p.faction)?.settlement) return 'continue';
  if (p.needs.rest >= 1) return 'done';
  if (!w.isNight() && p.needs.rest > 0.95) return 'done';
  return 'continue';
}

function bill(w: World, p: Pawn, j: J<'bill'>): JobResult {
  const bench = w.get<Building>(j.bench);
  if (!bench || bench.kind !== 'building' || bench.faction !== p.faction) return 'fail';
  const b = bench.bills.find((x) => x.id === j.bill);
  if (!b) return 'fail';
  const recipe = RECIPES[b.recipe];
  const benchCell = w.cellOf(bench);
  if (j.stage === 0) {
    // Fetch the next ingredient.
    if (j.sources.length === 0) {
      j.stage = 2;
      return 'continue';
    }
    const src = j.sources[0];
    const it = w.get<Item>(src.item);
    if (!it || it.kind !== 'item') return 'fail';
    const r = goTo(w, p, w.cellOf(it), false);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    pickUp(w, p, it, src.count);
    j.stage = 1;
    return 'continue';
  }
  if (j.stage === 1 || j.stage === 2) {
    const r = goTo(w, p, benchCell, true);
    if (r !== 'arrived') return r === 'fail' ? 'fail' : 'continue';
    if (j.stage === 1) {
      if (p.carrying) j.gathered.push(p.carrying);
      p.carrying = null;
      j.sources.shift();
      j.stage = 0;
      w.markDirty(p);
      return 'continue';
    }
    j.stage = 3;
  }
  j.progress += workSpeed(w, p, recipe.workType === 'cook' ? 'cooking' : 'crafting');
  if (j.progress < recipe.work) return 'continue';
  j.gathered = [];
  w.placeItemNear(recipe.product.item, recipe.product.count, benchCell);
  if (b.mode === 'count') {
    b.target--;
    if (b.target <= 0) bench.bills = bench.bills.filter((x) => x.id !== b.id);
  }
  w.markDirty(bench);
  return 'done';
}
