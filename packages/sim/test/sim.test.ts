import { describe, expect, it } from 'vitest';
import {
  addPlayerFaction,
  createWorld,
  deserializeWorld,
  findPath,
  hashWorld,
  serializeWorld,
  type Building,
  type Item,
  type Plant,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

function itemsOf(w: ReturnType<typeof flatWorld>, def: string): Item[] {
  return [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def);
}

function total(items: Item[]): number {
  return items.reduce((a, i) => a + i.count, 0);
}

describe('pathfinding', () => {
  it('walks around a wall', () => {
    const w = flatWorld(20, 20);
    for (let y = 0; y < 15; y++) w.setRock(w.map.idx(10, y), 1);
    const path = findPath(w, w.map.idx(5, 5), w.map.idx(15, 5), false, 1)!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toBe(w.map.idx(15, 5));
    // Must route below the wall's end at y=15.
    expect(path.some((c) => w.map.cy(c) >= 15)).toBe(true);
  });

  it('returns null when sealed off', () => {
    const w = flatWorld(20, 20);
    for (let y = 0; y < 20; y++) w.setRock(w.map.idx(10, y), 1);
    expect(findPath(w, w.map.idx(5, 5), w.map.idx(15, 5), false, 1)).toBeNull();
  });

  it("other factions' doors block, own doors don't", () => {
    const w = flatWorld(20, 20);
    for (let y = 0; y < 20; y++) if (y !== 10) w.setRock(w.map.idx(10, y), 1);
    w.spawnBuilding('door', w.map.idx(10, 10), 2);
    expect(findPath(w, w.map.idx(5, 10), w.map.idx(15, 10), false, 1)).toBeNull();
    expect(findPath(w, w.map.idx(5, 10), w.map.idx(15, 10), false, 2)).not.toBeNull();
  });
});

describe('jobs', () => {
  it('mines designated rock and drops stone', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    const c = w.map.idx(12, 5);
    w.setRock(c, 1);
    w.enqueue(1, { c: 'designate', kind: 'mine', ...rect(12, 5, 12, 5) });
    runUntil(w, () => w.map.rock[c] === 0);
    expect(w.map.desig[c]).toBe(0);
  });

  it('delivers materials and builds a wall', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    w.spawnItem('wood', 20, w.map.idx(3, 3));
    w.enqueue(1, { c: 'build', def: 'wood_wall', hollow: false, ...rect(10, 10, 12, 10) });
    runUntil(w, () => [...w.kinds.building].length === 3);
    expect(w.kinds.construct.size).toBe(0);
    expect(total(itemsOf(w, 'wood'))).toBe(5);
    expect(w.map.solid[w.map.idx(11, 10)]).toBe(1);
  });

  it('hauls items into a stockpile', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    w.spawnItem('steel', 30, w.map.idx(20, 20));
    w.enqueue(1, { c: 'zone', kind: 'stockpile', ...rect(2, 2, 4, 4) });
    runUntil(w, () => {
      const s = itemsOf(w, 'steel');
      return s.length === 1 && w.map.zoneAt[w.cellOf(s[0])] !== 0;
    });
    expect(total(itemsOf(w, 'steel'))).toBe(30);
  });

  it('chops trees for wood', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    const tree = w.spawnPlant('oak', w.map.idx(8, 8), 1);
    w.enqueue(1, { c: 'designate', kind: 'chop', ...rect(8, 8, 8, 8) });
    runUntil(w, () => !w.get(tree.id));
    expect(total(itemsOf(w, 'wood'))).toBe(25);
  });

  it('sows a grow zone', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    w.enqueue(1, { c: 'zone', kind: 'grow', plant: 'rice', ...rect(8, 8, 10, 10) });
    const rice = () => [...w.kinds.plant].map((id) => w.get<Plant>(id)!).filter((p) => p.def === 'rice');
    runUntil(w, () => rice().length === 9, 40_000);
    expect(rice().every((p) => w.map.zoneAt[w.cellOf(p)] !== 0)).toBe(true);
  });

  it('cooks a meal from a bill', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    const fire = w.spawnBuilding('campfire', w.map.idx(8, 5), 1);
    w.spawnItem('potato', 15, w.map.idx(3, 8));
    w.enqueue(1, { c: 'addBill', bench: fire.id, recipe: 'cook_simple_meal', mode: 'count', target: 1 });
    runUntil(w, () => itemsOf(w, 'simple_meal').length > 0);
    expect(total(itemsOf(w, 'potato'))).toBe(5);
    expect(w.get<Building>(fire.id)!.bills.length).toBe(0);
  });

  it('hungry pawns eat', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    p.needs.food = 0.1;
    w.spawnItem('survival_meal', 2, w.map.idx(9, 9));
    runUntil(w, () => p.needs.food > 0.8);
    expect(total(itemsOf(w, 'survival_meal'))).toBe(1);
  });

  it('tired pawns sleep in an owned bed', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    const bed = w.spawnBuilding('bed', w.map.idx(9, 5), 1);
    p.needs.rest = 0.1;
    runUntil(w, () => p.asleep);
    expect(p.bed).toBe(bed.id);
    expect(w.cellOf(p)).toBe(w.cellOf(bed));
  });

  it('players cannot command other factions', () => {
    const w = flatWorld();
    w.factions.set(2, { id: 2, name: 'B', color: 0, home: { x: 30, y: 30 }, isPlayer: false });
    const p = addPawn(w, 5, 5, 1);
    w.enqueue(2, { c: 'setPriority', pawn: p.id, work: 'mine', prio: 0 });
    run(w, 2);
    expect(p.priorities.mine).toBe(3);
  });

  it('detects enclosed rooms', () => {
    const w = flatWorld();
    for (let x = 10; x <= 14; x++) {
      w.spawnBuilding('stone_wall', w.map.idx(x, 10), 1);
      w.spawnBuilding('stone_wall', w.map.idx(x, 14), 1);
    }
    for (let y = 11; y <= 13; y++) {
      w.spawnBuilding('stone_wall', w.map.idx(10, y), 1);
      w.spawnBuilding('stone_wall', w.map.idx(14, y), 1);
    }
    run(w, 260);
    const r = w.map.roomAt[w.map.idx(12, 12)];
    expect(r).not.toBe(0);
    expect(w.rooms.get(r)!.cells.length).toBe(9);
  });
});

describe('determinism', () => {
  function scenario(seed: number) {
    const w = createWorld({ seed, width: 120, height: 120 });
    addPlayerFaction(w, 'North');
    addPlayerFaction(w, 'South');
    for (const f of w.factions.values()) {
      const { x, y } = f.home;
      w.enqueue(f.id, { c: 'zone', kind: 'stockpile', ...rect(x - 2, y - 2, x + 2, y + 2) });
      w.enqueue(f.id, { c: 'build', def: 'wood_wall', hollow: true, ...rect(x + 4, y - 3, x + 9, y + 2) });
      w.enqueue(f.id, { c: 'designate', kind: 'chop', ...rect(x - 15, y - 15, x + 15, y + 15) });
      w.enqueue(f.id, { c: 'zone', kind: 'grow', plant: 'potato', ...rect(x - 8, y + 4, x - 4, y + 8) });
    }
    return w;
  }

  it('same seed and commands give the same world', () => {
    const a = scenario(99);
    const b = scenario(99);
    run(a, 20_000);
    run(b, 20_000);
    expect(hashWorld(a)).toBe(hashWorld(b));
    // Something actually happened.
    expect(a.kinds.construct.size + a.kinds.building.size).toBeGreaterThan(0);
  });

  it('save/load continues identically', () => {
    const a = scenario(7);
    run(a, 6000);
    const b = deserializeWorld(serializeWorld(a));
    expect(hashWorld(b)).toBe(hashWorld(a));
    run(a, 6000);
    run(b, 6000);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });
});

describe('settling', () => {
  it('suggests spread-out sites and rejects spots too close to another colony', async () => {
    const { siteProblem, suggestSites, MIN_COLONY_GAP } = await import('../src');
    const w = createWorld({ seed: 4, width: 160, height: 160 });
    const sites = suggestSites(w, 5);
    expect(sites.length).toBeGreaterThan(2);
    for (const s of sites) expect(siteProblem(w, s.x, s.y)).toBeNull();
    const a = addPlayerFaction(w, 'First', 3, sites[0]);
    expect(a.home).toEqual({ x: sites[0].x, y: sites[0].y });
    expect(siteProblem(w, a.home.x + 3, a.home.y + 3)).toMatch(/Too close/);
    expect(siteProblem(w, 1, 1)).toMatch(/edge/);
    const far = sites.find((s) => Math.hypot(s.x - a.home.x, s.y - a.home.y) >= MIN_COLONY_GAP)!;
    expect(siteProblem(w, far.x, far.y)).toBeNull();
  });
});

describe('moving a colony', () => {
  it('sets a new home when the site is fine, refuses bad ones', async () => {
    const w = createWorld({ seed: 12, width: 160, height: 160 });
    const a = addPlayerFaction(w, 'Movers', 3, { x: 30, y: 80 });
    const b = addPlayerFaction(w, 'Others', 3, { x: 130, y: 80 });
    // Too close to the other colony: refused, home unchanged.
    w.enqueue(a.id, { c: 'setHome', x: b.home.x - 5, y: b.home.y });
    run(w, 2);
    expect(a.home).toEqual({ x: 30, y: 80 });
    // A good spot nearby: accepted even though it's close to the old home.
    const { suggestSites } = await import('../src');
    const site = suggestSites(w, 8).find((s) => Math.hypot(s.x - b.home.x, s.y - b.home.y) > 40)!;
    w.enqueue(a.id, { c: 'setHome', x: site.x, y: site.y });
    run(w, 2);
    expect(a.home).toEqual({ x: site.x, y: site.y });
  });

  it('packing up removes zones and buildings: the bed folds into a kit, the wall comes apart', () => {
    const w = flatWorld();
    addPawn(w, 5, 5);
    w.enqueue(1, { c: 'zone', kind: 'stockpile', ...rect(10, 10, 12, 12) });
    w.spawnBuilding('bed', w.map.idx(14, 14), 1);
    w.spawnBuilding('wood_wall', w.map.idx(15, 14), 1);
    run(w, 2);
    expect(w.zones.size).toBe(1);
    w.enqueue(1, { c: 'packUp', ...rect(8, 8, 16, 16) });
    run(w, 2);
    expect(w.zones.size).toBe(0);
    expect(w.kinds.building.size).toBe(0);
    // The bed is packed whole; 75% of the wall's 5 wood comes back.
    expect(total(itemsOf(w, 'kit_bed'))).toBe(1);
    expect(total(itemsOf(w, 'wood'))).toBe(Math.floor(5 * 0.75));
  });

describe('condition endings read right', () => {
  it('singular, plural and names that start with "The"', async () => {
    const { endedName } = await import('../src/rare');
    expect(endedName('Cold snap')).toBe('The cold snap has');
    expect(endedName('Gentle rains')).toBe('The gentle rains have');
    expect(endedName('The Long Night')).toBe('The Long Night has');
    expect(endedName('Sleeping sickness')).toBe('The sleeping sickness has');
  });
});
});
