/**
 * The curves behind the world's small animations, kept apart from Pixi so they can be tested.
 * All purely visual: nothing here feeds back into the game.
 */

/** One full swing of an axe, pick or hammer, and of a gentler job (hoeing, crafting, tending). */
export const HEAVY_SWING_MS = 760;
export const GENTLE_SWING_MS = 900;
/** Where in a swing the tool lands. */
export const HEAVY_STRIKE = 0.78;
export const GENTLE_STRIKE = 0.25;

/** A heavy swing, -1 (arms back) to 1 (tool down): a slow wind-up, a fast blow, then a recovery. */
export function heavySwing(p: number): number {
  if (p < 0.62) {
    const k = p / 0.62;
    return -(1 - (1 - k) * (1 - k));
  }
  if (p < HEAVY_STRIKE) {
    const k = (p - 0.62) / (HEAVY_STRIKE - 0.62);
    return -1 + 2 * k * k;
  }
  const k = (p - HEAVY_STRIKE) / (1 - HEAVY_STRIKE);
  return 1 - k;
}

export function gentleSwing(p: number): number {
  return Math.sin(p * Math.PI * 2);
}

/** Whether the point `at` was passed going from `was` to `is`, on a 0..1 loop. */
export function passed(was: number, is: number, at: number): boolean {
  return was <= is ? was < at && at <= is : at > was || at <= is;
}

/** How long a felled tree takes to reach the ground, then rebound, then fade. */
export const FELL_MS = 640;
export const REBOUND_MS = 170;
export const SETTLE_MS = 1000;

export interface FellPose {
  /** Share of the tree's length the crown has travelled from the stump. */
  reach: number;
  /** The crown seen from the side: flatter along the line of the fall. */
  squash: number;
  alpha: number;
}

/** A falling tree at `ms` after the last cut: slow to go, then all at once, a small bounce, and it fades. */
export function fellPose(ms: number): FellPose {
  if (ms < FELL_MS) {
    const k = ms / FELL_MS;
    const s = Math.sin((Math.PI / 2) * Math.pow(k, 2.4));
    return { reach: s, squash: 1 - 0.28 * s, alpha: 1 };
  }
  if (ms < FELL_MS + REBOUND_MS) {
    const k = (ms - FELL_MS) / REBOUND_MS;
    return { reach: 1 - 0.07 * Math.sin(k * Math.PI), squash: 0.72, alpha: 1 };
  }
  const k = Math.min(1, (ms - FELL_MS - REBOUND_MS) / SETTLE_MS);
  return { reach: 1, squash: 0.72, alpha: k < 0.35 ? 1 : 1 - (k - 0.35) / 0.65 };
}

/** The way a tree falls: away from whoever cut it, or any way at all if nobody did. */
export function fellAngle(treeX: number, treeY: number, by: { x: number; y: number } | null | undefined, random: number): number {
  if (by && (by.x !== treeX || by.y !== treeY)) return Math.atan2(treeY - by.y, treeX - by.x);
  return random * Math.PI * 2;
}

/** Steps a building rises through, bottom up. */
export const RISE_STEPS = 24;

export function riseStep(share: number): number {
  return Math.max(1, Math.min(RISE_STEPS, Math.ceil(share * RISE_STEPS)));
}

/** How a building site looks: the blueprint with goods piling up, then the thing itself rising. */
export function siteStage(need: number, got: number, progress: number, work: number): { ready: boolean; pile: number; rise: number } {
  const ready = got >= need;
  return { ready, pile: ready || need <= 0 ? 0 : Math.ceil((Math.min(got, need) / need) * 3), rise: ready ? Math.min(1, progress / work) : 0 };
}

/** Degrees below which you can see someone's breath. */
export const BREATH_BELOW = 3;

/** Ms between breaths: quicker when moving or working, slow in sleep. */
export function breathGap(busy: boolean, asleep: boolean, random: number): number {
  return (asleep ? 4400 : busy ? 1700 : 2900) + random * 800;
}

/** The ground underfoot, as far as what a step leaves on it goes. */
export type Footing = 'snow' | 'sand' | 'mud' | 'dirt' | 'water' | null;

/** Frost this deep lies thick enough to take a print. */
const SNOW_FROST = 0.25;

export function footingOf(terrain: string, frost: number, indoors: boolean, wet: boolean): Footing {
  if (indoors) return null;
  if (terrain === 'shallow_water') return frost >= SNOW_FROST ? 'snow' : 'water';
  if (frost >= SNOW_FROST) return 'snow';
  switch (terrain) {
    case 'sand':
      return 'sand';
    case 'marsh':
      return 'mud';
    case 'soil':
    case 'rich_soil':
      return wet ? 'dirt' : null;
    default:
      return null;
  }
}

/** A grazing dip of the head, 0..1, on a slow loop of its own for each animal. */
export function grazeDip(seconds: number, id: number): number {
  const p = (seconds * 0.17 + id * 0.37) % 1;
  return p < 0.24 ? Math.sin((p / 0.24) * Math.PI) : 0;
}

/** A stack is drawn at one of five fill levels: 1 is a fifth full or less, 5 is full. Empty stacks are gone. */
export const PILE_LEVELS = 5;

export function pileLevel(count: number, limit: number): number {
  return Math.max(1, Math.min(PILE_LEVELS, Math.ceil((count / Math.max(1, limit)) * PILE_LEVELS)));
}
