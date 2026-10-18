import { describe, expect, it } from 'vitest';
import { kitKey } from '@fe/defs';
import {
  carryCapacity,
  cargoBulk,
  foundSettlement,
  MEMBER_CARRY,
  resolveChoice,
  SLEDGE_CARRY,
  START_TICK,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  tollFor,
  isPass,
  type Building,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { addPawn, flatWorld, run } from './helpers';

const lying = (w: World, def: string) => [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def);
const count = (w: World, def: string) => lying(w, def).reduce((a, i) => a + i.count, 0);

/** A colony at (15, 30) with a stockpile of goods, on a wide flat map; morning of day 2. */
function colony(width = 160, members = 2): { w: World; pawns: Pawn[] } {
  // Tall enough that the frost (measured against the shorter side) leaves the far end open.
  const w = flatWorld(width, 160);
  w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 7 * TICKS_PER_HOUR;
  w.frost = { ...w.frost, startDay: 1000 };
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 15, y: 30 }, isPlayer: true });
  const z = w.createZone(2, 'stockpile');
  for (let x = 10; x < 20; x++) for (let y = 25; y < 28; y++) w.addZoneCell(z, w.map.idx(x, y));
  w.placeItemNear('survival_meal', 20, w.map.idx(11, 26));
  w.placeItemNear(kitKey('bed'), 2, w.map.idx(13, 26));
  w.placeItemNear('wood', 300, w.map.idx(16, 26));
  const pawns = Array.from({ length: members }, (_, i) => addPawn(w, 15 + i, 30, 2));
  return { w, pawns };
}

const setOut = (w: World, pawns: Pawn[], x: number, y: number, extra: object = {}) =>
  w.enqueue(2, { c: 'caravan', act: 'form', pawns: pawns.map((p) => p.id), x, y, ...extra } as never);

describe('the journey', () => {
  it('musters, loads what it can carry (kits and food first), walks there, unpacks, and moves home', () => {
    const { w, pawns } = colony();
    setOut(w, pawns, 120, 30);
    w.step();
    const f = w.factions.get(2)!;
    expect(f.caravan?.phase).toBe('muster');
    for (let k = 0; k < 4000 && f.caravan?.phase === 'muster'; k++) w.step();
    expect(f.caravan?.phase).toBe('travel');
    const cap = carryCapacity(2, 0);
    expect(cap).toBe(2 * MEMBER_CARRY);
    expect(cargoBulk(f.caravan!.cargo)).toBeLessThanOrEqual(cap);
    const carried = Object.fromEntries(f.caravan!.cargo);
    expect(carried[kitKey('bed')]).toBe(2);
    expect(carried.survival_meal).toBe(20);
    // Not all 300 wood fits.
    expect(carried.wood ?? 0).toBeLessThan(300);
    for (let k = 0; k < 3 * TICKS_PER_DAY && f.caravan; k++) w.step();
    expect(f.caravan).toBeUndefined();
    expect(f.home).toEqual({ x: 120, y: 30 });
    expect(count(w, kitKey('bed'))).toBe(2);
    const near = lying(w, kitKey('bed')).every((i) => Math.hypot(i.x - 120, i.y - 30) < 8);
    expect(near).toBe(true);
    for (const p of pawns) expect(Math.hypot(p.x - 120, p.y - 30)).toBeLessThan(12);
  });

  it('a sledge carries far more, and a heavy load is slower going', () => {
    expect(carryCapacity(2, 1)).toBe(2 * MEMBER_CARRY + SLEDGE_CARRY);
    expect(carryCapacity(1, 3)).toBe(MEMBER_CARRY + SLEDGE_CARRY);
    const { w, pawns } = colony();
    w.placeItemNear('sledge', 1, w.map.idx(18, 26));
    setOut(w, pawns, 120, 30);
    const f = w.factions.get(2)!;
    for (let k = 0; k < 4000 && f.caravan?.phase !== 'travel'; k++) w.step();
    expect(Object.fromEntries(f.caravan!.cargo).wood).toBe(300);
  });

  it('makes camp around a fire at night and breaks it at dawn', () => {
    const { w, pawns } = colony(240);
    // Set out in the evening: night falls on the road.
    w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 19 * TICKS_PER_HOUR;
    setOut(w, pawns, 220, 30);
    const f = w.factions.get(2)!;
    let fire = 0;
    for (let k = 0; k < 12 * TICKS_PER_HOUR && !fire; k++) {
      w.step();
      if (f.caravan?.phase === 'camp') fire = f.caravan.fire ?? 0;
    }
    expect(fire).toBeTruthy();
    expect(w.get<Building>(fire)?.def).toBe('campfire');
    run(w, 9 * TICKS_PER_HOUR);
    expect(f.caravan?.phase).toBe('travel');
    expect(w.entities.has(fire)).toBe(false);
    // Someone slept by the fire in the night.
    expect(pawns.every((p) => p.needs.rest > 0.3)).toBe(true);
  });

  it('a wary town on the way asks a toll; paying costs goods, refusing costs goodwill', () => {
    for (const pay of [true, false]) {
      const { w, pawns } = colony();
      const town = foundSettlement(w, { x: 70, y: 22 }, 0, 3);
      town.settlement!.met.push(2);
      setOut(w, pawns, 130, 30);
      const f = w.factions.get(2)!;
      let letter = undefined as ReturnType<typeof w.choices.get>;
      for (let k = 0; k < TICKS_PER_DAY && !letter; k++) {
        w.step();
        letter = [...w.choices.values()].find((c) => c.event === 'caravan_toll');
      }
      expect(letter).toBeTruthy();
      expect(f.caravan?.waiting).toBe(letter!.id);
      const before = f.caravan!.cargo.reduce((a, [, n]) => a + n, 0);
      resolveChoice(w, letter!.id, pay ? 'pay' : 'refuse', 2);
      const after = f.caravan!.cargo.reduce((a, [, n]) => a + n, 0);
      if (pay) {
        expect(after).toBeLessThan(before);
        expect(town.settlement!.goodwill[2]).toBe(2);
      } else {
        expect(after).toBe(before);
        expect(town.settlement!.goodwill[2]).toBe(-12);
      }
      expect(f.caravan?.waiting).toBeUndefined();
    }
    expect(tollFor([['gold', 100]])).toBeGreaterThan(tollFor([['wood', 10]]));
  });

  it('can be halted, resumed, and called off (goods set down where it stood)', () => {
    const { w, pawns } = colony();
    setOut(w, pawns, 120, 30);
    const f = w.factions.get(2)!;
    for (let k = 0; k < 4000 && f.caravan?.phase !== 'travel'; k++) w.step();
    run(w, 300);
    w.enqueue(2, { c: 'caravan', act: 'halt' });
    w.step();
    expect(f.caravan?.phase).toBe('halt');
    const x = pawns[0].x;
    run(w, 300);
    expect(Math.abs(pawns[0].x - x)).toBeLessThanOrEqual(2);
    w.enqueue(2, { c: 'caravan', act: 'resume' });
    w.step();
    expect(f.caravan?.phase).toBe('travel');
    w.enqueue(2, { c: 'caravan', act: 'disband' });
    w.step();
    expect(f.caravan).toBeUndefined();
    // On the ground, or already picked up by someone standing next to it.
    const carried = pawns.reduce((a, p) => a + (p.carrying?.def === kitKey('bed') ? p.carrying.count : 0), 0);
    expect(count(w, kitKey('bed')) + carried).toBe(2);
    expect(f.home).toEqual({ x: 15, y: 30 });
  });
  it('raiders may lie in wait in a mountain pass', () => {
    const { w, pawns } = colony();
    // Rock either side of the road from x 50 to 90.
    for (let x = 50; x <= 90; x++) {
      for (const y of [26, 27, 33, 34]) {
        w.map.rock[w.map.idx(x, y)] = 1;
        w.refreshCell(w.map.idx(x, y));
      }
    }
    expect(isPass(w, w.map.idx(70, 30))).toBe(true);
    expect(isPass(w, w.map.idx(30, 30))).toBe(false);
    setOut(w, pawns, 130, 30);
    w.step();
    const f = w.factions.get(2)!;
    for (let k = 0; k < TICKS_PER_DAY && f.caravan && !f.caravan.ambushed; k++) w.step();
    expect(f.caravan?.ambushed).toBe(true);
    const raid = [...w.factions.values()].find((x) => x.raid?.target === 2);
    const raiders = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === raid?.id);
    expect(raiders.length).toBeGreaterThan(0);
    // Waiting along the pass, not at the map edge.
    expect(raiders.every((r) => r.x >= 40 && r.x <= 110)).toBe(true);
    expect(w.dirty.msgs.some((m) => m.text.includes('ambush'))).toBe(true);
  });

  it('a friendly town nearby offers shelter for the night, and they sleep inside its walls', () => {
    const { w, pawns } = colony(240);
    // About where the first night falls on the road.
    const town = foundSettlement(w, { x: 110, y: 46 }, 45, 3);
    town.settlement!.met.push(2);
    w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 19 * TICKS_PER_HOUR;
    setOut(w, pawns, 220, 30);
    const f = w.factions.get(2)!;
    let offer = undefined as ReturnType<typeof w.choices.get>;
    for (let k = 0; k < 10 * TICKS_PER_HOUR && !offer; k++) {
      w.step();
      offer = [...w.choices.values()].find((c) => c.event === 'caravan_shelter');
    }
    expect(offer).toBeTruthy();
    resolveChoice(w, offer!.id, 'accept', 2);
    expect(f.caravan?.shelter).toBe(town.id);
    run(w, 3 * TICKS_PER_HOUR);
    for (const p of pawns) expect(Math.hypot(p.x - 110, p.y - 46)).toBeLessThan(6);
    // (Goodwill drifts back a point at midnight, so look at what they remember.)
    expect(town.settlement!.memories?.some((m) => m.f === 2 && m.why === 'Our guests for a night')).toBe(true);
  });
});
