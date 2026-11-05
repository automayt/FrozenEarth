import type { Mirror } from '@fe/protocol';

/**
 * The composer: which notes, when, and how tense things are. All plain functions of a random
 * source and the world, so the shape of a long session can be checked without hearing it.
 */

export type Rng = () => number;

export type Voice = 'pad' | 'pluck' | 'glass' | 'low' | 'drum';

export interface NoteEvent {
  /** Seconds from the start of the phrase. */
  at: number;
  voice: Voice;
  /** Semitones from the sample's own pitch. */
  semi: number;
  vel: number;
  pan: number;
}

export interface Phrase {
  events: NoteEvent[];
  /** Seconds until the last note has rung out. */
  length: number;
  /** Seconds of silence after it. */
  rest: number;
}

export interface Mood {
  /** 0 an ordinary day .. 1 deep winter at the frost line: fewer notes, further apart, higher and glassier. */
  sparse: number;
}

/** Tuning: silence between phrases, in seconds. Most of a long session is meant to have no music in it. */
export const REST_MIN = 75;
export const REST_RANGE = 150;
/** Tuning: seconds between melody notes, before sparseness stretches them. */
const SPACINGS = [2.4, 3.2, 4.8, 6.4];
/** Natural minor without its second-darkest notes: open and cold, and nothing here can clash. */
const SCALE = [-12, -9, -5, -2, 0, 2, 3, 7, 10, 12, 14, 15, 19];
/** Winter's version: only the bare bones. */
const BARE = [-12, -5, 0, 3, 7, 12, 15, 19];
/** Pad roots: all inside the same scale, so the melody needn't know which it is over. */
const ROOTS = [0, -4, 3, -2];
const STEPS = [-2, -1, -1, 0, 1, 1, 2];

const pick = <T>(list: readonly T[], rng: Rng): T => list[Math.floor(rng() * list.length) % list.length];

/** One calm phrase: maybe a held chord, and a slow wandering line over it. */
export function composeCalm(mood: Mood, rng: Rng): Phrase {
  const sparse = Math.max(0, Math.min(1, mood.sparse));
  const scale = sparse > 0.5 ? BARE : SCALE;
  const root = pick(ROOTS, rng);
  const events: NoteEvent[] = [];
  if (rng() < 0.75) events.push({ at: 0, voice: 'pad', semi: root, vel: 0.7 + rng() * 0.3, pan: 0 });
  let t = 3 + rng() * 5;
  const notes = Math.round(4 + rng() * (9 - 5 * sparse));
  let i = Math.floor(scale.length / 2) + Math.floor(rng() * 3) - 1;
  for (let n = 0; n < notes; n++) {
    const voice: Voice = rng() < 0.12 + 0.4 * sparse ? 'glass' : 'pluck';
    // Glass is sampled two octaves up.
    const semi = scale[i] - (voice === 'glass' ? 12 : 0);
    const pan = (rng() - 0.5) * 0.8;
    events.push({ at: t, voice, semi, vel: 0.5 + rng() * 0.4, pan });
    if (rng() < 0.14 && i + 1 < scale.length) events.push({ at: t + 0.38, voice, semi: scale[i + 1] - (voice === 'glass' ? 12 : 0), vel: 0.35, pan });
    i = Math.max(0, Math.min(scale.length - 1, i + pick(STEPS, rng)));
    t += pick(SPACINGS, rng) * (1 + 0.6 * sparse) * (0.85 + rng() * 0.3);
  }
  return { events, length: t + 8, rest: REST_MIN + rng() * REST_RANGE + sparse * 45 };
}

/** The next thing the tense layer does, and how long until the one after: never a pulse you can count. */
export function composeTense(level: number, rng: Rng): { wait: number; events: NoteEvent[] } {
  const wait = (13 - 8 * level) * (0.7 + rng() * 0.6);
  const events: NoteEvent[] = [];
  if (rng() < 0.55) {
    const hits = 1 + Math.floor(rng() * (1 + 2.5 * level));
    let t = 0;
    for (let n = 0; n < hits; n++) {
      events.push({ at: t, voice: 'drum', semi: pick([0, 0, -2], rng), vel: 0.5 + 0.4 * level - n * 0.08, pan: (rng() - 0.5) * 0.3 });
      t += pick([0.42, 0.62, 0.84], rng);
    }
  } else {
    events.push({ at: 0, voice: 'low', semi: pick([0, -2, -5, 1, 3], rng), vel: 0.6 + 0.3 * level, pan: 0 });
  }
  return { wait, events };
}

// ------------------------------------------------------------------- tension

export interface TensionInput {
  /** Raiders on the map against us. */
  raiders: number;
  /** A chief's demand is waiting for an answer. */
  demand: boolean;
  /** Blows being struck close enough to hear. */
  fighting: boolean;
  lastStand: boolean;
}

/** Tuning: how tense each situation is. */
export function tensionTarget(i: TensionInput): number {
  if (i.lastStand) return 1;
  if (i.raiders > 0 && i.fighting) return 0.85;
  if (i.demand || i.raiders > 0) return 0.55;
  if (i.fighting) return 0.4;
  return 0;
}

/** Tuning: seconds to come up, seconds it stays after the danger has passed, and seconds to let go. */
const RISE_S = 5;
const HOLD_S = 25;
const FALL_S = 30;

/** Follows the target: quick to rise, slow to trust that it's over. */
export class Tension {
  level = 0;
  private hold = 0;

  update(target: number, dt: number): number {
    if (target >= this.level) {
      this.level = Math.min(target, this.level + dt / RISE_S);
      this.hold = HOLD_S;
    } else if (this.hold > 0) {
      this.hold -= dt;
    } else {
      this.level = Math.max(target, this.level - dt / FALL_S);
    }
    return this.level;
  }
}

export type TensionMirror = Pick<Mirror, 'factions' | 'choices'>;

/** Read the danger to one colony from the mirror. */
export function tensionFrom(m: TensionMirror, me: number, tick: number, fighting: boolean): TensionInput {
  const out: TensionInput = { raiders: 0, demand: false, fighting, lastStand: false };
  if (!me) return out;
  for (const f of m.factions.values()) {
    const r = f.raid;
    if (!r || r.target !== me || r.fled || r.camp) continue;
    out.raiders += Math.max(0, r.size - r.dead);
    if (r.parley && r.parley > tick) out.demand = true;
    if (r.lastStand) out.lastStand = true;
  }
  if (m.choices.some((c) => c.faction === me && c.event === 'raid_demand')) out.demand = true;
  return out;
}

// ------------------------------------------------------------------- moments

export type Cue = 'raid' | 'firstRaid' | 'chief' | 'death' | 'frost' | 'thaw';

/** The Moments banners big enough for music. Everything else keeps its chime. */
export function cueForMoment(title: string, raidHeard: boolean): Cue | null {
  switch (title) {
    case 'Raiders!':
    case 'Ambush!':
      return raidHeard ? 'raid' : 'firstRaid';
    case 'Pay or fight':
    case 'Last stand':
    case 'War':
      return 'raid';
    case 'The chief is down!':
      return 'chief';
    case 'The frost is here':
      return 'frost';
    case 'A town has fallen':
      return 'death';
    default:
      return null;
  }
}

/** A letter saying someone died: whose name and colony. Null if it isn't one. */
export function deathIn(text: string): { name: string; colony: string } | null {
  const m = /^(.+) of (.+) has died of /.exec(text);
  return m ? { name: m[1], colony: m[2] } : null;
}
