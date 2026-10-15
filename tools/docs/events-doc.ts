/**
 * Regenerates the catalogue tables in docs/EVENTS.md from the event and condition defs.
 *
 *   npm run docs:events
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONDITIONS, EVENTS, RARITY_WEIGHT, TRAITS, WEATHER, type EventCategory } from '@fe/defs';

const CATEGORY_TITLES: Record<EventCategory, string> = {
  weather: 'Weather and sky',
  health: 'Health',
  mood: 'Mood',
  fortune: 'Fortune',
  disaster: 'Disasters',
  visitors: 'Visitors and choices',
  threat: 'Threats (combat)',
  mystery: 'Mysteries and uniques',
};
const SEASON = ['Spring', 'Summer', 'Fall', 'Winter'];

function eventTables(): string {
  const out: string[] = [];
  for (const cat of Object.keys(CATEGORY_TITLES) as EventCategory[]) {
    out.push(`### ${CATEGORY_TITLES[cat]}\n`);
    out.push('| Event | Rarity | Tone | Hits | When | What happens |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const e of Object.values(EVENTS).filter((x) => x.category === cat)) {
      const when = [
        e.followUp ? 'follow-up only' : `day ${e.minDay}+`,
        e.seasons ? e.seasons.map((s) => SEASON[s]).join('/') : '',
        e.hours ? `${e.hours[0]}–${e.hours[1]} h` : '',
        e.unique ? '**once per world**' : '',
      ]
        .filter(Boolean)
        .join(', ');
      const hits = e.scope === 'map' ? 'everyone' : e.scope === 'faction' ? 'a colony' : 'a colonist';
      out.push(`| **${e.label}** \`${e.key}\` | ${e.rarity} | ${e.tone}${e.cost ? ` (${e.scaledCost ? `${e.cost}+, scaled` : e.cost})` : ''} | ${hits} | ${when} | ${e.description} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function conditionTable(): string {
  const out = ['| Condition | Kind | How it behaves |', '| --- | --- | --- |'];
  for (const c of Object.values(CONDITIONS)) {
    const how = c.healPerDay
      ? `wound: stacks per hit${c.bleed ? `, bleeds ${c.bleed}×severity/day until tended` : ''}, pain ×${c.pain}, heals ${c.healPerDay}/day once tended`
      : c.hours
      ? `lasts ${c.hours[0]}–${c.hours[1]} h`
      : c.immunityPerDay
        ? `severity +${c.severityPerDay}/day vs immunity +${c.immunityPerDay}/day${c.lethal ? ', lethal at 100%' : ''}${c.contagious ? ', contagious' : ''}`
        : `builds from the environment${c.lethal ? ', lethal at 100%' : ''}`;
    out.push(`| **${c.label}** | ${c.kind} | ${how}. ${c.description} |`);
  }
  return out.join('\n');
}

function traitTable(): string {
  const out = ['| Trait | Effect |', '| --- | --- |'];
  for (const t of Object.values(TRAITS)) out.push(`| **${t.label}**${t.special ? ' (event only)' : ''} | ${t.description} |`);
  return out.join('\n');
}

function weatherTable(): string {
  const out = ['| Condition | Effects |', '| --- | --- |'];
  for (const [k, w] of Object.entries(WEATHER)) {
    const fx = [
      w.tempOffset ? `${w.tempOffset > 0 ? '+' : ''}${w.tempOffset}°C` : '',
      w.growthMult !== undefined ? `plant growth ×${w.growthMult}` : '',
      w.dark ? 'darkness' : '',
      w.outdoorMove ? `outdoor movement ×${w.outdoorMove}` : '',
      w.rain ? 'rain (fires die down)' : '',
      w.dry ? 'dry (fires spread faster)' : '',
      w.lightningHours ? `lightning every ~${w.lightningHours} h` : '',
      w.breakMult ? `mental breaks ×${w.breakMult}` : '',
      w.mood ? `mood ${w.mood > 0 ? '+' : ''}${Math.round(w.mood * 100)}` : '',
    ].filter(Boolean);
    out.push(`| ${EVENTS[k]?.label ?? k} | ${fx.join(', ')} |`);
  }
  return out.join('\n');
}

const path = resolve(import.meta.dirname, '../../docs/EVENTS.md');
const doc = readFileSync(path, 'utf8');
const blocks: Record<string, string> = {
  events: eventTables(),
  conditions: conditionTable(),
  traits: traitTable(),
  weather: weatherTable(),
  rarity: Object.entries(RARITY_WEIGHT)
    .map(([r, w]) => `**${r}** ${w}`)
    .join(' · '),
};
let next = doc;
for (const [name, body] of Object.entries(blocks)) {
  next = next.replace(new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`), `$1\n${body}\n$2`);
}
writeFileSync(path, next);
console.log(`Updated ${path}: ${Object.keys(EVENTS).length} events, ${Object.keys(CONDITIONS).length} conditions, ${Object.keys(TRAITS).length} traits.`);
