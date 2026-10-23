import { BUILDINGS, CELLS_PER_LANDMARK, ITEMS, LANDMARKS, maxHp, T, TERRAINS, type LandmarkDef, type LandmarkKind } from '@fe/defs';
import { inCaravan } from './caravan';
import { tell } from './chronicle';
import { offerChoice, registerChoice } from './choices';
import { lineOfSight } from './combat';
import { addCondition, injure } from './health';
import { frostLevel, frostRadius } from './frost';
import { Rng } from './rng';
import type { Building, Faction, Pawn } from './types';
import { spawnAnimal } from './wildlife';
import type { World } from './world';

/**
 * Places worth walking to: abandoned camps, cairns, old ruins, frozen wrecks, hot springs and
 * monoliths, scattered over the map when it's made. A colony learns of one when one of its people
 * sees it (or hears of it); walking up to it searches it. Loot goes to whoever gets there first,
 * and the frost buries what nobody reached in time. Richer places lie further in.
 */

/** Cells within which a colonist notices a landmark (with a clear line of sight). */
export const SPOT_RANGE = 14;
/** Cells within which a colonist searches it. */
export const VISIT_RANGE = 2;
/** A monolith shows the landmarks within this many cells of it. */
const MONOLITH_REVEAL = 70;
/** Frost level at which a landmark nobody searched is lost under the ice. */
const BURY_AT = 0.6;
/** How often colonists look about them, in ticks. */
const SCAN_EVERY = 60;

export function isLandmark(b: { def: string }): boolean {
  return !!BUILDINGS[b.def]?.landmark;
}

export function landmarkDef(b: { def: string }): LandmarkDef | undefined {
  return isLandmark(b) ? LANDMARKS[b.def as LandmarkKind] : undefined;
}

/** Every landmark building on the map. */
export function landmarksOf(w: World): Building[] {
  const out: Building[] = [];
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    if (isLandmark(b)) out.push(b);
  }
  return out;
}

/** "to the north-east, 40 cells from home". */
export function bearing(fromX: number, fromY: number, x: number, y: number): string {
  const dx = x - fromX;
  const dy = y - fromY;
  const d = Math.round(Math.hypot(dx, dy));
  if (d < 6) return 'close to home';
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const k = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
  return `${d} cells ${dirs[k]} of home`;
}

// ---------------------------------------------------------------- map generation

/** Scatter landmarks over a new map. Uses its own random stream, so the rest of map making is unchanged. */
export function placeLandmarks(w: World): void {
  const m = w.map;
  const rng = new Rng(w.seed ^ 0x1a4d);
  const half = Math.min(m.w, m.h) / 2;
  const want = Math.round((m.w * m.h) / CELLS_PER_LANDMARK);
  const kinds = Object.values(LANDMARKS);
  const placed: { x: number; y: number }[] = [];
  const count: Record<string, number> = {};
  // Big enough maps always get a hot spring and a monolith: they are what makes the middle worth reaching.
  const queue: LandmarkKind[] = want >= 6 ? ['hot_spring', 'monolith'] : [];
  for (let k = 0; queue.length + k < want; k++) {
    const total = kinds.reduce((a, d) => a + d.weight, 0);
    let r = rng.next() * total;
    let pick = kinds[0];
    for (const d of kinds) {
      r -= d.weight;
      if (r <= 0) {
        pick = d;
        break;
      }
    }
    queue.push(pick.key);
  }
  for (const key of queue) {
    const def = LANDMARKS[key];
    if ((count[key] ?? 0) >= def.max) continue;
    for (let tries = 0; tries < 120; tries++) {
      const a = rng.next() * Math.PI * 2;
      const d = half * (def.ring[0] + rng.next() * (def.ring[1] - def.ring[0]));
      const x = Math.round(m.w / 2 + Math.cos(a) * d);
      const y = Math.round(m.h / 2 + Math.sin(a) * d);
      if (x < 6 || y < 6 || x >= m.w - 6 || y >= m.h - 6) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < 16)) continue;
      if ([...w.factions.values()].some((f) => (f.settlement || f.isPlayer) && Math.hypot(f.home.x - x, f.home.y - y) < (f.settlement?.radius ?? 10) + 8)) continue;
      if (!siteFits(w, key, x, y)) continue;
      build(w, rng, key, x, y);
      placed.push({ x, y });
      count[key] = (count[key] ?? 0) + 1;
      break;
    }
  }
}

/** Open, dry ground around (x, y) for this kind; hot springs want the foot of a mountain. */
function siteFits(w: World, key: LandmarkKind, x: number, y: number): boolean {
  const m = w.map;
  const r = key === 'old_ruin' ? 3 : 1;
  for (let yy = y - r; yy <= y + r; yy++) {
    for (let xx = x - r; xx <= x + r; xx++) {
      const c = m.idx(xx, yy);
      if (m.solid[c] || m.buildingAt[c] || !TERRAINS[m.terrain[c]].buildable) return false;
    }
  }
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (Math.abs(p.x - x) <= r + 1 && Math.abs(p.y - y) <= r + 1) return false;
  }
  if (key === 'hot_spring') {
    let rock = 0;
    for (let yy = y - 5; yy <= y + 5; yy++) for (let xx = x - 5; xx <= x + 5; xx++) if (m.rock[m.idx(xx, yy)]) rock++;
    if (rock < 6) return false;
  }
  return true;
}

function clearCell(w: World, c: number): void {
  const m = w.map;
  if (m.plantAt[c]) w.despawn(m.plantAt[c]);
  if (m.itemAt[c]) w.despawn(m.itemAt[c]);
}

function build(w: World, rng: Rng, key: LandmarkKind, x: number, y: number): void {
  const m = w.map;
  const at = m.idx(x, y);
  if (key === 'old_ruin') {
    // A broken square of stone walls round a cracked flagstone floor.
    for (let yy = y - 3; yy <= y + 3; yy++) {
      for (let xx = x - 3; xx <= x + 3; xx++) {
        const c = m.idx(xx, yy);
        clearCell(w, c);
        const edge = Math.abs(xx - x) === 3 || Math.abs(yy - y) === 3;
        if (edge && rng.chance(0.5)) {
          const wall = w.spawnBuilding('stone_wall', c, 0);
          wall.hp = Math.round(maxHp('stone_wall') * (0.25 + rng.next() * 0.45));
        } else if (!edge && rng.chance(0.45)) w.setTerrain(c, T.rough_stone);
      }
    }
  } else if (key === 'hot_spring') {
    // A small steaming pool.
    for (let yy = y - 2; yy <= y + 2; yy++) {
      for (let xx = x - 2; xx <= x + 2; xx++) {
        const c = m.idx(xx, yy);
        if (Math.hypot(xx - x, yy - y) > 1.6 || m.rock[c]) continue;
        clearCell(w, c);
        w.setTerrain(c, T.shallow_water);
      }
    }
  }
  clearCell(w, at);
  w.spawnBuilding(key, at, 0);
}

// ---------------------------------------------------------------- what colonists find

type Loot = [def: string, lo: number, hi: number];

const LOOT: Record<string, Loot[]> = {
  abandoned_camp: [
    ['survival_meal', 4, 10],
    ['cloth', 15, 35],
    ['wood', 20, 40],
    ['meat', 10, 25],
    ['tuque', 1, 2],
    ['sledge', 1, 1],
    ['bow', 1, 1],
  ],
  cairn: [
    ['survival_meal', 6, 14],
    ['steel', 20, 45],
    ['cloth', 20, 40],
    ['parka', 1, 1],
    ['gold', 3, 8],
  ],
  old_ruin: [
    ['stone', 30, 60],
    ['steel', 25, 50],
    ['gold', 3, 10],
    ['knife', 1, 1],
    ['simple_meal', 3, 8],
  ],
  cellar: [
    ['gold', 8, 18],
    ['steel', 40, 70],
    ['survival_meal', 10, 20],
    ['parka', 1, 2],
    ['rifle', 1, 1],
  ],
  frozen_wreck: [
    ['steel', 60, 100],
    ['gold', 10, 25],
    ['rifle', 1, 2],
    ['parka', 1, 3],
    ['survival_meal', 12, 24],
    ['sledge', 1, 2],
  ],
};

const LORE: Record<string, string[]> = {
  abandoned_camp: [
    'Their tracks lead inward, toward the middle of the world.',
    'The fire ring is cold, but someone scratched a tally of days into a stone: forty-one.',
    'A child’s mitten lies by the bedroll.',
  ],
  cairn: [
    'A name is scratched on the top stone, too worn to read.',
    'Under the stones, wrapped in oilcloth, someone’s savings.',
  ],
  old_ruin: [
    'Over the hearth, a painted sun, faded nearly white.',
    'A doorframe still stands. Someone measured their children against it.',
    'Pots still on the shelf. Whoever lived here left in a hurry.',
  ],
  monolith: [
    'Its surface is warm to the touch, even in the cold.',
    'Up close, the stone is covered in lines that look like a map of this land.',
    'When the wind stops, it hums.',
  ],
};

function rollLoot(w: World, table: Loot[], stacks: number): [string, number][] {
  const out: [string, number][] = [];
  for (let k = 0; k < stacks; k++) {
    const [def, lo, hi] = w.rng.pick(table);
    if (!ITEMS[def]) continue;
    const n = lo + w.rng.int(hi - lo + 1);
    const line = out.find((l) => l[0] === def);
    if (line) line[1] += n;
    else out.push([def, n]);
  }
  return out;
}

/** "40 steel, 2 parkas and a rifle". Single big things (clothes, weapons, sledges) count as so many of them. */
function lootText(goods: [string, number][]): string {
  const parts = goods.map(([d, n]) => {
    const label = ITEMS[d]?.label.toLowerCase() ?? d;
    const single = (ITEMS[d]?.stackLimit ?? 50) <= 10;
    if (!single) return `${n} ${label}`;
    return n === 1 ? `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}` : `${n} ${label.replace(/fe$/, 've')}s`;
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
}

/** Hand found goods over: into the packs if the finder is with the caravan, else on the ground there. */
function giveLoot(w: World, p: Pawn, at: number, goods: [string, number][]): boolean {
  const c = inCaravan(w, p);
  for (const [def, n] of goods) {
    if (c) {
      const line = c.cargo.find((l) => l[0] === def);
      if (line) line[1] += n;
      else c.cargo.push([def, n]);
    } else w.placeItemNear(def, n, at);
  }
  if (c) w.dirty.factions.add(p.faction);
  return !!c;
}

function first(p: Pawn): string {
  return p.name.split(' ')[0];
}

function know(f: Faction, id: number): boolean {
  const seen = (f.seen ??= []);
  if (seen.includes(id)) return false;
  seen.push(id);
  return true;
}

/** Tell a colony where a landmark is (from a map, a monolith, the aurora). True if it was news. */
export function revealLandmark(w: World, f: Faction, b: Building): boolean {
  if (!know(f, b.id)) return false;
  w.dirty.factions.add(f.id);
  return true;
}

function spot(w: World, f: Faction, p: Pawn, b: Building): void {
  if (!know(f, b.id)) return;
  w.dirty.factions.add(f.id);
  const def = landmarkDef(b)!;
  const gone = b.found ? (b.found < 0 ? ' The frost has it now.' : ' Someone has been through it already.') : '';
  w.message(f.id, `${first(p)} spotted ${def.a}, ${bearing(f.home.x, f.home.y, b.x, b.y)}.${gone}`, 'neutral', w.cellOf(b));
}

function visit(w: World, f: Faction, p: Pawn, b: Building): void {
  const visited = (f.visited ??= []);
  if (visited.includes(b.id)) return;
  visited.push(b.id);
  know(f, b.id);
  w.dirty.factions.add(f.id);
  const def = landmarkDef(b)!;
  const at = w.cellOf(b);
  const who = first(p);
  if (!def.lasting && b.found) {
    const by = b.found > 0 ? w.factions.get(b.found) : undefined;
    w.message(f.id, b.found < 0 ? `${who} reached the ${def.label.toLowerCase()}, but the ice has sealed it over.` : `${who} reached the ${def.label.toLowerCase()}, but ${by && by.id !== f.id ? by.name : 'someone'} got there first. Nothing is left.`, 'neutral', at);
    return;
  }
  switch (def.key) {
    case 'abandoned_camp':
    case 'cairn':
    case 'old_ruin':
      return search(w, f, p, b, def);
    case 'frozen_wreck': {
      offerChoice(
        w,
        f.id,
        'landmark_wreck',
        'A frozen wreck',
        `${who} has reached the wreck. The hold is still shut, iced over. Breaking in will take some doing, and something might be living in there.`,
        [
          { key: 'open', label: 'Break into the hold' },
          { key: 'leave', label: 'Leave it' },
        ],
        3,
        { lm: b.id, pawn: p.id },
        at,
      );
      return;
    }
    case 'hot_spring':
      addCondition(w, p, 'bathed');
      w.message(f.id, `${who} found a hot spring, ${bearing(f.home.x, f.home.y, b.x, b.y)}. The air is warm around it and the water never freezes: somewhere the frost can't fully take.`, 'good', at);
      tell(w, f.id, `${p.name} found a hot spring, where the water never freezes.`, 'first_find');
      return;
    case 'monolith': {
      let n = 0;
      for (const o of landmarksOf(w)) if (o.id !== b.id && Math.hypot(o.x - b.x, o.y - b.y) <= MONOLITH_REVEAL && revealLandmark(w, f, o)) n++;
      const lore = w.rng.pick(LORE.monolith);
      const shown = n ? ` As ${who} looks at it, the lines on it fall into place: ${n} place${n > 1 ? 's' : ''} out there worth finding. They are on your map now.` : '';
      w.message(f.id, `${who} touched the monolith. ${lore}${shown}`, 'good', at);
      tell(w, f.id, `${p.name} touched a strange monolith.${n ? ` It showed the way to ${n} more places.` : ''}`, 'first_find');
      return;
    }
  }
}

/** A camp, cairn or ruin: goods, a line of what happened here, and sometimes more to find. */
function search(w: World, f: Faction, p: Pawn, b: Building, def: LandmarkDef): void {
  b.found = f.id;
  w.markDirty(b);
  const at = w.cellOf(b);
  // Further in, more to find.
  const inward = 1 - Math.min(1, Math.hypot(b.x - w.map.w / 2, b.y - w.map.h / 2) / (Math.min(w.map.w, w.map.h) / 2));
  const goods = rollLoot(w, LOOT[def.key], 2 + w.rng.int(2) + (inward > 0.5 ? 1 : 0));
  const packed = giveLoot(w, p, at, goods);
  const lore = LORE[def.key] ? ` ${w.rng.pick(LORE[def.key])}` : '';
  const where = packed ? ' It goes into the caravan’s packs.' : ' Haul it home before anyone else does.';
  w.message(f.id, `${first(p)} searched the ${def.label.toLowerCase()} and found ${lootText(goods)}.${where}${lore}`, 'good', at);
  tell(w, f.id, `${p.name} searched ${def.a} and came back with ${lootText(goods)}.`, 'first_find');
  // An abandoned camp often holds a scrawled map; a ruin, sometimes, a cellar.
  if (def.key === 'abandoned_camp' && w.rng.chance(0.5)) {
    const next = nearestUnknown(w, f, b.x, b.y);
    if (next && revealLandmark(w, f, next)) {
      w.message(f.id, `Among their things, a scrawled map: it marks ${landmarkDef(next)!.a}, ${bearing(f.home.x, f.home.y, next.x, next.y)}.`, 'good', w.cellOf(next));
    }
  }
  if (def.key === 'old_ruin' && w.rng.chance(0.4)) {
    offerChoice(
      w,
      f.id,
      'landmark_cellar',
      'A cellar under the ruin',
      `Under the rubble, ${first(p)} found a trapdoor. The steps go down into the dark, and the beams above them look rotten.`,
      [
        { key: 'search', label: 'Go down' },
        { key: 'leave', label: 'Leave it' },
      ],
      3,
      { lm: b.id, pawn: p.id },
      at,
    );
  }
}

function nearestUnknown(w: World, f: Faction, x: number, y: number): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const o of landmarksOf(w)) {
    if (f.seen?.includes(o.id) || (o.found && !landmarkDef(o)?.lasting)) continue;
    const d = Math.hypot(o.x - x, o.y - y);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

/** The scout, if they're still standing near the place, else nobody. */
function scoutAt(w: World, faction: number, pawn: unknown, b: Building): Pawn | undefined {
  const p = w.get<Pawn>(Number(pawn));
  if (!p || p.kind !== 'pawn' || p.faction !== faction || p.downed) return undefined;
  return w.dist(w.cellOf(p), w.cellOf(b)) <= VISIT_RANGE + 6 ? p : undefined;
}

registerChoice('landmark_cellar', (w, ch, option, d) => {
  const f = w.factions.get(ch.faction);
  const b = w.get<Building>(Number(d.lm));
  if (!f || !b || b.kind !== 'building' || option !== 'search') return;
  const p = scoutAt(w, f.id, d.pawn, b);
  if (!p) return w.message(f.id, 'Nobody is at the ruin any more to go down into the cellar.', 'neutral', w.cellOf(b));
  if (w.rng.chance(0.3)) {
    injure(w, p, 'bruise', 0.3 + w.rng.next() * 0.2);
    w.message(f.id, `The steps gave way under ${first(p)}, who fell hard into the dark. They climbed back out empty-handed and hurt.`, 'bad', w.cellOf(b));
    tell(w, f.id, `${p.name} fell through the rotten floor of an old cellar.`);
    return;
  }
  const goods = rollLoot(w, LOOT.cellar, 3);
  giveLoot(w, p, w.cellOf(b), goods);
  w.message(f.id, `${first(p)} went down into the cellar and came back up with ${lootText(goods)}.`, 'good', w.cellOf(b));
  tell(w, f.id, `${p.name} braved a cellar under an old ruin and found ${lootText(goods)}.`);
});

registerChoice('landmark_wreck', (w, ch, option, d) => {
  const f = w.factions.get(ch.faction);
  const b = w.get<Building>(Number(d.lm));
  if (!f || !b || b.kind !== 'building') return;
  if (b.found) return w.message(f.id, 'Someone else has broken into the wreck already.', 'neutral', w.cellOf(b));
  const p = option === 'open' ? scoutAt(w, f.id, d.pawn, b) : undefined;
  if (!p) {
    // Leaving it (or nobody there): come back and it asks again.
    f.visited = f.visited?.filter((id) => id !== b.id);
    w.dirty.factions.add(f.id);
    if (option === 'open') w.message(f.id, 'Nobody is at the wreck any more to break in. Send someone back to try again.', 'neutral', w.cellOf(b));
    return;
  }
  b.found = f.id;
  w.markDirty(b);
  const at = w.cellOf(b);
  const roll = w.rng.next();
  if (roll < 0.3) {
    // Wolves have made a den of it.
    const n = 2 + w.rng.int(2);
    for (let k = 0; k < n; k++) {
      const wolf = spawnAnimal(w, 'wolf', nearOpen(w, at));
      wolf.aggro = p.id;
      wolf.needs.food = 0.2;
    }
    w.message(f.id, `${first(p)} pried the hold open, and wolves came out of it. They had made a den in there.`, 'bad', at);
    tell(w, f.id, `${p.name} broke into a frozen wreck and woke the wolves denning in it.`);
  } else if (roll < 0.42) {
    injure(w, p, 'bruise', 0.35);
    w.message(f.id, `The hull groaned and folded as ${first(p)} worked at the hold. They got out, battered. The hold is crushed shut for good.`, 'bad', at);
    return;
  }
  const goods = rollLoot(w, LOOT.frozen_wreck, 3 + w.rng.int(2));
  giveLoot(w, p, at, goods);
  w.message(f.id, `Inside the wreck's hold: ${lootText(goods)}.`, 'good', at);
  tell(w, f.id, `${p.name} broke into a frozen wreck and found ${lootText(goods)}.`, 'first_find');
});

function nearOpen(w: World, at: number): number {
  const m = w.map;
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = m.cx(at) + dx;
        const y = m.cy(at) + dy;
        if (m.inBounds(x, y) && !m.solid[m.idx(x, y)]) return m.idx(x, y);
      }
    }
  }
  return at;
}

// ---------------------------------------------------------------- over time

/** Colonists notice and search landmarks; bathers soak; the frost buries what nobody reached. */
export function landmarkTick(w: World): void {
  if (w.tick % SCAN_EVERY !== 7) return;
  const marks = landmarksOf(w);
  if (!marks.length) return;
  frostOver(w, marks);
  const aurora = w.hasCondition('aurora');
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.species || p.prisoner || p.downed) continue;
    const f = w.factions.get(p.faction);
    if (!f?.isPlayer) continue;
    for (const b of marks) {
      const dx = Math.abs(p.x - b.x);
      const dy = Math.abs(p.y - b.y);
      if (dx > SPOT_RANGE || dy > SPOT_RANGE) continue;
      const here = w.cellOf(p);
      const at = w.cellOf(b);
      if (dx <= VISIT_RANGE && dy <= VISIT_RANGE) {
        visit(w, f, p, b);
        if (b.def === 'hot_spring') addCondition(w, p, 'bathed');
        if (b.def === 'monolith' && aurora && addCondition(w, p, 'inspired')) {
          w.message(f.id, `The monolith hums under the aurora. ${first(p)} stood by it a long while and came away inspired.`, 'good', at);
        }
      } else if (!f.seen?.includes(b.id) && !p.asleep && lineOfSight(w, here, at)) spot(w, f, p, b);
    }
  }
}

/** The frost reaching a landmark: an unsearched one is lost; a hot spring steams on. Stateless: the line only advances. */
function frostOver(w: World, marks: Building[]): void {
  const m = w.map;
  const now = w.frostRadius();
  const before = frostRadius(w.tick - SCAN_EVERY, w.frost);
  if (before - now < 1e-9) return;
  for (const b of marks) {
    const def = landmarkDef(b)!;
    const was = frostLevel(b.x, b.y, m.w, m.h, before);
    const is = frostLevel(b.x, b.y, m.w, m.h, now);
    const at = w.cellOf(b);
    if (def.lasting) {
      if (def.key === 'hot_spring' && was < 0.3 && is >= 0.3) {
        for (const f of w.factions.values()) {
          if (f.isPlayer && f.seen?.includes(b.id)) w.message(f.id, 'The frost has reached the hot spring, and the spring steams on: a pocket of warm air in the ice.', 'neutral', at);
        }
      }
      continue;
    }
    if (b.found || was >= BURY_AT || is < BURY_AT) continue;
    b.found = -1;
    w.markDirty(b);
    for (const f of w.factions.values()) {
      if (f.isPlayer && f.seen?.includes(b.id) && !f.visited?.includes(b.id)) w.message(f.id, `The frost has swallowed the ${def.label.toLowerCase()} you spotted. Whatever was there is under the ice now.`, 'bad', at);
    }
  }
}

/** Water near a hot spring never freezes. */
export function springWarmed(w: World, cell: number): boolean {
  const m = w.map;
  const x = m.cx(cell);
  const y = m.cy(cell);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (!m.inBounds(x + dx, y + dy)) continue;
      const id = m.buildingAt[m.idx(x + dx, y + dy)];
      if (id && w.get<Building>(id)?.def === 'hot_spring') return true;
    }
  }
  return false;
}

/** An aurora: the lights seem to gather over somewhere each colony hasn't found yet. */
export function auroraLights(w: World): void {
  for (const f of w.factions.values()) {
    if (!f.isPlayer) continue;
    const b = nearestUnknown(w, f, f.home.x, f.home.y);
    if (!b || !revealLandmark(w, f, b)) continue;
    w.message(f.id, `Under the aurora, the lights seem to gather over one place: ${landmarkDef(b)!.a}, ${bearing(f.home.x, f.home.y, b.x, b.y)}. It is on your map now.`, 'good', w.cellOf(b));
  }
}

/** Frost level at which an unsearched landmark is lost: the client warns before it. */
export const LANDMARK_BURY_LEVEL = BURY_AT;
