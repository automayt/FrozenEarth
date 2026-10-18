import { describe, expect, it } from 'vitest';
import { kitKey } from '@fe/defs';
import { addPlayerFaction, chooseLoad, createWorld, foundSettlement, Rng, siteProblem, snapshot, START_TICK, TICKS_PER_DAY, World } from '@fe/sim';
import { Mirror } from '@fe/protocol';
import { crossings, detourAround, planLoad, siteTrouble } from '../src/ui/journey';

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
});
