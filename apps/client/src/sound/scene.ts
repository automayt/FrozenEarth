import { T } from '@fe/defs';
import type { Mirror } from '@fe/protocol';
import { calendar, frostDistance, frostLevel, frostRadius, outdoorTempAt } from '@fe/sim';
import { darknessAt } from '../render/light';

/**
 * What's around the camera, and what that should sound like. Sampled a few times a second, not
 * every frame; both halves are plain functions of the world, so they can be tested without audio.
 */

export type Precip = 'none' | 'rain' | 'storm' | 'snow' | 'blizzard' | 'ash';

/** What the sampler needs from the mirror. */
export type SceneMirror = Pick<Mirror, 'w' | 'h' | 'terrain' | 'fire' | 'fireCells' | 'buildingAt' | 'plantAt' | 'frost' | 'coldOffset' | 'conditions' | 'entities'>;

export interface Scene {
  hour: number;
  season: 'Spring' | 'Summer' | 'Fall' | 'Winter';
  /** Outdoor °C. */
  temp: number;
  /** 0 midday .. 1 deep night. */
  dark: number;
  /** 0 far from the frost line .. 1 at it or beyond. */
  frostNear: number;
  /** 0 on open ground .. 1 looking down on frozen land. */
  frozen: number;
  /** How much water is close by, and which side it's on (-1 left .. 1 right). */
  water: number;
  waterPan: number;
  fire: number;
  firePan: number;
  /** How much living cover (trees, plants) is around. */
  green: number;
  /** 0 at normal zoom .. 1 pulled all the way out. */
  altitude: number;
  precip: Precip;
  /** Wind from the weather, 0..1. */
  wind: number;
}

/** Tuning: how far from the camera water and fire are heard, in cells. */
const NEAR_MIN = 14;
const NEAR_MAX = 44;
/** Tuning: most cells looked at per side of the sampled square. */
const SAMPLE_SIDE = 34;
/** Tuning: how far inside the line the wind starts to rise, in frost-radius units. */
const FROST_NEAR_BAND = 0.3;
/** At most this many burning cells are looked at: a forest fire can be thousands. */
const FIRE_SAMPLE = 300;
/** Views wider than ALT_LOW cells count as high; ALT_HIGH is all the way out. */
const ALT_LOW = 55;
const ALT_HIGH = 220;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const rise = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const WATER = new Uint8Array(32);
WATER[T.deep_water] = 10;
WATER[T.shallow_water] = 10;
WATER[T.marsh] = 3;

function loudFor(amount: number, k: number): number {
  return 1 - Math.exp(-amount * k);
}

/** Look at the cells around the camera (cx, cy in cells; span = cells across the view). */
export function sampleScene(m: SceneMirror, cx: number, cy: number, span: number, tick: number, precip: Precip, wind: number): Scene {
  const cal = calendar(tick);
  const active = new Set<string>();
  for (const c of m.conditions) active.add(c.key);
  const radius = frostRadius(tick, m.frost);
  const here = frostDistance(cx, cy, m.w, m.h);
  const near = Math.max(NEAR_MIN, Math.min(NEAR_MAX, span / 2));
  const step = Math.max(1, Math.floor((near * 2) / SAMPLE_SIDE));
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  let weight = 0;
  let wet = 0;
  let wetX = 0;
  let burn = 0;
  let burnX = 0;
  let green = 0;
  const r = Math.ceil(near);
  // The stride grows with the view, so each cell looked at stands for more of the ground.
  const area = step * step;
  for (let dy = -r; dy <= r; dy += step) {
    const y = y0 + dy;
    if (y < 0 || y >= m.h) continue;
    for (let dx = -r; dx <= r; dx += step) {
      const x = x0 + dx;
      if (x < 0 || x >= m.w) continue;
      const d = Math.hypot(dx, dy) / near;
      if (d >= 1) continue;
      // The nearest cells count for the most.
      const w = (1 - d) * (1 - d);
      const c = y * m.w + x;
      weight += w;
      const water = WATER[m.terrain[c]];
      if (water) {
        wet += w * water * 0.1;
        wetX += w * water * 0.1 * dx;
      }
      if (m.plantAt[c]) green += w;
      const id = m.buildingAt[c];
      if (id) {
        const def = (m.entities.get(id) as { def?: string } | undefined)?.def;
        if (def === 'campfire') {
          burn += w * 2.5 * area;
          burnX += w * 2.5 * area * dx;
        } else if (def === 'hot_spring') {
          wet += w * 2;
          wetX += w * 2 * dx;
        }
      }
    }
  }
  // Burning cells are found directly: a stride over the map could step right over them.
  let seen = 0;
  for (const c of m.fireCells) {
    if (seen++ >= FIRE_SAMPLE) break;
    const dx = (c % m.w) - x0;
    const dy = Math.floor(c / m.w) - y0;
    const d = Math.hypot(dx, dy) / near;
    if (d >= 1) continue;
    const w = (1 - d) * (1 - d) * (0.6 + m.fire[c] * 0.4);
    burn += w;
    burnX += w * dx;
  }
  const altitude = rise(span, ALT_LOW, ALT_HIGH);
  return {
    hour: cal.hour,
    season: cal.season,
    temp: outdoorTempAt(tick, m.coldOffset, m.conditions),
    dark: darknessAt(cal.hour, active),
    frostNear: clamp01(1 - (radius - here) / FROST_NEAR_BAND),
    frozen: frostLevel(cx, cy, m.w, m.h, radius),
    water: weight ? loudFor(wet / weight, 5) : 0,
    waterPan: wet ? Math.max(-1, Math.min(1, (wetX / wet / near) * 1.6)) : 0,
    fire: loudFor(burn, 0.5),
    firePan: burn ? Math.max(-1, Math.min(1, (burnX / burn / near) * 1.6)) : 0,
    green: weight ? clamp01((green / weight) * 3) : 0,
    altitude,
    precip,
    wind,
  };
}

/** How present each layer should be, 0..1; for the calls, 0..1 is how often they come. */
export interface Layers {
  wind: number;
  /** The thin high edge of the wind: it only appears when it really blows. */
  whistle: number;
  rain: number;
  water: number;
  fire: number;
  insects: number;
  crickets: number;
  birds: number;
  wolves: number;
  thunder: number;
  ice: number;
}

/** How alive each season is with small things. */
const SEASON_LIFE = { Spring: 0.8, Summer: 1, Fall: 0.45, Winter: 0 } as const;
const SEASON_WOLVES = { Spring: 0.5, Summer: 0.35, Fall: 0.8, Winter: 1 } as const;

const QUIET: Layers = { wind: 0, whistle: 0, rain: 0, water: 0, fire: 0, insects: 0, crickets: 0, birds: 0, wolves: 0, thunder: 0, ice: 0 };

/** Silence, for when the page is hidden. */
export function quietLayers(): Layers {
  return { ...QUIET };
}

/** The whole mapping from world to sound. Everything crossfades because these all move continuously. */
export function layerTargets(s: Scene): Layers {
  const frost = Math.max(s.frostNear, s.frozen);
  const heavy = s.precip === 'storm' || s.precip === 'blizzard';
  const falling = heavy ? 1 : s.precip === 'rain' ? 0.65 : s.precip === 'ash' ? 0.4 : 0;
  const cold = rise(-s.temp, -2, 14);
  const wind = clamp01(0.08 + s.wind * 0.72 + frost * 0.42 + cold * 0.16 + s.altitude * 0.1);
  // From high up the ground's small sounds are lost, but the wind isn't.
  const ground = 1 - s.altitude * 0.9;
  // Small life goes quiet near the cold, in the wet, and in the wrong season.
  const life = SEASON_LIFE[s.season] * (1 - frost) * (1 - falling) * rise(s.temp, 3, 11) * ground;
  const day = 1 - rise(s.dark, 0.05, 0.4);
  const evening = s.hour >= 17 ? rise(s.hour, 18, 20) * (1 - rise(s.hour, 22.5, 24)) : s.hour < 5 ? 0.45 * (1 - rise(s.hour, 3, 5)) : 0;
  const night = rise(s.dark, 0.6, 0.95);
  return {
    wind,
    whistle: rise(wind, 0.42, 1),
    rain: s.precip === 'storm' ? 1 : s.precip === 'rain' ? 0.6 : 0,
    water: s.water * ground,
    fire: s.fire * ground,
    insects: life * day * rise(s.temp, 12, 19) * (0.5 + 0.5 * s.green),
    crickets: life * evening,
    birds: life * day * (0.35 + 0.65 * s.green),
    wolves: night * SEASON_WOLVES[s.season] * (1 - falling) * ground,
    thunder: s.precip === 'storm' ? 1 : 0,
    ice: rise(frost, 0.55, 1) * (1 - s.altitude * 0.6),
  };
}
