import { describe, expect, it } from 'vitest';
import { GameMap, Rng } from '../src';

/** Same partition? (ids may differ, grouping must not) */
function samePartition(a: Int32Array, b: Int32Array, n: number): boolean {
  const ab = new Map<number, number>();
  const ba = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if ((x < 0) !== (y < 0)) return false;
    if (x < 0) continue;
    if ((ab.has(x) && ab.get(x) !== y) || (ba.has(y) && ba.get(y) !== x)) return false;
    ab.set(x, y);
    ba.set(y, x);
  }
  return true;
}

function resolved(m: GameMap): Int32Array {
  const out = new Int32Array(m.n);
  for (let i = 0; i < m.n; i++) out[i] = m.solid[i] ? -1 : m.component(i);
  return out;
}

describe('incremental connectivity', () => {
  it('matches a full rebuild after every random open and close', () => {
    const rng = new Rng(42);
    const m = new GameMap(24, 24);
    for (let i = 0; i < m.n; i++) m.solid[i] = rng.chance(0.3) ? 1 : 0;
    m.rebuildComponents();
    for (let step = 0; step < 3000; step++) {
      const i = rng.int(m.n);
      const solid = m.solid[i] ? 0 : 1;
      m.solid[i] = solid;
      if (solid) m.cellClosed(i);
      else m.cellOpened(i);
      const incremental = resolved(m);
      const fresh = new GameMap(m.w, m.h);
      fresh.solid.set(m.solid);
      fresh.rebuildComponents();
      if (!samePartition(incremental, resolved(fresh), m.n)) throw new Error(`diverged at step ${step}`);
    }
    expect(true).toBe(true);
  });

  it('detects a room being sealed and reopened', () => {
    const m = new GameMap(12, 12);
    m.rebuildComponents();
    const wall = (x: number, y: number) => {
      const i = m.idx(x, y);
      m.solid[i] = 1;
      m.cellClosed(i);
    };
    for (let x = 3; x <= 7; x++) {
      wall(x, 3);
      wall(x, 7);
    }
    for (let y = 4; y <= 6; y++) {
      wall(3, y);
      if (y !== 5) wall(7, y);
    }
    expect(m.component(m.idx(5, 5))).toBe(m.component(m.idx(0, 0)));
    wall(7, 5);
    expect(m.component(m.idx(5, 5))).not.toBe(m.component(m.idx(0, 0)));
    const door = m.idx(7, 5);
    m.solid[door] = 0;
    m.cellOpened(door);
    expect(m.component(m.idx(5, 5))).toBe(m.component(m.idx(0, 0)));
  });
});

describe('incremental rooms', () => {
  it('matches a full rebuild after random wall edits', async () => {
    const { World } = await import('../src');
    const { rebuildRooms, updateRooms } = await import('../src/rare');
    const rng = new Rng(9);
    const w = new World(1, 40, 40);
    for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
    w.factions.set(1, { id: 1, name: 'T', color: 0, home: { x: 1, y: 1 }, isPlayer: false });
    // Seed some boxes so rooms exist.
    for (let b = 0; b < 6; b++) {
      const x0 = 3 + rng.int(28);
      const y0 = 3 + rng.int(28);
      for (let x = x0; x <= x0 + 5; x++) for (const y of [y0, y0 + 4]) if (!w.map.buildingAt[w.map.idx(x, y)]) w.spawnBuilding('stone_wall', w.map.idx(x, y), 1);
      for (let y = y0; y <= y0 + 4; y++) for (const x of [x0, x0 + 5]) if (!w.map.buildingAt[w.map.idx(x, y)]) w.spawnBuilding('stone_wall', w.map.idx(x, y), 1);
    }
    rebuildRooms(w);
    const signature = () =>
      [...w.rooms.values()]
        .map((r) => [...r.cells].sort((a, b) => a - b).join(','))
        .sort()
        .join('|');
    for (let step = 0; step < 400; step++) {
      const c = 1 + rng.int(w.map.n - 2);
      const b = w.map.buildingAt[c];
      if (b) w.despawn(b);
      else if (!w.map.solid[c]) w.spawnBuilding('stone_wall', c, 1);
      updateRooms(w);
      const incremental = signature();
      rebuildRooms(w);
      if (signature() !== incremental) throw new Error(`rooms diverged at step ${step}`);
    }
    expect(w.rooms.size).toBeGreaterThan(0);
  });
});
