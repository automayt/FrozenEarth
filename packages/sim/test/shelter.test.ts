import { describe, expect, it } from 'vitest';
import { START_TICK, type Pawn, type World } from '../src';
import { setPact } from '../src/pacts';
import { addPawn, flatWorld, run } from './helpers';

/** A colony (2) at work around (20, 20), and a raider band (5) that can be placed anywhere. */
function colony(): { w: World; worker: Pawn } {
  const w = flatWorld(80, 60);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 20, y: 20 }, isPlayer: true });
  w.factions.set(5, { id: 5, name: 'Raiders', color: 0x880000, home: { x: 79, y: 20 }, isPlayer: false, raid: { target: 2, size: 1, breakAt: 1, dead: 0, until: START_TICK + 1e7, fled: false } });
  const worker = addPawn(w, 20, 20, 2);
  return { w, worker };
}

/** A hostile that stands where it's put. */
function standing(w: World, x: number, y: number, faction: number, weapon = 'rifle'): Pawn {
  const p = w.spawnPawn(faction, w.map.idx(x, y), 'Threat', undefined, weapon);
  p.drafted = true;
  p.needs.food = 1;
  p.needs.rest = 1;
  return p;
}

const dist = (a: Pawn, b: Pawn) => Math.hypot(a.x - b.x, a.y - b.y);

describe('colonists who are not drafted', () => {
  it('break off and take cover when a raider comes close, then go back to work once it is gone', () => {
    const { w, worker } = colony();
    const raider = standing(w, 28, 20, 5);
    const before = dist(worker, raider);
    run(w, 60);
    expect(worker.job?.type).toBe('shelter');
    run(w, 400);
    expect(dist(worker, raider)).toBeGreaterThan(before + 4);
    w.despawn(raider.id);
    run(w, 120);
    expect(worker.job?.type).not.toBe('shelter');
  });

  it('fight back when cornered', () => {
    const { w, worker } = colony();
    worker.weapon = 'knife';
    standing(w, 21, 20, 5, 'club');
    run(w, 31);
    expect(worker.job?.type).toBe('attack');
  });

  it('stay put when drafted, and ignore grazing animals and colonies at peace', () => {
    const { w, worker } = colony();
    worker.drafted = true;
    standing(w, 26, 20, 5);
    run(w, 60);
    expect(worker.job?.type).not.toBe('shelter');

    const calm = colony();
    calm.w.factions.set(9, { id: 9, name: 'Neighbours', color: 0x00ff00, home: { x: 60, y: 40 }, isPlayer: true });
    standing(calm.w, 26, 20, 9);
    run(calm.w, 60);
    expect(calm.worker.job?.type).not.toBe('shelter');
    // At war, the same neighbour is a threat.
    setPact(calm.w, 2, 9, 'war');
    run(calm.w, 60);
    expect(calm.worker.job?.type).toBe('shelter');
  });
});
