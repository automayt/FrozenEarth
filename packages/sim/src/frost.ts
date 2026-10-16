import { START_TICK, TICKS_PER_DAY, DAYS_PER_SEASON, SEASONS } from './constants';

/**
 * The frost line: permanent winter creeping in from the map edge toward the center.
 *
 * Positions are measured as a fraction of the map's half-size from the center, so 0 is the
 * center, 1 is the middle of an edge and about 1.41 is a corner. Everything further out than
 * the current radius is frozen. It is a pure function of time, so the client computes the same
 * line the server does without any syncing.
 */
export interface FrostParams {
  /** Days into the game before the front starts moving. */
  startDay: number;
  /** Speed multiplier. 1 = the default pace. */
  pace: number;
  /** The front never closes in past this radius: the last refuge at the center. */
  minRadius: number;
}

export const DEFAULT_FROST: FrostParams = { startDay: 8, pace: 1, minRadius: 0.18 };

/** Radius before the front starts: just outside the corners. */
export const FROST_MAX = 1.45;
/** Width of the transition band, as a fraction of half-size. */
export const FROST_BAND = 0.08;
/** Degrees colder at the frozen side of the band. */
export const FROST_COLD = 28;

/** How hard the front pushes in each season (spring, summer, fall, winter). */
const SEASON_PUSH = [0.35, 0.15, 1, 1.5];
/** Radius lost per day at full push, before pace and slowdown. */
const BASE_RATE = 0.032;

const cache = new Map<string, number[]>();

/** Radius at the start of each game day, computed incrementally and memoised per parameter set. */
function radiusByDay(p: FrostParams, day: number): number[] {
  const key = `${p.startDay}:${p.pace}:${p.minRadius}`;
  let arr = cache.get(key);
  if (!arr) {
    arr = [FROST_MAX];
    cache.set(key, arr);
  }
  while (arr.length <= day + 1) {
    const d = arr.length - 1;
    const r = arr[d];
    let next = r;
    if (d >= p.startDay) {
      const absoluteDay = d + START_TICK / TICKS_PER_DAY;
      const season = Math.floor(absoluteDay / DAYS_PER_SEASON) % SEASONS.length;
      // Slows as it nears the center: the last stretch is the hardest won.
      const slow = Math.max(0.25, Math.sqrt(Math.max(0, r - p.minRadius) / (FROST_MAX - p.minRadius)));
      next = Math.max(p.minRadius, r - BASE_RATE * SEASON_PUSH[season] * p.pace * slow);
    }
    arr.push(next);
  }
  return arr;
}

/** Current frost radius at a tick. */
export function frostRadius(tick: number, p: FrostParams = DEFAULT_FROST): number {
  const days = Math.max(0, (tick - START_TICK) / TICKS_PER_DAY);
  const d = Math.floor(days);
  const arr = radiusByDay(p, d);
  // Smooth within the day.
  return arr[d] + (arr[d + 1] - arr[d]) * (days - d);
}

/** Normalised distance of a cell from the map center. */
export function frostDistance(x: number, y: number, w: number, h: number): number {
  const half = Math.min(w, h) / 2;
  return Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / half;
}

/** 0 = untouched, 1 = fully frozen; ramps across the band just outside the radius. */
export function frostLevel(x: number, y: number, w: number, h: number, radius: number): number {
  const d = frostDistance(x, y, w, h);
  return Math.max(0, Math.min(1, (d - radius) / FROST_BAND));
}

/** Days until the front reaches a cell (Infinity if it never will), looking ahead up to `horizon` days. */
export function daysUntilFrost(x: number, y: number, w: number, h: number, tick: number, p: FrostParams = DEFAULT_FROST, horizon = 120): number {
  const d = frostDistance(x, y, w, h);
  if (frostRadius(tick, p) <= d) return 0;
  for (let k = 1; k <= horizon; k++) {
    if (frostRadius(tick + k * TICKS_PER_DAY, p) <= d) return k;
  }
  return Infinity;
}
