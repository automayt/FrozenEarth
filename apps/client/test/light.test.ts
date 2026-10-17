import { describe, expect, it } from 'vitest';
import { darknessAt, gradeAt, overcastOf, packRgb, SHADOW_ALPHA, sunAt } from '../src/render/light';

const none = new Set<string>();
const sun = (hour: number, overcast = 0) => sunAt(hour, darknessAt(hour, none), overcast);

describe('sun', () => {
  it('throws shadows west in the morning, south at noon, east in the evening', () => {
    expect(sun(8).x).toBeLessThan(-0.3);
    expect(Math.abs(sun(13).x)).toBeLessThan(0.01);
    expect(sun(13).y).toBeGreaterThan(0);
    expect(sun(18).x).toBeGreaterThan(0.3);
    // Always a little south: the light comes from the top of the screen.
    for (const h of [6, 9, 12, 15, 19]) expect(sun(h).y).toBeGreaterThan(0);
  });

  it('makes shadows long at the ends of the day and short at noon', () => {
    const len = (h: number) => Math.hypot(sun(h).x, sun(h).y);
    expect(len(7)).toBeGreaterThan(len(10));
    expect(len(10)).toBeGreaterThan(len(13));
    expect(len(19)).toBeGreaterThan(len(16));
    expect(len(13)).toBeLessThan(0.6);
  });

  it('casts no shadows at night and full ones by day', () => {
    expect(sun(1).strength).toBe(0);
    expect(sun(23).strength).toBe(0);
    expect(sun(13).strength).toBeCloseTo(SHADOW_ALPHA, 5);
    // Fading through dusk.
    expect(sun(20).strength).toBeGreaterThan(0);
    expect(sun(20).strength).toBeLessThan(sun(18).strength);
  });

  it('flattens shadows under cloud, fog and snow', () => {
    expect(overcastOf(new Set(['fog']), 'none')).toBe(1);
    expect(overcastOf(none, 'snow')).toBeGreaterThan(0.5);
    expect(overcastOf(none, 'none')).toBe(0);
    expect(sun(13, 1).strength).toBeLessThan(sun(13).strength * 0.4);
  });

  it('keeps an eclipse dark at midday', () => {
    expect(darknessAt(13, new Set(['eclipse']))).toBeGreaterThanOrEqual(0.8);
    expect(darknessAt(13, none)).toBe(0);
    expect(darknessAt(23, none)).toBe(1);
  });
});

describe('colour grade', () => {
  it('is neutral at noon, warm at dawn and dusk, blue at night', () => {
    const [r, g, b] = gradeAt(13, 0);
    expect(Math.min(r, g, b)).toBeGreaterThan(0.97);
    const dusk = gradeAt(19, 0);
    expect(dusk[0]).toBeGreaterThan(dusk[2] + 0.2);
    const dawn = gradeAt(6.5, 0);
    expect(dawn[0]).toBeGreaterThan(dawn[2]);
    const night = gradeAt(2, 0);
    expect(night[2]).toBeGreaterThan(night[0]);
  });

  it('wraps around midnight and greys out under cloud', () => {
    expect(gradeAt(24, 0)).toEqual(gradeAt(0, 0));
    const clear = gradeAt(19, 0);
    const grey = gradeAt(19, 1);
    expect(clear[0] - clear[2]).toBeGreaterThan(grey[0] - grey[2]);
  });

  it('packs to a 24-bit colour', () => {
    expect(packRgb(1, 1, 1)).toBe(0xffffff);
    expect(packRgb(1, 0, 0.5)).toBe(0xff0080);
    expect(packRgb(2, -1, 0)).toBe(0xff0000);
  });
});
