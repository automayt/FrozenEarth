import { tell } from './chronicle';
import { CONDITIONS, EVENTS, ITEMS, PLANTS, ROCKS, T, TERRAINS, TRAITS } from '@fe/defs';

/** Could this pawn get the condition right now (not immune, not already sick with it)? */
function canCatch(p: Pawn, cond: string): boolean {
  return !hasCondition(p, cond) && !p.traits.some((t) => TRAITS[t]?.immune?.includes(cond));
}
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { offerChoice, registerChoice } from './choices';
import { startFire } from './fire';
import { addCondition, hasCondition, isMental, removeCondition } from './health';
import { pawnName } from './names';
import { scheduleEvent } from './schedule';
import { raidPoints, spendThreat, startRaid } from './raids';
import { askForHelp, settlementsThatCouldAsk } from './settlements';
import { brawl, chemistry, colonistsOf, warmTo, worstPair } from './social';
import type { Item, Pawn, Plant, Tone } from './types';
import { NEIGHBORS8, type World } from './world';

type Data = Record<string, unknown>;
type Handler = (w: World, faction: number, data: Data) => boolean;

// ============================================================================ helpers

/** A faction's colonists. Prisoners it holds don't count. */
function pawnsOf(w: World, faction: number): Pawn[] {
  const out: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && !p.prisoner) out.push(p);
  }
  return out;
}

function playerPawns(w: World): Pawn[] {
  const out: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (w.factions.get(p.faction)?.isPlayer) out.push(p);
  }
  return out;
}

function pickPawn(w: World, faction: number, ok: (p: Pawn) => boolean = () => true): Pawn | null {
  const ps = pawnsOf(w, faction).filter(ok);
  return ps.length ? w.rng.pick(ps) : null;
}

function homeCell(w: World, faction: number): number {
  const f = w.factions.get(faction);
  const m = w.map;
  return f ? m.idx(f.home.x, f.home.y) : m.idx(m.w >> 1, m.h >> 1);
}

function isOpen(w: World, c: number): boolean {
  const m = w.map;
  return !m.solid[c] && !m.buildingAt[c] && !m.constructAt[c] && TERRAINS[m.terrain[c]].buildable;
}

/** Open ground under open sky: where things falling from the sky can land (not on overhead mountain). */
function skyOpen(w: World, c: number): boolean {
  return isOpen(w, c) && !w.map.roof[c];
}

/** Random open cell within radius of (cx, cy). -1 if none found. */
function cellNear(w: World, cx: number, cy: number, radius: number, ok: (c: number) => boolean = (c) => isOpen(w, c)): number {
  const m = w.map;
  for (let tries = 0; tries < 300; tries++) {
    const x = Math.round(cx + w.rng.range(-radius, radius));
    const y = Math.round(cy + w.rng.range(-radius, radius));
    if (!m.inBounds(x, y)) continue;
    const c = m.idx(x, y);
    if (ok(c)) return c;
  }
  return -1;
}

/** A spot toward the center of the map: further in is harder, and where the good stuff is. */
function towardCenter(w: World, minFrac: number, maxFrac: number, ok?: (c: number) => boolean): number {
  const m = w.map;
  const half = Math.min(m.w, m.h) / 2;
  for (let tries = 0; tries < 300; tries++) {
    const a = w.rng.next() * Math.PI * 2;
    const r = half * w.rng.range(minFrac, maxFrac);
    const x = Math.round(m.w / 2 + Math.cos(a) * r);
    const y = Math.round(m.h / 2 + Math.sin(a) * r);
    if (!m.inBounds(x, y)) continue;
    const c = m.idx(x, y);
    if (ok ? ok(c) : isOpen(w, c)) return c;
  }
  return -1;
}

/** Find a size x size square with nothing player-made in it. Returns the top-left cell or -1. */
function findSite(w: World, size: number, minFrac: number, maxFrac: number): number {
  const m = w.map;
  return towardCenter(w, minFrac, maxFrac, (c) => {
    const x0 = m.cx(c);
    const y0 = m.cy(c);
    if (x0 + size >= m.w - 1 || y0 + size >= m.h - 1) return false;
    for (let y = y0 - 1; y <= y0 + size; y++) {
      for (let x = x0 - 1; x <= x0 + size; x++) {
        const i = m.idx(x, y);
        if (m.buildingAt[i] || m.constructAt[i] || m.zoneAt[i] || !TERRAINS[m.terrain[i]].passable || m.terrain[i] === T.shallow_water) return false;
      }
    }
    for (const id of w.kinds.pawn) {
      const p = w.get<Pawn>(id)!;
      if (p.x >= x0 - 1 && p.x <= x0 + size && p.y >= y0 - 1 && p.y <= y0 + size) return false;
    }
    return true;
  });
}

function edgeCell(w: World): number {
  const m = w.map;
  for (let tries = 0; tries < 200; tries++) {
    const side = w.rng.int(4);
    const t = w.rng.int(side < 2 ? m.w : m.h);
    const x = side < 2 ? t : side === 2 ? 0 : m.w - 1;
    const y = side === 0 ? 0 : side === 1 ? m.h - 1 : t;
    const c = m.idx(x, y);
    if (!m.solid[c]) return c;
  }
  return -1;
}

function storedItems(w: World, faction: number, ok: (it: Item) => boolean = () => true): Item[] {
  const out: Item[] = [];
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (z && z.kind === 'stockpile' && z.faction === faction && ok(it)) out.push(it);
  }
  return out;
}

export function storedCount(w: World, faction: number, def: string): number {
  return storedItems(w, faction, (it) => it.def === def).reduce((a, it) => a + it.count, 0);
}

/** Remove n of an item (or category "cat:x") from a faction's stockpiles. Returns how many were taken. */
export function takeStored(w: World, faction: number, of: string, n: number): number {
  const cat = of.startsWith('cat:') ? of.slice(4) : null;
  let left = n;
  for (const it of storedItems(w, faction, (i) => (cat ? ITEMS[i.def].category === cat : i.def === of))) {
    if (left <= 0) break;
    left -= w.takeFromItem(it, left);
  }
  return n - left;
}

export function giveNearHome(w: World, faction: number, def: string, n: number): void {
  w.placeItemNear(def, n, homeCell(w, faction));
}

function itemText(def: string, n: number): string {
  return `${n} ${ITEMS[def]?.label.toLowerCase() ?? def}`;
}

type Loot = [string, number, number];
const LOOT_COMMON: Loot[] = [
  ['steel', 30, 60],
  ['wood', 40, 75],
  ['cloth', 20, 45],
  ['survival_meal', 5, 12],
  ['stone', 30, 60],
  ['simple_meal', 3, 8],
  ['tuque', 1, 3],
  ['tunic', 1, 2],
];
const LOOT_RICH: Loot[] = [
  ['parka', 1, 3],
  ['gold', 5, 15],
  ['steel', 50, 75],
  ['survival_meal', 10, 20],
  ['cloth', 40, 70],
];

function dropLoot(w: World, cell: number, table: Loot[], stacks: number): string[] {
  const got: string[] = [];
  for (let k = 0; k < stacks; k++) {
    const [def, lo, hi] = w.rng.pick(table);
    const n = lo + w.rng.int(hi - lo + 1);
    w.placeItemNear(def, n, cell);
    got.push(itemText(def, n));
  }
  return got;
}

function joinPawn(w: World, faction: number, name: string, traits: string[]): Pawn | null {
  const cell = edgeCell(w);
  if (cell < 0) return null;
  // Travellers carry whatever they could find.
  const p = w.spawnPawn(faction, cell, name, traits, w.rng.pick(['', 'knife', 'club', 'bow']));
  p.needs.food = 0.6;
  p.needs.rest = 0.6;
  return p;
}

function traitText(traits: string[]): string {
  return traits.length ? traits.map((t) => TRAITS[t]?.label.toLowerCase()).join(', ') : 'unremarkable';
}

const say = (w: World, faction: number, text: string, tone: Tone, at?: number) => w.message(faction, text, tone, at);

// ============================================================================ weather

const WEATHER_TEXT: Record<string, [string, Tone]> = {
  cold_snap: ['A cold snap has rolled in. Get everyone near heat; outdoor crops may freeze.', 'bad'],
  heat_wave: ['A heat wave is baking the land. Food spoils fast and colonists risk heatstroke.', 'bad'],
  blizzard: ['A blizzard is howling across the land. It is bitterly cold and slow going outdoors.', 'bad'],
  early_frost: ['An early frost is coming tonight. Unprotected crops will die.', 'bad'],
  warm_spell: ['A warm wind from the south: a brief thaw in the depths of winter.', 'good'],
  spring_rains: ['Gentle rains are falling. Plants are thriving.', 'good'],
  thunderstorm: ['A thunderstorm is rolling in. Watch for lightning fires.', 'neutral'],
  drought: ['A drought has set in. Crops are struggling and fires will spread fast.', 'bad'],
  fog: ['Thick fog has settled over the land.', 'neutral'],
  eclipse: ['An eclipse darkens the sky. Plants will not grow until it passes.', 'neutral'],
  aurora: ['A shimmering aurora fills the sky. Everyone feels a little better.', 'good'],
  ash_fall: ['Ash is falling from a darkened sky. Somewhere far away a mountain has torn itself open. Nothing will grow until it clears.', 'bad'],
  cold_wind: ['A bitter wind blows from the frozen heart of the world. It feels like a warning.', 'bad'],
  blood_moon: ['The moon has risen red. Everyone is on edge.', 'bad'],
  long_night: ['The sun has not risen. The sky stays black and the cold deepens. The old stories called this the Long Night.', 'bad'],
  false_spring: ['Impossible warmth floods the land. The snow melts and buds open... it cannot last.', 'good'],
  dry_lightning: ['Dry lightning crackles across the sky with no rain behind it.', 'bad'],
};

function weatherEvent(key: string): Handler {
  return (w) => {
    const def = EVENTS[key];
    const [lo, hi] = def.hours ?? [12, 24];
    w.conditions.push({ key, until: w.tick + Math.round(w.rng.range(lo, hi) * TICKS_PER_HOUR), faction: 0 });
    w.dirty.conditions = true;
    const [text, tone] = WEATHER_TEXT[key] ?? [`${def.label}.`, def.tone];
    say(w, 0, text, tone);
    if (key === 'long_night') for (const p of playerPawns(w)) addCondition(w, p, 'dread');
    return true;
  };
}

function meteorite(w: World, cell: number, rich: boolean): void {
  const m = w.map;
  const x0 = m.cx(cell);
  const y0 = m.cy(cell);
  const ore = rich && w.rng.chance(0.35) ? 3 : 2;
  for (let y = y0 - 1; y <= y0 + 1; y++) {
    for (let x = x0 - 1; x <= x0 + 1; x++) {
      if (!m.inBounds(x, y)) continue;
      const c = m.idx(x, y);
      if (m.buildingAt[c] || m.constructAt[c] || m.itemAt[c] || !TERRAINS[m.terrain[c]].passable) continue;
      if ([...w.kinds.pawn].some((id) => w.cellOf(w.get<Pawn>(id)!) === c)) continue;
      if (m.plantAt[c]) w.despawn(m.plantAt[c]);
      w.setTerrain(c, T.rough_stone);
      w.setRock(c, w.rng.chance(0.7) ? ore : 1);
    }
  }
  for (const [dx, dy] of NEIGHBORS8) {
    const x = x0 + dx * 2;
    const y = y0 + dy * 2;
    if (m.inBounds(x, y) && w.rng.chance(0.3)) startFire(w, m.idx(x, y));
  }
}

// ============================================================================ handlers

const HANDLERS: Record<string, Handler> = {};
for (const key of Object.keys(WEATHER_TEXT)) HANDLERS[key] = weatherEvent(key);

HANDLERS.meteor_shower = (w) => {
  const n = 3 + w.rng.int(4);
  let first = -1;
  for (let k = 0; k < n; k++) {
    const c = cellNear(w, w.map.w / 2, w.map.h / 2, w.map.w * 0.45, (x) => skyOpen(w, x));
    if (c < 0) continue;
    meteorite(w, c, true);
    if (first < 0) first = c;
  }
  say(w, 0, `A meteor shower lights up the sky. ${n} fragments have struck the ground, leaving lumps of ore.`, 'neutral', first);
  return first >= 0;
};

// ---------------------------------------------------------------------------- health

function diseaseEvent(cond: string, text: (p: Pawn) => string, extraVictimChance = 0): Handler {
  return (w, faction) => {
    const p = pickPawn(w, faction, (x) => canCatch(x, cond));
    if (!p || !addCondition(w, p, cond)) return false;
    say(w, faction, text(p), 'bad', w.cellOf(p));
    if (extraVictimChance && w.rng.chance(extraVictimChance)) {
      const q = pickPawn(w, faction, (x) => canCatch(x, cond));
      if (q && addCondition(w, q, cond)) say(w, faction, `${q.name} is showing the same symptoms.`, 'bad', w.cellOf(q));
    }
    return true;
  };
}

HANDLERS.flu_outbreak = diseaseEvent('flu', (p) => `${p.name} has come down with the flu. Keep others away and let them rest in bed.`);
HANDLERS.stomach_flu = diseaseEvent('stomach_flu', (p) => `${p.name} has stomach flu. They'll be miserable and hungry for a day or two.`);
HANDLERS.plague = diseaseEvent('plague', (p) => `${p.name} has the plague! It is deadly and spreads fast. Get them into a bed and away from others.`, 0.5);
HANDLERS.wasting_cough = diseaseEvent('wasting_cough', (p) => `${p.name} has developed a wasting cough from the cold air.`);
HANDLERS.sleeping_sickness = diseaseEvent('sleeping_sickness', (p) => `${p.name} has sleeping sickness and can barely stay awake.`);
HANDLERS.food_poisoning = diseaseEvent('food_poisoning', (p) => `${p.name} has food poisoning. Something they ate was off.`);
HANDLERS.migraine = diseaseEvent('migraine', (p) => `${p.name} has a pounding migraine.`);

HANDLERS.accident = (w, faction) => {
  const kind = w.rng.pick(['sprained_ankle', 'cut_hand', 'back_strain']);
  const p = pickPawn(w, faction, (x) => canCatch(x, kind));
  if (!p || !addCondition(w, p, kind)) return false;
  say(w, faction, `${p.name} had an accident: ${CONDITIONS[kind].label.toLowerCase()}.`, 'bad', w.cellOf(p));
  return true;
};

HANDLERS.miracle_recovery = (w, faction) => {
  let n = 0;
  for (const p of pawnsOf(w, faction)) {
    for (const c of [...p.conditions]) {
      const kind = CONDITIONS[c.key]?.kind;
      if (kind === 'disease' || kind === 'injury' || kind === 'exposure') {
        removeCondition(w, p, c.key);
        n++;
      }
    }
  }
  if (!n) return false;
  say(w, faction, 'Overnight, every sick and injured colonist woke up feeling completely well. Nobody can explain it.', 'good');
  return true;
};

// ---------------------------------------------------------------------------- mood

HANDLERS.inspiration = (w, faction) => {
  const p = pickPawn(w, faction, (x) => !isMental(x) && !hasCondition(x, 'inspired'));
  if (!p || !addCondition(w, p, 'inspired')) return false;
  say(w, faction, `${p.name} is struck by inspiration and will work much faster for a day.`, 'good', w.cellOf(p));
  return true;
};

HANDLERS.second_wind = (w, faction) => {
  const p = pickPawn(w, faction, (x) => !isMental(x) && !hasCondition(x, 'second_wind'));
  if (!p || !addCondition(w, p, 'second_wind')) return false;
  p.needs.rest = 1;
  say(w, faction, `${p.name} has a second wind and barely needs sleep.`, 'good', w.cellOf(p));
  return true;
};

HANDLERS.nightmares = (w, faction) => {
  const p = pickPawn(w, faction);
  if (!p) return false;
  p.needs.rest = Math.max(0, p.needs.rest - 0.35);
  w.markDirty(p);
  say(w, faction, `${p.name} was woken by terrible nightmares about the cold. They're exhausted.`, 'bad', w.cellOf(p));
  return true;
};

const QUARREL_TOPICS = [
  'who gets the warm spot by the fire',
  'the last of the good meat',
  "who's been slacking",
  'a debt from before the frost',
  "whose turn it is to haul",
  'a song one of them will not stop singing',
  'who left the door open all night',
  'whether the colony should move inward now',
];

const firstName = (p: Pawn) => p.name.split(' ')[0];

HANDLERS.quarrel = (w, faction) => {
  const pair = worstPair(w, faction);
  if (!pair) return false;
  const [a, b] = pair;
  const topic = w.rng.pick(QUARREL_TOPICS);
  offerChoice(
    w,
    faction,
    'quarrel',
    'A quarrel',
    `${a.name} and ${b.name} are at each other's throats over ${topic}. The whole colony can hear it, and both look to you.`,
    [
      { key: 'a', label: `Side with ${firstName(a)}` },
      { key: 'b', label: `Side with ${firstName(b)}` },
      { key: 'leave', label: 'Let them sort it out' },
    ],
    5,
    { a: a.id, b: b.id, topic },
    w.cellOf(a),
  );
  return true;
};

registerChoice('quarrel', (w, c, option, d) => {
  const a = w.get<Pawn>(Number(d.a));
  const b = w.get<Pawn>(Number(d.b));
  if (!a || !b || a.kind !== 'pawn' || b.kind !== 'pawn' || a.faction !== c.faction || b.faction !== c.faction) return;
  if (option === 'a' || option === 'b') {
    const [won, lost] = option === 'a' ? [a, b] : [b, a];
    addCondition(w, won, 'vindicated');
    addCondition(w, lost, 'slighted');
    warmTo(w, lost, won, -15, 5);
    say(w, c.faction, `You side with ${won.name}. ${firstName(lost)} storms off, muttering about ${d.topic}.`, 'neutral', w.cellOf(lost));
    return;
  }
  // Left to themselves: good chemistry talks it out, bad chemistry ends in fists.
  if (w.rng.chance(0.5 + chemistry(w, a.id, b.id) * 0.35)) {
    warmTo(w, a, b, 15);
    say(w, c.faction, `${a.name} and ${b.name} talked it out over the fire and shook hands.`, 'good', w.cellOf(a));
  } else {
    brawl(w, a, b, ` over ${d.topic}`);
  }
});

HANDLERS.feast = (w, faction) => {
  const people = colonistsOf(w, faction);
  if (people.length < 2) return false;
  const meals = storedItems(w, faction, (it) => ITEMS[it.def].category === 'meal').reduce((a, it) => a + it.count, 0);
  const n = people.length;
  const cost = meals >= n + 2 ? { of: 'cat:meal', n: n + 2, text: `${n + 2} meals` } : { of: 'cat:raw_food', n: n * 6, text: `${n * 6} raw food` };
  if (storedItems(w, faction, (it) => (cost.of === 'cat:meal' ? ITEMS[it.def].category === 'meal' : ITEMS[it.def].category === 'raw_food')).reduce((a, it) => a + it.count, 0) < cost.n) return false;
  const host = [...people].sort((x, y) => y.needs.mood - x.needs.mood || x.id - y.id)[0];
  offerChoice(
    w,
    faction,
    'feast',
    'A feast?',
    `${host.name} wants to throw a feast tonight: ${cost.text} from the stores, music, and a fire big enough to see from the next valley. Everyone would feel better for it, and closer.`,
    [
      { key: 'feast', label: 'Hold the feast' },
      { key: 'keep', label: 'Keep the food' },
    ],
    5,
    { host: host.id, ...cost },
    w.cellOf(host),
  );
  return true;
};

registerChoice('feast', (w, c, option, d) => {
  const host = w.get<Pawn>(Number(d.host));
  if (option !== 'feast') {
    if (host && host.kind === 'pawn' && !d.expired) addCondition(w, host, 'slighted');
    say(w, c.faction, host ? `No feast. ${firstName(host)} takes it badly.` : 'No feast, then.', 'neutral');
    return;
  }
  if (takeStored(w, c.faction, String(d.of), Number(d.n)) < Number(d.n)) {
    say(w, c.faction, 'The stores turned out too thin for a feast. Maybe another time.', 'neutral');
    return;
  }
  const people = colonistsOf(w, c.faction);
  for (const p of people) addCondition(w, p, 'feasted');
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) warmTo(w, people[i], people[j], 6);
  say(w, c.faction, `The feast goes on long into the night${host && host.kind === 'pawn' ? `, and ${firstName(host)} is the last to bed` : ''}. Everyone feels better, and closer.`, 'good', host && host.kind === 'pawn' ? w.cellOf(host) : undefined);
  tell(w, c.faction, `Held a feast${host && host.kind === 'pawn' ? `, thrown by ${host.name}` : ''}.`);
});

HANDLERS.festival = (w) => {
  const pawns = playerPawns(w);
  if (!pawns.length) return false;
  for (const p of pawns) addCondition(w, p, 'festival');
  say(w, 0, 'It is the old Festival of the Last Light. Every colony celebrates, and everyone feels better.', 'good');
  return true;
};

// ---------------------------------------------------------------------------- fortune

HANDLERS.cargo_pods = (w) => {
  const homes = [...w.factions.values()].filter((f) => f.isPlayer).map((f) => f.home);
  if (!homes.length) return false;
  // Land roughly between the colonies so everyone has a reason to race for it.
  const ax = homes.reduce((a, h) => a + h.x, 0) / homes.length;
  const ay = homes.reduce((a, h) => a + h.y, 0) / homes.length;
  const c = cellNear(w, ax, ay, 20, (x) => skyOpen(w, x));
  if (c < 0) return false;
  dropLoot(w, c, LOOT_COMMON, 2 + w.rng.int(2));
  say(w, 0, 'Cargo pods crashed nearby. Whoever hauls the contents first keeps them!', 'good', c);
  return true;
};

HANDLERS.meteorite = (w) => {
  const c = cellNear(w, w.map.w / 2, w.map.h / 2, w.map.w * 0.45, (x) => skyOpen(w, x));
  if (c < 0) return false;
  meteorite(w, c, w.rng.chance(0.4));
  say(w, 0, 'A meteorite crashed to the ground, leaving a lump of rich ore.', 'neutral', c);
  return true;
};

HANDLERS.ore_discovered = (w, faction) => {
  const m = w.map;
  const f = w.factions.get(faction);
  if (!f) return false;
  const start = cellNear(w, f.home.x, f.home.y, 30, (c) => ROCKS[m.rock[c]].stone);
  if (start < 0) return false;
  const gold = w.rng.chance(0.25);
  const size = gold ? 4 + w.rng.int(4) : 6 + w.rng.int(6);
  const vein = [start];
  for (let k = 0; k < vein.length && vein.length < size; k++) {
    const x = m.cx(vein[k]);
    const y = m.cy(vein[k]);
    for (const [dx, dy] of NEIGHBORS8) {
      if (!m.inBounds(x + dx, y + dy)) continue;
      const n = m.idx(x + dx, y + dy);
      if (ROCKS[m.rock[n]].stone && !vein.includes(n) && w.rng.chance(0.5)) vein.push(n);
    }
  }
  for (const c of vein) w.setRock(c, gold ? 3 : 2);
  say(w, faction, `Your colonists spotted a vein of ${gold ? 'gold' : 'steel'} in the rock nearby.`, 'good', start);
  return true;
};

HANDLERS.berry_bloom = (w, faction) => {
  const m = w.map;
  const f = w.factions.get(faction);
  if (!f) return false;
  const n = 8 + w.rng.int(7);
  let placed = 0;
  let first = -1;
  for (let k = 0; k < n; k++) {
    const c = cellNear(w, f.home.x, f.home.y, 14, (x) => isOpen(w, x) && !m.plantAt[x] && !m.itemAt[x] && !m.zoneAt[x] && TERRAINS[m.terrain[x]].fertility >= 0.5);
    if (c < 0) continue;
    w.spawnPlant('berry_bush', c, 0.85 + w.rng.next() * 0.15);
    placed++;
    if (first < 0) first = c;
  }
  if (!placed) return false;
  say(w, faction, `${placed} wild berry bushes have sprung up and ripened around your colony. Harvest them!`, 'good', first);
  return true;
};

HANDLERS.bumper_crop = (w, faction) => {
  const crops: Plant[] = [];
  for (const id of w.kinds.plant) {
    const p = w.get<Plant>(id)!;
    const z = w.zoneAt(w.cellOf(p));
    if (z && z.faction === faction && PLANTS[p.def].sowable && p.growth < 1) crops.push(p);
  }
  if (crops.length < 5) return false;
  for (const p of crops) {
    p.growth = Math.min(1, p.growth + 0.35);
    w.markDirty(p);
  }
  say(w, faction, 'Your crops have shot up overnight. A bumper crop is on the way.', 'good', w.cellOf(crops[0]));
  return true;
};

HANDLERS.abandoned_cache = (w) => {
  const c = towardCenter(w, 0.2, 0.55);
  if (c < 0) return false;
  const got = dropLoot(w, c, w.rng.chance(0.3) ? LOOT_RICH : LOOT_COMMON, 2 + w.rng.int(3));
  say(w, 0, `Scouts spotted an abandoned cache further in toward the center: ${got.join(', ')}. First come, first served.`, 'good', c);
  return true;
};

const EXPLORER_NOTES = [
  'Their journal ends: "The center is not frozen. It is the only place that isn’t."',
  'A note in their glove reads: "Do not trust the ones who come out of the white."',
  'They carried a map with a circle drawn around the center and one word: "warm".',
  'Their last entry: "The cold moves inward every year. We are running out of world."',
  'Scratched into their canteen: "Something lives where the snow stops."',
];

HANDLERS.frozen_explorer = (w) => {
  const c = towardCenter(w, 0.1, 0.35);
  if (c < 0) return false;
  dropLoot(w, c, LOOT_RICH, 2);
  w.placeItemNear('survival_meal', 4 + w.rng.int(6), c);
  say(w, 0, `The frozen body of an explorer was found near the center, still carrying a full pack. ${w.rng.pick(EXPLORER_NOTES)}`, 'good', c);
  return true;
};

// ---------------------------------------------------------------------------- disasters

HANDLERS.blight = (w, faction) => {
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
  say(w, faction, `Blight has struck ${n} of your crops. Harvest or cut them before they rot away.`, 'bad', w.cellOf(crops[0]));
  return n > 0;
};

HANDLERS.wildfire = (w) => {
  const m = w.map;
  const homes = [...w.factions.values()].map((f) => m.idx(f.home.x, f.home.y));
  for (let tries = 0; tries < 400; tries++) {
    const c = w.rng.int(m.n);
    const p = m.plantAt[c] ? w.get<Plant>(m.plantAt[c]) : undefined;
    if (!p || !PLANTS[p.def].tree || homes.some((h) => w.dist(h, c) < 15)) continue;
    startFire(w, c);
    for (const [dx, dy] of NEIGHBORS8) {
      const x = m.cx(c) + dx;
      const y = m.cy(c) + dy;
      if (m.inBounds(x, y) && w.rng.chance(0.4)) startFire(w, m.idx(x, y));
    }
    say(w, 0, 'A wildfire has broken out in the forest! Keep firefighters ready if it spreads toward you.', 'bad', c);
    return true;
  }
  return false;
};

HANDLERS.pests = (w, faction) => {
  const food = storedItems(w, faction, (it) => ITEMS[it.def].category === 'raw_food');
  const total = food.reduce((a, it) => a + it.count, 0);
  if (total < 20) return false;
  const frac = w.rng.range(0.25, 0.5);
  let eaten = 0;
  for (const it of food) eaten += w.takeFromItem(it, Math.ceil(it.count * frac));
  say(w, faction, `Rats got into your stores and ate ${eaten} raw food.`, 'bad', w.cellOf(food[0]));
  return true;
};

const VALUABLE = new Set(['gold', 'steel', 'survival_meal', 'simple_meal', 'cloth']);

function stealFrom(w: World, faction: number, minFrac: number, maxFrac: number): string | null {
  const loot = storedItems(w, faction, (it) => VALUABLE.has(it.def)).sort((a, b) => ITEMS[b.def].marketValue * b.count - ITEMS[a.def].marketValue * a.count);
  if (!loot.length) return null;
  const it = loot[0];
  const def = it.def;
  const n = w.takeFromItem(it, Math.max(1, Math.round(it.count * w.rng.range(minFrac, maxFrac))));
  return itemText(def, n);
}

HANDLERS.thief = (w, faction) => {
  const what = stealFrom(w, faction, 0.3, 0.6);
  if (!what) return false;
  for (const p of pawnsOf(w, faction)) addCondition(w, p, 'robbed');
  say(w, faction, `A thief slipped into your stockpile during the night and made off with ${what}.`, 'bad');
  return true;
};

// ---------------------------------------------------------------------------- visitors

HANDLERS.wanderer_joins = (w, faction) => {
  const p = joinPawn(w, faction, pawnName(w.rng), w.rollTraits());
  if (!p) return false;
  if (w.rng.chance(0.15)) addCondition(w, p, 'flu');
  say(w, faction, `${p.name} (${traitText(p.traits)}), a wanderer, has joined you. They're walking in from the edge of the map.`, 'good', w.cellOf(p));
  tell(w, faction, `${p.name}, a wanderer, joined the colony.`, 'first_colonist');
  return true;
};

HANDLERS.new_arrivals = (w, faction) => {
  const first = joinPawn(w, faction, pawnName(w.rng), w.rollTraits());
  joinPawn(w, faction, pawnName(w.rng), w.rollTraits());
  if (!first) return false;
  say(w, faction, 'Two survivors found what is left of your colony and decided to stay. It is not over yet.', 'good', w.cellOf(first));
  return true;
};

const REFUGEE_REASONS = ['raiders burning their village', 'a collapsed mine', 'the advancing cold', 'a blood feud back home', 'a plague-struck town', 'a cult near the center'];

HANDLERS.refugee = (w, faction) => {
  const name = pawnName(w.rng);
  const traits = w.rollTraits();
  const reason = w.rng.pick(REFUGEE_REASONS);
  const sick = w.rng.chance(reason === 'a plague-struck town' ? 0.6 : 0.2);
  const thief = w.rng.chance(0.2);
  offerChoice(
    w,
    faction,
    'refugee',
    'A refugee asks for shelter',
    `${name} (${traitText(traits)}) is fleeing ${reason} and asks to join your colony.`,
    [
      { key: 'accept', label: 'Take them in' },
      { key: 'decline', label: 'Turn them away' },
    ],
    6,
    { name, traits, sick, thief },
  );
  return true;
};

registerChoice('refugee', (w, c, option, data) => {
  if (option !== 'accept') {
    say(w, c.faction, `${data.name} nods and trudges on toward the center.`, 'neutral');
    return;
  }
  const p = joinPawn(w, c.faction, String(data.name), data.traits as string[]);
  if (!p) return;
  if (data.sick) addCondition(w, p, 'flu');
  if (data.thief) scheduleEvent(w, 'refugee_betrayal', c.faction, (2 + w.rng.next() * 3) * TICKS_PER_DAY, { pawn: p.id });
  say(w, c.faction, `${p.name} has joined your colony.`, 'good', w.cellOf(p));
  tell(w, c.faction, `${p.name} found refuge with the colony.`, 'first_colonist');
});

HANDLERS.refugee_betrayal = (w, faction, data) => {
  const p = w.get<Pawn>(Number(data.pawn));
  if (!p || p.kind !== 'pawn' || p.faction !== faction) return false;
  const what = stealFrom(w, faction, 0.4, 0.7) ?? 'nothing but the clothes on their back';
  const cell = w.cellOf(p);
  if (p.carrying) w.placeItemNear(p.carrying.def, p.carrying.count, cell);
  w.despawn(p.id);
  for (const o of pawnsOf(w, faction)) addCondition(w, o, 'betrayed');
  say(w, faction, `${p.name} was never a refugee. They slipped away in the night with ${what}.`, 'bad', cell);
  return true;
};

interface Offer {
  give: [string, number];
  want: [string, number][];
}

const OFFERS: Offer[] = [
  { give: ['survival_meal', 8], want: [['wood', 45], ['steel', 25], ['gold', 3]] },
  { give: ['steel', 40], want: [['wood', 70], ['gold', 5], ['cloth', 40]] },
  { give: ['gold', 6], want: [['steel', 55], ['survival_meal', 6]] },
  { give: ['cloth', 40], want: [['wood', 35], ['steel', 18]] },
  { give: ['wood', 75], want: [['steel', 30], ['gold', 3], ['cloth', 45]] },
  { give: ['simple_meal', 6], want: [['wood', 30], ['cloth', 20]] },
  { give: ['steel', 25], want: [['potato', 40], ['rice', 40], ['corn', 40], ['berries', 40]] },
  { give: ['parka', 2], want: [['wood', 80], ['steel', 45], ['gold', 6]] },
  { give: ['tuque', 3], want: [['wood', 30], ['cloth', 25]] },
];

HANDLERS.settlement_raid = (w) => {
  // Somewhere a colony knows about, if there is one, so someone hears of it.
  const towns = [...w.factions.values()].filter((f) => f.settlement?.state === 'home');
  const known = towns.filter((f) => f.settlement!.met.length);
  const pool = known.length ? known : towns;
  if (!pool.length) return false;
  const f = w.rng.pick(pool);
  const people = [...w.kinds.pawn].filter((id) => w.get<Pawn>(id)!.faction === f.id).length;
  return !!startRaid(w, f.id, 140 + people * 35, 'raid');
};

HANDLERS.settlement_plea = (w, faction) => {
  const options = settlementsThatCouldAsk(w, faction);
  return options.length > 0 && askForHelp(w, w.rng.pick(options), faction);
};

HANDLERS.peddler = (w, faction) => {
  const offer = w.rng.pick(OFFERS);
  const affordable = offer.want.filter(([def, n]) => storedCount(w, faction, def) >= n);
  const [wantDef, wantN] = affordable.length ? w.rng.pick(affordable) : w.rng.pick(offer.want);
  const [giveDef, giveN] = offer.give;
  offerChoice(
    w,
    faction,
    'peddler',
    'A peddler is passing through',
    `A travelling peddler offers ${itemText(giveDef, giveN)} for ${itemText(wantDef, wantN)} from your stockpiles.`,
    [
      { key: 'accept', label: 'Trade' },
      { key: 'decline', label: 'No thanks' },
    ],
    4,
    { giveDef, giveN, wantDef, wantN },
  );
  return true;
};

registerChoice('peddler', (w, c, option, d) => {
  if (option !== 'accept') return;
  const wantDef = String(d.wantDef);
  const wantN = Number(d.wantN);
  if (storedCount(w, c.faction, wantDef) < wantN) {
    say(w, c.faction, `You don't have ${itemText(wantDef, wantN)} in your stockpiles. The peddler shrugs and leaves.`, 'neutral');
    return;
  }
  takeStored(w, c.faction, wantDef, wantN);
  giveNearHome(w, c.faction, String(d.giveDef), Number(d.giveN));
  say(w, c.faction, `Trade done: ${itemText(String(d.giveDef), Number(d.giveN))} left near your colony.`, 'good', homeCell(w, c.faction));
});

HANDLERS.beggars = (w, faction) => {
  const meals = storedItems(w, faction, (it) => ITEMS[it.def].category === 'meal').reduce((a, it) => a + it.count, 0);
  const ask = meals >= 3 ? { of: 'cat:meal', n: 3, text: '3 meals' } : { of: 'cat:raw_food', n: 15, text: '15 raw food' };
  offerChoice(
    w,
    faction,
    'beggars',
    'Hungry travellers',
    `A ragged family stops at the edge of your colony and asks for ${ask.text}. They have nothing to offer in return.`,
    [
      { key: 'give', label: 'Give them food' },
      { key: 'refuse', label: 'Send them away' },
    ],
    5,
    ask,
  );
  return true;
};

registerChoice('beggars', (w, c, option, d) => {
  if (option !== 'give') {
    say(w, c.faction, 'The travellers move on without a word.', 'neutral');
    return;
  }
  const got = takeStored(w, c.faction, String(d.of), Number(d.n));
  if (got < Number(d.n)) {
    say(w, c.faction, 'You scraped together what you could. The travellers thank you anyway.', 'neutral');
  } else {
    say(w, c.faction, 'The travellers eat and thank you. Your colonists feel good about it.', 'good');
  }
  for (const p of pawnsOf(w, c.faction)) addCondition(w, p, 'charitable');
  if (w.rng.chance(0.55)) scheduleEvent(w, 'beggars_return', c.faction, (2 + w.rng.next() * 2) * TICKS_PER_DAY);
});

HANDLERS.beggars_return = (w, faction) => {
  const home = homeCell(w, faction);
  const got = dropLoot(w, home, LOOT_RICH, 1 + w.rng.int(2));
  let extra = '';
  if (w.rng.chance(0.15)) {
    const p = joinPawn(w, faction, pawnName(w.rng), w.rollTraits());
    if (p) extra = ` ${p.name}, one of them, has decided to stay and help.`;
  }
  say(w, faction, `The family you fed came back with a gift: ${got.join(', ')}.${extra}`, 'good', home);
  return true;
};

HANDLERS.lost_child = (w, faction, data) => {
  const name = String(data.name ?? pawnName(w.rng));
  const offered = (data.offered as number[] | undefined) ?? [];
  offerChoice(
    w,
    faction,
    'lost_child',
    'A lost child',
    `A child named ${name} has wandered in alone, cold and frightened. They can't do heavy work, but they'll grow.`,
    [
      { key: 'accept', label: 'Take them in' },
      { key: 'decline', label: 'Send them on' },
    ],
    6,
    { name, offered: [...offered, faction] },
  );
  return true;
};

registerChoice('lost_child', (w, c, option, d) => {
  if (option === 'accept') {
    const p = joinPawn(w, c.faction, String(d.name), ['child']);
    if (p) {
      p.social = { op: {}, born: w.tick };
      say(w, c.faction, `${p.name} has joined your colony.`, 'good', w.cellOf(p));
      tell(w, c.faction, `${p.name} joined the colony.`, 'first_colonist');
    }
    return;
  }
  // The child wanders on to another colony that hasn't been asked yet.
  const offered = d.offered as number[];
  const others = [...w.factions.values()].filter((f) => f.isPlayer && !offered.includes(f.id));
  if (others.length) {
    const next = w.rng.pick(others);
    HANDLERS.lost_child(w, next.id, d);
    say(w, c.faction, `${d.name} wanders off toward ${next.name}.`, 'neutral');
  } else {
    say(w, c.faction, `${d.name} wanders off alone into the cold.`, 'bad');
  }
});

HANDLERS.mysterious_stranger = (w, faction) => {
  const price: [string, number] = storedCount(w, faction, 'gold') >= 4 ? ['gold', 4] : storedCount(w, faction, 'steel') >= 50 ? ['steel', 50] : ['wood', 80];
  offerChoice(
    w,
    faction,
    'mysterious_stranger',
    'A hooded stranger',
    `A figure in a frost-stiff cloak sets down a sealed iron crate. "Yours for ${itemText(price[0], price[1])}. No questions, no refunds."`,
    [
      { key: 'buy', label: 'Buy the crate' },
      { key: 'refuse', label: 'Refuse' },
    ],
    3,
    { def: price[0], n: price[1] },
  );
  return true;
};

registerChoice('mysterious_stranger', (w, c, option, d) => {
  if (option !== 'buy') {
    say(w, c.faction, 'The stranger picks up the crate and is gone in the snow.', 'neutral');
    return;
  }
  if (takeStored(w, c.faction, String(d.def), Number(d.n)) < Number(d.n)) {
    say(w, c.faction, 'You can’t pay. The stranger laughs softly and leaves.', 'neutral');
    return;
  }
  const home = homeCell(w, c.faction);
  const roll = w.rng.next();
  if (roll < 0.45) {
    const got = dropLoot(w, home, LOOT_RICH, 3 + w.rng.int(2));
    say(w, c.faction, `The crate is packed with treasure: ${got.join(', ')}.`, 'good', home);
  } else if (roll < 0.75) {
    w.placeItemNear('stone', 20 + w.rng.int(30), home);
    say(w, c.faction, 'The crate is full of rocks. The stranger is long gone.', 'bad', home);
  } else if (roll < 0.9) {
    const p = pickPawn(w, c.faction);
    if (p) addCondition(w, p, w.rng.chance(0.3) ? 'plague' : 'stomach_flu');
    say(w, c.faction, `The crate held nothing but sick, scrabbling rats. ${p ? `${p.name} was bitten.` : ''}`, 'bad', home);
  } else {
    say(w, c.faction, 'The crate is empty. When you look up, there are no footprints in the snow.', 'neutral', home);
  }
});

HANDLERS.pilgrim = (w, faction) => {
  const name = pawnName(w.rng);
  offerChoice(
    w,
    faction,
    'pilgrim',
    'A pilgrim from the Center',
    `A tall, calm traveller named ${name} has walked out of the frozen heart of the world, wearing almost nothing against the cold. "It is warmer where I come from," they say. "I can show you the way, in time." They ask to join you.`,
    [
      { key: 'accept', label: 'Welcome them' },
      { key: 'decline', label: 'Turn them away' },
    ],
    8,
    { name },
  );
  return true;
};

registerChoice('pilgrim', (w, c, option, d) => {
  if (option !== 'accept') {
    say(w, c.faction, 'The pilgrim bows and walks back toward the center without a word.', 'neutral');
    return;
  }
  const traits = ['pilgrim', ...w.rollTraits().slice(0, 1)];
  const p = joinPawn(w, c.faction, String(d.name), traits);
  if (p) {
    say(w, 0, `${p.name}, a pilgrim from the Center, has joined ${w.factions.get(c.faction)?.name}.`, 'good', w.cellOf(p));
    tell(w, c.faction, `${p.name}, a pilgrim from the Center, joined the colony.`, 'first_colonist');
  }
});

// ---------------------------------------------------------------------------- threats

/** Raid points for an event: the colony's wealth-based size, but never more than its threat budget allows. */
function raidBudget(w: World, faction: number, mult: number): number {
  const want = raidPoints(w, faction) * mult;
  const pool = w.story.threat[faction] ?? 0;
  const points = Math.max(EVENTS.raid.cost, Math.min(want, pool));
  spendThreat(w, faction, points);
  return points;
}

HANDLERS.raid = (w, faction, data) => {
  if (!pawnsOf(w, faction).length) return false;
  return !!startRaid(w, faction, Number(data.points) || raidBudget(w, faction, 1), 'raid');
};

HANDLERS.night_raid = (w, faction, data) => {
  if (!pawnsOf(w, faction).length) return false;
  // Melee raiders hit harder per point, so a night raid gets a little more to spend.
  const points = Number(data.points) || raidBudget(w, faction, 1.2);
  if (!w.isNight()) {
    // Already paid for: wait for dark.
    const hours = (23 - w.hour() + 24) % 24;
    scheduleEvent(w, 'night_raid', faction, hours * TICKS_PER_HOUR, { points });
    return true;
  }
  return !!startRaid(w, faction, points, 'night');
};

HANDLERS.sapper_raid = (w, faction, data) => {
  if (!pawnsOf(w, faction).length) return false;
  return !!startRaid(w, faction, Number(data.points) || raidBudget(w, faction, 1), 'sapper');
};

HANDLERS.scout_party = (w, faction) => {
  if (!pawnsOf(w, faction).length) return false;
  return !!startRaid(w, faction, 90, 'scout');
};

// ---------------------------------------------------------------------------- mysteries

HANDLERS.strange_signal = (w) => {
  const c = towardCenter(w, 0, 0.2);
  say(w, 0, 'Every radio crackles with a slow, repeating pulse coming from near the center of the map. Then it stops.', 'neutral', c >= 0 ? c : undefined);
  scheduleEvent(w, 'ancient_vault', 0, 2 * TICKS_PER_DAY);
  return true;
};

HANDLERS.ancient_vault = (w) => {
  const m = w.map;
  const size = 7;
  const site = findSite(w, size, 0, 0.3);
  if (site < 0) return false;
  const x0 = m.cx(site);
  const y0 = m.cy(site);
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const c = m.idx(x, y);
      if (m.plantAt[c]) w.despawn(m.plantAt[c]);
      if (m.itemAt[c]) w.despawn(m.itemAt[c]);
      w.setTerrain(c, T.stone_tile);
      const edge = x === x0 || y === y0 || x === x0 + size - 1 || y === y0 + size - 1;
      w.setRock(c, edge ? 1 : 0);
    }
  }
  const center = m.idx(x0 + 3, y0 + 3);
  dropLoot(w, center, LOOT_RICH, 4 + w.rng.int(3));
  say(w, 0, 'The ground near the center has split open, revealing a sealed stone vault. Mine your way in to claim what’s inside.', 'good', center);
  return true;
};

function relic(def: string, text: string): Handler {
  return (w) => {
    const site = findSite(w, 3, 0, 0.18);
    if (site < 0) return false;
    const m = w.map;
    const c = m.idx(m.cx(site) + 1, m.cy(site) + 1);
    if (m.plantAt[c]) w.despawn(m.plantAt[c]);
    if (m.itemAt[c]) w.despawn(m.itemAt[c]);
    w.spawnBuilding(def, c, 0);
    say(w, 0, text, 'good', c);
    return true;
  };
}

HANDLERS.sun_shard = relic(
  'sun_shard',
  'Something fell from the sky near the center of the map and did not stop glowing. The snow around it has melted. Whoever walls it in will have a room that never freezes.',
);
HANDLERS.whispering_stone = relic('whispering_stone', 'A tall black stone has pushed up out of the earth near the center. Those who stand near it hear something like singing.');

// ============================================================================ entry point

/** Run an event now. Returns false if it had nothing to act on. */
export function fireEvent(w: World, key: string, faction: number, data: Data = {}): boolean {
  const h = HANDLERS[key];
  if (!h) return false;
  return h(w, faction, data);
}

export const HANDLED_EVENTS = Object.keys(HANDLERS);
