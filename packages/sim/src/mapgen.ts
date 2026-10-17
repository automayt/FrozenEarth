import { ROCKS, ROOF, STONE_IDS, T, TERRAIN_BY_KEY, TERRAINS } from '@fe/defs';
import { Simplex } from './noise';
import { Rng } from './rng';
import type { GameMap } from './map';
import type { World } from './world';

/** Cells of rock between a cell and open ground before its roof counts as overhead mountain. */
export const THICK_ROOF_DEPTH = 4;

// Mountain shaping. The mountain field is smooth and large-scale so rock comes in real masses;
// winding passes are cut through it, small blobs are dropped and pinholes filled.
/** Mountain field threshold: higher means less rock. */
const MOUNT_T = 0.61;
/** How much the mountains thin out toward the rim, where colonies start (settlements need open land inward too). */
const MOUNT_RIM_EASE = 0.035;
/** Half-width of a pass, in units of the pass noise. */
const PASS_W = 0.075;
/** Rock masses smaller than this (in cells) are removed... */
const MIN_MASS = 14;
/** ...and enclosed gaps smaller than this are filled. */
const MAX_PINHOLE = 6;

/** Fill a fresh world's map with terrain, mountains, ore and wild plants. */
export function generateMap(w: World): void {
  const m = w.map;
  const W = m.w;
  const H = m.h;
  const elev = new Simplex(w.seed ^ 0x1234);
  const moist = new Simplex(w.seed ^ 0x5678);
  const forest = new Simplex(w.seed ^ 0xdef0);
  const mount = new Simplex(w.seed ^ 0x2468);
  const outcrop = new Simplex(w.seed ^ 0x9abc);
  const pass = new Simplex(w.seed ^ 0x1357);
  const passGate = new Simplex(w.seed ^ 0x8642);
  const scree = new Simplex(w.seed ^ 0x4321);
  const rng = new Rng(w.seed ^ 0x7777);
  const geoRng = new Rng(w.seed ^ 0x6e01);

  const half = Math.min(W, H) / 2;
  const elevation = new Float32Array(m.n);
  let mask: Uint8Array = new Uint8Array(m.n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = m.idx(x, y);
      const e = elev.fbm(x / 70, y / 70, 5);
      const mo = moist.fbm(x / 45, y / 45, 3);
      elevation[i] = e;
      let t = T.soil;
      if (e < 0.28) t = T.deep_water;
      else if (e < 0.32) t = T.shallow_water;
      else if (e < 0.35) t = T.sand;
      else if (mo > 0.66 && e < 0.45) t = T.marsh;
      else if (mo > 0.56) t = T.rich_soil;
      else if (e > 0.6) t = T.gravel;
      m.terrain[i] = t;
      if (e < 0.37) continue;
      const r = Math.min(1, Math.hypot(x - W / 2, y - H / 2) / half);
      const rim = Math.max(0, Math.min(1, (r - 0.6) / 0.3));
      const mv = mount.fbm(x / 52, y / 52, 4) + 0.3 * (e - 0.5) - MOUNT_RIM_EASE * rim;
      if (mv > MOUNT_T) {
        // Winding passes through the bigger masses (not every one: some ranges stay whole).
        const p = Math.abs(pass.noise(x / 40, y / 40) + 0.12 * pass.noise(x / 9, y / 9));
        if (!(p < PASS_W && passGate.fbm(x / 80, y / 80, 2) > 0.42)) mask[i] = 1;
      } else if (outcrop.fbm(x / 11, y / 11, 2) > 0.8 && mo < 0.6) {
        mask[i] = 1;
      }
    }
  }

  mask = smooth(m, smooth(m, mask, elevation), elevation);
  dropSmallMasses(m, mask);

  // Stone types: each map has three of them, in broad regions that cut across the mountains.
  const pool = [...STONE_IDS];
  for (let k = pool.length - 1; k > 0; k--) {
    const j = geoRng.int(k + 1);
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  const stones = pool.slice(0, Math.min(3, pool.length));
  const geo = stones.map((_, k) => new Simplex(w.seed ^ (0x3100 + k)));
  let rockCells = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = m.idx(x, y);
      if (!mask[i]) continue;
      rockCells++;
      let best = 0;
      let bestV = -1;
      for (let k = 0; k < stones.length; k++) {
        const v = geo[k].fbm(x / 48, y / 48, 2);
        if (v > bestV) {
          bestV = v;
          best = k;
        }
      }
      const stone = stones[best];
      m.rock[i] = stone;
      m.terrain[i] = TERRAIN_BY_KEY[ROCKS[stone].floor].id;
    }
  }

  // Scree: gravel spills out around the foot of the rock.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = m.idx(x, y);
      if (mask[i]) continue;
      const t = m.terrain[i];
      if (t !== T.soil && t !== T.rich_soil) continue;
      let near = 3;
      for (let dy = -2; dy <= 2 && near > 1; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!m.inBounds(x + dx, y + dy) || !mask[m.idx(x + dx, y + dy)]) continue;
          near = Math.min(near, Math.max(Math.abs(dx), Math.abs(dy)));
        }
      }
      if (near > 2) continue;
      if (scree.fbm(x / 5, y / 5, 2) > (near === 1 ? 0.5 : 0.66)) m.terrain[i] = T.gravel;
    }
  }

  const depth = rockDepth(m);
  placeVeins(m, geoRng, depth, rockCells);
  computeRoof(m, depth);

  for (let i = 0; i < m.n; i++) w.refreshCell(i);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = m.idx(x, y);
      if (m.rock[i] || !TERRAINS[m.terrain[i]].passable) continue;
      const fert = TERRAINS[m.terrain[i]].fertility;
      if (fert < 0.5) continue;
      const f = forest.fbm(x / 30, y / 30, 3);
      const r = rng.next();
      let def = '';
      if ((f > 0.58 && r < 0.3) || r < 0.025) def = f > 0.62 ? 'pine' : 'oak';
      else if (r < 0.045) def = 'bush';
      else if (r < 0.055) def = 'berry_bush';
      if (def) w.spawnPlant(def, i, 0.3 + rng.next() * 0.7);
    }
  }
  m.compDirty = true;
  m.roomsDirty = true;
}

/** One pass of majority smoothing: knocks off spurs and fills notches. Never builds rock into water. */
function smooth(m: GameMap, mask: Uint8Array, elevation: Float32Array): Uint8Array {
  const out = new Uint8Array(m.n);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = m.idx(x, y);
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && m.inBounds(x + dx, y + dy) && mask[m.idx(x + dx, y + dy)]) k++;
        }
      }
      out[i] = k >= 5 ? (elevation[i] >= 0.34 ? 1 : 0) : k <= 2 ? 0 : mask[i];
    }
  }
  return out;
}

/** Remove rock masses too small to matter and fill pinholes inside the big ones (4-connected). */
function dropSmallMasses(m: GameMap, mask: Uint8Array): void {
  const seen = new Uint8Array(m.n);
  const stack: number[] = [];
  const cells: number[] = [];
  for (let s = 0; s < m.n; s++) {
    if (seen[s]) continue;
    const v = mask[s];
    cells.length = 0;
    let edge = false;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const x = c % m.w;
      const y = (c / m.w) | 0;
      if (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1) edge = true;
      const nb = [x > 0 ? c - 1 : -1, x < m.w - 1 ? c + 1 : -1, y > 0 ? c - m.w : -1, y < m.h - 1 ? c + m.w : -1];
      for (const d of nb) {
        if (d < 0 || seen[d] || mask[d] !== v) continue;
        seen[d] = 1;
        stack.push(d);
      }
    }
    if (v && cells.length < MIN_MASS) for (const c of cells) mask[c] = 0;
    else if (!v && !edge && cells.length < MAX_PINHOLE) for (const c of cells) mask[c] = 1;
  }
}

/**
 * Steps (4-connected) from each rock cell to the nearest open cell; 0 for open cells. The map
 * edge doesn't count as open: a range running off the map is as deep there as it looks.
 */
export function rockDepth(m: GameMap): Int32Array {
  const depth = new Int32Array(m.n);
  const queue = new Int32Array(m.n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < m.n; i++) {
    if (m.rock[i]) depth[i] = -1;
    else queue[tail++] = i;
  }
  while (head < tail) {
    const c = queue[head++];
    const x = c % m.w;
    const d = depth[c] + 1;
    if (x > 0 && depth[c - 1] < 0) {
      depth[c - 1] = d;
      queue[tail++] = c - 1;
    }
    if (x < m.w - 1 && depth[c + 1] < 0) {
      depth[c + 1] = d;
      queue[tail++] = c + 1;
    }
    if (c - m.w >= 0 && depth[c - m.w] < 0) {
      depth[c - m.w] = d;
      queue[tail++] = c - m.w;
    }
    if (c + m.w < m.n && depth[c + m.w] < 0) {
      depth[c + m.w] = d;
      queue[tail++] = c + m.w;
    }
  }
  // A map that is all rock has no open cell to measure from.
  for (let i = 0; i < m.n; i++) if (depth[i] < 0) depth[i] = THICK_ROOF_DEPTH;
  return depth;
}

/** Roof every rock cell: a rock roof on a mountain's flanks, overhead mountain deep inside. Open cells get none. */
export function computeRoof(m: GameMap, depth = rockDepth(m)): void {
  for (let i = 0; i < m.n; i++) m.roof[i] = !m.rock[i] ? ROOF.none : depth[i] >= THICK_ROOF_DEPTH ? ROOF.thick : ROOF.rock;
}

/** Steel and gold as clustered veins inside the stone; gold is rarer, deeper and toward the center. */
function placeVeins(m: GameMap, rng: Rng, depth: Int32Array, rockCells: number): void {
  const deep2: number[] = [];
  const deep3: number[] = [];
  for (let i = 0; i < m.n; i++) {
    if (depth[i] >= 2) deep2.push(i);
    if (depth[i] >= 3) deep3.push(i);
  }
  const half = Math.min(m.w, m.h) / 2;
  const central = (c: number) => Math.hypot((c % m.w) - m.w / 2, ((c / m.w) | 0) - m.h / 2) / half < 0.8;
  const steel = Math.round(rockCells / 240);
  const gold = rockCells >= 300 ? Math.max(1, Math.round(rockCells / 1500)) : 0;
  for (let k = 0; k < steel && deep2.length; k++) growVein(m, rng, rng.pick(deep2), 2, 6 + rng.int(10));
  for (let k = 0; k < gold && (deep3.length || deep2.length); k++) {
    const from = deep3.length ? deep3 : deep2;
    let start = rng.pick(from);
    for (let tries = 0; tries < 20 && !central(start); tries++) start = rng.pick(from);
    growVein(m, rng, start, 3, 3 + rng.int(5));
  }
}

function growVein(m: GameMap, rng: Rng, start: number, ore: number, size: number): void {
  if (!ROCKS[m.rock[start]]?.stone) return;
  const vein = [start];
  m.rock[start] = ore;
  for (let k = 0; k < vein.length && vein.length < size; k++) {
    const x = vein[k] % m.w;
    const y = (vein[k] / m.w) | 0;
    for (let dy = -1; dy <= 1 && vein.length < size; dy++) {
      for (let dx = -1; dx <= 1 && vein.length < size; dx++) {
        if ((!dx && !dy) || !m.inBounds(x + dx, y + dy)) continue;
        const n = m.idx(x + dx, y + dy);
        if (!ROCKS[m.rock[n]].stone || !rng.chance(0.45)) continue;
        // The host stone's floor is already under it, so a mined vein leaves matching rough stone.
        m.rock[n] = ore;
        vein.push(n);
      }
    }
  }
}
