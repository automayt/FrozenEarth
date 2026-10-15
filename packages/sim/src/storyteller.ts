import { EVENTS, PLANTS, type EventDef } from '@fe/defs';
import { SEASONS, START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { pawnName } from './names';
import type { Pawn, Plant } from './types';
import type { World } from './world';

export interface StoryState {
  nextCheck: number;
  /** Event key -> tick it last fired. */
  lastFired: Record<string, number>;
  /** Points available for bad events. Grows with time, spent by firing. */
  threat: number;
  lastSeason: number;
}

/** Hours between storyteller rolls, and the chance each roll fires something. */
const CHECK_HOURS = 6;
const FIRE_CHANCE = 0.3;

export function newStoryState(): StoryState {
  // A quiet first day to get settled.
  return { nextCheck: START_TICK + TICKS_PER_DAY, lastFired: {}, threat: 0, lastSeason: 0 };
}

/** Check every few in-game hours whether something should happen. */
export function tickStoryteller(w: World): void {
  const s = w.story;
  const season = w.seasonIndex();
  if (season !== s.lastSeason) {
    s.lastSeason = season;
    const name = SEASONS[season];
    w.message(0, name === 'Winter' ? 'Winter has arrived. Crops will freeze outdoors.' : `${name} has begun.`, season === 3 ? 'bad' : 'neutral');
  }
  if (w.tick < s.nextCheck) return;
  s.nextCheck = w.tick + TICKS_PER_HOUR * CHECK_HOURS;
  const players = [...w.factions.values()].filter((f) => f.isPlayer);
  if (players.length === 0) return;
  // Days since the world began, so minDay means "days into the game".
  const day = (w.tick - START_TICK) / TICKS_PER_DAY;
  s.threat += 9 * Math.min(2, 0.5 + day / 10);
  if (!w.rng.chance(FIRE_CHANCE)) return;

  const options = Object.values(EVENTS).filter((e) => {
    if (day < e.minDay) return false;
    const last = s.lastFired[e.key];
    if (last !== undefined && w.tick - last < e.cooldownDays * TICKS_PER_DAY) return false;
    if (e.tone === 'bad' && e.cost > s.threat) return false;
    return true;
  });
  if (options.length === 0) return;
  const total = options.reduce((a, e) => a + e.weight, 0);
  let r = w.rng.next() * total;
  let pick: EventDef = options[0];
  for (const e of options) {
    r -= e.weight;
    if (r <= 0) {
      pick = e;
      break;
    }
  }
  const target = pick.scope === 'faction' ? w.rng.pick(players).id : 0;
  if (fireEvent(w, pick.key, target)) {
    s.lastFired[pick.key] = w.tick;
    if (pick.tone === 'bad') s.threat -= pick.cost;
  }
}

function addCondition(w: World, def: EventDef, faction: number): void {
  w.conditions.push({ key: def.key, until: w.tick + (def.durationHours ?? 24) * TICKS_PER_HOUR, faction });
  w.dirty.conditions = true;
}

/** Run an event now. Returns false if it had nothing to act on. */
export function fireEvent(w: World, key: string, faction: number): boolean {
  const def = EVENTS[key];
  const m = w.map;
  switch (key) {
    case 'cold_snap':
      addCondition(w, def, 0);
      w.message(0, 'A cold snap has rolled in. Temperatures will drop sharply for a day and a half.', 'bad');
      return true;
    case 'heat_wave':
      addCondition(w, def, 0);
      w.message(0, 'A heat wave is baking the land.', 'bad');
      return true;
    case 'eclipse':
      addCondition(w, def, 0);
      w.message(0, 'An eclipse darkens the sky. Plants will not grow until it passes.', 'neutral');
      return true;
    case 'aurora':
      addCondition(w, def, 0);
      w.message(0, 'A shimmering aurora fills the sky. Everyone feels a little better.', 'good');
      return true;
    case 'blight': {
      const crops: Plant[] = [];
      for (const id of w.kinds.plant) {
        const p = w.get<Plant>(id)!;
        const z = w.zoneAt(w.cellOf(p));
        if (z && z.faction === faction && PLANTS[p.def].sowable && !p.blighted) crops.push(p);
      }
      if (crops.length < 6) return false;
      let n = 0;
      for (const p of crops) {
        if (w.rng.chance(0.4)) {
          p.blighted = true;
          w.markDirty(p);
          n++;
        }
      }
      w.message(faction, `Blight has struck ${n} of your crops. Harvest or cut them before it spreads.`, 'bad', w.cellOf(crops[0]));
      return true;
    }
    case 'wanderer_joins': {
      const cell = edgeCell(w);
      if (cell < 0) return false;
      const p = w.spawnPawn(faction, cell, pawnName(w.rng));
      w.message(faction, `${p.name}, a wanderer, has asked to join you. They are walking in from the edge of the map.`, 'good', cell);
      return true;
    }
    case 'cargo_pods': {
      const homes = [...w.factions.values()].filter((f) => f.isPlayer).map((f) => f.home);
      // Land roughly between the colonies so everyone has a reason to race for it.
      const ax = homes.reduce((a, h) => a + h.x, 0) / homes.length;
      const ay = homes.reduce((a, h) => a + h.y, 0) / homes.length;
      for (let tries = 0; tries < 50; tries++) {
        const x = Math.round(ax + w.rng.range(-20, 20));
        const y = Math.round(ay + w.rng.range(-20, 20));
        if (!m.inBounds(x, y)) continue;
        const c = m.idx(x, y);
        if (m.solid[c] || m.buildingAt[c]) continue;
        const loot: [string, number][] = [
          ['steel', 40 + w.rng.int(36)],
          ['wood', 50 + w.rng.int(26)],
          ['survival_meal', 6 + w.rng.int(8)],
          ['cloth', 20 + w.rng.int(30)],
          ['simple_meal', 4 + w.rng.int(6)],
        ];
        for (let k = 0; k < 3; k++) {
          const [def, n] = w.rng.pick(loot);
          w.placeItemNear(def, n, c);
        }
        w.message(0, 'Cargo pods crashed nearby. Whoever hauls the contents first keeps them!', 'good', c);
        return true;
      }
      return false;
    }
    case 'stomach_flu': {
      const pawns = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === faction);
      if (pawns.length === 0) return false;
      const victim = w.rng.pick(pawns);
      victim.sickUntil = w.tick + (def.durationHours ?? 24) * TICKS_PER_HOUR;
      w.markDirty(victim);
      w.message(faction, `${victim.name} has come down with stomach flu. They will be slow for a day.`, 'bad', w.cellOf(victim));
      return true;
    }
  }
  return false;
}

/** A random passable cell on the map border. */
function edgeCell(w: World): number {
  const m = w.map;
  for (let tries = 0; tries < 200; tries++) {
    const side = w.rng.int(4);
    const t = w.rng.int(side < 2 ? m.w : m.h);
    const x = side === 0 ? t : side === 1 ? t : side === 2 ? 0 : m.w - 1;
    const y = side === 0 ? 0 : side === 1 ? m.h - 1 : t;
    const c = m.idx(x, y);
    if (!m.solid[c]) return c;
  }
  return -1;
}
