import { describe, expect, it } from 'vitest';
import { canStealFrom, Rng, sightRange, START_TICK, stealthMult, TICKS_PER_DAY, TICKS_PER_HOUR, type Item, type World } from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const stored = (w: World, f: number, def: string) => {
  let n = 0;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    if (it.def === def && w.zoneAt(w.cellOf(it))?.faction === f) n += it.count;
  }
  return n;
};
const lying = (w: World, def: string) => [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def && !w.zoneAt(w.cellOf(i)));

/** Two colonies 40 cells apart: the thieves (2) and the victims (3), who keep 30 gold in an open stockpile. */
function neighbours(hour: number) {
  const w = flatWorld(80, 60);
  w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + hour * TICKS_PER_HOUR;
  w.factions.set(2, { id: 2, name: 'Rogues', color: 0xff0000, home: { x: 10, y: 30 }, isPlayer: true });
  w.factions.set(3, { id: 3, name: 'Marks', color: 0x0000ff, home: { x: 50, y: 30 }, isPlayer: true });
  const ours = w.createZone(2, 'stockpile');
  for (let y = 28; y < 33; y++) w.addZoneCell(ours, w.map.idx(8, y));
  const theirs = w.createZone(3, 'stockpile');
  for (let x = 48; x < 53; x++) w.addZoneCell(theirs, w.map.idx(x, 30));
  w.placeItemNear('gold', 30, w.map.idx(50, 30));
  const thief = addPawn(w, 30, 30, 2);
  return { w, thief };
}
const mark = (w: World) => w.enqueue(2, { c: 'designate', kind: 'steal', x0: 47, y0: 29, x1: 53, y1: 31 });

describe('stealing from another colony', () => {
  it('at night, unseen and unheard, the goods vanish and the victims only learn something is missing', () => {
    const { w } = neighbours(23);
    // Their one colonist is fast asleep at home, out of earshot.
    const sleeper = addPawn(w, 50, 50, 3);
    sleeper.job = { type: 'sleep', stage: 1, bed: 0, cell: w.cellOf(sleeper), rest: false };
    sleeper.asleep = true;
    sleeper.needs.rest = 0.3;
    mark(w);
    runUntil(w, () => stored(w, 2, 'gold') >= 30, 5000);
    expect(stored(w, 3, 'gold')).toBe(0);
    const notes = w.dirty.msgs.filter((m) => m.text.includes('gone missing'));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((m) => m.faction === 3)).toBe(true);
    expect(w.dirty.msgs.some((m) => m.text.includes('stealing'))).toBe(false);
  });

  it('grabbing goods makes noise: a sleeper close by can wake, come to look, and catch the thief', () => {
    let caught = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { w, thief } = neighbours(23);
      w.rng = new Rng(seed);
      const sleeper = addPawn(w, 50, 33, 3);
      sleeper.job = { type: 'sleep', stage: 1, bed: 0, cell: w.cellOf(sleeper), rest: false };
      sleeper.asleep = true;
      sleeper.needs.rest = 0.3;
      const gold = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => i.def === 'gold')!;
      w.enqueue(2, { c: 'steal', pawn: thief.id, item: gold.id });
      run(w, 1500);
      if (w.dirty.msgs.some((m) => m.text.includes('stealing'))) caught++;
    }
    expect(caught).toBeGreaterThan(0);
  });

  it('caught in the act, the thief drops the goods and everyone hears who it was', () => {
    const { w, thief } = neighbours(12);
    const watcher = addPawn(w, 50, 32, 3);
    watcher.job = { type: 'hold', stage: 0, until: w.tick + 50_000 };
    // Haulers wait for dark, so this is a direct order.
    const gold = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => i.def === 'gold')!;
    w.enqueue(2, { c: 'steal', pawn: thief.id, item: gold.id });
    runUntil(w, () => w.dirty.msgs.some((m) => m.text.includes('stealing')), 3000);
    const msg = w.dirty.msgs.find((m) => m.text.includes('stealing'))!;
    expect(msg.faction).toBe(0);
    expect(msg.text).toContain(thief.name);
    run(w, 30);
    expect(thief.carrying).toBeNull();
    expect(stored(w, 2, 'gold')).toBe(0);
    expect(lying(w, 'gold').reduce((a, i) => a + i.count, 0) + stored(w, 3, 'gold')).toBe(30);
  });

  it('a locked storeroom keeps thieves out', () => {
    const { w } = neighbours(23);
    // Wall the victims' stockpile in, with their own door.
    for (let x = 47; x <= 53; x++) {
      for (const y of [29, 31]) w.spawnBuilding('wood_wall', w.map.idx(x, y), 3);
    }
    w.spawnBuilding('wood_wall', w.map.idx(53, 30), 3);
    w.spawnBuilding('door', w.map.idx(47, 30), 3);
    mark(w);
    run(w, 3000);
    expect(stored(w, 3, 'gold')).toBe(30);
    expect(stored(w, 2, 'gold')).toBe(0);
  });

  it("you can't mark your own stockpile", () => {
    const { w } = neighbours(23);
    w.placeItemNear('steel', 10, w.map.idx(8, 30));
    w.enqueue(2, { c: 'designate', kind: 'steal', x0: 8, y0: 28, x1: 8, y1: 32 });
    run(w, 2);
    for (let y = 28; y < 33; y++) expect(w.map.desig[w.map.idx(8, y)]).toBe(0);
  });
});

describe('what clients are told about thieves', () => {
  it('once a thief is clear, the pawn is resent so clients stop showing stolen goods', () => {
    const { w, thief } = neighbours(23);
    const gold = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => i.def === 'gold')!;
    w.enqueue(2, { c: 'steal', pawn: thief.id, item: gold.id });
    const stolen = () => (thief.job?.type === 'haul' ? thief.job.stolen : undefined);
    runUntil(w, () => !!stolen(), 3000);
    // Each tick, see what a delta would carry; the tick the thief gets clear must include them.
    for (let i = 0; i < 3000 && stolen(); i++) {
      w.takeDelta();
      w.step();
    }
    expect(thief.carrying?.def).toBe('gold');
    expect(stolen()).toBeUndefined();
    expect(w.takeDelta().ents.map((e) => e.id)).toContain(thief.id);
  });

  it('a change of steering direction is sent, a repeat is not', () => {
    const { w, thief } = neighbours(12);
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    run(w, 2);
    w.takeDelta();
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 0, dy: 0 });
    w.applyCommands();
    expect(w.takeDelta().ents.length).toBe(0);
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: -1, dy: 1 });
    w.applyCommands();
    expect(w.takeDelta().ents.find((e) => e.id === thief.id)).toMatchObject({ steer: [-1, 1] });
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: -5, dy: 3 });
    w.applyCommands();
    expect(w.takeDelta().ents.length).toBe(0);
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 0, dy: 0 });
    w.applyCommands();
    expect(w.takeDelta().ents.find((e) => e.id === thief.id)).toMatchObject({ steer: undefined });
  });
});

describe('sight and stealth', () => {
  it('people see far by day, only a little way at night, unless the spot is lit', () => {
    const { w } = neighbours(12);
    const spot = w.map.idx(30, 30);
    const day = sightRange(w, spot);
    w.tick += 11 * TICKS_PER_HOUR; // 23:00
    expect(sightRange(w, spot)).toBeLessThan(day);
    w.spawnBuilding('campfire', w.map.idx(31, 30), 2);
    expect(sightRange(w, spot)).toBe(day);
  });

  it('sneaking, and practice, make a thief much harder to spot', () => {
    const { thief } = neighbours(12);
    const plain = stealthMult(thief);
    thief.sneaking = true;
    const sneaking = stealthMult(thief);
    thief.skills.stealth = { level: 20, xp: 0 };
    expect(sneaking).toBeLessThan(plain);
    expect(stealthMult(thief)).toBeLessThan(sneaking);
  });

  it('slipping past people builds the stealth skill', () => {
    const { w, thief } = neighbours(23);
    const sleeper = addPawn(w, 50, 50, 3);
    sleeper.job = { type: 'sleep', stage: 1, bed: 0, cell: w.cellOf(sleeper), rest: false };
    sleeper.asleep = true;
    const before = thief.skills.stealth.xp + thief.skills.stealth.level * 10_000;
    mark(w);
    runUntil(w, () => stored(w, 2, 'gold') >= 30, 5000);
    expect(thief.skills.stealth.xp + thief.skills.stealth.level * 10_000).toBeGreaterThanOrEqual(before);
    expect(canStealFrom(w, 2, 3)).toBe(true);
    expect(canStealFrom(w, 2, 2)).toBe(false);
  });
});

describe('direct control', () => {
  it('a possessed colonist is drafted and walks where it is steered', () => {
    const { w, thief } = neighbours(12);
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    run(w, 2);
    expect(thief.possessed).toBe(true);
    expect(thief.drafted).toBe(true);
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 1, dy: 0 });
    run(w, 200);
    expect(thief.x).toBeGreaterThan(33);
    expect(thief.y).toBe(30);
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 0, dy: 0 });
    run(w, 60);
    const x = thief.x;
    run(w, 100);
    expect(thief.x).toBe(x);
  });

  it("only your own colonists can be possessed", () => {
    const { w } = neighbours(12);
    const theirs = addPawn(w, 50, 34, 3);
    w.enqueue(2, { c: 'possess', pawn: theirs.id, on: true });
    run(w, 2);
    expect(theirs.possessed).toBeFalsy();
  });

  it('E takes goods from a stockpile by hand (stealing, with the same risks) and puts them down', () => {
    const { w, thief } = neighbours(23);
    thief.x = 50;
    thief.y = 31;
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    run(w, 2);
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    run(w, 2);
    expect(thief.carrying?.def).toBe('gold');
    expect(thief.job?.type === 'control' && thief.job.stolen).toBe(3);
    w.enqueue(2, { c: 'sneak', pawn: thief.id, on: true });
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: -1, dy: 0 });
    // A long stockpile row to walk into.
    const row = w.zones.get(w.map.zoneAt[w.map.idx(8, 30)])!;
    for (let x = 1; x < 8; x++) w.addZoneCell(row, w.map.idx(x, 31));
    runUntil(w, () => thief.x <= 7, 6000);
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 0, dy: 0 });
    run(w, 40);
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    run(w, 30);
    expect(thief.carrying).toBeNull();
    expect(stored(w, 2, 'gold')).toBeGreaterThan(0);
    expect(w.dirty.msgs.some((m) => m.faction === 3 && m.text.includes('gone missing'))).toBe(true);
  });

  it('sneaking walks slower', () => {
    const { w, thief } = neighbours(12);
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 1, dy: 0 });
    run(w, 300);
    const fast = thief.x - 30;
    const b = neighbours(12);
    b.w.enqueue(2, { c: 'possess', pawn: b.thief.id, on: true });
    b.w.enqueue(2, { c: 'sneak', pawn: b.thief.id, on: true });
    b.w.enqueue(2, { c: 'steer', pawn: b.thief.id, dx: 1, dy: 0 });
    run(b.w, 300);
    expect(b.thief.x - 30).toBeLessThan(fast);
  });
});
