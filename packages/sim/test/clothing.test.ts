import { describe, expect, it } from 'vitest';
import { DAYS_PER_SEASON, hasCondition, TICKS_PER_DAY, TICKS_PER_HOUR, START_TICK } from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const WINTER = START_TICK + (3 * DAYS_PER_SEASON - 2) * TICKS_PER_DAY;

describe('clothing', () => {
  it('colonists start in a tunic', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    expect(p.apparel).toEqual(['tunic']);
  });

  it('puts on a parka and tuque in winter', () => {
    const w = flatWorld();
    w.tick = WINTER;
    const p = addPawn(w, 5, 5);
    w.spawnItem('parka', 1, w.map.idx(9, 9));
    w.spawnItem('tuque', 1, w.map.idx(3, 9));
    runUntil(w, () => p.apparel.includes('parka') && p.apparel.includes('tuque'), 3000);
    expect([...p.apparel].sort()).toEqual(['parka', 'tunic', 'tuque']);
  });

  it('takes the parka off in summer', () => {
    const w = flatWorld();
    w.tick = START_TICK + DAYS_PER_SEASON * TICKS_PER_DAY;
    const p = addPawn(w, 5, 5);
    p.apparel.push('parka');
    runUntil(w, () => !p.apparel.includes('parka'), 3000);
    expect([...w.kinds.item].length).toBe(1);
  });

  it('a parka keeps a colonist alive outdoors in a hard frost', () => {
    const w = flatWorld();
    w.tick = WINTER;
    w.coldOffset = -8;
    const bundled = addPawn(w, 5, 5);
    bundled.apparel.push('parka', 'tuque');
    const bare = addPawn(w, 8, 8);
    w.spawnItem('survival_meal', 20, w.map.idx(6, 6));
    run(w, TICKS_PER_DAY);
    expect(w.outdoorTemp()).toBeLessThan(0);
    expect(hasCondition(bundled, 'hypothermia')).toBe(false);
    expect(!w.get(bare.id) || hasCondition(bare, 'hypothermia')).toBe(true);
  });
});

describe('skills', () => {
  it('practice raises the skill and speeds up the work', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    p.skills.mining = { level: 0, xp: 0 };
    for (let x = 10; x < 30; x++) w.setRock(w.map.idx(x, 5), 1);
    w.enqueue(1, { c: 'designate', kind: 'mine', x0: 10, y0: 5, x1: 29, y1: 5 });
    const firstRock = runUntil(w, () => w.map.rock[w.map.idx(10, 5)] === 0, 6000);
    runUntil(w, () => p.skills.mining.level >= 4, 20 * TICKS_PER_HOUR * 3);
    expect(p.skills.mining.level).toBeGreaterThanOrEqual(4);
    expect(firstRock).toBeGreaterThan(0);
  });
});
