import { EVENTS, RARITY_WEIGHT, WEATHER, type EventDef } from '@fe/defs';
import { SEASONS, START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { tickChoices } from './choices';
import { daysUntilFrost, FROST_MAX } from './frost';
import { fireEvent } from './eventHandlers';
import type { World } from './world';

export { newStoryState, scheduleEvent, type StoryState } from './schedule';

/** Hours between storyteller rolls. */
const CHECK_HOURS = 4;
/** Chance per roll that a map-wide event fires. */
const MAP_CHANCE = 0.12;
/** Chance per roll, per colony, that something happens to that colony. */
const FACTION_CHANCE = 0.15;

/** Days since the world began, so minDay means "days into the game". */
function gameDay(w: World): number {
  return (w.tick - START_TICK) / TICKS_PER_DAY;
}

export function tickStoryteller(w: World): void {
  const s = w.story;
  const season = w.seasonIndex();
  if (season !== s.lastSeason) {
    s.lastSeason = season;
    const name = SEASONS[season];
    w.message(0, name === 'Winter' ? 'Winter has arrived. Crops will freeze outdoors and the nights can kill.' : `${name} has begun.`, season === 3 ? 'bad' : 'neutral');
  }
  tickChoices(w);
  runScheduled(w);
  if (w.tick < s.nextCheck) return;
  s.nextCheck = w.tick + TICKS_PER_HOUR * CHECK_HOURS;
  const players = [...w.factions.values()].filter((f) => f.isPlayer);
  if (players.length === 0) return;
  frostNotices(w, players);

  const day = gameDay(w);
  const ramp = Math.min(2.2, 0.5 + day / 8);
  s.threat[0] = (s.threat[0] ?? 0) + 7 * ramp;
  for (const f of players) s.threat[f.id] = (s.threat[f.id] ?? 0) + 7 * ramp;

  if (w.rng.chance(MAP_CHANCE)) roll(w, 'map', 0);
  for (const f of players) if (w.rng.chance(FACTION_CHANCE)) roll(w, 'faction', f.id);
}

/** Tell colonies when the frost line starts moving, when it's close, and when it arrives. */
function frostNotices(w: World, players: { id: number; name: string; home: { x: number; y: number } }[]): void {
  const s = w.story;
  s.frostNotice ??= {};
  const m = w.map;
  if (!s.frostNotice[0] && w.frostRadius() < FROST_MAX - 0.001) {
    s.frostNotice[0] = 1;
    w.message(0, 'The frost line has begun to move. Permanent winter is creeping in from the edges of the world. Colonies will have to move inward to survive.', 'bad');
  }
  for (const f of players) {
    const days = daysUntilFrost(f.home.x, f.home.y, m.w, m.h, w.tick, w.frost, 4);
    const notice = s.frostNotice[f.id] ?? 0;
    if (days === 0 && notice < 2) {
      s.frostNotice[f.id] = 2;
      w.message(f.id, 'The frost line has reached your colony. Outdoors it will never be warm again. Heat your rooms, or move toward the center.', 'bad', m.idx(f.home.x, f.home.y));
    } else if (days <= 3 && notice < 1) {
      s.frostNotice[f.id] = 1;
      w.message(f.id, `The frost line will reach your colony in about ${days} day${days === 1 ? '' : 's'}. Prepare heated shelter or start moving inward.`, 'bad', m.idx(f.home.x, f.home.y));
    }
  }
}

function runScheduled(w: World): void {
  const due = w.story.scheduled.filter((e) => e.tick <= w.tick);
  if (!due.length) return;
  w.story.scheduled = w.story.scheduled.filter((e) => e.tick > w.tick);
  for (const e of due) fireEvent(w, e.key, e.faction, e.data);
}

function cooldownKey(def: EventDef, faction: number): string {
  return def.scope === 'map' ? def.key : `${def.key}:${faction}`;
}

/** Events that could fire right now for this target, with their weights. */
export function eligibleEvents(w: World, scope: 'map' | 'faction', faction: number): { def: EventDef; weight: number }[] {
  const s = w.story;
  const day = gameDay(w);
  const season = w.seasonIndex();
  const pool = s.threat[faction] ?? 0;
  const recentBad = w.tick - (s.lastBad[faction] ?? -Infinity) < TICKS_PER_DAY;
  const activeTemp = w.conditions.some((c) => WEATHER[c.key]?.tempOffset);
  const out: { def: EventDef; weight: number }[] = [];
  for (const def of Object.values(EVENTS)) {
    if (def.followUp) continue;
    if ((def.scope === 'map') !== (scope === 'map')) continue;
    if (day < def.minDay) continue;
    if (def.seasons && !def.seasons.includes(season)) continue;
    if (def.unique && s.uniqueFired.includes(def.key)) continue;
    const last = s.lastFired[cooldownKey(def, faction)];
    if (last !== undefined && w.tick - last < def.cooldownDays * TICKS_PER_DAY) continue;
    if (w.conditions.some((c) => c.key === def.key)) continue;
    // Don't stack two temperature swings on top of each other.
    if (activeTemp && WEATHER[def.key]?.tempOffset) continue;
    if (def.tone === 'bad' && def.cost > pool) continue;
    let weight = RARITY_WEIGHT[def.rarity] * (def.weight ?? 1);
    if (def.tone === 'bad' && recentBad) weight *= 0.35;
    out.push({ def, weight });
  }
  return out;
}

function roll(w: World, scope: 'map' | 'faction', faction: number): void {
  const options = eligibleEvents(w, scope, faction);
  // A few tries: some events find nothing to act on (no crops to blight, no rock for ore...).
  for (let tries = 0; tries < 3 && options.length; tries++) {
    const total = options.reduce((a, o) => a + o.weight, 0);
    let r = w.rng.next() * total;
    let k = 0;
    for (; k < options.length - 1; k++) {
      r -= options[k].weight;
      if (r <= 0) break;
    }
    const { def } = options.splice(k, 1)[0];
    if (!fireEvent(w, def.key, faction)) continue;
    const s = w.story;
    s.lastFired[cooldownKey(def, faction)] = w.tick;
    if (def.unique) s.uniqueFired.push(def.key);
    if (def.tone === 'bad') {
      // Scaled events (raids) pay their own way inside the handler.
      if (!def.scaledCost) s.threat[faction] = (s.threat[faction] ?? 0) - def.cost;
      s.lastBad[faction] = w.tick;
    }
    return;
  }
}

export { fireEvent };
