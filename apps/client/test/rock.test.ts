import { describe, expect, it } from 'vitest';
import { ROCK_BY_KEY, ROOF, TERRAIN_BY_KEY } from '@fe/defs';
import { computeRoof, createWorld, World } from '@fe/sim';
import { paintRockCell, ROCK_PX, RockLayer, rockCellHasContent, type RockMap } from '../src/render/rock';

const P = ROCK_PX;

/** A 30x20 open map with a 10x8 slate block at x 10..19, y 6..13 and a steel vein in it. */
function blockMap(): RockMap & { w: number } {
  const w = new World(1, 30, 20);
  const m = w.map;
  for (let y = 6; y <= 13; y++) {
    for (let x = 10; x <= 19; x++) {
      m.rock[m.idx(x, y)] = ROCK_BY_KEY.slate.id;
      m.terrain[m.idx(x, y)] = TERRAIN_BY_KEY.rough_slate.id;
    }
  }
  for (let x = 14; x <= 16; x++) m.rock[m.idx(x, 9)] = ROCK_BY_KEY.steel_ore.id;
  computeRoof(m);
  return m;
}

function paint(m: RockMap, c: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(P * P * 4);
  paintRockCell(m, c, data, P, 0, 0);
  return data;
}

const alphaAt = (d: Uint8ClampedArray, px: number, py: number) => d[(py * P + px) * 4 + 3];
const lumaAt = (d: Uint8ClampedArray, px: number, py: number) => {
  const o = (py * P + px) * 4;
  return (d[o] + d[o + 1] + d[o + 2]) / 3;
};

describe('rock painting', () => {
  it('leaves open ground away from rock transparent and fills rock solid', () => {
    const m = blockMap();
    const far = paint(m, 2 * m.w + 2);
    expect(far.every((v) => v === 0)).toBe(true);
    expect(rockCellHasContent(m, 2 * m.w + 2)).toBe(false);
    const inner = paint(m, 10 * m.w + 12);
    for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) expect(alphaAt(inner, px, py)).toBe(255);
  });

  it('draws a dark outline at the edge, bulging a little onto the open ground', () => {
    const m = blockMap();
    // Across the west face, from the open cell into the rock: transparent, then a solid near-black outline, then stone.
    const edge = paint(m, 10 * m.w + 10);
    const lip = paint(m, 10 * m.w + 9);
    const row = P >> 1;
    const line: { a: number; l: number }[] = [];
    for (let px = 0; px < P; px++) line.push({ a: alphaAt(lip, px, row), l: lumaAt(lip, px, row) });
    for (let px = 0; px < P; px++) line.push({ a: alphaAt(edge, px, row), l: lumaAt(edge, px, row) });
    expect(line[0].a).toBe(0);
    const dark = line.findIndex((p) => p.a === 255 && p.l < 25);
    expect(dark).toBeGreaterThan(0);
    expect(line.at(-1)!.l).toBeGreaterThan(line[dark].l + 10);
    // The open cell carries the outline's lip on its east side, and nothing on its west side.
    let lipPixels = 0;
    for (let py = 0; py < P; py++) if (alphaAt(lip, P - 1, py) > 0) lipPixels++;
    expect(lipPixels).toBeGreaterThan(P / 2);
    for (let py = 0; py < P; py++) expect(alphaAt(lip, 0, py)).toBe(0);
  });

  it('lights faces toward the light and shades the cliff side', () => {
    const m = blockMap();
    // Just inside the outline: north face (toward the light) vs south face (away from it).
    const north = paint(m, 6 * m.w + 14);
    const south = paint(m, 13 * m.w + 14);
    let n = 0;
    let s = 0;
    for (let px = 0; px < P; px++) {
      n += lumaAt(north, px, 5);
      s += lumaAt(south, px, P - 6);
    }
    expect(n).toBeGreaterThan(s * 1.2);
  });

  it('shows ore as glints in the vein', () => {
    const m = blockMap();
    const ore = paint(m, 9 * m.w + 15);
    const stone = paint(m, 12 * m.w + 15);
    const bright = (d: Uint8ClampedArray) => {
      let k = 0;
      for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) if (lumaAt(d, px, py) > 110) k++;
      return k;
    };
    expect(bright(stone)).toBe(0);
    expect(bright(ore)).toBeGreaterThanOrEqual(2);
  });

  it('dims a tunnel under the mountain, darker under overhead mountain', () => {
    const m = blockMap();
    const thin = 7 * m.w + 12;
    const deep = 10 * m.w + 14;
    m.rock[thin] = 0;
    m.rock[deep] = 0;
    expect(m.roof[thin]).toBe(ROOF.rock);
    expect(m.roof[deep]).toBe(ROOF.thick);
    const a = paint(m, thin);
    const b = paint(m, deep);
    // Centre pixels: translucent shade, not solid rock and not bare ground.
    const ca = alphaAt(a, P >> 1, P >> 1);
    const cb = alphaAt(b, P >> 1, P >> 1);
    expect(ca).toBeGreaterThan(0);
    expect(cb).toBeLessThan(255);
    expect(cb).toBeGreaterThan(ca);
  });

  it('paints a real map in good time', () => {
    const w = createWorld({ seed: 11, settlements: false, wildlife: false });
    const m = w.map;
    const data = new Uint8ClampedArray(P * P * 4);
    const t = performance.now();
    let cells = 0;
    for (let c = 0; c < m.n; c++) {
      if (!rockCellHasContent(m, c)) continue;
      paintRockCell(m, c, data, P, 0, 0);
      cells++;
    }
    expect(cells).toBeGreaterThan(5000);
    // About 0.1 s here; the budget is loose for slow CI machines.
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('RockLayer', () => {
  it('makes chunk textures only where there is rock, and repaints just around a mined cell', () => {
    const m = blockMap();
    const layer = new RockLayer(m.w, m.h, 32);
    layer.drawAll(m);
    // 30x20 cells in 16-cell chunks is 2x2; the block (x 9..20 with its lip, y 5..14) touches the top two.
    expect(layer.chunkCount).toBe(2);
    const open = new RockLayer(m.w, m.h, 32);
    open.drawAll({ ...m, rock: new Uint8Array(m.w * m.h), roof: new Uint8Array(m.w * m.h) });
    expect(open.chunkCount).toBe(0);
    // Mining a cell keeps the chunk count and doesn't throw on the update path.
    const c = 6 * m.w + 12;
    m.rock[c] = 0;
    layer.update(m, [c]);
    expect(layer.chunkCount).toBe(2);
    layer.destroy();
    open.destroy();
  });
});
