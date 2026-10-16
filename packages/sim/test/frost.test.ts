import { describe, expect, it } from 'vitest';
import {
  addPlayerFaction,
  createWorld,
  daysUntilFrost,
  DEFAULT_FROST,
  deserializeWorld,
  FROST_MAX,
  frostRadius,
  hashWorld,
  serializeWorld,
  siteProblem,
  START_TICK,
  suggestSites,
  TICKS_PER_DAY,
} from '../src';
import { run } from './helpers';

const day = (d: number) => START_TICK + d * TICKS_PER_DAY;

describe('frost line', () => {
  it('waits, then closes in season by season, never past the refuge', () => {
    expect(frostRadius(day(0))).toBe(FROST_MAX);
    expect(frostRadius(day(DEFAULT_FROST.startDay))).toBe(FROST_MAX);
    let prev = FROST_MAX;
    for (let d = 0; d <= 400; d += 1) {
      const r = frostRadius(day(d));
      expect(r).toBeLessThanOrEqual(prev + 1e-12);
      prev = r;
    }
    // Corners are frozen within a couple of seasons of the start, the middle band within about two years.
    expect(frostRadius(day(20))).toBeLessThan(1.41);
    expect(frostRadius(day(50))).toBeLessThan(0.9);
    expect(frostRadius(day(400))).toBeCloseTo(DEFAULT_FROST.minRadius, 5);
  });

  it('a faster pace freezes sooner', () => {
    expect(frostRadius(day(30), { ...DEFAULT_FROST, pace: 2 })).toBeLessThan(frostRadius(day(30)));
  });

  it('makes frozen ground far colder than ground inside the line', () => {
    const w = createWorld({ seed: 2, width: 120, height: 120 });
    w.tick = day(60);
    const corner = w.map.idx(1, 1);
    const center = w.map.idx(60, 60);
    expect(w.frostAt(corner)).toBe(1);
    expect(w.frostAt(center)).toBe(0);
    expect(w.tempAt(center) - w.tempAt(corner)).toBeGreaterThan(25);
  });

  it('counts down to the frost reaching a spot', () => {
    const t = day(DEFAULT_FROST.startDay);
    const soon = daysUntilFrost(2, 2, 120, 120, t);
    expect(soon).toBeGreaterThan(0);
    expect(soon).toBeLessThan(30);
    expect(daysUntilFrost(60, 60, 120, 120, t)).toBe(Infinity);
  });

  it("won't let anyone settle on frozen land, and suggests sites inside the line", () => {
    const w = createWorld({ seed: 6, width: 160, height: 160 });
    w.tick = day(45);
    expect(siteProblem(w, 10, 10)).toMatch(/frozen/);
    const sites = suggestSites(w, 5);
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) expect(w.frostAt(w.map.idx(s.x, s.y))).toBe(0);
  });

  it('warns a colony before the frost arrives, then again when it does', () => {
    const w = createWorld({ seed: 8, width: 120, height: 120 });
    addPlayerFaction(w, 'Edge', 3, { x: 10, y: 60 });
    const texts: string[] = [];
    const orig = w.message.bind(w);
    w.message = (f, t, tone, at) => {
      texts.push(t);
      orig(f, t, tone, at);
    };
    run(w, 40 * TICKS_PER_DAY);
    expect(texts.some((t) => t.includes('frost line has begun to move'))).toBe(true);
    expect(texts.some((t) => t.includes('will reach your colony'))).toBe(true);
    expect(texts.some((t) => t.includes('has reached your colony'))).toBe(true);
  });

  it('frost settings survive save and load', () => {
    const w = createWorld({ seed: 3, width: 80, height: 80 });
    w.frost = { ...DEFAULT_FROST, pace: 1.7, startDay: 3 };
    const b = deserializeWorld(serializeWorld(w));
    expect(b.frost).toEqual(w.frost);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });
});
