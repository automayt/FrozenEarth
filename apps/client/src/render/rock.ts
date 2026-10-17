import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js';
import { ROCKS, ROOF, TERRAIN_BY_KEY, TERRAINS } from '@fe/defs';
import { hash2 } from '@fe/sim';

/**
 * Mountains, drawn RimWorld-style into their own static layer above the ground: a dark textured
 * mass per stone type, a crisp, slightly wavy black outline where rock meets open ground, a
 * lighter rim along the exposed edge (brighter on faces toward the light), ore glinting in its
 * veins, and a carved, dimmed look over tunnel floors under the mountain's roof.
 *
 * Pixels live in lazily created chunk textures (only where there is rock or roof) and are
 * repainted per cell, so mining a cell redraws its 3x3 neighbourhood and nothing else.
 */

/** Bitmap pixels per cell (TILE 32 world units / 12 = 2.7 units per pixel). */
export const ROCK_PX = 12;
/** Cells per chunk side. */
const CHUNK = 16;

/** What the painter reads: the client Mirror satisfies this, and so does a sim GameMap. */
export interface RockMap {
  w: number;
  h: number;
  rock: Uint8Array;
  terrain: Uint8Array;
  roof: Uint8Array;
}

// ---------------------------------------------------------------- look

/** Outline width in pixels, and how much thicker it gets on faces turned away from the light (the cliff side). */
const OUTLINE = 1.8;
const CLIFF = 1.7;
/** Band of lit (or shadowed) rim just inside the outline, in pixels. */
const RIM = 4.5;
/** How far the outline bulges past the rock's smoothed edge onto open ground: LIP_MIN..LIP_MIN+LIP_VAR pixels. */
const LIP_MIN = 0.4;
const LIP_VAR = 2.4;
/** Box size, in cells, the rock mask is smoothed over: rounds outer corners and fills inner ones. */
const BLUR = 0.62;
/** Light comes from the north-north-west (unit vector). */
const LX = -0.45;
const LY = -0.89;
const OUTLINE_RGB = [13, 11, 10];

interface StoneStyle {
  /** Base colour of the mass: darker than the rough floor it leaves, so mountains read as solid. */
  rgb: [number, number, number];
  pattern: 'granite' | 'limestone' | 'slate' | 'marble';
}

function rgbOf(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

const STYLES: Record<string, StoneStyle> = {
  granite: { rgb: rgbOf(0x3d3431), pattern: 'granite' },
  limestone: { rgb: rgbOf(0x544c3d), pattern: 'limestone' },
  slate: { rgb: rgbOf(0x2c3038), pattern: 'slate' },
  marble: { rgb: rgbOf(0x4f4d4a), pattern: 'marble' },
};

/** Stone rock id by the terrain id of its rough floor: an ore vein shows its host stone around the ore. */
const STONE_BY_FLOOR = new Map<number, number>();
for (const r of ROCKS) if (r.stone && TERRAIN_BY_KEY[r.floor]) STONE_BY_FLOOR.set(TERRAIN_BY_KEY[r.floor].id, r.id);
const GRANITE = ROCKS.find((r) => r.key === 'granite')!.id;

/** The stone a rock cell is made of (its host stone, for an ore vein). */
function stoneOf(m: RockMap, c: number): number {
  const r = m.rock[c];
  if (ROCKS[r]?.stone) return r;
  return STONE_BY_FLOOR.get(m.terrain[c]) ?? GRANITE;
}

const ORE: Record<string, { speck: [number, number, number]; glint: [number, number, number]; tint: number }> = {
  steel_ore: { speck: [96, 112, 132], glint: [168, 184, 204], tint: 0.2 },
  gold_ore: { speck: [196, 150, 44], glint: [255, 228, 140], tint: 0.22 },
};

/** Smooth value noise in [0, 1]. With a period (in lattice cells), it tiles. */
function vnoise(x: number, y: number, seed: number, period = 0): number {
  let xi = Math.floor(x);
  let yi = Math.floor(y);
  let fx = x - xi;
  let fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  let xj = xi + 1;
  let yj = yi + 1;
  if (period) {
    xi = ((xi % period) + period) % period;
    yi = ((yi % period) + period) % period;
    xj = xj % period;
    yj = yj % period;
  }
  const a = hash2(xi, yi, seed);
  const b = hash2(xj, yi, seed);
  const c = hash2(xi, yj, seed);
  const d = hash2(xj, yj, seed);
  return a + (b - a) * fx + (c - a + (d - c - b + a) * fx) * fy;
}

/** Stone surface texture tiles are this many pixels square (16 cells), and repeat. */
const TEX = 192;
/** Tiling noise at TEX / s pixels per lattice cell (s must divide TEX). */
function tnoise(gx: number, gy: number, s: number, seed: number): number {
  return vnoise(gx / s, gy / s, seed, TEX / s);
}

/** One stone's surface pattern, before broad variation and lighting: RGB per pixel, built once. */
function buildTile(stone: number): Uint8ClampedArray {
  const st = STYLES[ROCKS[stone].key] ?? STYLES.granite;
  const [br, bg, bb] = st.rgb;
  const out = new Uint8ClampedArray(TEX * TEX * 3);
  for (let gy = 0; gy < TEX; gy++) {
    for (let gx = 0; gx < TEX; gx++) {
      // Mottling and fine grain, shared by all stones.
      let f = 1 + (tnoise(gx, gy, 12, 3) - 0.5) * 0.18 + (hash2(gx, gy, 9) - 0.5) * 0.09;
      let tr = 0;
      let tb = 0;
      switch (st.pattern) {
        case 'granite': {
          // Salt-and-pepper crystals, with the odd pink feldspar.
          const h = hash2(gx, gy, 5);
          if (h > 0.94) f *= 1.3;
          else if (h < 0.05) f *= 0.72;
          if (hash2(gx >> 1, gy >> 1, 6) > 0.97) tr += 9;
          break;
        }
        case 'limestone': {
          // Soft horizontal bedding and the occasional pale fossil fleck.
          const bed = Math.sin((gy * Math.PI * 2 * 13) / TEX + tnoise(gx, gy, 16, 4) * 5);
          f *= 1 + bed * 0.05;
          if (hash2(gx >> 1, gy >> 1, 7) > 0.975) f *= 1.2;
          break;
        }
        case 'slate': {
          // Fine diagonal cleavage, a cool blue cast.
          const k = (gx + gy * 0.5 + tnoise(gx, gy, 8, 4) * 6) % 6;
          if (k < 0.9) f *= 0.8;
          else if (k < 1.6) f *= 1.06;
          tb += 6;
          break;
        }
        case 'marble': {
          // Thin dark veins wandering through it.
          const v1 = Math.abs(tnoise(gx, gy, 24, 4) - 0.5);
          if (v1 < 0.011) f *= 0.7;
          else if (v1 < 0.022) f *= 0.87;
          if (Math.abs(tnoise(gx, gy, 8, 5) - 0.5) < 0.01 && tnoise(gx, gy, 32, 6) > 0.55) f *= 0.84;
          break;
        }
      }
      // Broken hairline cracks.
      if (tnoise(gx, gy, 24, 13) > 0.6 && Math.abs(tnoise(gx, gy, 12, 12) - 0.5) < 0.014) f *= 0.72;
      const o = (gy * TEX + gx) * 3;
      out[o] = br * f + tr;
      out[o + 1] = bg * f;
      out[o + 2] = bb * f + tb;
    }
  }
  return out;
}

const tiles = new Map<number, Uint8ClampedArray>();
const tmp: [number, number, number] = [0, 0, 0];

/** Broad light and dark across a range, so big masses aren't flat (and the tile's repeat hides). Sampled at cell corners. */
function broad(x: number, y: number): number {
  return 1 + (vnoise(x / 4, y / 4, 2) - 0.5) * 0.22;
}

/** Colour of the stone's surface at world pixel (gx, gy), times brightness f, before lighting. Written into a shared array. */
function stoneTexel(stone: number, gx: number, gy: number, f: number): [number, number, number] {
  let tile = tiles.get(stone);
  if (!tile) tiles.set(stone, (tile = buildTile(stone)));
  const o = ((gy % TEX) * TEX + (gx % TEX)) * 3;
  tmp[0] = tile[o] * f;
  tmp[1] = tile[o + 1] * f;
  tmp[2] = tile[o + 2] * f;
  return tmp;
}

// ---------------------------------------------------------------- painting

/** Rock state of a cell; off the map, the nearest edge cell's (so the map border never gets an outline). */
function rockAt(m: RockMap, x: number, y: number): boolean {
  const cx = x < 0 ? 0 : x >= m.w ? m.w - 1 : x;
  const cy = y < 0 ? 0 : y >= m.h ? m.h - 1 : y;
  return m.rock[cy * m.w + cx] > 0;
}

function rockIs(m: RockMap, x: number, y: number, id: number): boolean {
  return x >= 0 && y >= 0 && x < m.w && y < m.h && m.rock[y * m.w + x] === id;
}

/** Share of a box (size in cells) around world point (wx, wy) that is rock (or, with only, that kind of rock). */
function coverage(m: RockMap, wx: number, wy: number, box = BLUR, only = 0): number {
  const hb = box / 2;
  const x0 = wx - hb;
  const x1 = wx + hb;
  const y0 = wy - hb;
  const y1 = wy + hb;
  const cx0 = Math.floor(x0);
  const cy0 = Math.floor(y0);
  let sum = 0;
  for (let cy = cy0; cy <= cy0 + 1; cy++) {
    const oy = Math.min(y1, cy + 1) - Math.max(y0, cy);
    if (oy <= 0) continue;
    for (let cx = cx0; cx <= cx0 + 1; cx++) {
      const ox = Math.min(x1, cx + 1) - Math.max(x0, cx);
      if (ox > 0 && (only ? rockIs(m, cx, cy, only) : rockAt(m, cx, cy))) sum += ox * oy;
    }
  }
  return sum / (box * box);
}

/** True if this cell draws anything in the rock layer. */
export function rockCellHasContent(m: RockMap, c: number): boolean {
  if (m.rock[c] || m.roof[c]) return true;
  const x = c % m.w;
  const y = (c / m.w) | 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && rockAt(m, x + dx, y + dy)) return true;
  return false;
}

/**
 * Paint cell c's ROCK_PX x ROCK_PX pixels (premultiplied RGBA) into data at (ox, oy).
 * Open cells away from rock and roof come out fully transparent.
 */
export function paintRockCell(m: RockMap, c: number, data: Uint8ClampedArray, stride: number, ox: number, oy: number): void {
  const P = ROCK_PX;
  const x = c % m.w;
  const y = (c / m.w) | 0;
  const isRock = m.rock[c] > 0;
  // Neighbours on the other side of the rock edge: open ones for a rock cell, rock ones for an open cell.
  const edgeDx: number[] = [];
  const edgeDy: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && rockAt(m, x + dx, y + dy) !== isRock) {
        edgeDx.push(dx);
        edgeDy.push(dy);
      }
    }
  }
  const edge = edgeDx.length > 0;
  const roof = isRock ? 0 : m.roof[c] | 0;
  if (!isRock && !edge && !roof) {
    for (let py = 0; py < P; py++) data.fill(0, ((oy + py) * stride + ox) * 4, ((oy + py) * stride + ox + P) * 4);
    return;
  }
  const stone = isRock ? stoneOf(m, c) : 0;
  // Where two stones meet inside a mountain, their boundary is broken up instead of following the cells.
  let mixed = false;
  if (isRock) {
    for (let dy = -1; dy <= 1 && !mixed; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && m.rock[ny * m.w + nx] && stoneOf(m, ny * m.w + nx) !== stone) {
          mixed = true;
          break;
        }
      }
    }
  }
  // The ore in or next to this cell: its vein fades out over cell edges instead of stopping square.
  let oreId = 0;
  if (isRock) {
    if (ORE[ROCKS[m.rock[c]].key]) oreId = m.rock[c];
    for (let dy = -1; dy <= 1 && !oreId; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && ORE[ROCKS[m.rock[ny * m.w + nx]].key]) {
          oreId = m.rock[ny * m.w + nx];
          break;
        }
      }
    }
  }
  const ore = oreId ? ORE[ROCKS[oreId].key] : undefined;
  const carved = !isRock && TERRAINS[m.terrain[c]]?.key.startsWith('rough_');
  const half = (BLUR * P) / 2;
  const b00 = broad(x, y);
  const b10 = broad(x + 1, y);
  const b01 = broad(x, y + 1);
  const b11 = broad(x + 1, y + 1);
  for (let py = 0; py < P; py++) {
    for (let px = 0; px < P; px++) {
      const u = (px + 0.5) / P;
      const v = (py + 0.5) / P;
      const gx = x * P + px;
      const gy = y * P + py;
      const o = ((oy + py) * stride + ox + px) * 4;
      // t: depth in pixels into the drawn rock (negative out on open ground). nx, ny: outward normal of the nearest edge.
      let t = isRock ? P * 3 : -P * 3;
      let nx = 0;
      let ny = 0;
      let near = -1;
      if (edge) {
        // Exact distance to the nearest cell across the edge...
        let dist = P * 3;
        for (let k = 0; k < edgeDx.length; k++) {
          const dx = edgeDx[k];
          const dy = edgeDy[k];
          const ex = dx < 0 ? u : dx > 0 ? 1 - u : 0;
          const ey = dy < 0 ? v : dy > 0 ? 1 - v : 0;
          const d = (dx && dy ? Math.sqrt(ex * ex + ey * ey) : dx ? ex : ey) * P;
          if (d < dist) {
            dist = d;
            near = k;
          }
        }
        const s = isRock ? 1 : -1;
        const l = edgeDx[near] && edgeDy[near] ? Math.SQRT2 : 1;
        nx = (edgeDx[near] * s) / l;
        ny = (edgeDy[near] * s) / l;
        // ...but near the edge the smoothed mask decides, so corners round off and the outline wanders.
        const cov = coverage(m, x + u, y + v);
        const sd = cov > 0 && cov < 1 ? (cov - 0.5) * BLUR * P : isRock ? Math.max(half, dist) : -Math.max(half, dist);
        t = sd + LIP_MIN + LIP_VAR * (vnoise(gx / 7, gy / 7, 21) * 0.75 + vnoise(gx / 2.5, gy / 2.5, 22) * 0.25);
      }
      if (t <= 0) {
        // Open ground: transparent, or the shade of a roofed tunnel.
        if (!roof) {
          data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
          continue;
        }
        let a = roof === ROOF.thick ? 0.42 : 0.26;
        // Shadow pooling against the tunnel walls.
        if (near >= 0) a += 0.42 * Math.max(0, 1 + t / 6);
        if (carved) {
          // Chisel marks: short diagonal strokes in a loose grid.
          const bx = gx >> 2;
          const by = gy >> 2;
          if (hash2(bx, by, 31) > 0.55 && ((gx + gy + ((hash2(bx, by, 32) * 4) | 0)) & 3) === 0) a += 0.14;
          else if (hash2(gx, gy, 33) > 0.9) a -= 0.08;
        }
        a = Math.min(0.88, Math.max(0, a));
        data[o] = 9 * a;
        data[o + 1] = 9 * a;
        data[o + 2] = 13 * a;
        data[o + 3] = 255 * a;
        continue;
      }
      const lit = nx * LX + ny * LY;
      const outline = OUTLINE + CLIFF * Math.max(0, -lit);
      let r: number;
      let g: number;
      let b: number;
      let a = 1;
      if (t < outline) {
        // The crisp outline, anti-aliased on its outer side; thicker on the cliff side, away from the light.
        a = Math.min(1, t * 1.6);
        r = OUTLINE_RGB[0];
        g = OUTLINE_RGB[1];
        b = OUTLINE_RGB[2];
      } else {
        let st = isRock ? stone : stoneOf(m, (y + edgeDy[near]) * m.w + x + edgeDx[near]);
        if (mixed) {
          const sx = Math.floor(x + u + (vnoise(gx / 5, gy / 5, 51) - 0.5) * 1.1);
          const sy = Math.floor(y + v + (vnoise(gx / 5, gy / 5, 52) - 0.5) * 1.1);
          if (sx >= 0 && sy >= 0 && sx < m.w && sy < m.h && m.rock[sy * m.w + sx]) st = stoneOf(m, sy * m.w + sx);
        }
        const bf = b00 + (b10 - b00) * u + (b01 - b00 + (b11 - b10 - b01 + b00) * u) * v;
        const tx = stoneTexel(st, gx, gy, bf);
        r = tx[0];
        g = tx[1];
        b = tx[2];
        const vein = ore && t > outline + 1 ? coverage(m, x + u, y + v, 1, oreId) : 0;
        if (ore && vein > 0) {
          // Ore: a tint over the vein so it reads from afar, and clustered specks that glint.
          const k = vein * vein * (3 - 2 * vein);
          r += (ore.speck[0] - r) * ore.tint * k;
          g += (ore.speck[1] - g) * ore.tint * k;
          b += (ore.speck[2] - b) * ore.tint * k;
          const n = (vnoise(gx / 1.7, gy / 1.7, 41) * 0.65 + vnoise(gx / 7, gy / 7, 42) * 0.35) * (0.75 + 0.25 * k) + 0.25 * (k - 1);
          if (n > 0.62) {
            const c2 = n > 0.7 && hash2(gx, gy, 43) > 0.5 ? ore.glint : ore.speck;
            r = c2[0];
            g = c2[1];
            b = c2[2];
          } else if (n > 0.57) {
            r *= 0.62;
            g *= 0.62;
            b *= 0.62;
          }
        }
        if (near >= 0) {
          const into = t - outline;
          if (into < RIM) {
            // The flank just inside the outline: lit faces catch a bright rim, the far side drops into shade.
            const k = (1 - into / RIM) ** 1.3;
            if (lit > -0.2) {
              const lift = (0.16 + 0.5 * Math.max(0, lit)) * k;
              r += (Math.min(255, r * 1.7 + 42) - r) * lift;
              g += (Math.min(255, g * 1.7 + 42) - g) * lift;
              b += (Math.min(255, b * 1.7 + 40) - b) * lift;
            } else {
              const drop = 1 + 0.34 * lit * k;
              r *= drop;
              g *= drop;
              b *= drop;
            }
          }
          // A soft bevel: the edge of the mass rises out of the darker interior.
          if (into < RIM * 2.5) {
            const bevel = 1 + 0.2 * (1 - into / (RIM * 2.5)) * (lit >= 0 ? 1 : -0.4);
            r *= bevel;
            g *= bevel;
            b *= bevel;
          }
        }
      }
      data[o] = Math.min(255, r) * a;
      data[o + 1] = Math.min(255, g) * a;
      data[o + 2] = Math.min(255, b) * a;
      data[o + 3] = 255 * a;
    }
  }
}

/** Colours for the dust and chips a mined cell bursts into. */
export function rockDust(rock: number): number[] {
  const st = STYLES[ROCKS[rock]?.key] ?? STYLES.granite;
  const [r, g, b] = st.rgb;
  const c = (k: number) => (Math.min(255, r * k) << 16) | (Math.min(255, g * k) << 8) | Math.min(255, b * k);
  return [c(1.5), c(1.8), c(2.2)];
}

// ---------------------------------------------------------------- layer

interface Chunk {
  data: Uint8ClampedArray;
  pw: number;
  ph: number;
  source: BufferImageSource;
  texture: Texture;
}

/** The rock layer: chunk textures created on demand, repainted per cell. */
export class RockLayer {
  readonly root = new Container();
  private readonly cols: number;
  private readonly rows: number;
  private readonly chunks: (Chunk | null)[];
  private readonly dirty = new Set<Chunk>();
  /** Milliseconds the last full draw took (for profiling). */
  lastDrawMs = 0;

  constructor(
    readonly w: number,
    readonly h: number,
    private readonly tile: number,
  ) {
    this.cols = Math.ceil(w / CHUNK);
    this.rows = Math.ceil(h / CHUNK);
    this.chunks = new Array<Chunk | null>(this.cols * this.rows).fill(null);
    this.root.label = 'rock';
  }

  /** Paint everything (a new snapshot). */
  drawAll(m: RockMap): void {
    const t0 = performance.now();
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const k = cy * this.cols + cx;
        let any = false;
        for (let y = cy * CHUNK; y < Math.min(this.h, (cy + 1) * CHUNK) && !any; y++) {
          for (let x = cx * CHUNK; x < Math.min(this.w, (cx + 1) * CHUNK); x++) {
            if (rockCellHasContent(m, y * this.w + x)) {
              any = true;
              break;
            }
          }
        }
        const ch = this.chunks[k];
        if (any) this.paintChunk(m, ch ?? this.makeChunk(cx, cy));
        else if (ch) {
          ch.data.fill(0);
          this.dirty.add(ch);
        }
      }
    }
    this.flush();
    this.lastDrawMs = performance.now() - t0;
  }

  /** Repaint around changed cells (rock mined or placed): each cell and its eight neighbours. */
  update(m: RockMap, cells: Iterable<number>): void {
    const todo = new Set<number>();
    for (const c of cells) {
      const x = c % this.w;
      const y = (c / this.w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < this.w && ny < this.h) todo.add(ny * this.w + nx);
        }
      }
    }
    for (const c of todo) {
      const x = c % this.w;
      const y = (c / this.w) | 0;
      const k = ((y / CHUNK) | 0) * this.cols + ((x / CHUNK) | 0);
      let ch = this.chunks[k];
      if (!ch) {
        if (!rockCellHasContent(m, c)) continue;
        ch = this.makeChunk((x / CHUNK) | 0, (y / CHUNK) | 0);
      }
      paintRockCell(m, c, ch.data, ch.pw, (x % CHUNK) * ROCK_PX, (y % CHUNK) * ROCK_PX);
      this.dirty.add(ch);
    }
    this.flush();
  }

  private makeChunk(cx: number, cy: number): Chunk {
    const pw = Math.min(CHUNK, this.w - cx * CHUNK) * ROCK_PX;
    const ph = Math.min(CHUNK, this.h - cy * CHUNK) * ROCK_PX;
    const data = new Uint8ClampedArray(pw * ph * 4);
    const source = new BufferImageSource({
      resource: data,
      width: pw,
      height: ph,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'linear',
      // Mipmaps keep the fine grain and specks from shimmering when zoomed out.
      autoGenerateMipmaps: true,
    });
    const texture = new Texture({ source });
    const s = new Sprite(texture);
    s.position.set(cx * CHUNK * this.tile, cy * CHUNK * this.tile);
    s.scale.set(this.tile / ROCK_PX);
    this.root.addChild(s);
    const ch: Chunk = { data, pw, ph, source, texture };
    this.chunks[cy * this.cols + cx] = ch;
    return ch;
  }

  private paintChunk(m: RockMap, ch: Chunk): void {
    const i = this.chunks.indexOf(ch);
    const cx = i % this.cols;
    const cy = (i / this.cols) | 0;
    for (let y = cy * CHUNK; y < Math.min(this.h, (cy + 1) * CHUNK); y++) {
      for (let x = cx * CHUNK; x < Math.min(this.w, (cx + 1) * CHUNK); x++) {
        paintRockCell(m, y * this.w + x, ch.data, ch.pw, (x - cx * CHUNK) * ROCK_PX, (y - cy * CHUNK) * ROCK_PX);
      }
    }
    this.dirty.add(ch);
  }

  private flush(): void {
    for (const ch of this.dirty) ch.source.update();
    this.dirty.clear();
  }

  /** Chunks allocated so far (for profiling). */
  get chunkCount(): number {
    return this.chunks.filter(Boolean).length;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    for (const ch of this.chunks) ch?.texture.destroy(true);
    this.chunks.fill(null);
    this.dirty.clear();
  }
}
