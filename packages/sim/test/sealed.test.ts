import { describe, expect, it } from 'vitest';
import { findPath, sealedFrom } from '../src/pathfinding';
import { updateRooms } from '../src/rare';
import { flatWorld } from './helpers';

/** A walled 5x5 storeroom owned by colony 3, door on the south side, in an open field. */
function storeroom(doorFaction: number) {
  const w = flatWorld(60, 60);
  w.factions.set(2, { id: 2, name: 'Us', color: 0, home: { x: 5, y: 5 }, isPlayer: true });
  w.factions.set(3, { id: 3, name: 'Them', color: 0, home: { x: 40, y: 40 }, isPlayer: true });
  for (let y = 30; y <= 36; y++) {
    for (let x = 30; x <= 36; x++) {
      if (x > 30 && x < 36 && y > 30 && y < 36) continue;
      w.spawnBuilding(x === 33 && y === 36 ? 'door' : 'wood_wall', w.map.idx(x, y), x === 33 && y === 36 ? doorFaction : 3);
    }
  }
  w.map.roomsDirty = false;
  w.map.wallChanges = [];
  for (let y = 30; y <= 36; y++) for (let x = 30; x <= 36; x++) w.map.wallChanges.push(w.map.idx(x, y));
  updateRooms(w);
  return w;
}

describe('paths into locked rooms', () => {
  it('fail at once for outsiders, and still work for the owners and through unowned doors', () => {
    const w = storeroom(3);
    const inside = w.map.idx(33, 33);
    const out = w.map.idx(5, 5);
    expect(w.map.roomAt[inside]).not.toBe(0);
    expect(sealedFrom(w, out, inside, 2)).toBe(true);
    expect(findPath(w, out, inside, false, 2)).toBeNull();
    expect(sealedFrom(w, out, inside, 3)).toBe(false);
    expect(findPath(w, out, inside, false, 3)?.length).toBeGreaterThan(0);
    // Already inside: never sealed.
    expect(sealedFrom(w, w.map.idx(32, 32), inside, 2)).toBe(false);
    const open = storeroom(0);
    expect(sealedFrom(open, out, inside, 2)).toBe(false);
    expect(findPath(open, out, inside, false, 2)?.length).toBeGreaterThan(0);
  });
});
