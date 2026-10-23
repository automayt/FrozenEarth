import { EVENTS, type EventDef } from '@fe/defs';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { fireEvent } from './eventHandlers';
import { scheduleEvent } from './schedule';
import type { Pawn } from './types';
import type { World } from './world';

/**
 * The rhythm of a colony's first week, and the warnings that come before the worst things.
 *
 * A new colony gets a paced opening: a visitor, a squabble, a newcomer, scouts (with a warning),
 * a windfall, then the first real raid, foreshadowed. Each beat tries its events in order and
 * takes the first that finds something to act on. Random events still happen meanwhile, thinner.
 *
 * Omens: an event with `omen` in its def can send a warning letter first and arrive hours later,
 * so there's time to wall up, draft, or bring people home.
 */

/** [days after the colony was founded, events to try in order]. */
export const OPENING: [day: number, events: string[]][] = [
  [0.5, ['peddler', 'beggars']],
  [1.3, ['quarrel', 'inspiration']],
  [2.2, ['refugee', 'wanderer_joins']],
  [3.1, ['scout_party']],
  [4.2, ['berry_bloom', 'ore_discovered', 'bumper_crop']],
  [5.4, ['raid']],
];

/** While its opening runs, a colony's share of random events is scaled by this. */
export const OPENING_RANDOM_MULT = 0.5;

/** Opening beats that always come with a warning, so a new player learns that omens mean something. */
const OPENING_OMENS: Record<string, [number, number]> = { scout_party: [3, 6], raid: [8, 14] };

/** Start a new colony's opening. Called when a player founds a colony. */
export function beginOpening(w: World, faction: number): void {
  (w.story.opening ??= {})[faction] = [w.tick, 0];
}

/** Is this colony still in its opening week? */
export function inOpening(w: World, faction: number): boolean {
  const o = w.story.opening?.[faction];
  return !!o && o[1] < OPENING.length;
}

/** Hourly: fire whichever opening beats have come due. */
export function openingTick(w: World): void {
  const all = w.story.opening;
  if (!all) return;
  for (const key of Object.keys(all)) {
    const faction = Number(key);
    const o = all[faction];
    if (!w.factions.get(faction)?.isPlayer) {
      delete all[faction];
      continue;
    }
    if (o[1] >= OPENING.length) continue;
    const [day, events] = OPENING[o[1]];
    if (w.tick - o[0] < day * TICKS_PER_DAY) continue;
    o[1]++;
    for (const ev of events) {
      const def = EVENTS[ev];
      if (!def) continue;
      const cooldown = def.scope === 'map' ? def.key : `${def.key}:${faction}`;
      const last = w.story.lastFired[cooldown];
      if (last !== undefined && w.tick - last < def.cooldownDays * TICKS_PER_DAY) continue;
      const omen = OPENING_OMENS[ev];
      const ok = omen ? foreshadow(w, def, faction, omen) : fireEvent(w, ev, faction);
      if (!ok) continue;
      const s = w.story;
      s.lastFired[cooldown] = w.tick;
      if (def.tone === 'bad') s.lastBad[faction] = w.tick;
      break;
    }
  }
}

/**
 * Fire an event the storyteller picked, or (for one with an omen) warn first and fire it later.
 * Returns false if it had nothing to act on.
 */
export function fireOrForeshadow(w: World, def: EventDef, faction: number): boolean {
  if (def.omen && w.rng.chance(def.omen.chance) && foreshadow(w, def, faction, def.omen.hours)) return true;
  return fireEvent(w, def.key, faction);
}

/** Send the warning and queue the event. False if there's nobody to warn. */
function foreshadow(w: World, def: EventDef, faction: number, hours: [number, number]): boolean {
  const text = omenText(w, def.key, faction);
  if (!text) return false;
  w.message(faction, text, 'bad');
  scheduleEvent(w, def.key, faction, w.rng.range(hours[0], hours[1]) * TICKS_PER_HOUR, { omened: 1 });
  return true;
}

/** The warning letter for an event, or null if there's nobody to hear it. */
export function omenText(w: World, key: string, faction: number): string | null {
  if (faction && !hasPeople(w, faction)) return null;
  switch (key) {
    case 'raid': {
      const town = knownTown(w, faction);
      return town
        ? `A trapper from ${town} stops by with a warning: armed strangers have made camp a day's walk from your colony, and they were asking about you.`
        : w.rng.pick([
            'Your colonists found a fresh campfire at the edge of the woods, and the prints of many boots around it. Someone is watching the colony.',
            'Smoke rises from a camp in the hills, and at dusk a glint of steel. Someone is watching the colony.',
          ]);
    }
    case 'night_raid':
      return 'Something moves at the edge of the firelight after dark, and is gone when anyone looks. Whoever it is, they come at night.';
    case 'sapper_raid':
      return 'At night the ground thrums faintly, like picks working far off in the rock. Someone is digging toward you.';
    case 'scout_party':
      return 'Fresh tracks circle the colony: two people, light on their feet, keeping out of sight. Scouts, maybe. Keep your people close, and ready to fight (R drafts them).';
    case 'cold_snap':
      return 'The old hands say their joints ache, and the birds have gone quiet. A hard cold is on its way.';
    case 'blizzard':
      return 'The northern sky has turned the colour of slate and the wind is rising. A blizzard is on its way.';
    case 'early_frost':
      return 'The air smells of iron tonight. A killing frost is coming: harvest what you can.';
    case 'plague':
      return 'A traveller who shared your fire last night coughed blood into the snow and was gone before dawn. Watch your people.';
    default:
      return null;
  }
}

function hasPeople(w: World, faction: number): boolean {
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && !p.prisoner) return true;
  }
  return false;
}

/** A town this colony has met that's still standing, for news to come from. */
function knownTown(w: World, faction: number): string | null {
  const towns = [...w.factions.values()].filter((f) => f.settlement?.state === 'home' && f.settlement.met.includes(faction));
  return towns.length ? w.rng.pick(towns).name : null;
}
