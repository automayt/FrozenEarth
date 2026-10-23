import { ANIMALS, type AnimalDef } from '@fe/defs';
import { RARE_TICK } from './constants';
import { tell } from './chronicle';
import { cellDistance } from './combat';
import { addCondition, injure } from './health';
import { maybeReachable } from './pathfinding';
import { goTo, learn } from './pawns';
import type { Caravan, Job, Pawn } from './types';
import { rk, type World } from './world';

/**
 * Taming: a colonist with Hunt work walks up slowly to an animal marked for taming and wins it
 * over, a try at a time (social skill helps; a muskox may lose patience and charge). A tamed
 * animal keeps its wild faction, so nobody fights it, but it belongs to the colony: it gets a
 * name, grazes near home, walks with the caravan, carries a load, and a muskox pulls a sledge.
 */

/** Ticks between taming attempts once next to the animal. */
const ATTEMPT_TICKS = 400;
/** A taming job gives up after this long. */
const TAME_JOB_TICKS = 5000;
/** Tamed animals graze within this many cells of home. */
const GRAZE_RANGE = 8;

const BEAST_NAMES = ['Bramble', 'Moss', 'Tallow', 'Sleet', 'Juniper', 'Barley', 'Cinder', 'Old Grey', 'Pebble', 'Thistle', 'Hob', 'Rime', 'Willow', 'Knot', 'Saffron', 'Dusk', 'Burdock', 'Fennel', 'Nettle', 'Clover'];

export function canTame(a: Pawn): boolean {
  return !!a.species && !!ANIMALS[a.species]?.tame && !a.tamed && !a.downed;
}

/** Mark animals for a colony's tamers, or clear the mark. */
export function markTame(w: World, faction: number, ids: unknown, on: boolean): void {
  if (!Array.isArray(ids)) return;
  let wild = 0;
  for (const id of ids.slice(0, 100)) {
    const a = w.get<Pawn>(Number(id));
    if (!a || a.kind !== 'pawn' || !a.species) continue;
    if (on) {
      if (!canTame(a)) {
        if (!a.tamed) wild++;
        continue;
      }
      a.taming = faction;
      if (a.hunted === faction) a.hunted = 0;
    } else if (a.taming === faction) a.taming = 0;
    w.markDirty(a);
  }
  if (wild) w.message(faction, 'Wolves will not be tamed.', 'neutral');
}

/** Colonists with Hunt work go and tame the animals their colony marked. No weapon needed. */
export function giveTame(w: World, p: Pawn): Job | null {
  if (p.species) return null;
  const here = w.cellOf(p);
  let best: Pawn | null = null;
  let bestD = Infinity;
  for (const id of w.kinds.pawn) {
    const a = w.get<Pawn>(id)!;
    if (a.taming !== p.faction || !canTame(a) || w.reservedByOther(rk.e(a.id), p.id)) continue;
    const c = w.cellOf(a);
    const d = w.dist(here, c);
    if (d < bestD && !w.isUnreachable(p.faction, c) && maybeReachable(w, here, c, true)) {
      best = a;
      bestD = d;
    }
  }
  if (!best) return null;
  w.reserve(rk.e(best.id), p.id);
  return { type: 'tame', stage: 0, target: best.id, next: 0, until: w.tick + TAME_JOB_TICKS };
}

/** The chance one try wins this animal over. */
export function tameChance(def: AnimalDef, social: number): number {
  return Math.min(0.9, (def.tame ?? 0) * (0.6 + 0.06 * social));
}

export function tameTick(w: World, p: Pawn, j: Extract<Job, { type: 'tame' }>): 'continue' | 'done' | 'fail' {
  const a = w.get<Pawn>(j.target);
  if (!a || a.kind !== 'pawn' || a.taming !== p.faction || !canTame(a) || w.tick > j.until) return 'done';
  const here = w.cellOf(p);
  const there = w.cellOf(a);
  if (w.dist(here, there) > 1) {
    // It drifts a little: re-path only when it has moved away from where we're heading.
    if (p.path && w.dist(p.path.goal, there) <= 1) return 'continue';
    if (p.path) p.path = null;
    return goTo(w, p, there, true) === 'fail' ? 'fail' : 'continue';
  }
  if (p.path) {
    p.path = null;
    w.markDirty(p);
  }
  if (w.tick < j.next) return 'continue';
  j.next = w.tick + ATTEMPT_TICKS;
  const def = ANIMALS[a.species!];
  learn(w, p, 'social', 60);
  if (w.rng.chance(tameChance(def, p.skills.social?.level ?? 0))) {
    tameAnimal(w, a, p);
    return 'done';
  }
  if (def.defends && w.rng.chance(0.12)) {
    // It loses patience: one hard butt, and the tamer backs off for now.
    injure(w, p, 'bruise', def.bite * 1.5);
    w.message(p.faction, `The ${def.label.toLowerCase()} lost patience and butted ${p.name.split(' ')[0]} hard. They back off to try another time.`, 'bad', there);
    return 'done';
  }
  return 'continue';
}

function beastName(w: World, faction: number): string {
  const used = new Set<string>();
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.tamed === faction) used.add(o.name);
  }
  const free = BEAST_NAMES.filter((n) => !used.has(n));
  return w.rng.pick(free.length ? free : BEAST_NAMES);
}

/** Make an animal the colony's: named, unmarked, calm. `by` is who won it over, if anyone. */
export function adoptAnimal(w: World, a: Pawn, faction: number): string {
  a.tamed = faction;
  a.taming = 0;
  a.hunted = 0;
  a.aggro = 0;
  a.name = beastName(w, faction);
  a.job = null;
  a.path = null;
  w.markDirty(a);
  return a.name;
}

function tameAnimal(w: World, a: Pawn, by: Pawn): void {
  const def = ANIMALS[a.species!];
  const name = adoptAnimal(w, a, by.faction);
  const use = def.draft ? 'It can carry a heavy load on the road, or pull a sledge.' : def.pack ? 'It can carry a load on the road.' : 'It will keep the colony company.';
  w.message(by.faction, `${by.name} has tamed a ${def.label.toLowerCase()}. It answers to ${name} now. ${use}`, 'good', w.cellOf(a));
  tell(w, by.faction, `${by.name} tamed a ${def.label.toLowerCase()} and named it ${name}.`, 'first_tame');
}

// ---------------------------------------------------------------- tamed and taming animals

/** An animal being tamed holds still while its tamer is close. Null: think as usual. */
export function tamingThink(w: World, a: Pawn): Job | null {
  if (!a.taming) return null;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction === a.taming && o.job?.type === 'tame' && o.job.target === a.id && Math.abs(o.x - a.x) <= 6 && Math.abs(o.y - a.y) <= 6) return { type: 'hold', stage: 0, until: w.tick + 120 };
  }
  return null;
}

/** People of the colony taming it don't frighten it. */
export function calmToward(a: Pawn, o: Pawn): boolean {
  return (!!a.taming && o.faction === a.taming) || (!!a.tamed && !o.species);
}

/** The caravan this tamed animal walks with, if any. */
export function caravanOf(w: World, a: Pawn): Caravan | undefined {
  const c = a.tamed ? w.factions.get(a.tamed)?.caravan : undefined;
  return c?.beasts?.includes(a.id) ? c : undefined;
}

/** A tamed animal: walk with the caravan, or graze near home. Null when it has no owner left. */
export function tamedThink(w: World, a: Pawn, openNear: (x: number, y: number, spread: number) => number): Job | null {
  const owner = a.tamed ? w.factions.get(a.tamed) : undefined;
  if (!owner?.isPlayer) {
    a.tamed = 0;
    return null;
  }
  const m = w.map;
  const c = caravanOf(w, a);
  let tx = owner.home.x;
  let ty = owner.home.y;
  let range = GRAZE_RANGE;
  if (c) {
    const at = c.phase === 'muster' ? c.muster : c.phase === 'travel' ? c.route[Math.min(c.leg, c.route.length - 1)] : c.at ?? c.muster;
    tx = m.cx(at);
    ty = m.cy(at);
    range = 2;
  } else if (w.isNight() && w.rng.chance(0.7) && Math.hypot(a.x - tx, a.y - ty) <= range) return { type: 'hold', stage: 0, until: w.tick + 900 };
  const d = Math.hypot(a.x - tx, a.y - ty);
  if (c && d <= range) return { type: 'hold', stage: 0, until: w.tick + 90 };
  const spot = openNear(tx, ty, Math.min(range, d > range ? range : GRAZE_RANGE));
  if (spot < 0) return { type: 'hold', stage: 0, until: w.tick + 300 };
  return c ? { type: 'goto', stage: 0, dest: spot } : { type: 'wander', stage: 0, dest: spot, until: w.tick + 300 + w.rng.int(600) };
}

/** Colonists near one of their animals feel better for it. Once a slow tick. */
export function companionTick(w: World): void {
  if (w.tick % RARE_TICK !== 0) return;
  for (const id of w.kinds.pawn) {
    const a = w.get<Pawn>(id)!;
    if (!a.tamed || a.downed) continue;
    for (const pid of w.kinds.pawn) {
      const p = w.get<Pawn>(pid)!;
      if (p.faction === a.tamed && !p.species && !p.prisoner && cellDistance(w, w.cellOf(p), w.cellOf(a)) <= 2) addCondition(w, p, 'petted');
    }
  }
}

/** The tamed animals of a colony that could walk with a caravan gathering here. */
export function beastsNear(w: World, faction: number, cell: number, radius: number): Pawn[] {
  const m = w.map;
  const out: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const a = w.get<Pawn>(id)!;
    if (a.tamed !== faction || a.downed) continue;
    const def = ANIMALS[a.species!];
    if (!def?.pack && !def?.draft) continue;
    if (Math.abs(a.x - m.cx(cell)) <= radius && Math.abs(a.y - m.cy(cell)) <= radius) out.push(a);
  }
  return out;
}

/** What a caravan's animals add: bulk on their backs, and how many can pull a sledge. */
export function beastHaul(w: World, c: Caravan): { pack: number; draft: number } {
  let pack = 0;
  let draft = 0;
  for (const id of c.beasts ?? []) {
    const a = w.get<Pawn>(id);
    if (!a || a.kind !== 'pawn' || a.downed) continue;
    const def = ANIMALS[a.species!];
    pack += def?.pack ?? 0;
    if (def?.draft) draft++;
  }
  return { pack, draft };
}
