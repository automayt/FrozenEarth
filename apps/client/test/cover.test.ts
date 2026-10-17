import { describe, expect, it } from 'vitest';
import { coverAgainst, Rng, snapshot, World } from '@fe/sim';
import { decode, encode, Mirror, type ServerMsg } from '@fe/protocol';
import { rebuildRooms } from '../../../packages/sim/src/rare';
import { coverFrom } from '../src/render/cover';

/**
 * The cover the client shows must be the cover the sim applies, or players are told a colonist
 * is safe behind something the sim ignores (or exposed when they aren't).
 */

function mirrorOf(w: World): Mirror {
  const m = new Mirror();
  m.applySnapshot(decode<Extract<ServerMsg, { t: 'welcome' }>>(encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) })).snap);
  return m;
}

function clutteredWorld(seed: number): World {
  const w = new World(seed, 40, 40);
  for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
  w.factions.set(1, { id: 1, name: 'Us', color: 0xffffff, home: { x: 5, y: 5 }, isPlayer: true });
  const rng = new Rng(seed);
  // A walled room with a door and a firing slit, so indoor-only cover is exercised.
  for (let x = 10; x <= 18; x++)
    for (let y = 10; y <= 16; y++) {
      if (x !== 10 && x !== 18 && y !== 10 && y !== 16) continue;
      w.spawnBuilding(x === 14 && y === 16 ? 'door' : x === 18 && y === 13 ? 'embrasure' : 'stone_wall', y * 40 + x, 1);
    }
  const defs = ['wood_wall', 'embrasure', 'door', 'sandbags', 'sandbags', 'bed'];
  for (let k = 0; k < 220; k++) {
    const c = rng.int(w.map.n);
    if (w.map.buildingAt[c] || w.map.rock[c] || w.map.plantAt[c]) continue;
    const roll = rng.next();
    if (roll < 0.2) w.setRock(c, 1);
    else if (roll < 0.45) w.spawnPlant(rng.chance(0.5) ? 'oak' : 'pine', c, rng.next());
    else w.spawnBuilding(rng.pick(defs), c, 1);
  }
  rebuildRooms(w);
  return w;
}

describe('client cover matches the sim', () => {
  it('coverFrom gives the same share as coverAgainst, and names a cell that gives it', () => {
    for (const seed of [1, 2, 3]) {
      const w = clutteredWorld(seed);
      const m = mirrorOf(w);
      expect([...m.roomAt].some((r) => r !== 0)).toBe(true);
      const rng = new Rng(seed + 10);
      let covered = 0;
      for (let k = 0; k < 4000; k++) {
        const a = rng.int(w.map.n);
        // Half the targets inside or next to the room, where doors and slits matter.
        const b = k % 2 ? rng.int(w.map.n) : (9 + rng.int(11)) * 40 + 9 + rng.int(11);
        const hit = coverFrom(m, a, b);
        expect(hit.cover, `${a} -> ${b}`).toBe(coverAgainst(w, a, b));
        if (hit.cover > 0) {
          covered++;
          expect(hit.cell).toBeGreaterThanOrEqual(0);
          expect(w.map.cover[hit.cell] / 100).toBe(hit.cover);
        } else expect(hit.cell).toBe(-1);
      }
      expect(covered).toBeGreaterThan(200);
    }
  });
});
