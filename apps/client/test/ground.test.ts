import { describe, expect, it } from 'vitest';
import { TERRAINS, T } from '@fe/defs';
import { ATLAS_COLS, ATLAS_GUTTER, ATLAS_SLOT, ATLAS_TILE, blitSlot, buildParams, KIND, makeNoise, PARAM_W, planAtlas, terrainKind, textureKey, writeIndex } from '../src/render/groundData';

const kinds = new Uint8Array(256);
const deep = new Uint8Array(256);
for (const t of TERRAINS) {
  kinds[t.id] = terrainKind(t.key);
  deep[t.id] = t.key.startsWith('deep') ? 1 : 0;
}

describe('ground shader data', () => {
  it('sorts terrains into land, floors, water and ice, and shares the rough stone texture', () => {
    expect(terrainKind('soil')).toBe(KIND.land);
    expect(terrainKind('wood_floor')).toBe(KIND.floor);
    expect(terrainKind('stone_tile')).toBe(KIND.floor);
    expect(terrainKind('deep_water')).toBe(KIND.water);
    expect(terrainKind('ice')).toBe(KIND.ice);
    expect(textureKey('rough_limestone')).toBe('terrain_rough_stone');
    expect(textureKey('shallow_water')).toBeNull();
    const plan = planAtlas([...TERRAINS, { id: TERRAINS.length, key: 'rough_slate', color: 0x404850 }]);
    expect(plan.slotOf[TERRAINS.length]).toBe(plan.slotOf[T.rough_stone]);
    expect(plan.slotOf[T.shallow_water]).toBe(-1);
    expect(new Set(plan.keys).size).toBe(plan.keys.length);
  });

  it('tints a borrowed texture toward its own terrain colour', () => {
    const slate = { id: TERRAINS.length, key: 'rough_slate', color: 0x404850 };
    const all = [...TERRAINS, slate];
    const plan = planAtlas(all);
    const means = plan.keys.map(() => [100, 100, 100]);
    const p = buildParams(all, plan, means, 0);
    const row1 = PARAM_W * 4 + slate.id * 4;
    // 0x40 / 100 of the texture mean, stored as tint / 2.
    expect(p[row1] / 127.5).toBeCloseTo(0x40 / 100, 1);
    expect(p[row1 + 2] / 127.5).toBeCloseTo(0x50 / 100, 1);
    expect(p[slate.id * 4 + 1]).toBe(KIND.land);
    expect(p[T.marsh * 4 + PARAM_W * 4 + 3]).toBe(255);
  });

  it('deepens water away from the shore, and keeps deep water deep', () => {
    const w = 20;
    const h = 5;
    const terrain = new Uint8Array(w * h).fill(T.soil);
    for (let y = 0; y < h; y++) for (let x = 2; x < w; x++) terrain[y * w + x] = x < 6 ? T.shallow_water : T.deep_water;
    const out = new Uint8Array(w * h * 4);
    writeIndex(out, terrain, w, h, kinds, deep, 0, 0, w - 1, h - 1);
    const depth = (x: number) => out[(2 * w + x) * 4 + 1] / 255;
    expect(depth(0)).toBe(0);
    expect(depth(2)).toBe(0);
    expect(depth(4)).toBeGreaterThan(depth(3));
    expect(depth(5)).toBeLessThanOrEqual(0.51);
    expect(depth(6)).toBeGreaterThanOrEqual(0.54);
    expect(depth(12)).toBe(1);
    expect(out[(2 * w + 12) * 4]).toBe(T.deep_water);
    // A partial rewrite matches the full one.
    const again = out.slice();
    again.fill(0, 0, 4 * w * 2);
    writeIndex(again, terrain, w, h, kinds, deep, 0, 0, w - 1, 1);
    expect(again).toEqual(out);
  });

  it('makes noise that wraps around', () => {
    const n = 32;
    const z = makeNoise(n, 3);
    let edge = 0;
    let inner = 0;
    for (let y = 0; y < n; y++) {
      edge += Math.abs(z[(y * n + n - 1) * 4] - z[y * n * 4]);
      inner += Math.abs(z[(y * n + 15) * 4] - z[(y * n + 16) * 4]);
    }
    // Neighbours across the wrap differ no more than neighbours in the middle do.
    expect(edge).toBeLessThan(inner * 2 + n * 4);
    expect(Math.max(...z.filter((_, i) => i % 4 === 0))).toBe(255);
  });

  it('copies a texture into its atlas slot with wrapped gutters', () => {
    const src = { w: 4, h: 4, data: new Uint8ClampedArray(64) };
    for (let i = 0; i < 16; i++) src.data.set([i * 10, 0, 0, 255], i * 4);
    const aw = ATLAS_COLS * ATLAS_SLOT;
    const atlas = new Uint8Array(aw * ATLAS_SLOT * 2 * 4);
    const mean = blitSlot(atlas, aw, 5, src);
    expect(mean[0]).toBeGreaterThan(50);
    const at = (x: number, y: number) => atlas[((ATLAS_SLOT + y) * aw + ATLAS_SLOT + x) * 4];
    // The gutter repeats the far edge of the tile.
    expect(at(ATLAS_GUTTER - 1, 100)).toBe(at(ATLAS_GUTTER + ATLAS_TILE - 1, 100));
    expect(at(ATLAS_GUTTER + ATLAS_TILE, 100)).toBe(at(ATLAS_GUTTER, 100));
  });
});
