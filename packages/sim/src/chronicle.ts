import { TICKS_PER_DAY } from './constants';
import { calendar } from './time';
import type { Pawn } from './types';
import type { World } from './world';

/**
 * Each colony's story: the moments worth retelling (a death, a raid driven off, a journey made,
 * a newcomer), and milestones, each reached once. Kept on the faction, so every player sees
 * their own story on any device, and it survives a restart.
 */

/** Milestones, in the order a colony usually reaches them, with how the story names them. */
export const MILESTONES: Record<string, string> = {
  first_colonist: 'A newcomer joined',
  first_trade: 'First trade with a town',
  first_raid: 'Drove off the first raid',
  first_alliance: 'First alliance sworn',
  first_journey: 'First journey inward',
  first_winter: 'Lived through a winter',
  frost: 'The frost arrived',
};

/** Most tales a colony keeps (the oldest go first). */
const KEEP = 80;

/** Add a line to a colony's story; with a milestone key, only the first time it's reached. */
export function tell(w: World, faction: number, text: string, milestone?: string): void {
  const f = w.factions.get(faction);
  if (!f?.isPlayer) return;
  let m = milestone;
  if (m) {
    if (f.milestones?.includes(m)) m = undefined;
    else (f.milestones ??= []).push(m);
  }
  const story = (f.chronicle ??= []);
  story.push(m ? { tick: w.tick, text, milestone: m } : { tick: w.tick, text });
  if (story.length > KEEP) story.splice(0, story.length - KEEP);
  w.dirty.factions.add(faction);
}

/** A milestone that is only worth a line the first time (a first trade, say). */
export function milestone(w: World, faction: number, key: string, text: string): void {
  if (w.factions.get(faction)?.milestones?.includes(key)) return;
  tell(w, faction, text, key);
}

/** Once a day: a colony still standing as winter turns to spring has lived through it. */
export function chronicleTick(w: World): void {
  if (w.tick % TICKS_PER_DAY !== 0 || w.tick < TICKS_PER_DAY) return;
  const today = calendar(w.tick).season;
  const yesterday = calendar(w.tick - TICKS_PER_DAY).season;
  if (yesterday !== 'Winter' || today === 'Winter') return;
  for (const f of w.factions.values()) {
    if (!f.isPlayer) continue;
    let alive = 0;
    for (const id of w.kinds.pawn) {
      const p = w.get<Pawn>(id)!;
      if (p.faction === f.id && !p.prisoner) alive++;
    }
    if (alive) tell(w, f.id, `Lived through the winter, ${alive} strong.`, 'first_winter');
  }
}
