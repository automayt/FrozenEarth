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

export function resolveChoice(w: World, id: number, option: string, faction?: number): void {
  const c = w.choices.get(id);
  if (!c || (faction !== undefined && c.faction !== faction)) return;
  if (!c.options.some((o) => o.key === option)) return;
  const data = w.choiceData.get(id) ?? {};
  w.choices.delete(id);
  w.choiceData.delete(id);
  w.dirty.choices = true;
  resolvers.get(c.event)?.(w, c, option, data);
}

export function tickChoices(w: World): void {
  for (const c of [...w.choices.values()]) {
    if (w.tick >= c.expires) resolveChoice(w, c.id, c.options[c.options.length - 1].key);
  }
}
