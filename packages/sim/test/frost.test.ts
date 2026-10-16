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
import { T } from '@fe/defs';
import { flatWorld, run } from './helpers';

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

  it('freezes lakes into walkable ice behind the front, but not ahead of it', () => {
    const w = flatWorld(40, 40);
    const m = w.map;
    // A moat cutting off the west edge, and a pond in the middle of the map.
    for (let y = 0; y < 40; y++) w.setTerrain(m.idx(3, y), T.deep_water);
    for (const [x, y] of [[20, 20], [21, 20], [20, 21], [21, 21]]) w.setTerrain(m.idx(x, y), T.deep_water);
    m.rebuildComponents();
    const west = m.idx(1, 20);
    const east = m.idx(10, 20);
    expect(m.component(west)).not.toBe(m.component(east));

    w.tick = day(400) - (day(400) % 250);
    run(w, 250);
    for (let y = 0; y < 40; y++) expect(m.terrain[m.idx(3, y)]).toBe(T.ice);
    expect(m.terrain[m.idx(20, 20)]).toBe(T.deep_water);
    expect(m.component(west)).toBe(m.component(east));
    const incremental = Array.from({ length: m.n }, (_, i) => (m.solid[i] ? -1 : m.component(i)));
    m.rebuildComponents();
    const fresh = Array.from({ length: m.n }, (_, i) => (m.solid[i] ? -1 : m.component(i)));
    // Same partition: two cells share a region in one exactly when they do in the other.
    const pairs = (a: number[]) => a.map((c) => (c < 0 ? -1 : a.indexOf(c)));
    expect(pairs(incremental)).toEqual(pairs(fresh));

    // Freezing is derived from the map, so a reloaded world carries on identically.
    const b = deserializeWorld(serializeWorld(w));
    run(w, 2000);
    run(b, 2000);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });
});
