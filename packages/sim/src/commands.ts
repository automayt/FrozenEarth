import { BUILDINGS, ITEM_CATEGORIES, ITEMS, PLANTS, RECIPES, TERRAINS, WEAPONS, WORK_TYPES } from '@fe/defs';
import { MAX_COMMAND_AREA } from './constants';
import type { Building, Command, Construct, EntityId, Item, Pawn, Plant, Rect, Zone } from './types';
import { canUseItem, endJob, setDrafted } from './pawns';
import { isRaider } from './combat';
import { releasePrisoner } from './raids';
import { bedFor, findStorageCell } from './work';
import { DESIG } from './types';
import { NEIGHBORS4, rk, unreachableKey, type World } from './world';
import { resolveChoice } from './choices';
import { siteProblem } from './setup';
import { offerTrade } from './trade';
import { deliverRequest, settlementTrade } from './settlements';
import { canStealFrom } from './stealth';
import { interact, setPossessed } from './control';
import { markHunt } from './wildlife';

// ---------------------------------------------------------------- wire validation

/** Fields that must be plain finite numbers when present. */
const NUM_FIELDS = ['x', 'y', 'x0', 'y0', 'x1', 'y1', 'pawn', 'prio', 'zone', 'bench', 'target', 'bill', 'choice', 'to', 'settlement', 'request', 'item', 'dx', 'dy'];
/** Fields that must be strings when present. */
const STR_FIELDS = ['kind', 'def', 'plant', 'work', 'mode', 'recipe', 'option', 'note'];
const DESIGNATE_KINDS = ['mine', 'chop', 'cut', 'harvest', 'steal', 'cancel'];
const ZONE_KINDS = ['stockpile', 'grow'];

const has = (table: object, key: unknown): boolean => typeof key === 'string' && Object.hasOwn(table, key);

function tradeLines(v: unknown): boolean {
  return Array.isArray(v) && v.length <= 8 && v.every((l) => Array.isArray(l) && has(ITEMS, l[0]) && typeof l[1] === 'number' && Number.isFinite(l[1]));
}

/**
 * Commands arrive straight off the wire, so anything can be in them. True only when every field
 * has the type the command needs: numbers that are finite, names that are real keys of their
 * table (not "__proto__" or "constructor"), id lists of numbers. Everything else is dropped
 * before it reaches the game rules, which can then use the fields as typed.
 */
export function wellFormed(cmd: unknown): cmd is Command {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return false;
  const o = cmd as Record<string, unknown>;
  if (typeof o.c !== 'string') return false;
  for (const k of NUM_FIELDS) if (o[k] != null && (typeof o[k] !== 'number' || !Number.isFinite(o[k]))) return false;
  for (const k of STR_FIELDS) if (o[k] != null && typeof o[k] !== 'string') return false;
  if (o.pawns != null && !(Array.isArray(o.pawns) && o.pawns.every((id) => typeof id === 'number'))) return false;
  if (o.allow != null && !(Array.isArray(o.allow) && o.allow.every((a) => typeof a === 'string'))) return false;
  for (const k of ['give', 'want']) if (o[k] != null && !tradeLines(o[k])) return false;
  switch (o.c) {
    case 'designate':
      return DESIGNATE_KINDS.includes(o.kind as string);
    case 'build':
      return has(BUILDINGS, o.def);
    case 'zone':
      return ZONE_KINDS.includes(o.kind as string);
    case 'addBill':
      return has(RECIPES, o.recipe);
    case 'setPriority':
      return has(WORK_TYPE_SET, o.work) && typeof o.prio === 'number';
  }
  return true;
}

const WORK_TYPE_SET = Object.fromEntries(WORK_TYPES.map((k) => [k, true]));

/** Validate and apply one player command. Invalid commands are silently ignored. */
export function applyCommand(w: World, faction: number, cmd: Command): void {
  if (!w.factions.has(faction) || !wellFormed(cmd)) return;
  switch (cmd.c) {
    case 'designate':
      return designate(w, faction, cmd.kind, cmd);
    case 'build':
      return build(w, faction, cmd.def, cmd.hollow, cmd);
    case 'zone':
      return zone(w, faction, cmd.kind, cmd.plant, cmd);
    case 'unzone':
      for (const c of rectCells(w, cmd)) {
        const z = w.zoneAt(c);
        if (z && z.faction === faction) w.removeZoneCell(c);
      }
      return;
    case 'deconstruct':
      return deconstruct(w, faction, cmd);
    case 'packUp':
      for (const c of rectCells(w, cmd)) {
        const z = w.zoneAt(c);
        if (z && z.faction === faction) w.removeZoneCell(c);
      }
      deconstruct(w, faction, cmd);
      designate(w, faction, 'cancel', cmd);
      return;
    case 'setHome': {
      const f = w.factions.get(faction)!;
      const x = Math.round(Number(cmd.x));
      const y = Math.round(Number(cmd.y));
      if (!w.map.inBounds(x, y)) return;
      const problem = siteProblem(w, x, y, faction);
      if (problem) {
        w.message(faction, `Can't move the colony there: ${problem}`, 'neutral');
        return;
      }
      f.home = { x, y };
      w.dirty.factions.add(faction);
      // Frost warnings start over for the new site.
      if (w.story.frostNotice) w.story.frostNotice[faction] = 0;
      w.message(faction, `Your colony's new home is set. Colonists will gather there. Build a stockpile and pack up the old site so haulers bring everything over.`, 'good', w.map.idx(x, y));
      return;
    }
    case 'setPriority': {
      const p = w.get<Pawn>(cmd.pawn);
      if (!p || p.kind !== 'pawn' || p.faction !== faction || !WORK_TYPES.includes(cmd.work)) return;
      p.priorities[cmd.work] = Math.max(0, Math.min(4, Math.round(cmd.prio)));
      w.markDirty(p);
      return;
    }
    case 'zoneSettings': {
      const z = w.zones.get(cmd.zone);
      if (!z || z.faction !== faction) return;
      if (cmd.plant && PLANTS[cmd.plant]?.sowable && z.kind === 'grow') z.plant = cmd.plant;
      if (cmd.allow && z.kind === 'stockpile') {
        const valid = new Set(ITEM_CATEGORIES.map((c) => c.key));
        z.allow = cmd.allow.filter((a) => valid.has(a));
        w.haulVersion++;
      }
      w.dirty.zones.add(z.id);
      return;
    }
    case 'addBill': {
      const b = ownBench(w, faction, cmd.bench);
      if (!b || !BUILDINGS[b.def].recipes?.includes(cmd.recipe) || !RECIPES[cmd.recipe] || b.bills.length >= 10) return;
      b.bills.push({ id: w.nextBillId++, recipe: cmd.recipe, mode: validMode(cmd.mode), target: clampTarget(cmd.target), suspended: false });
      w.markDirty(b);
      return;
    }
    case 'updateBill': {
      const b = ownBench(w, faction, cmd.bench);
      const bill = b?.bills.find((x) => x.id === cmd.bill);
      if (!b || !bill) return;
      if (cmd.mode) bill.mode = validMode(cmd.mode);
      if (cmd.target !== undefined) bill.target = clampTarget(cmd.target);
      if (cmd.suspended !== undefined) bill.suspended = !!cmd.suspended;
      w.markDirty(b);
      return;
    }
    case 'choose':
      resolveChoice(w, Number(cmd.choice), String(cmd.option), faction);
      return;
    case 'steal': {
      // Send one colonist (drafted or not, awake at any hour) to carry off an item from a settlement's or colony's stores.
      const p = ownPawns(w, faction, [cmd.pawn])[0];
      const it = w.get<Item>(Number(cmd.item));
      if (!p || p.downed || !it || it.kind !== 'item') return;
      const z = w.zoneAt(w.cellOf(it));
      if (!z || z.kind !== 'stockpile' || !canStealFrom(w, faction, z.faction) || w.reservedByOther(rk.e(it.id), p.id)) return;
      const dest = findStorageCell(w, faction, it, p.id);
      if (dest < 0) {
        w.message(faction, 'Nowhere to put stolen goods: make a stockpile first.', 'neutral');
        return;
      }
      endJob(w, p);
      // An explicit order always gets a fresh try, whatever earlier pathing gave up on.
      w.unreachable.delete(unreachableKey(faction, w.cellOf(it)));
      w.reserve(rk.e(it.id), p.id);
      w.reserve(rk.c(dest), p.id);
      p.job = { type: 'haul', stage: 0, item: it.id, dest };
      w.markDirty(p);
      return;
    }
    case 'possess': {
      if (cmd.on) {
        const p = ownPawns(w, faction, [cmd.pawn])[0];
        if (p) setPossessed(w, p, true);
        return;
      }
      // Letting go always works, even of a colonist who has since been knocked down.
      const p = w.get<Pawn>(cmd.pawn);
      if (p && p.kind === 'pawn' && p.faction === faction && p.possessed) setPossessed(w, p, false);
      return;
    }
    case 'steer': {
      const p = ownPawns(w, faction, [cmd.pawn])[0];
      if (!p?.possessed) return;
      const dx = Math.sign(Number(cmd.dx) || 0);
      const dy = Math.sign(Number(cmd.dy) || 0);
      const steer: [number, number] | undefined = dx || dy ? [dx, dy] : undefined;
      if (steer?.[0] === p.steer?.[0] && steer?.[1] === p.steer?.[1]) return;
      p.steer = steer;
      // Clients see the held direction too (it's on the pawn), so send it.
      w.markDirty(p);
      return;
    }
    case 'sneak': {
      const p = ownPawns(w, faction, [cmd.pawn])[0];
      if (!p) return;
      p.sneaking = !!cmd.on;
      w.markDirty(p);
      return;
    }
    case 'interact': {
      const p = ownPawns(w, faction, [cmd.pawn])[0];
      if (p?.possessed) interact(w, p);
      return;
    }
    case 'hunt':
      markHunt(w, faction, cmd.pawns, !!cmd.on);
      return;
    case 'deliverRequest':
      deliverRequest(w, faction, Number(cmd.settlement), Number(cmd.request));
      return;
    case 'settlementTrade':
      settlementTrade(w, faction, Number(cmd.settlement), cmd.give, cmd.want);
      return;
    case 'offerTrade':
      offerTrade(w, faction, Number(cmd.to), cmd.give, cmd.want, cmd.note);
      return;
    case 'draft':
      for (const p of ownPawns(w, faction, cmd.pawns)) setDrafted(w, p, !!cmd.on);
      return;
    case 'move':
      return moveOrder(w, faction, cmd.pawns, Number(cmd.x) | 0, Number(cmd.y) | 0);
    case 'attack': {
      // The only way one player's pawns ever fight another's: an explicit order from drafted pawns.
      const t = w.get<Pawn>(Number(cmd.target));
      if (!t || t.kind !== 'pawn' || t.faction === faction) return;
      for (const p of ownPawns(w, faction, cmd.pawns)) {
        if (!p.drafted) continue;
        endJob(w, p);
        p.job = { type: 'attack', stage: 0, target: t.id, forced: true, chase: true, next: 0, until: 0 };
      }
      return;
    }
    case 'capture':
      return capture(w, faction, cmd.pawns, Number(cmd.target));
    case 'equip': {
      const p = ownPawns(w, faction, [cmd.pawn])[0];
      if (!p) return;
      const id = Number(cmd.item) || 0;
      const it = id ? w.get<Item>(id) : undefined;
      if (id && (!it || it.kind !== 'item' || !WEAPONS[it.def] || !canUseItem(w, p, it))) return;
      if (!id && !p.weapon) return;
      endJob(w, p);
      if (it) w.reserve(rk.e(it.id), p.id);
      p.job = { type: 'equip', stage: 0, item: id };
      w.markDirty(p);
      return;
    }
    case 'release': {
      const p = w.get<Pawn>(Number(cmd.pawn));
      if (p && p.kind === 'pawn' && p.faction === faction) releasePrisoner(w, p);
      return;
    }
    case 'removeBill': {
      const b = ownBench(w, faction, cmd.bench);
      if (!b) return;
      b.bills = b.bills.filter((x) => x.id !== cmd.bill);
      w.markDirty(b);
      return;
    }
  }
}

/** The listed pawns that belong to this faction and can act (at most a squad's worth). */
function ownPawns(w: World, faction: number, ids: unknown): Pawn[] {
  if (!Array.isArray(ids)) return [];
  const out: Pawn[] = [];
  for (const id of new Set(ids.slice(0, 50).map(Number))) {
    const p = w.get<Pawn>(id as EntityId);
    if (p && p.kind === 'pawn' && p.faction === faction && !p.downed && !p.prisoner) out.push(p);
  }
  return out;
}

/** Send the nearest of the listed pawns to carry a downed raider to a free bed as a prisoner. */
function capture(w: World, faction: number, ids: unknown, target: number): void {
  const t = w.get<Pawn>(target);
  if (!t || t.kind !== 'pawn' || !t.downed || !isRaider(w, t.faction) || w.reservedByOther(rk.e(t.id), 0)) return;
  const there = w.cellOf(t);
  let who: Pawn | null = null;
  for (const p of ownPawns(w, faction, ids)) if (!who || w.dist(w.cellOf(p), there) < w.dist(w.cellOf(who), there)) who = p;
  if (!who) return;
  const bed = bedFor(w, t, who);
  if (!bed) {
    w.message(faction, `There is no free bed to hold ${t.name} in. Build one first.`, 'neutral', there);
    return;
  }
  endJob(w, who);
  w.reserve(rk.e(t.id), who.id);
  w.reserve(rk.e(bed.id), who.id);
  who.job = { type: 'rescue', stage: 0, patient: t.id, bed: bed.id, capture: true };
  w.markDirty(who);
}

/** Send drafted pawns to a spot, spreading them over nearby open cells so they don't stack. */
function moveOrder(w: World, faction: number, ids: unknown, x: number, y: number): void {
  const m = w.map;
  if (!m.inBounds(x, y)) return;
  const squad = ownPawns(w, faction, ids).filter((p) => p.drafted);
  const start = m.idx(x, y);
  const seen = new Set([start]);
  const queue = [start];
  const spots: number[] = [];
  for (let qi = 0; qi < queue.length && spots.length < squad.length && qi < 200; qi++) {
    const c = queue[qi];
    if (w.passable(c, faction)) spots.push(c);
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = m.cx(c) + dx;
      const ny = m.cy(c) + dy;
      if (!m.inBounds(nx, ny)) continue;
      const n = m.idx(nx, ny);
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  squad.forEach((p, k) => {
    if (k >= spots.length) return;
    endJob(w, p);
    p.job = { type: 'goto', stage: 0, dest: spots[k] };
  });
}

function validMode(m: string): 'count' | 'forever' | 'until' {
  return m === 'forever' || m === 'until' ? m : 'count';
}

function clampTarget(n: number): number {
  return Math.max(0, Math.min(999, Math.round(Number(n) || 0)));
}

function ownBench(w: World, faction: number, id: number): Building | undefined {
  const b = w.get<Building>(id);
  return b && b.kind === 'building' && b.faction === faction ? b : undefined;
}

/** Cells in a rect, clamped to the map. Empty if the rect is too large. */
export function rectCells(w: World, r: Rect, hollow = false): number[] {
  const m = w.map;
  const x0 = Math.max(0, Math.min(r.x0, r.x1) | 0);
  const x1 = Math.min(m.w - 1, Math.max(r.x0, r.x1) | 0);
  const y0 = Math.max(0, Math.min(r.y0, r.y1) | 0);
  const y1 = Math.min(m.h - 1, Math.max(r.y0, r.y1) | 0);
  if (x1 < x0 || y1 < y0 || (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_COMMAND_AREA) return [];
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (hollow && x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
      out.push(m.idx(x, y));
    }
  }
  return out;
}

function designate(w: World, faction: number, kind: string, r: Rect): void {
  const m = w.map;
  for (const c of rectCells(w, r)) {
    const owned = m.desig[c] === 0 || m.desigFaction[c] === faction;
    // Plants in another colony's or settlement's field or stockpile are theirs: hands off.
    const zone = w.zoneAt(c);
    const plant = m.plantAt[c] && (!zone || zone.faction === faction) ? w.get<Plant>(m.plantAt[c]) : undefined;
    switch (kind) {
      case 'mine':
        if (m.rock[c] && owned) w.setDesig(c, DESIG.mine, faction);
        break;
      case 'chop':
        if (plant && PLANTS[plant.def].tree && owned) w.setDesig(c, DESIG.cut, faction);
        break;
      case 'cut':
        if (plant && owned) w.setDesig(c, DESIG.cut, faction);
        break;
      case 'harvest':
        if (plant && PLANTS[plant.def].yieldItem && !PLANTS[plant.def].tree && owned) w.setDesig(c, DESIG.harvest, faction);
        break;
      case 'steal': {
        // Only goods in a living settlement's or another colony's stockpile.
        if (m.itemAt[c] && zone && zone.kind === 'stockpile' && canStealFrom(w, faction, zone.faction) && owned) w.setDesig(c, DESIG.steal, faction);
        break;
      }
      case 'cancel': {
        if (m.desig[c] && m.desigFaction[c] === faction) w.setDesig(c, 0, 0);
        const con = m.constructAt[c] ? w.get<Construct>(m.constructAt[c]) : undefined;
        if (con && con.faction === faction) {
          w.despawn(con.id);
          for (const [def, n] of Object.entries(con.delivered)) if (n > 0) w.placeItemNear(def, n, c);
        }
        break;
      }
    }
  }
}

export function canPlace(w: World, faction: number, def: string, c: number): boolean {
  const m = w.map;
  const d = Object.hasOwn(BUILDINGS, def) ? BUILDINGS[def] : undefined;
  if (!d || d.special) return false;
  if (!TERRAINS[m.terrain[c]].buildable || m.rock[c] || m.constructAt[c]) return false;
  const z = w.zoneAt(c);
  if (z && z.faction !== faction) return false;
  if (d.floorTerrain) return m.terrain[c] !== TERRAINS.findIndex((t) => t.key === d.floorTerrain) && !m.buildingAt[c];
  return !m.buildingAt[c];
}

function build(w: World, faction: number, def: string, hollow: boolean, r: Rect): void {
  if (!Object.hasOwn(BUILDINGS, def) || BUILDINGS[def].special) return;
  const cells = rectCells(w, r, hollow && !!BUILDINGS[def].wall);
  for (const c of cells) if (canPlace(w, faction, def, c)) w.spawnConstruct(def, c, faction);
}

function zone(w: World, faction: number, kind: Zone['kind'], plant: string | undefined, r: Rect): void {
  const m = w.map;
  const cells = rectCells(w, r).filter((c) => {
    if (m.zoneAt[c] || m.solid[c]) return false;
    const t = TERRAINS[m.terrain[c]];
    if (!t.buildable) return false;
    if (kind === 'grow') return t.fertility > 0 && !m.buildingAt[c];
    return true;
  });
  if (cells.length === 0) return;
  // Extend an adjacent zone of the same kind instead of creating a new one.
  let target: Zone | undefined;
  for (const c of cells) {
    for (const [dx, dy] of NEIGHBORS4) {
      const x = m.cx(c) + dx;
      const y = m.cy(c) + dy;
      if (!m.inBounds(x, y)) continue;
      const z = w.zoneAt(m.idx(x, y));
      if (z && z.faction === faction && z.kind === kind) {
        target = z;
        break;
      }
    }
    if (target) break;
  }
  const growPlant = plant && PLANTS[plant]?.sowable ? plant : 'potato';
  target ??= w.createZone(faction, kind, kind === 'grow' ? growPlant : '');
  for (const c of cells) w.addZoneCell(target, c);
}

function deconstruct(w: World, faction: number, r: Rect): void {
  for (const c of rectCells(w, r)) {
    const b = w.map.buildingAt[c] ? w.get<Building>(w.map.buildingAt[c]) : undefined;
    if (!b || b.faction !== faction) continue;
    w.despawn(b.id);
    for (const [def, n] of Object.entries(BUILDINGS[b.def].cost)) {
      const back = Math.floor(n * 0.75);
      if (back > 0) w.placeItemNear(def, back, c);
    }
  }
}
