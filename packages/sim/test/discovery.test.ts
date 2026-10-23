import { describe, expect, it } from 'vitest';
import { ANIMALS, T } from '@fe/defs';
import {
  carryCapacity,
  chooseLoad,
  createWorld,
  deserializeWorld,
  isLandmark,
  landmarksOf,
  MEMBER_CARRY,
  resolveChoice,
  roadFind,
  serializeWorld,
  SLEDGE_CARRY,
  spawnAnimal,
  springWarmed,
  START_TICK,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  caravanCapacity,
  type Building,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { landmarkTick } from '../src/landmarks';
import { iceFormed } from '../src/frontier';
import { addPawn, flatWorld, run, runUntil } from './helpers';

/** A flat map with a player colony (faction 2) at (10, 10), the frost held off. */
function colony(size = 60): World {
  const w = flatWorld(size, size);
  w.frost = { ...w.frost, startDay: 1000 };
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 10, y: 10 }, isPlayer: true });
  return w;
}

const items = (w: World) => [...w.kinds.item].map((id) => w.get<Item>(id)!);
const texts = (w: World) => w.dirty.msgs.map((m) => m.text);

describe('landmarks on a new map', () => {
  it('are scattered over a big map, the same for the same seed, with a hot spring and a monolith', () => {
    const a = createWorld({ seed: 4242 });
    const b = createWorld({ seed: 4242 });
    const marks = landmarksOf(a);
    expect(marks.length).toBeGreaterThanOrEqual(8);
    expect(marks.map((m) => [m.def, m.x, m.y])).toEqual(landmarksOf(b).map((m) => [m.def, m.x, m.y]));
    const kinds = new Set(marks.map((m) => m.def));
    expect(kinds.has('hot_spring') || kinds.has('monolith')).toBe(true);
    // Never on top of a town.
    for (const f of a.factions.values()) {
      if (!f.settlement) continue;
      for (const m of marks) expect(Math.hypot(m.x - f.home.x, m.y - f.home.y)).toBeGreaterThan(f.settlement.radius);
    }
    expect(landmarksOf(createWorld({ seed: 4242, width: 120, height: 120, landmarks: false }))).toHaveLength(0);
  });

  it('a hot spring sits in a pool that never freezes', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = createWorld({ seed, settlements: false, wildlife: false });
      const spring = landmarksOf(w).find((m) => m.def === 'hot_spring');
      if (!spring) continue;
      const pool = w.map.idx(spring.x + 1, spring.y);
      expect(w.map.terrain[w.map.idx(spring.x, spring.y)]).toBe(T.shallow_water);
      expect(springWarmed(w, pool)).toBe(true);
      return;
    }
    throw new Error('no hot spring on any of the test maps');
  });
});

describe('scouting', () => {
  it('a colonist who sees a landmark marks it, and one who walks up searches it: loot, a letter, a line in the story', () => {
    const w = colony();
    const cairn = w.spawnBuilding('cairn', w.map.idx(30, 30), 0);
    expect(isLandmark(cairn)).toBe(true);
    const p = addPawn(w, 30, 20, 2);
    p.priorities.haul = 0;
    w.tick = 7;
    landmarkTick(w);
    const f = w.factions.get(2)!;
    expect(f.seen).toContain(cairn.id);
    expect(f.visited ?? []).not.toContain(cairn.id);
    expect(texts(w).some((t) => t.includes('spotted a cairn'))).toBe(true);
    p.y = 29;
    w.tick = 67;
    const before = items(w).length;
    landmarkTick(w);
    expect(cairn.found).toBe(2);
    expect(f.visited).toContain(cairn.id);
    expect(items(w).length).toBeGreaterThan(before);
    expect(f.milestones).toContain('first_find');
    expect(f.chronicle?.some((t) => t.text.includes('searched a cairn'))).toBe(true);
  });

  it('first come, first served: the next colony finds it picked clean', () => {
    const w = colony();
    w.factions.set(3, { id: 3, name: 'Other', color: 0x00ff00, home: { x: 50, y: 50 }, isPlayer: true });
    const camp = w.spawnBuilding('abandoned_camp', w.map.idx(30, 30), 0);
    addPawn(w, 30, 31, 2);
    w.tick = 7;
    landmarkTick(w);
    expect(camp.found).toBe(2);
    const n = items(w).reduce((a, i) => a + i.count, 0);
    addPawn(w, 31, 30, 3);
    w.tick = 67;
    landmarkTick(w);
    expect(camp.found).toBe(2);
    expect(items(w).reduce((a, i) => a + i.count, 0)).toBe(n);
    expect(w.dirty.msgs.some((m) => m.faction === 3 && m.text.includes('got there first'))).toBe(true);
  });

  it('a wreck asks before breaking in; leaving it lets you come back', () => {
    const w = colony();
    const wreck = w.spawnBuilding('frozen_wreck', w.map.idx(30, 30), 0);
    addPawn(w, 30, 31, 2);
    w.tick = 7;
    landmarkTick(w);
    const ask = [...w.choices.values()].find((c) => c.event === 'landmark_wreck')!;
    expect(ask).toBeTruthy();
    expect(wreck.found).toBeUndefined();
    resolveChoice(w, ask.id, 'leave', 2);
    expect(w.factions.get(2)!.visited ?? []).not.toContain(wreck.id);
    w.tick = 67;
    landmarkTick(w);
    const again = [...w.choices.values()].find((c) => c.event === 'landmark_wreck')!;
    resolveChoice(w, again.id, 'open', 2);
    expect(wreck.found).toBe(2);
  });

  it('a monolith shows the way to the landmarks around it', () => {
    const w = colony(80);
    const stone = w.spawnBuilding('monolith', w.map.idx(40, 40), 0);
    const far = w.spawnBuilding('old_ruin', w.map.idx(70, 70), 0);
    addPawn(w, 40, 42, 2);
    w.tick = 7;
    landmarkTick(w);
    const f = w.factions.get(2)!;
    expect(f.visited).toContain(stone.id);
    expect(f.seen).toContain(far.id);
    expect(far.found).toBeUndefined();
  });

  it('the frost buries a landmark nobody reached', () => {
    const w = colony(60);
    w.frost = { startDay: 0, pace: 6, minRadius: 0.18 };
    const cairn = w.spawnBuilding('cairn', w.map.idx(2, 2), 0);
    w.factions.get(2)!.seen = [cairn.id];
    for (let t = START_TICK + 7; t < START_TICK + 20 * TICKS_PER_DAY && !cairn.found; t += 60) {
      w.tick = t - (t % 60) + 7;
      landmarkTick(w);
    }
    expect(cairn.found).toBe(-1);
    expect(texts(w).some((t) => t.includes('frost has swallowed the cairn'))).toBe(true);
  });
});

describe('taming', () => {
  it('a colonist wins over a marked deer: it gets a name and joins the colony, and the story says so', () => {
    const w = colony();
    const deer = spawnAnimal(w, 'deer', w.map.idx(25, 10));
    const p = addPawn(w, 10, 10, 2);
    p.skills.social.level = 15;
    w.enqueue(2, { c: 'tame', pawns: [deer.id], on: true });
    w.step();
    expect(deer.taming).toBe(2);
    runUntil(w, () => deer.tamed === 2, 30_000);
    expect(deer.name).not.toBe(ANIMALS.deer.label);
    expect(deer.taming).toBe(0);
    const f = w.factions.get(2)!;
    expect(f.milestones).toContain('first_tame');
    // A colony's animal is nobody's quarry.
    w.enqueue(2, { c: 'hunt', pawns: [deer.id], on: true });
    w.step();
    expect(deer.hunted ?? 0).toBe(0);
    // And it stays near home.
    run(w, 6000);
    expect(Math.hypot(deer.x - 10, deer.y - 10)).toBeLessThan(14);
  });

  it('wolves will not be tamed', () => {
    const w = colony();
    const wolf = spawnAnimal(w, 'wolf', w.map.idx(25, 10));
    w.enqueue(2, { c: 'tame', pawns: [wolf.id], on: true });
    w.step();
    expect(wolf.taming ?? 0).toBe(0);
  });

  it('a tamed animal that dies is remembered', () => {
    const w = colony();
    const ox = spawnAnimal(w, 'muskox', w.map.idx(20, 10));
    ox.tamed = 2;
    ox.name = 'Bramble';
    ox.conditions.push({ key: 'gunshot', severity: 5, immunity: 0, until: 0 });
    runUntil(w, () => !w.entities.has(ox.id), 5000);
    expect(w.factions.get(2)!.chronicle?.some((t) => t.text.startsWith('Bramble the muskox'))).toBe(true);
  });
});

describe('pack animals on the journey', () => {
  it('pack animals add room, and a muskox pulls a sledge of its own', () => {
    expect(carryCapacity(2, 3, 90, 1)).toBe(2 * MEMBER_CARRY + 3 * SLEDGE_CARRY + 90);
    expect(carryCapacity(2, 3)).toBe(2 * MEMBER_CARRY + 2 * SLEDGE_CARRY);
    const take = chooseLoad([{ def: 'sledge', count: 3 }], 2, [], 90, 1);
    expect(take[0]).toBe(3);
  });

  it('tamed animals near home walk with the caravan and carry their share', () => {
    const w = flatWorld(160, 160);
    w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 7 * TICKS_PER_HOUR;
    w.frost = { ...w.frost, startDay: 1000 };
    w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 15, y: 30 }, isPlayer: true });
    const ox = spawnAnimal(w, 'muskox', w.map.idx(18, 32));
    ox.tamed = 2;
    ox.name = 'Bramble';
    const pawns = [addPawn(w, 15, 30, 2), addPawn(w, 16, 30, 2)];
    w.enqueue(2, { c: 'caravan', act: 'form', pawns: pawns.map((p) => p.id), x: 120, y: 30 });
    w.step();
    const f = w.factions.get(2)!;
    expect(f.caravan?.beasts).toEqual([ox.id]);
    expect(caravanCapacity(w, f.caravan!)).toBe(2 * MEMBER_CARRY + 90);
    for (let k = 0; k < 4000 && f.caravan?.phase !== 'travel'; k++) w.step();
    for (let k = 0; k < 2 * TICKS_PER_HOUR; k++) w.step();
    const lead = pawns[0];
    expect(Math.hypot(ox.x - lead.x, ox.y - lead.y)).toBeLessThan(12);
    expect(ox.x).toBeGreaterThan(25);
  });
});

describe('the road', () => {
  function onTheRoad(): { w: World; f: ReturnType<World['factions']['get']> & object } {
    const w = flatWorld(160, 160);
    w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 7 * TICKS_PER_HOUR;
    w.frost = { ...w.frost, startDay: 1000 };
    w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 15, y: 30 }, isPlayer: true });
    const pawns = [addPawn(w, 15, 30, 2), addPawn(w, 16, 30, 2)];
    w.enqueue(2, { c: 'caravan', act: 'form', pawns: pawns.map((p) => p.id), x: 120, y: 30 });
    const f = w.factions.get(2)!;
    for (let k = 0; k < 4000 && f.caravan?.phase !== 'travel'; k++) w.step();
    return { w, f };
  }

  it('a stray pack animal falls in behind the caravan', () => {
    const { w, f } = onTheRoad();
    const c = f.caravan!;
    expect(roadFind(w, f, c, c.route[2], 'stray')).toBe(true);
    const ox = w.get<Pawn>(c.beasts![0])!;
    expect(ox.tamed).toBe(2);
    expect(f.chronicle?.some((t) => t.text.includes('joined the caravan'))).toBe(true);
  });

  it('a frozen traveller’s pack goes into the caravan’s cargo', () => {
    const { w, f } = onTheRoad();
    const c = f.caravan!;
    const meals = Object.fromEntries(c.cargo).survival_meal ?? 0;
    roadFind(w, f, c, c.route[2], 'pack');
    expect(Object.fromEntries(c.cargo).survival_meal).toBeGreaterThan(meals);
  });

  it('a lost traveller can join the caravan', () => {
    const { w, f } = onTheRoad();
    const c = f.caravan!;
    roadFind(w, f, c, c.route[2], 'traveller');
    const ask = [...w.choices.values()].find((x) => x.event === 'road_traveller')!;
    resolveChoice(w, ask.id, 'take', 2);
    expect(c.members).toHaveLength(3);
  });

  it('a blizzard on the road asks: digging in camps until it passes', () => {
    const { w, f } = onTheRoad();
    const until = w.tick + 10 * TICKS_PER_HOUR;
    w.conditions.push({ key: 'blizzard', until, faction: 0 });
    for (let k = 0; k < 60; k++) w.step();
    const ask = [...w.choices.values()].find((x) => x.event === 'caravan_blizzard')!;
    expect(ask).toBeTruthy();
    resolveChoice(w, ask.id, 'dig', 2);
    expect(f.caravan!.phase).toBe('camp');
    expect(f.caravan!.until).toBe(until);
    // It doesn't ask again for the same storm.
    for (let k = 0; k < 60; k++) w.step();
    expect([...w.choices.values()].filter((x) => x.event === 'caravan_blizzard')).toHaveLength(0);
  });
});

describe('the frost as a set piece', () => {
  it('a lake that freezes over is news: a new way across', () => {
    const w = colony(60);
    for (let y = 30; y < 40; y++) for (let x = 30; x < 40; x++) w.setTerrain(w.map.idx(x, y), T.shallow_water);
    let n = 0;
    for (let y = 30; y < 40; y++) {
      for (let x = 30; x < 40; x++) {
        w.setTerrain(w.map.idx(x, y), T.ice);
        iceFormed(w, w.map.idx(x, y));
        n++;
      }
    }
    expect(n).toBe(100);
    expect(texts(w).filter((t) => t.includes('has frozen over'))).toHaveLength(1);
  });

  it('landmark state and tamed animals survive a save', () => {
    const w = colony();
    const camp = w.spawnBuilding('abandoned_camp', w.map.idx(30, 30), 0);
    camp.found = 2;
    const deer = spawnAnimal(w, 'deer', w.map.idx(20, 20));
    deer.tamed = 2;
    w.factions.get(2)!.seen = [camp.id];
    const back = deserializeWorld(serializeWorld(w));
    expect(back.get<Building>(camp.id)!.found).toBe(2);
    expect(back.get<Pawn>(deer.id)!.tamed).toBe(2);
    expect(back.factions.get(2)!.seen).toEqual([camp.id]);
  });
});
