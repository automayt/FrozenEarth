import { describe, expect, it } from 'vitest';
import { kitKey } from '@fe/defs';
import { addPlayerFaction, caravanCapacity, chooseLoad, createWorld, foundSettlement, Rng, siteProblem, snapshot, spawnAnimal, START_TICK, TICKS_PER_DAY, World } from '@fe/sim';
import { Mirror } from '@fe/protocol';
import { beastsAt, crossings, detourAround, landmarksAlong, planLoad, siteTrouble } from '../src/ui/journey';

/** The journey panel must agree with the server about where a colony may go and what it can carry. */
describe('journey planning', () => {
  it('says the same as the server about where the colony may settle', () => {
    const w = createWorld({ seed: 11, width: 160, height: 160 });
    const me = addPlayerFaction(w, 'Us', 3).id;
    addPlayerFaction(w, 'Them', 3);
    w.tick = START_TICK + 12 * TICKS_PER_DAY;
    const m = new Mirror();
    m.applySnapshot(structuredClone(snapshot(w)));
    const rng = new Rng(5);
    let refused = 0;
    for (let k = 0; k < 400; k++) {
      const x = rng.int(160);
      const y = rng.int(160);
      const server = siteProblem(w, x, y, me);
      expect(siteTrouble(m, me, w.tick, x, y), `${x},${y}`).toBe(server === 'Not enough open, buildable ground here.' ? 'Not enough open, buildable ground there.' : server);
      if (server) refused++;
    }
    // Both kinds of answer came up.
    expect(refused).toBeGreaterThan(20);
    expect(refused).toBeLessThan(400);
  });

  it('plans the same load the caravan will take', () => {
    const goods = [
      { def: 'wood', count: 300 },
      { def: kitKey('bed'), count: 3 },
      { def: 'survival_meal', count: 30 },
      { def: 'sledge', count: 1 },
      { def: 'parka', count: 2 },
    ];
    for (const members of [1, 2, 4]) {
      const plan = planLoad(goods, members, []);
      const n = chooseLoad(goods, members, []);
      expect(plan.cargo).toEqual(goods.map((g, i) => [g.def, n[i]] as [string, number]).filter(([, k]) => k > 0));
      expect(plan.bulk).toBeLessThanOrEqual(plan.capacity);
    }
    // Only food: no wood, no kits.
    const food = planLoad(goods, 2, ['meal']);
    expect(food.cargo.map(([d]) => d).sort()).toEqual(['sledge', 'survival_meal']);
  });

  it('"Go around" puts a waypoint that takes the route off a hostile town’s land', () => {
    const w = new World(3, 120, 120);
    for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
    w.factions.set(1, { id: 1, name: 'Us', color: 0, home: { x: 10, y: 60 }, isPlayer: true });
    const town = foundSettlement(w, { x: 60, y: 60 }, -60, 3);
    const m = new Mirror();
    m.applySnapshot(structuredClone(snapshot(w)));
    const home = { x: 10, y: 60 };
    const dest = { x: 110, y: 60 };
    expect(crossings(m, 1, [home, dest], []).map((c) => c.kind)).toEqual(['hostile']);
    const via = detourAround(m, home, [], dest, m.factions.get(town.id)!)!;
    expect(via.length).toBe(1);
    expect(crossings(m, 1, [home, ...via, dest], [])).toEqual([]);
  });

  it('counts the colony’s pack animals the way the caravan will, and lists landmarks it knows along the route', () => {
    const w = new World(4, 120, 120);
    for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
    w.factions.set(2, { id: 2, name: 'Us', color: 0xff0000, home: { x: 20, y: 20 }, isPlayer: true });
    const ox = spawnAnimal(w, 'muskox', w.map.idx(24, 22));
    ox.tamed = 2;
    const deer = spawnAnimal(w, 'deer', w.map.idx(22, 25));
    deer.tamed = 2;
    // Too far from home to come along.
    const stray = spawnAnimal(w, 'deer', w.map.idx(90, 90));
    stray.tamed = 2;
    const ruin = w.spawnBuilding('old_ruin', w.map.idx(60, 24), 0);
    const hidden = w.spawnBuilding('cairn', w.map.idx(70, 18), 0);
    w.factions.get(2)!.seen = [ruin.id];
    const m = new Mirror();
    m.applySnapshot(structuredClone(snapshot(w)));
    const herd = beastsAt(m, 2, { x: 20, y: 20 });
    expect(herd.pack).toBe(135);
    expect(herd.draft).toBe(1);
    const goods = [{ def: 'sledge', count: 2 }, { def: 'wood', count: 400 }];
    const plan = planLoad(goods, 1, [], herd.pack, herd.draft);
    // One colonist and the muskox pull a sledge each.
    expect(plan.sledges).toBe(2);
    w.enqueue(2, { c: 'caravan', act: 'form', pawns: [w.spawnPawn(2, w.map.idx(20, 20), 'Ann Vale').id], x: 100, y: 24 });
    w.step();
    const c = w.factions.get(2)!.caravan!;
    expect(c.beasts?.sort()).toEqual([ox.id, deer.id].sort());
    c.cargo = [['sledge', 2]];
    expect(caravanCapacity(w, c)).toBe(plan.capacity);
    const along = landmarksAlong(m, 2, [{ x: 20, y: 20 }, { x: 100, y: 24 }]);
    expect(along.map((l) => l.label)).toEqual(['old ruin']);
    expect(along.some((l) => l.x === hidden.x)).toBe(false);
  });
});
