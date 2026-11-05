import { describe, expect, it } from 'vitest';
import { T } from '@fe/defs';
import { DEFAULT_FROST, TICKS_PER_DAY, TICKS_PER_HOUR, type Condition } from '@fe/sim';
import { layerTargets, sampleScene, type Scene, type SceneMirror } from '../src/sound/scene';

const W = 200;
const H = 200;
const DAYS_PER_SEASON = 5;
const NO_FROST = { ...DEFAULT_FROST, startDay: 100000 };

function world(paint?: (m: SceneMirror) => void, conditions: Condition[] = []): SceneMirror {
  const n = W * H;
  const m = {
    w: W,
    h: H,
    terrain: new Uint8Array(n),
    fire: new Uint8Array(n),
    fireCells: new Set<number>(),
    buildingAt: new Int32Array(n),
    plantAt: new Int32Array(n),
    frost: NO_FROST,
    coldOffset: 0,
    conditions,
    entities: new Map(),
  } as unknown as SceneMirror;
  paint?.(m);
  return m;
}

/** A tick in a season (0 spring .. 3 winter) at an hour. */
const at = (season: number, hour: number) => (season * DAYS_PER_SEASON + 2) * TICKS_PER_DAY + hour * TICKS_PER_HOUR;

const calm: Scene = { hour: 12, season: 'Summer', temp: 24, dark: 0, frostNear: 0, frozen: 0, water: 0, waterPan: 0, fire: 0, firePan: 0, green: 0.6, altitude: 0, precip: 'none', wind: 0 };

describe('sampleScene', () => {
  it('hears water close by, on the side it lies', () => {
    const m = world((w) => {
      for (let y = 90; y < 110; y++) for (let x = 106; x < 120; x++) w.terrain[y * W + x] = T.shallow_water;
    });
    const s = sampleScene(m, 100, 100, 40, at(1, 12), 'none', 0);
    expect(s.water).toBeGreaterThan(0.1);
    expect(s.waterPan).toBeGreaterThan(0.2);
    expect(sampleScene(m, 30, 30, 40, at(1, 12), 'none', 0).water).toBe(0);
  });

  it('hears nothing from water that has frozen', () => {
    const m = world((w) => w.terrain.fill(T.ice));
    expect(sampleScene(m, 100, 100, 40, at(1, 12), 'none', 0).water).toBe(0);
  });

  it('hears a campfire and burning cells, louder the closer they are', () => {
    const camp = world((w) => {
      w.buildingAt[103 * W + 103] = 7;
      (w.entities as Map<number, unknown>).set(7, { def: 'campfire' });
    });
    const near = sampleScene(camp, 100, 100, 40, at(1, 12), 'none', 0).fire;
    const far = sampleScene(camp, 88, 100, 40, at(1, 12), 'none', 0).fire;
    expect(near).toBeGreaterThan(0.2);
    expect(far).toBeLessThan(near);
    const burn = world((w) => {
      w.fire[100 * W + 110] = 3;
      w.fireCells.add(100 * W + 110);
    });
    const s = sampleScene(burn, 100, 100, 40, at(1, 12), 'none', 0);
    expect(s.fire).toBeGreaterThan(0.1);
    expect(s.firePan).toBeGreaterThan(0);
  });

  it('still catches a campfire when pulled far out, and sees height', () => {
    const camp = world((w) => {
      w.buildingAt[100 * W + 100] = 7;
      (w.entities as Map<number, unknown>).set(7, { def: 'campfire' });
    });
    const s = sampleScene(camp, 100, 100, 240, at(1, 12), 'none', 0);
    expect(s.altitude).toBe(1);
    expect(s.fire).toBeGreaterThan(0.2);
  });

  it('looks at a bounded number of cells however wide the view', () => {
    let reads = 0;
    const m = world();
    const terrain = new Proxy(m.terrain, {
      get(t, k) {
        if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    sampleScene({ ...m, terrain }, 100, 100, 260, at(1, 12), 'none', 0);
    expect(reads).toBeLessThan(2000);
    expect(reads).toBeGreaterThan(100);
  });

  it('knows the camera is nearing the frost line from the map edge', () => {
    const m = world();
    m.frost = { ...DEFAULT_FROST, startDay: 0 };
    const tick = at(3, 12) * 4;
    const centre = sampleScene(m, 100, 100, 40, tick, 'none', 0);
    const edge = sampleScene(m, 2, 100, 40, tick, 'none', 0);
    expect(edge.frostNear).toBeGreaterThan(centre.frostNear);
    expect(edge.frostNear).toBeCloseTo(1);
  });

  it('reads the hour, season and cold from the tick', () => {
    const s = sampleScene(world(), 100, 100, 40, at(3, 2), 'none', 0);
    expect(s.season).toBe('Winter');
    expect(s.hour).toBeCloseTo(2);
    expect(s.dark).toBe(1);
  });

  it('copes with the camera off the edge of the map', () => {
    const s = sampleScene(world(), -50, 900, 40, at(1, 12), 'none', 0);
    expect(Number.isFinite(s.water + s.fire + s.green)).toBe(true);
  });
});

describe('layerTargets', () => {
  it('fills a warm day with birds and insects and no night sounds', () => {
    const l = layerTargets(calm);
    expect(l.birds).toBeGreaterThan(0.5);
    expect(l.insects).toBeGreaterThan(0.5);
    expect(l.crickets).toBe(0);
    expect(l.wolves).toBe(0);
  });

  it('brings crickets in at dusk', () => {
    const l = layerTargets({ ...calm, hour: 20.5, dark: 0.75 });
    expect(l.crickets).toBeGreaterThan(0.5);
    expect(l.birds).toBe(0);
    expect(l.insects).toBe(0);
  });

  it('crosses from day to dusk without a jump', () => {
    let last = layerTargets({ ...calm, hour: 17, dark: 0 });
    for (let h = 17; h < 23; h += 0.1) {
      const dark = h < 19 ? 0 : h > 21 ? 1 : (h - 19) / 2;
      const l = layerTargets({ ...calm, hour: h, dark });
      expect(Math.abs(l.crickets - last.crickets)).toBeLessThan(0.15);
      expect(Math.abs(l.birds - last.birds)).toBeLessThan(0.15);
      last = l;
    }
  });

  it('has wolves at night, most of all in winter, and no small life then', () => {
    const summer = layerTargets({ ...calm, hour: 1, dark: 1 });
    const winter = layerTargets({ ...calm, hour: 1, dark: 1, season: 'Winter', temp: -8 });
    expect(summer.wolves).toBeGreaterThan(0);
    expect(winter.wolves).toBeGreaterThan(summer.wolves);
    expect(winter.crickets).toBe(0);
    expect(winter.birds).toBe(0);
  });

  it('silences small life in winter days and in the rain', () => {
    expect(layerTargets({ ...calm, season: 'Winter', temp: -4 }).birds).toBe(0);
    expect(layerTargets({ ...calm, precip: 'storm', wind: 0.8 }).birds).toBe(0);
    expect(layerTargets({ ...calm, precip: 'rain', wind: 0.3 }).birds).toBeLessThan(layerTargets(calm).birds);
  });

  it('raises the wind toward the frost line, with storms, and with cold', () => {
    const base = layerTargets(calm).wind;
    const near = layerTargets({ ...calm, frostNear: 0.8 }).wind;
    const storm = layerTargets({ ...calm, wind: 0.8, precip: 'storm' }).wind;
    const cold = layerTargets({ ...calm, temp: -12 }).wind;
    expect(near).toBeGreaterThan(base + 0.2);
    expect(storm).toBeGreaterThan(base + 0.3);
    expect(cold).toBeGreaterThan(base);
    expect(layerTargets({ ...calm, frostNear: 1, wind: 1, temp: -30, altitude: 1 }).wind).toBeLessThanOrEqual(1);
  });

  it('only lets the wind whistle when it really blows', () => {
    expect(layerTargets(calm).whistle).toBe(0);
    expect(layerTargets({ ...calm, frostNear: 1, wind: 0.6 }).whistle).toBeGreaterThan(0.3);
  });

  it('kills the birds at the frost line, and starts the ice cracking', () => {
    const l = layerTargets({ ...calm, frostNear: 1 });
    expect(l.birds).toBe(0);
    expect(l.ice).toBe(1);
    expect(layerTargets(calm).ice).toBe(0);
  });

  it('fades ground sounds when the camera is high', () => {
    const low = layerTargets({ ...calm, water: 0.8, fire: 0.8 });
    const high = layerTargets({ ...calm, water: 0.8, fire: 0.8, altitude: 1 });
    expect(high.water).toBeLessThan(low.water * 0.2);
    expect(high.fire).toBeLessThan(low.fire * 0.2);
    expect(high.wind).toBeGreaterThan(low.wind);
  });

  it('rains with the weather and thunders only in a storm', () => {
    expect(layerTargets({ ...calm, precip: 'rain' }).rain).toBeCloseTo(0.6);
    expect(layerTargets({ ...calm, precip: 'rain' }).thunder).toBe(0);
    expect(layerTargets({ ...calm, precip: 'storm' }).thunder).toBe(1);
    expect(layerTargets({ ...calm, precip: 'blizzard' }).rain).toBe(0);
  });

  it('stays within 0..1 whatever the scene', () => {
    for (const hour of [0, 4, 6, 12, 18, 20, 23.9]) {
      for (const season of ['Spring', 'Summer', 'Fall', 'Winter'] as const) {
        const l = layerTargets({ ...calm, hour, season, temp: -40, dark: 1, frostNear: 1, frozen: 1, water: 1, fire: 1, altitude: 1, wind: 1, precip: 'blizzard' });
        for (const v of Object.values(l)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
