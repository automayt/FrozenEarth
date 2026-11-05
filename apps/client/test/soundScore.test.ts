import { describe, expect, it } from 'vitest';
import { Rng, type PathState } from '@fe/sim';
import { composeCalm, composeTense, cueForMoment, deathIn, REST_MIN, Tension, tensionFrom, tensionTarget, type TensionMirror } from '../src/sound/score';
import { doorOnPath, seasonCue, Watcher, type WatchMirror } from '../src/sound/watch';

const seeded = (seed: number) => {
  const r = new Rng(seed);
  return () => r.next();
};

describe('composeCalm', () => {
  it('spends most of a long session in silence', () => {
    const rng = seeded(1);
    let played = 0;
    let total = 0;
    while (total < 4 * 3600) {
      const p = composeCalm({ sparse: 0.2 }, rng);
      played += p.length;
      total += p.length + p.rest;
    }
    const share = played / total;
    expect(share).toBeLessThan(0.45);
    expect(share).toBeGreaterThan(0.1);
  });

  it('always rests at least a minute and a bit between phrases', () => {
    const rng = seeded(2);
    for (let i = 0; i < 300; i++) expect(composeCalm({ sparse: Math.random() }, rng).rest).toBeGreaterThanOrEqual(REST_MIN);
  });

  it('never plays the same phrase twice, so it cannot loop audibly', () => {
    const rng = seeded(3);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const melody = composeCalm({ sparse: 0 }, rng)
        .events.filter((e) => e.voice !== 'pad')
        .map((e) => `${e.semi}@${e.at.toFixed(1)}`)
        .join(' ');
      expect(seen.has(melody)).toBe(false);
      seen.add(melody);
    }
  });

  it('thins out in deep winter', () => {
    const count = (sparse: number) => {
      const rng = seeded(4);
      let notes = 0;
      let seconds = 0;
      for (let i = 0; i < 400; i++) {
        const p = composeCalm({ sparse }, rng);
        notes += p.events.length;
        seconds += p.length + p.rest;
      }
      return notes / seconds;
    };
    expect(count(1)).toBeLessThan(count(0) * 0.7);
  });

  it('keeps every note in order, in range, and inside the phrase', () => {
    const rng = seeded(5);
    for (let i = 0; i < 200; i++) {
      const p = composeCalm({ sparse: i % 2 }, rng);
      for (const e of p.events) {
        expect(e.at).toBeLessThan(p.length);
        expect(Math.abs(e.semi)).toBeLessThanOrEqual(24);
        expect(e.vel).toBeGreaterThan(0);
        expect(e.vel).toBeLessThanOrEqual(1);
        expect(Math.abs(e.pan)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('composeTense', () => {
  it('has no steady pulse', () => {
    const rng = seeded(6);
    const waits = Array.from({ length: 50 }, () => composeTense(0.8, rng).wait);
    expect(Math.max(...waits) - Math.min(...waits)).toBeGreaterThan(2);
  });

  it('comes on faster as things get worse', () => {
    const mean = (level: number) => {
      const rng = seeded(7);
      let sum = 0;
      for (let i = 0; i < 300; i++) sum += composeTense(level, rng).wait;
      return sum / 300;
    };
    expect(mean(1)).toBeLessThan(mean(0.3));
  });
});

describe('tension', () => {
  it('ranks the danger', () => {
    const none = { raiders: 0, demand: false, fighting: false, lastStand: false };
    expect(tensionTarget(none)).toBe(0);
    const demand = tensionTarget({ ...none, demand: true });
    const raid = tensionTarget({ ...none, raiders: 5 });
    const battle = tensionTarget({ ...none, raiders: 5, fighting: true });
    const last = tensionTarget({ ...none, raiders: 5, fighting: true, lastStand: true });
    expect(demand).toBeGreaterThan(0);
    expect(raid).toBeGreaterThan(0);
    expect(battle).toBeGreaterThan(raid);
    expect(last).toBeGreaterThan(battle);
  });

  it('rises within seconds, holds after the danger passes, then lets go slowly', () => {
    const t = new Tension();
    for (let s = 0; s < 8; s++) t.update(1, 1);
    expect(t.level).toBeGreaterThan(0.9);
    for (let s = 0; s < 20; s++) t.update(0, 1);
    expect(t.level).toBeGreaterThan(0.9);
    for (let s = 0; s < 20; s++) t.update(0, 1);
    expect(t.level).toBeLessThan(0.9);
    expect(t.level).toBeGreaterThan(0);
    for (let s = 0; s < 60; s++) t.update(0, 1);
    expect(t.level).toBe(0);
  });

  it('never jumps, up or down', () => {
    const t = new Tension();
    let last = 0;
    for (let s = 0; s < 400; s++) {
      const now = t.update(s % 120 < 50 ? 0.85 : 0, 0.25);
      expect(Math.abs(now - last)).toBeLessThan(0.06);
      last = now;
    }
  });

  const raid = { target: 1, size: 6, dead: 1, fled: false, breakAt: 3, until: 9999 };
  const mirror = (f: object[], choices: object[] = []) => ({ factions: new Map(f.map((x, i) => [i, x])), choices }) as unknown as TensionMirror;

  it('reads raiders against this colony from the mirror', () => {
    expect(tensionFrom(mirror([{ raid }]), 1, 100, false).raiders).toBe(5);
    expect(tensionFrom(mirror([{ raid }]), 2, 100, false).raiders).toBe(0);
    expect(tensionFrom(mirror([{ raid: { ...raid, fled: true } }]), 1, 100, false).raiders).toBe(0);
    expect(tensionFrom(mirror([{ raid: { ...raid, camp: 5 } }]), 1, 100, false).raiders).toBe(0);
    expect(tensionFrom(mirror([{}]), 1, 100, false).raiders).toBe(0);
  });

  it('notices a waiting demand and a last stand', () => {
    expect(tensionFrom(mirror([{ raid: { ...raid, parley: 500 } }]), 1, 100, false).demand).toBe(true);
    expect(tensionFrom(mirror([{ raid: { ...raid, parley: 50 } }]), 1, 100, false).demand).toBe(false);
    expect(tensionFrom(mirror([], [{ faction: 1, event: 'raid_demand' }]), 1, 100, false).demand).toBe(true);
    expect(tensionFrom(mirror([], [{ faction: 1, event: 'trade' }]), 1, 100, false).demand).toBe(false);
    expect(tensionFrom(mirror([{ raid: { ...raid, lastStand: [4, 6] } }]), 1, 100, false).lastStand).toBe(true);
  });

  it('is calm for a spectator with no colony', () => {
    expect(tensionFrom(mirror([{ raid }]), 0, 100, true)).toEqual({ raiders: 0, demand: false, fighting: true, lastStand: false });
  });
});

describe('moments', () => {
  it('gives the first raid the bigger cue, once', () => {
    expect(cueForMoment('Raiders!', false)).toBe('firstRaid');
    expect(cueForMoment('Raiders!', true)).toBe('raid');
    expect(cueForMoment('Ambush!', false)).toBe('firstRaid');
  });

  it('keeps music for the big moments', () => {
    expect(cueForMoment('The chief is down!', true)).toBe('chief');
    expect(cueForMoment('The frost is here', true)).toBe('frost');
    expect(cueForMoment('Love', true)).toBeNull();
    expect(cueForMoment('A new colonist', true)).toBeNull();
  });

  it('reads a death out of its letter', () => {
    expect(deathIn('Ada Blake of Northwatch has died of blood loss.')).toEqual({ name: 'Ada Blake', colony: 'Northwatch' });
    expect(deathIn('A trader has arrived.')).toBeNull();
  });
});

describe('Watcher', () => {
  const path = (cells: number[], times: number[]): PathState => ({ cells, times, t0: 0, fx: 0, fy: 0 }) as unknown as PathState;

  it('finds the door a path walks through in the window, once', () => {
    const p = path([10, 11, 12, 13], [100, 110, 120, 130]);
    const door = (c: number) => c === 12;
    expect(doorOnPath(p, 95, 115, door)).toBe(-1);
    expect(doorOnPath(p, 115, 125, door)).toBe(12);
    expect(doorOnPath(p, 125, 135, door)).toBe(-1);
    expect(doorOnPath(null, 0, 500, door)).toBe(-1);
  });

  it('marks the end of winter and its coming, and no other turn of the year', () => {
    expect(seasonCue('Winter', 'Spring')).toBe('thaw');
    expect(seasonCue('Fall', 'Winter')).toBe('frost');
    expect(seasonCue('Spring', 'Summer')).toBeNull();
    expect(seasonCue('', 'Winter')).toBeNull();
    expect(seasonCue('Winter', 'Winter')).toBeNull();
  });

  const out = () => {
    const heard: string[] = [];
    return { heard, sink: { play: (k: string) => heard.push(k), cue: (c: string) => heard.push(c) } };
  };
  const pawn = (id: number, extra: object) => ({ id, kind: 'pawn', x: 5, y: 5, path: null, ...extra });
  const mirror = (ents: { id: number }[]) => ({ w: 100, entities: new Map(ents.map((e) => [e.id, e])), buildingAt: new Int32Array(100 * 100) }) as unknown as WatchMirror;

  it('hears a hurt animal fall, but not one that just wandered off', () => {
    const { heard, sink } = out();
    const w = new Watcher(sink as never, () => 1);
    const m = mirror([pawn(1, { species: 'deer', aggro: 9 }), pawn(2, { species: 'deer' })]);
    w.note(m, new Set(), new Set());
    w.note(m, new Set(), new Set([1, 2]));
    expect(heard).toEqual(['animalDeath']);
  });

  it('stays quiet when a snapshot replaces everything', () => {
    const { heard, sink } = out();
    const w = new Watcher(sink as never, () => 1);
    const ents = Array.from({ length: 60 }, (_, i) => pawn(i + 1, { species: 'wolf', aggro: 1 }));
    const m = mirror(ents);
    w.note(m, new Set(), new Set());
    w.note(m, new Set(), new Set(ents.map((e) => e.id)));
    expect(heard).toEqual([]);
  });

  it('only calls animals that are in view', () => {
    const { heard, sink } = out();
    const w = new Watcher(sink as never, () => 0);
    const m = mirror([pawn(1, { species: 'wolf' })]);
    w.note(m, new Set(), new Set());
    w.sample(m, 1000, { x0: 50, y0: 50, x1: 60, y1: 60 }, 0.25);
    expect(heard).toEqual([]);
    w.sample(m, 1010, { x0: 0, y0: 0, x1: 10, y1: 10 }, 0.25);
    expect(heard).toEqual(['wolf']);
  });
});
