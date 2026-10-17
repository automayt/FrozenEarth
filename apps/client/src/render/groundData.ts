/**
 * Pure data for the ground shader (render/ground.ts): how each terrain is drawn, the per-cell
 * index texels, water depth, the noise texture and the texture atlas layout. Nothing here touches
 * the GPU, so tests can run it.
 */

/** How the ground shader treats a terrain: blended natural ground, a crisp built floor, open water or ice. */
export const KIND = { land: 0, floor: 1, water: 2, ice: 3 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export interface TerrainLike {
  id: number;
  key: string;
  color: number;
}

export function terrainKind(key: string): Kind {
  if (key === 'ice') return KIND.ice;
  if (key.endsWith('_water')) return KIND.water;
  if (key.endsWith('_floor') || key.endsWith('_tile')) return KIND.floor;
  return KIND.land;
}

/**
 * The texture a terrain is painted with. Every rough_* floor (rough_stone, rough_limestone...)
 * shares the rough stone texture, tinted by its own colour. Water has none (the shader paints it).
 */
export function textureKey(key: string): string | null {
  if (terrainKind(key) === KIND.water) return null;
  if (key.startsWith('rough_')) return 'terrain_rough_stone';
  return `terrain_${key}`;
}

/** Cells one texture repeat covers. Floors line their pattern up with the cell grid. */
export function repeatCells(key: string): number {
  if (key === 'stone_tile') return 4; // 4x4 flagstones a texture: one flagstone a cell
  if (key === 'wood_floor') return 2; // 6 boards a texture: three boards a cell
  return 4;
}

/**
 * How much of a texture's own contrast is kept: the painted renders are busy up close, and the
 * ground should stay calm under pawns, plants and items.
 */
export function textureContrast(key: string): number {
  switch (key) {
    case 'terrain_soil':
      return 0.4;
    case 'terrain_rich_soil':
      return 0.65;
    case 'terrain_gravel':
      return 0.55;
    case 'terrain_sand':
      return 0.6;
    case 'terrain_rough_stone':
    case 'terrain_marsh':
      return 0.7;
    case 'terrain_ice':
      return 0.8;
    default:
      return 1;
  }
}

/** Extra height given to a terrain when edges are blended: higher ground wins a contested edge. */
function heightBias(key: string): number {
  if (key === 'gravel' || key.startsWith('rough_')) return 0.3;
  if (key === 'rich_soil') return 0.05;
  if (key === 'marsh') return 0.12;
  if (key === 'sand') return 0.0;
  return 0.12;
}

/** Atlas geometry: square slots of TILE texels with a GUTTER of wrapped texels around each. */
export const ATLAS_TILE = 512;
export const ATLAS_GUTTER = 16;
export const ATLAS_SLOT = ATLAS_TILE + 2 * ATLAS_GUTTER;
export const ATLAS_COLS = 4;
/** Width of the params texture: the most terrain ids the shader can tell apart. */
export const PARAM_W = 64;

export interface AtlasPlan {
  /** Texture key per slot, in slot order. */
  keys: string[];
  /** Slot per terrain id, or -1 for water. */
  slotOf: number[];
}

/** One atlas slot per distinct texture, in terrain order, plus a final neutral slot. */
export function planAtlas(terrains: readonly TerrainLike[]): AtlasPlan {
  const keys: string[] = [];
  const slotOf: number[] = [];
  for (const t of terrains) {
    const k = textureKey(t.key);
    if (!k) {
      slotOf[t.id] = -1;
      continue;
    }
    let s = keys.indexOf(k);
    if (s < 0) s = keys.push(k) - 1;
    slotOf[t.id] = s;
  }
  return { keys, slotOf };
}

/**
 * Per-terrain shader parameters, PARAM_W x 2 RGBA texels:
 * row 0 = (slot, kind, height bias, repeat / 32), row 1 = (tint rgb / 2, marsh puddles).
 * `means` is each slot's average colour ([r, g, b] 0..255), or undefined when that slot was filled
 * procedurally from the terrain colour; a terrain sharing a slot with another (rough_limestone on
 * the rough stone texture) is tinted toward its own colour.
 */
export function buildParams(terrains: readonly TerrainLike[], plan: AtlasPlan, means: (readonly number[] | undefined)[], bedSlot: number): Uint8Array {
  const out = new Uint8Array(PARAM_W * 2 * 4);
  for (const t of terrains) {
    if (t.id < 0 || t.id >= PARAM_W) continue;
    const kind = terrainKind(t.key);
    const slot = plan.slotOf[t.id] >= 0 ? plan.slotOf[t.id] : bedSlot;
    const o = t.id * 4;
    out[o] = slot;
    out[o + 1] = kind;
    out[o + 2] = Math.round(heightBias(t.key) * 255);
    out[o + 3] = Math.round((repeatCells(t.key) / 32) * 255);
    const mean = plan.slotOf[t.id] >= 0 ? means[slot] : undefined;
    const rgb = [(t.color >> 16) & 255, (t.color >> 8) & 255, t.color & 255];
    const r = PARAM_W * 4 + o;
    for (let i = 0; i < 3; i++) {
      let k = 1;
      if (mean && mean[i] > 1) {
        // The texture's own slot keeps most of its painted colour (pulled 35% toward the terrain
        // colour, so the minimap still matches); a borrowed texture takes the terrain's colour.
        const own = textureKey(t.key) === `terrain_${t.key}`;
        k = Math.pow(rgb[i] / mean[i], own ? 0.35 : 1);
      }
      out[r + i] = Math.round(Math.max(0, Math.min(2, k)) * 127.5);
    }
    out[r + 3] = t.key === 'marsh' ? 255 : 0;
  }
  return out;
}

/** Water depth, 0 at the shore to 1 about six cells out; deep water is never shallower than this. */
const DEEP_MIN = 0.55;
const SHALLOW_MAX = 0.5;
const DEPTH_REACH = 6;

let scratch = new Float32Array(0);

/**
 * Write index texels (R terrain id, G water depth, B 0, A 255) for cells x0..x1, y0..y1
 * (inclusive). Depth looks DEPTH_REACH cells around, so callers widen their window by that much
 * when the extent of water may have changed. `kinds[id]` and `deep[id]` describe each terrain id.
 */
export function writeIndex(out: Uint8Array, terrain: ArrayLike<number>, w: number, h: number, kinds: ArrayLike<number>, deep: ArrayLike<number>, x0: number, y0: number, x1: number, y1: number): void {
  const R = DEPTH_REACH;
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w - 1, x1);
  y1 = Math.min(h - 1, y1);
  if (x1 < x0 || y1 < y0) return;
  // Distance to the nearest dry cell, by a two-pass chamfer over the window plus its reach (a
  // straight line from a window cell to any dry cell within reach stays inside that rectangle).
  const X0 = Math.max(0, x0 - R);
  const Y0 = Math.max(0, y0 - R);
  const X1 = Math.min(w - 1, x1 + R);
  const Y1 = Math.min(h - 1, y1 + R);
  const rw = X1 - X0 + 1;
  const rh = Y1 - Y0 + 1;
  if (scratch.length < rw * rh) scratch = new Float32Array(rw * rh);
  const d = scratch;
  const FAR = 1e6;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const k = kinds[terrain[(Y0 + y) * w + X0 + x]];
      d[y * rw + x] = k === KIND.water || k === KIND.ice ? FAR : 0;
    }
  }
  const D = Math.SQRT2;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - rw] + 1);
        if (x > 0) v = Math.min(v, d[i - rw - 1] + D);
        if (x < rw - 1) v = Math.min(v, d[i - rw + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = rh - 1; y >= 0; y--) {
    for (let x = rw - 1; x >= 0; x--) {
      const i = y * rw + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < rw - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < rh - 1) {
        v = Math.min(v, d[i + rw] + 1);
        if (x < rw - 1) v = Math.min(v, d[i + rw + 1] + D);
        if (x > 0) v = Math.min(v, d[i + rw - 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = y * w + x;
      const id = terrain[c];
      const k = kinds[id];
      let depth = 0;
      if (k === KIND.water || k === KIND.ice) {
        depth = Math.max(0, Math.min(1, (d[(y - Y0) * rw + x - X0] - 1) / (R - 1)));
        depth = deep[id] ? Math.max(DEEP_MIN, depth) : Math.min(SHALLOW_MAX, depth);
      }
      const o = c * 4;
      out[o] = id;
      out[o + 1] = Math.round(depth * 255);
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
  }
}

export const DEPTH_WINDOW = DEPTH_REACH;

/** Tileable value noise, size x size RGBA: four independent fractal channels (seeded, deterministic). */
export function makeNoise(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number, s: number) => {
    let n = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const acc = new Float32Array(size * size);
  for (let ch = 0; ch < 4; ch++) {
    acc.fill(0);
    let amp = 1;
    let total = 0;
    for (let oct = 0; oct < 4; oct++) {
      const f = 4 << oct; // lattice cells across the tile, so it wraps
      const s = seed * 131 + ch * 17 + oct * 7;
      for (let y = 0; y < size; y++) {
        const fy = (y / size) * f;
        const iy = Math.floor(fy);
        let ty = fy - iy;
        ty = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x++) {
          const fx = (x / size) * f;
          const ix = Math.floor(fx);
          let tx = fx - ix;
          tx = tx * tx * (3 - 2 * tx);
          const a = hash(ix % f, iy % f, s);
          const b = hash((ix + 1) % f, iy % f, s);
          const c = hash(ix % f, (iy + 1) % f, s);
          const d = hash((ix + 1) % f, (iy + 1) % f, s);
          acc[y * size + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
        }
      }
      total += amp;
      amp *= 0.5;
    }
    // Stretch to the full range so thresholds in the shader behave the same for every channel.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < acc.length; i++) {
      lo = Math.min(lo, acc[i]);
      hi = Math.max(hi, acc[i]);
    }
    const span = hi - lo || total;
    for (let i = 0; i < acc.length; i++) out[i * 4 + ch] = Math.round(((acc[i] - lo) / span) * 255);
  }
  return out;
}

export interface Pixels {
  w: number;
  h: number;
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * Copy `src` (any size, resampled bilinearly with wrap-around) into atlas slot `slot` of an RGBA
 * buffer `atlasW` texels wide, gutter included, with its contrast scaled, and return its mean colour.
 */
export function blitSlot(atlas: Uint8Array, atlasW: number, slot: number, src: Pixels, contrast = 1): number[] {
  const ox = (slot % ATLAS_COLS) * ATLAS_SLOT;
  const oy = Math.floor(slot / ATLAS_COLS) * ATLAS_SLOT;
  const sum = [0, 0, 0];
  // Contrast is eased around the texture's own mean, per channel.
  const mean = [0, 0, 0];
  for (let i = 0; i < src.w * src.h; i++) for (let k = 0; k < 3; k++) mean[k] += src.data[i * 4 + k];
  for (let k = 0; k < 3; k++) mean[k] /= src.w * src.h;
  const T = ATLAS_TILE;
  const G = ATLAS_GUTTER;
  for (let y = 0; y < ATLAS_SLOT; y++) {
    const v = ((((y - G + 0.5) / T) % 1) + 1) % 1;
    const sy = v * src.h - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const ya = ((y0 % src.h) + src.h) % src.h;
    const yb = (ya + 1) % src.h;
    for (let x = 0; x < ATLAS_SLOT; x++) {
      const u = ((((x - G + 0.5) / T) % 1) + 1) % 1;
      const sx = u * src.w - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const xa = ((x0 % src.w) + src.w) % src.w;
      const xb = (xa + 1) % src.w;
      const o = ((oy + y) * atlasW + ox + x) * 4;
      const inner = x >= G && x < G + T && y >= G && y < G + T;
      for (let i = 0; i < 3; i++) {
        const a = src.data[(ya * src.w + xa) * 4 + i];
        const b = src.data[(ya * src.w + xb) * 4 + i];
        const c = src.data[(yb * src.w + xa) * 4 + i];
        const d = src.data[(yb * src.w + xb) * 4 + i];
        const val = mean[i] + ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy - mean[i]) * contrast;
        atlas[o + i] = val;
        if (inner) sum[i] += val;
      }
      atlas[o + 3] = 255;
    }
  }
  return sum.map((s) => s / (T * T));
}

/** A stand-in texture for a missing image: the colour with soft mottling, so the ground still reads. */
export function proceduralTexture(color: number, noise: Uint8Array, noiseSize: number): Pixels {
  const n = noiseSize;
  const data = new Uint8ClampedArray(n * n * 4);
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  for (let i = 0; i < n * n; i++) {
    const f = 0.82 + (noise[i * 4 + 3] / 255) * 0.26 + (noise[i * 4 + 2] / 255 - 0.5) * 0.1;
    data[i * 4] = r * f;
    data[i * 4 + 1] = g * f;
    data[i * 4 + 2] = b * f;
    data[i * 4 + 3] = 255;
  }
  return { w: n, h: n, data };
}
