import { TICKS_PER_HOUR } from './constants';
import type { Choice, ChoiceOption } from './types';
import type { World } from './world';

export type ChoiceResolver = (w: World, choice: Choice, option: string, data: Record<string, unknown>) => void;

const resolvers = new Map<string, ChoiceResolver>();

export function registerChoice(event: string, fn: ChoiceResolver): void {
  resolvers.set(event, fn);
}

/**
 * Put a decision in front of a player. The last option is the default if they don't answer
 * before it expires. `data` stays on the server.
 */
export function offerChoice(
  w: World,
  faction: number,
  event: string,
  title: string,
  text: string,
  options: ChoiceOption[],
  hours: number,
  data: Record<string, unknown> = {},
  at?: number,
): Choice {
  const c: Choice = { id: w.nextChoiceId++, faction, event, title, text, options, expires: w.tick + Math.round(hours * TICKS_PER_HOUR), at };
  w.choices.set(c.id, c);
  w.choiceData.set(c.id, data);
  w.dirty.choices = true;
  w.message(faction, `${title}: a decision is waiting for you.`, 'neutral', at);
  return c;
}

/** While its recipient is offline, an offer from another player always has at least this long left... */
const HOLD_MIN_HOURS = 4;
/** ...topped back up to this, so the countdown isn't resent every tick. */
const HOLD_TOPUP_HOURS = 8;

/**
 * `expired`: nobody answered in time and the default was taken. Resolvers see it as
 * `data.expired`, so they can say "didn't answer" instead of "declined".
 */
export function resolveChoice(w: World, id: number, option: string, faction?: number, expired = false): void {
  const c = w.choices.get(id);
  if (!c || (faction !== undefined && c.faction !== faction)) return;
  if (!c.options.some((o) => o.key === option)) return;
  const data = { ...(w.choiceData.get(id) ?? {}), ...(expired ? { expired: true } : {}) };
  w.choices.delete(id);
  w.choiceData.delete(id);
  w.dirty.choices = true;
  resolvers.get(c.event)?.(w, c, option, data);
}

export function tickChoices(w: World): void {
  for (const c of [...w.choices.values()]) {
    // A friend's offer waits for its recipient to come back rather than lapsing unseen.
    if (c.from && w.online && !w.online.has(c.faction)) {
      if (c.expires - w.tick < HOLD_MIN_HOURS * TICKS_PER_HOUR) {
        c.expires = w.tick + HOLD_TOPUP_HOURS * TICKS_PER_HOUR;
        w.dirty.choices = true;
      }
      continue;
    }
    if (w.tick >= c.expires) resolveChoice(w, c.id, c.options[c.options.length - 1].key, undefined, true);
  }
}

/** Is this offer from another player waiting on someone who is offline? */
export function choiceOnHold(w: { online?: Set<number> }, c: Choice): boolean {
  return !!c.from && !!w.online && !w.online.has(c.faction);
}

/** The sender of an offer takes it back before it's answered. */
export function withdrawChoice(w: World, id: number, faction: number): void {
  const c = w.choices.get(id);
  if (!c || c.from !== faction) return;
  w.choices.delete(id);
  w.choiceData.delete(id);
  w.dirty.choices = true;
  const from = w.factions.get(faction)?.name ?? 'Another colony';
  w.message(c.faction, `${from} withdrew their offer (${c.title}).`, 'neutral');
  w.message(faction, `You withdrew your offer to ${w.factions.get(c.faction)?.name ?? 'them'}.`, 'neutral');
}
