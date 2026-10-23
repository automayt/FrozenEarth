import { TRAITS } from '@fe/defs';
import { tell } from './chronicle';
import { RARE_TICK, TICKS_PER_DAY } from './constants';
import { addCondition, injure, isMental } from './health';
import { pawnName } from './names';
import { endJob, learn } from './pawns';
import { hash2 } from './rng';
import type { EntityId, Pawn } from './types';
import type { World } from './world';

/**
 * The people in a colony and how they get on. Colonists near each other now and then exchange a
 * word; each pair has a fixed chemistry, so some just click and others never will. Opinions
 * build into friendships, rivalries and love, which move mood and make the colony's small
 * dramas: a brawl between rivals, heartbreak when a lover dies, a child.
 */

/** One colonist's side of their bonds. Optional on the pawn: older saves have none. */
export interface Social {
  /** Opinion of each colony-mate by id, -100..100. Missing = 0. */
  op: Record<number, number>;
  /** Their lover, and since when (it also times when a child might come). */
  love?: EntityId;
  loveSince?: number;
  /** The last exchange they started: with whom, what kind (index in TALK), and when. Clients show it as speech. */
  talk?: [partner: EntityId, kind: number, tick: number];
  /** Last time they took part in any exchange, so nobody chatters nonstop. */
  last?: number;
  /** Already warned that they're close to breaking, until their mood recovers. */
  edge?: boolean;
  /** Children: when they joined or were born; they grow up CHILD_DAYS later. */
  born?: number;
  /** Bonds already announced (1 friends, -1 rivals), so one wavering across the line isn't news twice. */
  told?: Record<number, 1 | -1>;
}

/** Kinds of exchange, in the order their index is sent to clients. */
export const TALK = ['chat', 'joke', 'insult', 'comfort', 'flirt', 'brawl', 'makeup', 'love'] as const;
export type TalkKind = (typeof TALK)[number];

// ---------------------------------------------------------------- balance knobs

/** Cells apart two colonists can be to talk. */
export const CHAT_RANGE = 7;
/** Chance per slow tick (about 4 s at 1x) that an idle-enough colonist starts an exchange. */
export const CHAT_CHANCE = 0.4;
/** Ticks after an exchange before either takes part in another (under an in-game hour). */
export const CHAT_GAP = 900;
/** Both at or above this: friends. */
/** How far one exchange moves opinions. Lower with more talk, so bonds keep the same pace. */
export const TALK_WEIGHT = 0.8;
export const FRIEND_AT = 40;
/** Either at or below this: rivals. */
export const RIVAL_AT = -40;
/** Both at or above this, after a romantic moment: lovers. Below BREAKUP_AT, it's over. */
export const LOVE_AT = 65;
export const BREAKUP_AT = 15;
/** Each slow tick, opinions drift this share of the way back toward the pair's chemistry. */
export const DRIFT = 0.0008;
/** Where a pair's opinions settle with no one talking: chemistry times this. */
export const CHEMISTRY_PULL = 25;
/** The first word between two people: chemistry times this, all at once. */
export const FIRST_IMPRESSION = 10;
/** Chance an insult between rivals standing close turns into a brawl. */
export const BRAWL_CHANCE = 0.3;
/** Lovers together this long may have a child, at this chance per day, while the colony is small enough. */
export const BIRTH_AFTER_DAYS = 3;
export const BIRTH_PER_DAY = 0.12;
export const BIRTH_MAX_COLONY = 8;
/** Days a child takes to grow up. */
export const CHILD_DAYS = 10;
/** Mood below this: a letter warns the player (once per low spell); back above RECOVER_MOOD resets it. */
export const EDGE_MOOD = 0.25;
export const RECOVER_MOOD = 0.36;

// ---------------------------------------------------------------- helpers

/** A pair's chemistry, -1..1: the same for both, fixed for the life of the world. */
export function chemistry(w: World, a: EntityId, b: EntityId): number {
  return hash2(Math.min(a, b), Math.max(a, b), w.seed) * 2 - 1;
}

export function opinion(p: Pawn, of: EntityId): number {
  return p.social?.op[of] ?? 0;
}

function socialOf(p: Pawn): Social {
  return (p.social ??= { op: {} });
}

function adjust(p: Pawn, of: EntityId, by: number): void {
  const s = socialOf(p);
  s.op[of] = Math.round(Math.max(-100, Math.min(100, (s.op[of] ?? 0) + by)) * 10) / 10;
}

export type Bond = 'lover' | 'friend' | 'rival' | '';

export function bondOf(p: Pawn, q: Pawn): Bond {
  if (p.social?.love === q.id) return 'lover';
  const a = opinion(p, q.id);
  const b = opinion(q, p.id);
  if (a <= RIVAL_AT || b <= RIVAL_AT) return 'rival';
  if (a >= FRIEND_AT && b >= FRIEND_AT) return 'friend';
  return '';
}

function traitSum(p: Pawn, key: 'warmth'): number {
  let v = 0;
  for (const t of p.traits) v += TRAITS[t]?.[key] ?? 0;
  return v;
}

function traitMult(p: Pawn, key: 'romance' | 'breakMult'): number {
  let v = 1;
  for (const t of p.traits) v *= TRAITS[t]?.[key] ?? 1;
  return v;
}

export const isChild = (p: Pawn) => p.traits.includes('child');
const first = (p: Pawn) => p.name.split(' ')[0];

/** A colonist of a player colony who is free to talk: awake, standing, not fighting or hiding. */
function canTalk(w: World, p: Pawn): boolean {
  if (p.species || p.prisoner || p.downed || p.asleep || p.drafted) return false;
  const jt = p.job?.type;
  if (jt === 'attack' || jt === 'shelter' || jt === 'flee' || jt === 'rescue' || jt === 'tend') return false;
  return !!w.factions.get(p.faction)?.isPlayer;
}

/** A colony's people (not prisoners, not animals). */
export function colonistsOf(w: World, faction: number): Pawn[] {
  const out: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction === faction && !p.prisoner && !p.species) out.push(p);
  }
  return out;
}

/** Is it time for this colonist to sleep? Night owls keep the opposite hours. */
export function sleepTime(w: World, p: Pawn): boolean {
  // Only colonists keep their own hours; townsfolk live by the village's.
  const owl = p.traits.some((t) => TRAITS[t]?.nightOwl) && !!w.factions.get(p.faction)?.isPlayer;
  return owl ? !w.isNight() : w.isNight();
}

// ---------------------------------------------------------------- the slow tick

/** Once per slow tick for each colonist of a player colony: talk, drift, grow, worry. */
export function socialTick(w: World, p: Pawn): void {
  if (p.species || p.prisoner || !w.factions.get(p.faction)?.isPlayer) return;
  const s = socialOf(p);
  drift(w, p, s);
  growUp(w, p, s);
  edge(w, p, s);
  coldStrike(w, p);
  if (s.love) loverTick(w, p, s);
  if ((s.last !== undefined && w.tick - s.last < CHAT_GAP) || !canTalk(w, p)) return;
  if (!w.rng.chance(CHAT_CHANCE)) return;
  const here = w.cellOf(p);
  const mates: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const q = w.get<Pawn>(id)!;
    if (q.id === p.id || q.faction !== p.faction || (q.social?.last !== undefined && w.tick - q.social.last < CHAT_GAP)) continue;
    if (w.dist(here, w.cellOf(q)) > CHAT_RANGE || !canTalk(w, q)) continue;
    mates.push(q);
  }
  if (mates.length) exchange(w, p, w.rng.pick(mates));
}

/** Opinions ease back toward chemistry; forget people who are gone. */
function drift(w: World, p: Pawn, s: Social): void {
  for (const key of Object.keys(s.op)) {
    const id = Number(key);
    const q = w.get<Pawn>(id);
    if (!q || q.kind !== 'pawn' || q.faction !== p.faction) {
      delete s.op[id];
      if (s.told) delete s.told[id];
      continue;
    }
    const base = chemistry(w, p.id, id) * CHEMISTRY_PULL;
    s.op[id] = Math.round((s.op[id] + (base - s.op[id]) * DRIFT) * 10) / 10;
    // Well back from the line: if they cross it again, that's news again.
    if (s.told?.[id] && s.op[id] > RIVAL_AT + 15 && s.op[id] < FRIEND_AT - 15) delete s.told[id];
  }
  if (s.love && !w.get(s.love)) {
    delete s.love;
    delete s.loveSince;
  }
}

/** Two colonists exchange a word. What kind depends on who they are and how they feel. */
export function exchange(w: World, p: Pawn, q: Pawn, forced?: TalkKind): TalkKind {
  const ps = socialOf(p);
  const qs = socialOf(q);
  const chem = chemistry(w, p.id, q.id);
  // First impressions: some people click at once, others don't.
  if (ps.op[q.id] === undefined) adjust(p, q.id, chem * FIRST_IMPRESSION);
  if (qs.op[p.id] === undefined) adjust(q, p.id, chem * FIRST_IMPRESSION);
  const o = ps.op[q.id];
  const back = qs.op[p.id];
  const warmth = traitSum(p, 'warmth');
  const skill = p.skills.social?.level ?? 0;
  const before = bondOf(p, q);
  let kind: TalkKind;
  if (forced) kind = forced;
  else if (q.needs.mood < 0.3 && (warmth > 0 || o >= FRIEND_AT) && w.rng.chance(0.6)) kind = 'comfort';
  else {
    const insult = Math.max(0.02, Math.min(0.7, 0.1 - warmth * 0.15 + (p.needs.mood < 0.3 ? 0.15 : 0) + (o < -20 ? 0.2 : 0) - chem * 0.12 - skill * 0.005));
    if (w.rng.chance(insult)) kind = 'insult';
    else if (!ps.love && !qs.love && !isChild(p) && !isChild(q) && o >= FRIEND_AT && back >= FRIEND_AT && w.rng.chance(0.15 * traitMult(p, 'romance'))) kind = 'flirt';
    else kind = w.rng.chance(0.3 + Math.max(0, chem) * 0.25) ? 'joke' : 'chat';
  }
  const warm = (1 + skill * 0.04) * TALK_WEIGHT;
  switch (kind) {
    case 'chat':
    case 'joke': {
      const k = kind === 'joke' ? 1.6 : 1;
      adjust(p, q.id, (1.5 + 3 * chem) * k * TALK_WEIGHT);
      adjust(q, p.id, (1.5 + 3 * chem + warmth * 2) * k * warm);
      break;
    }
    case 'insult':
      adjust(q, p.id, (-7 + Math.min(0, warmth * 2)) * TALK_WEIGHT);
      adjust(p, q.id, -2 * TALK_WEIGHT);
      break;
    case 'comfort':
      adjust(q, p.id, 8 * warm);
      adjust(p, q.id, 2 * TALK_WEIGHT);
      addCondition(w, q, 'comforted');
      break;
    case 'flirt':
      adjust(p, q.id, 4 * TALK_WEIGHT);
      adjust(q, p.id, 4 * traitMult(q, 'romance') * TALK_WEIGHT);
      break;
    default:
      break;
  }
  ps.talk = [q.id, TALK.indexOf(kind), w.tick];
  ps.last = qs.last = w.tick;
  learn(w, p, 'social', 40);
  w.markDirty(p);
  w.markDirty(q);
  // Rivals trading insults up close may not stop at words.
  if (kind === 'insult' && opinion(q, p.id) <= RIVAL_AT && w.dist(w.cellOf(p), w.cellOf(q)) <= 2 && w.rng.chance(BRAWL_CHANCE * Math.max(traitMult(p, 'breakMult'), traitMult(q, 'breakMult')))) {
    brawl(w, q, p);
    return 'brawl';
  }
  if (kind === 'flirt' && opinion(p, q.id) >= LOVE_AT && opinion(q, p.id) >= LOVE_AT) {
    fallInLove(w, p, q);
    return 'love';
  }
  announce(w, p, q, before, bondOf(p, q));
  return kind;
}

/** Say so when two people become friends or rivals. */
function announce(w: World, p: Pawn, q: Pawn, before: Bond, after: Bond): void {
  if (before === after || (after !== 'friend' && after !== 'rival')) return;
  const mark = after === 'friend' ? 1 : -1;
  const ps = socialOf(p);
  if (ps.told?.[q.id] === mark) return;
  (ps.told ??= {})[q.id] = mark;
  (socialOf(q).told ??= {})[p.id] = mark;
  const at = w.cellOf(p);
  if (after === 'friend') {
    w.message(p.faction, `${p.name} and ${q.name} have become friends.`, 'good', at);
    tell(w, p.faction, `${p.name} and ${q.name} became friends.`);
  } else if (after === 'rival') {
    w.message(p.faction, `${p.name} and ${q.name} can't stand each other.`, 'bad', at);
    tell(w, p.faction, `${p.name} and ${q.name} became rivals.`);
  }
}

function fallInLove(w: World, p: Pawn, q: Pawn): void {
  const ps = socialOf(p);
  const qs = socialOf(q);
  ps.love = q.id;
  qs.love = p.id;
  ps.loveSince = qs.loveSince = w.tick;
  ps.talk = [q.id, TALK.indexOf('love'), w.tick];
  w.markDirty(p);
  w.markDirty(q);
  w.message(p.faction, `${p.name} and ${q.name} have fallen in love.`, 'good', w.cellOf(p));
  tell(w, p.faction, `${p.name} and ${q.name} fell in love.`, 'first_love');
}

/** Two colonists come to blows: punches thrown, bruises, and both sore about it for a day. */
export function brawl(w: World, a: Pawn, b: Pawn, why = ''): void {
  if (a.downed || b.downed) return;
  const close = w.dist(w.cellOf(a), w.cellOf(b)) <= 2;
  for (const p of [a, b]) {
    if (p.job?.type !== 'sleep') endJob(w, p);
    addCondition(w, p, 'brawled');
  }
  if (close) {
    w.dirty.shots.push(a.id, b.id, a.x, a.y, b.x, b.y, 1, 0);
    w.dirty.shots.push(b.id, a.id, b.x, b.y, a.x, a.y, 1, 0);
  }
  const loser = w.rng.chance(0.5) ? a : b;
  const winner = loser === a ? b : a;
  adjust(a, b.id, -10);
  adjust(b, a.id, -10);
  socialOf(a).talk = [b.id, TALK.indexOf('brawl'), w.tick];
  socialOf(a).last = socialOf(b).last = w.tick;
  w.markDirty(a);
  w.markDirty(b);
  w.message(a.faction, `${a.name} and ${b.name} came to blows${why}. ${loser.name} came off worse.`, 'bad', w.cellOf(a));
  tell(w, a.faction, `${a.name} and ${b.name} came to blows${why}.`);
  injure(w, winner, 'bruise', w.rng.range(0.04, 0.12));
  injure(w, loser, 'bruise', w.rng.range(0.15, 0.32));
}

/** Lovers: a breakup if it's gone sour; otherwise, in time, maybe a child. */
function loverTick(w: World, p: Pawn, s: Social): void {
  const q = w.get<Pawn>(s.love!);
  if (!q || q.kind !== 'pawn') return;
  if (opinion(p, q.id) < BREAKUP_AT || opinion(q, p.id) < BREAKUP_AT) {
    delete s.love;
    delete s.loveSince;
    if (q.social) {
      delete q.social.love;
      delete q.social.loveSince;
    }
    addCondition(w, p, 'slighted');
    addCondition(w, q, 'slighted');
    w.markDirty(p);
    w.markDirty(q);
    w.message(p.faction, `${p.name} and ${q.name} have split up.`, 'bad', w.cellOf(p));
    tell(w, p.faction, `${p.name} and ${q.name} split up.`);
    return;
  }
  // Once per couple: the lower id rolls.
  if (p.id > q.id || s.loveSince === undefined || w.tick - s.loveSince < BIRTH_AFTER_DAYS * TICKS_PER_DAY) return;
  if (isChild(p) || isChild(q) || p.job?.type === 'trek' || q.job?.type === 'trek') return;
  if (colonistsOf(w, p.faction).length >= BIRTH_MAX_COLONY) return;
  if (!w.rng.chance((BIRTH_PER_DAY * RARE_TICK) / TICKS_PER_DAY)) return;
  birth(w, p, q);
}

function birth(w: World, p: Pawn, q: Pawn): void {
  const surname = p.name.split(' ').slice(1).join(' ') || 'Frost';
  const name = `${pawnName(w.rng).split(' ')[0]} ${surname}`;
  const baby = w.spawnPawn(p.faction, w.cellOf(p), name, ['child']);
  baby.weapon = '';
  baby.social = { op: { [p.id]: 60, [q.id]: 60 }, born: w.tick };
  adjust(p, baby.id, 60);
  adjust(q, baby.id, 60);
  socialOf(p).loveSince = socialOf(q).loveSince = w.tick;
  for (const o of colonistsOf(w, p.faction)) if (o.id !== baby.id) addCondition(w, o, 'newborn');
  w.message(p.faction, `${p.name} and ${q.name} have a child: ${baby.name} was born today.`, 'good', w.cellOf(baby));
  tell(w, p.faction, `${baby.name} was born to ${p.name} and ${q.name}.`, 'first_birth');
}

/** Children grow up: the child trait goes, and they find a trait of their own. */
function growUp(w: World, p: Pawn, s: Social): void {
  if (!isChild(p)) return;
  if (s.born === undefined) {
    s.born = w.tick;
    return;
  }
  if (w.tick - s.born < CHILD_DAYS * TICKS_PER_DAY) return;
  p.traits = p.traits.filter((t) => t !== 'child');
  const own = w.rollTraits().find((t) => !p.traits.some((o) => TRAITS[t]?.conflicts?.includes(o) || o === t));
  if (own) p.traits.push(own);
  delete s.born;
  w.markDirty(p);
  const what = own ? `, ${TRAITS[own].label.toLowerCase()}` : '';
  w.message(p.faction, `${p.name} has grown up${what}, and will pull their weight now.`, 'good', w.cellOf(p));
  tell(w, p.faction, `${p.name} grew up.`);
}

/** Warn once when someone is close to breaking, naming what's weighing on them. */
function edge(w: World, p: Pawn, s: Social): void {
  const mood = p.needs.mood;
  if (s.edge && mood > RECOVER_MOOD) {
    delete s.edge;
    return;
  }
  if (s.edge || mood >= EDGE_MOOD || isMental(p) || p.downed) return;
  s.edge = true;
  const worst = p.thoughts
    .map((t) => {
      const m = /^(.*) ([+-]?\d+)$/.exec(t);
      return m ? { label: m[1], v: Number(m[2]) } : null;
    })
    .filter((x): x is { label: string; v: number } => !!x && x.v < 0)
    .sort((a, b) => a.v - b.v)
    .slice(0, 3)
    .map((x) => x.label.toLowerCase());
  const why = worst.length ? ` What's weighing on ${first(p)}: ${worst.join(', ')}.` : '';
  w.message(p.faction, `${p.name} is close to breaking.${why}`, 'bad', w.cellOf(p));
}

/** Southerners down tools rather than work outdoors in a freeze. */
function coldStrike(w: World, p: Pawn): void {
  let limit = Infinity;
  for (const t of p.traits) {
    const c = TRAITS[t]?.coldStrike;
    if (c !== undefined) limit = Math.min(limit, c);
  }
  if (limit === Infinity || p.drafted || p.downed || p.possessed || p.asleep || isMental(p)) return;
  const jt = p.job?.type;
  if (!jt || jt === 'eat' || jt === 'sleep' || jt === 'warm' || jt === 'wander' || jt === 'shelter' || jt === 'trek' || jt === 'attack' || jt === 'hold' || jt === 'goto') return;
  const cell = w.cellOf(p);
  if (!w.outdoors(cell) || w.tempAt(cell) >= limit) return;
  if (!w.rng.chance(0.3)) return;
  if (!addCondition(w, p, 'cold_strike')) return;
  endJob(w, p);
  w.message(p.faction, `${p.name} refuses to work out in this cold, and has gone to find somewhere warm.`, 'neutral', cell);
}

// ---------------------------------------------------------------- mood, breaks, death

/** Mood from bonds: a lover, a friend close by, a rival who won't leave them be. */
export function socialThoughts(w: World, p: Pawn): [string, number][] {
  const s = p.social;
  if (!s) return [];
  const out: [string, number][] = [];
  const here = w.cellOf(p);
  if (s.love) {
    const q = w.get<Pawn>(s.love);
    if (q && q.kind === 'pawn') out.push([`In love with ${first(q)}`, 0.08]);
  }
  let friend = false;
  let rival: Pawn | null = null;
  for (const key of Object.keys(s.op)) {
    const v = s.op[Number(key)];
    if (v > RIVAL_AT && v < FRIEND_AT) continue;
    const q = w.get<Pawn>(Number(key));
    if (!q || q.kind !== 'pawn' || q.id === s.love) continue;
    const d = w.dist(here, w.cellOf(q));
    if (!friend && v >= FRIEND_AT && opinion(q, p.id) >= FRIEND_AT && d <= 10) friend = true;
    if (!rival && v <= RIVAL_AT && d <= 6) rival = q;
  }
  if (friend) out.push(['Near a friend', 0.04]);
  if (rival) out.push([`Has to put up with ${first(rival)}`, -0.05]);
  return out;
}

/** A volatile mind with a rival close by snaps at them instead of sulking. True if it did. */
export function socialBreak(w: World, p: Pawn): boolean {
  const s = p.social;
  if (!s || !canTalk(w, p)) return false;
  const here = w.cellOf(p);
  for (const key of Object.keys(s.op)) {
    if (s.op[Number(key)] > RIVAL_AT) continue;
    const q = w.get<Pawn>(Number(key));
    if (!q || q.kind !== 'pawn' || !canTalk(w, q) || w.dist(here, w.cellOf(q)) > 3) continue;
    if (!w.rng.chance(0.6)) return false;
    brawl(w, p, q, ` when ${first(p)} finally snapped`);
    return true;
  }
  return false;
}

/** Someone died: their lover's heart breaks, their friends grieve, and everyone forgets their opinion. */
export function socialOnDeath(w: World, dead: Pawn): void {
  for (const o of colonistsOf(w, dead.faction)) {
    const s = o.social;
    if (!s) continue;
    if (s.love === dead.id) {
      delete s.love;
      delete s.loveSince;
      addCondition(w, o, 'heartbroken');
      w.message(o.faction, `${o.name} is heartbroken over ${dead.name}.`, 'bad', w.cellOf(o));
      tell(w, o.faction, `${o.name} lost ${dead.name}, the one they loved.`);
    } else if ((s.op[dead.id] ?? 0) >= FRIEND_AT && opinion(dead, o.id) >= FRIEND_AT) {
      addCondition(w, o, 'lost_friend');
    }
    delete s.op[dead.id];
    w.markDirty(o);
  }
}

/** The pair in a colony who get on worst (with a little chance in it), for a quarrel. */
export function worstPair(w: World, faction: number): [Pawn, Pawn] | null {
  const ps = colonistsOf(w, faction).filter((p) => !p.downed && !isChild(p));
  let best: [Pawn, Pawn] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      if (a.social?.love === b.id) continue;
      const score = opinion(a, b.id) + opinion(b, a.id) + w.rng.range(0, 30);
      if (score < bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }
  return best;
}

/** Shift how two colonists feel about each other (and say if that makes or breaks a bond). */
export function warmTo(w: World, p: Pawn, q: Pawn, by: number, back = by): void {
  const before = bondOf(p, q);
  adjust(p, q.id, by);
  adjust(q, p.id, back);
  w.markDirty(p);
  w.markDirty(q);
  announce(w, p, q, before, bondOf(p, q));
}

