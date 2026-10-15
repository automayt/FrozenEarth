import { T, TERRAINS } from '@fe/defs';
import { Simplex } from './noise';
import { Rng } from './rng';
import type { World } from './world';

/** Fill a fresh world's map with terrain, mountains, ore and wild plants. */
export function generateMap(w: World): void {
  const m = w.map;
  const elev = new Simplex(w.seed ^ 0x1234);
  const moist = new Simplex(w.seed ^ 0x5678);
  const ore = new Simplex(w.seed ^ 0x9abc);
  const forest = new Simplex(w.seed ^ 0xdef0);
  const rng = new Rng(w.seed ^ 0x7777);

  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = m.idx(x, y);
      const e = elev.fbm(x / 70, y / 70, 5);
      const mo = moist.fbm(x / 45, y / 45, 3);
      let t = T.soil;
      if (e < 0.28) t = T.deep_water;
      else if (e < 0.32) t = T.shallow_water;
      else if (e < 0.35) t = T.sand;
      else if (mo > 0.66 && e < 0.45) t = T.marsh;
      else if (mo > 0.56) t = T.rich_soil;
      else if (e > 0.6) t = T.gravel;
      if (e > 0.66) {
        t = T.rough_stone;
        m.rock[i] = ore.fbm(x / 9, y / 9, 2) > 0.7 ? 2 : 1;
      }
      m.terrain[i] = t;
    }
  }
  for (let i = 0; i < m.n; i++) w.refreshCell(i);

  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
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
