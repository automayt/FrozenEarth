import { describe, expect, it } from 'vitest';
import { START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR, type Item, type World } from '../src';
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
  it('at night, unseen, the goods vanish and the victims only learn something is missing', () => {
    const { w } = neighbours(23);
    // Their one colonist is fast asleep at home.
    const sleeper = addPawn(w, 50, 34, 3);
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
