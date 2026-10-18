import { describe, expect, it } from 'vitest';
import { ROCK_BY_KEY, ROCKS, ROOF, T, TERRAIN_BY_KEY, TERRAINS } from '@fe/defs';
import {
  CAVE_TEMP,
  computeRoof,
  createWorld,
  deserializeWorld,
  hashWorld,
  rockDepth,
  SAVE_VERSION,
  serializeWorld,
  siteProblem,
  snapshot,
  suggestSites,
  THICK_ROOF_DEPTH,
  type Item,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
const SEEDS = [1, 7, 42, 1234, 99];

/** Sizes of 4-connected rock masses, largest first. */
function masses(w: World): number[] {
  const m = w.map;
  const seen = new Uint8Array(m.n);
  const out: number[] = [];
  for (let s = 0; s < m.n; s++) {
    if (!m.rock[s] || seen[s]) continue;
    let n = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const x = c % m.w;
      for (const d of [x > 0 ? c - 1 : -1, x < m.w - 1 ? c + 1 : -1, c - m.w, c + m.w]) {
        if (d < 0 || d >= m.n || seen[d] || !m.rock[d]) continue;
        seen[d] = 1;
        stack.push(d);
      }
    }
    out.push(n);
  }
  return out.sort((a, b) => b - a);
}

function count(w: World, rock: number): number {
  let n = 0;
  for (let i = 0; i < w.map.n; i++) if (w.map.rock[i] === rock) n++;
  return n;
}

describe('mountain generation', () => {
  it('is deterministic', () => {
    const a = createWorld({ seed: 4242 });
    const b = createWorld({ seed: 4242 });
    expect(Array.from(b.map.rock)).toEqual(Array.from(a.map.rock));
    expect(Array.from(b.map.roof)).toEqual(Array.from(a.map.roof));
    expect(Array.from(b.map.terrain)).toEqual(Array.from(a.map.terrain));
    expect(hashWorld(b)).toBe(hashWorld(a));
    expect(hashWorld(createWorld({ seed: 4243 }))).not.toBe(hashWorld(a));
  });

  it('makes a few big mountain masses rather than scattered blobs', () => {
    for (const seed of SEEDS) {
      const w = createWorld({ seed, settlements: false, wildlife: false });
      const sizes = masses(w);
      const rock = sizes.reduce((a, b) => a + b, 0);
      expect(rock / w.map.n, `seed ${seed} rock cover`).toBeGreaterThan(0.1);
      expect(rock / w.map.n, `seed ${seed} rock cover`).toBeLessThan(0.3);
      // Most rock is in masses big enough to tunnel into...
      expect(sizes.filter((s) => s >= 300).reduce((a, b) => a + b, 0) / rock, `seed ${seed}`).toBeGreaterThan(0.6);
      // ...with no specks.
      expect(Math.min(...sizes), `seed ${seed}`).toBeGreaterThanOrEqual(10);
      expect(sizes.length, `seed ${seed}`).toBeLessThan(60);
    }
  });

  it('uses several stone types, each with its own rough floor under it', () => {
    for (const seed of SEEDS) {
      const w = createWorld({ seed, settlements: false, wildlife: false });
      const m = w.map;
      const stones = ROCKS.filter((r) => r.stone && count(w, r.id) > 200);
      expect(stones.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < m.n; i++) {
        const r = ROCKS[m.rock[i]];
        if (r.stone) expect(TERRAINS[m.terrain[i]].key).toBe(r.floor);
        else if (m.rock[i]) expect(TERRAINS[m.terrain[i]].key.startsWith('rough_')).toBe(true);
      }
    }
  });

  it('hides steel and gold in the mountains as clustered veins', () => {
    for (const seed of SEEDS) {
      const w = createWorld({ seed, settlements: false, wildlife: false });
      const m = w.map;
      const steel = ROCK_BY_KEY.steel_ore.id;
      const gold = ROCK_BY_KEY.gold_ore.id;
      expect(count(w, steel), `seed ${seed} steel`).toBeGreaterThan(80);
      expect(count(w, gold), `seed ${seed} gold`).toBeGreaterThan(3);
      expect(count(w, gold)).toBeLessThan(count(w, steel));
      // Ore sits in veins: nearly every ore cell touches another of its kind.
      let lonely = 0;
      let ore = 0;
      for (let i = 0; i < m.n; i++) {
        const r = m.rock[i];
        if (r !== steel && r !== gold) continue;
        ore++;
        const x = i % m.w;
        const y = (i / m.w) | 0;
        let friend = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && m.inBounds(x + dx, y + dy) && m.rock[m.idx(x + dx, y + dy)] === r) friend = true;
        }
        if (!friend) lonely++;
      }
      expect(lonely / ore, `seed ${seed}`).toBeLessThan(0.2);
    }
  });

  it('roofs the mountains, thick deep inside', () => {
    const w = createWorld({ seed: 42, settlements: false, wildlife: false });
    const m = w.map;
    const depth = rockDepth(m);
    let thick = 0;
    for (let i = 0; i < m.n; i++) {
      const want = !m.rock[i] ? ROOF.none : depth[i] >= THICK_ROOF_DEPTH ? ROOF.thick : ROOF.rock;
      if (m.roof[i] !== want) throw new Error(`roof at ${i} is ${m.roof[i]}, wanted ${want}`);
      if (m.roof[i] === ROOF.thick) thick++;
    }
    expect(thick).toBeGreaterThan(500);
    expect(Array.from(snapshot(w).roof!)).toEqual(Array.from(m.roof));
  });

  it('still leaves good starting sites in the outer band', () => {
    for (const seed of SEEDS) {
      const w = createWorld({ seed });
      const sites = suggestSites(w, 5);
      expect(sites.length, `seed ${seed}`).toBeGreaterThanOrEqual(4);
      for (const s of sites) {
        expect(siteProblem(w, s.x, s.y)).toBeNull();
        expect(s.region).not.toBe('center');
      }
    }
  });

  it('generates a 200x200 map quickly', () => {
    createWorld({ seed: 3, settlements: false, wildlife: false });
    const t = performance.now();
    createWorld({ seed: 5, settlements: false, wildlife: false });
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

/** A flat world with a 21x21 marble mountain at x 10..30, y 5..25, a steel vein at its heart. */
function mountainWorld(): { w: World; heart: number } {
  const w = flatWorld(44, 32);
  const m = w.map;
  const marble = ROCK_BY_KEY.marble.id;
  for (let y = 5; y <= 25; y++) {
    for (let x = 10; x <= 30; x++) {
      const c = m.idx(x, y);
      w.setTerrain(c, TERRAIN_BY_KEY.rough_marble.id);
      w.setRock(c, marble);
    }
  }
  for (let x = 17; x <= 20; x++) w.setRock(m.idx(x, 15), ROCK_BY_KEY.steel_ore.id);
  computeRoof(m);
  run(w, 1);
  return { w, heart: m.idx(20, 15) };
}

function itemTotal(w: World, def: string): number {
  return [...w.kinds.item]
    .map((id) => w.get<Item>(id)!)
    .filter((i) => i.def === def)
    .reduce((a, i) => a + i.count, 0);
}

describe('mining into a mountain', () => {
  it('leaves a roofed tunnel of rough stone, and yields stone and ore', () => {
    const { w, heart } = mountainWorld();
    const m = w.map;
    expect(m.roof[heart]).toBe(ROOF.thick);
    expect(m.roof[m.idx(10, 15)]).toBe(ROOF.rock);
    addPawn(w, 6, 15);
    w.enqueue(1, { c: 'designate', kind: 'mine', ...rect(10, 15, 20, 15) });
    runUntil(w, () => !m.rock[heart], 80_000);
    for (let x = 10; x <= 20; x++) {
      const c = m.idx(x, 15);
      expect(m.rock[c]).toBe(0);
      expect(m.terrain[c]).toBe(TERRAIN_BY_KEY.rough_marble.id);
      expect(TERRAINS[m.terrain[c]].buildable).toBe(true);
      expect(w.outdoors(c)).toBe(false);
    }
    // The roof stays after the rock is gone: deep in, it's overhead mountain.
    expect(m.roof[heart]).toBe(ROOF.thick);
    expect(m.roof[m.idx(10, 15)]).toBe(ROOF.rock);
    expect(m.roof[m.idx(9, 15)]).toBe(ROOF.none);
    expect(w.outdoors(m.idx(9, 15))).toBe(true);
    // 7 marble cells and 4 steel ore cells; each drops its yield most of the time.
    expect(itemTotal(w, 'stone')).toBeGreaterThanOrEqual(3 * ROCK_BY_KEY.marble.yieldCount);
    expect(itemTotal(w, 'stone') % ROCK_BY_KEY.marble.yieldCount).toBe(0);
    expect(itemTotal(w, 'steel')).toBeGreaterThanOrEqual(ROCK_BY_KEY.steel_ore.yieldCount);
    expect(itemTotal(w, 'gold')).toBe(0);
  });

  it('keeps the air in a tunnel steadier than outside, and more so deep in', () => {
    const { w, heart } = mountainWorld();
    const m = w.map;
    for (let x = 10; x <= 20; x++) w.setRock(m.idx(x, 15), 0);
    w.coldOffset = -40;
    const outside = w.tempAt(m.idx(5, 15));
    const mouth = w.tempAt(m.idx(10, 15));
    const deep = w.tempAt(heart);
    expect(outside).toBeLessThan(mouth);
    expect(mouth).toBeLessThan(deep);
    expect(deep).toBeLessThan(CAVE_TEMP);
  });

  it('a pocket dug out of sight of the open is a room that drifts toward the cave temperature', () => {
    const { w, heart } = mountainWorld();
    const m = w.map;
    for (let x = 12; x <= 20; x++) w.setRock(m.idx(x, 15), 0);
    w.coldOffset = -40;
    run(w, 251);
    expect(m.roomAt[heart]).not.toBe(0);
    const room = w.rooms.get(m.roomAt[heart])!;
    expect(room.cells.length).toBe(9);
    run(w, 250 * 40);
    expect(room.temp).toBeGreaterThan(w.outdoorTemp() + 10);
  });
});

describe('save compatibility', () => {
  it('saves and restores the roof', () => {
    const w = createWorld({ seed: 77, settlements: false, wildlife: false });
    const b = deserializeWorld(serializeWorld(w));
    expect(Array.from(b.map.roof)).toEqual(Array.from(w.map.roof));
    expect(hashWorld(b)).toBe(hashWorld(w));
  });

  it('version 5 saves (no roof) load, and their mountains get roofs', () => {
    const w = createWorld({ seed: 77, settlements: false, wildlife: false });
    const save = serializeWorld(w);
    save.version = 5;
    delete save.roof;
    expect(SAVE_VERSION).toBe(7);
    const b = deserializeWorld(save);
    expect(b.map.roof.some((r) => r === ROOF.thick)).toBe(true);
    expect(Array.from(b.map.roof)).toEqual(Array.from(w.map.roof));
    run(b, 300);
  });

  it('old granite and ore rock ids still mean the same thing', () => {
    expect(ROCKS[1].key).toBe('granite');
    expect(ROCKS[2].key).toBe('steel_ore');
    expect(ROCKS[3].key).toBe('gold_ore');
    expect(ROCKS[1].floor).toBe('rough_stone');
    expect(T.rough_stone).toBe(7);
  });
});
