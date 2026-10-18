import { describe, expect, it } from 'vitest';
import { resolveChoice, START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR, type Building, type Item, type World } from '../src';
import { addPawn, flatWorld, run } from './helpers';

/**
 * Two players' commands landing in the same tick on the same thing. Commands apply in arrival
 * order, so the first wins and the second must find the thing taken: never both, never a copy.
 */

const total = (w: World, def: string) => [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def).reduce((a, i) => a + i.count, 0);
const stored = (w: World, f: number, def: string) =>
  [...w.kinds.item]
    .map((id) => w.get<Item>(id)!)
    .filter((i) => i.def === def && w.zoneAt(w.cellOf(i))?.faction === f)
    .reduce((a, i) => a + i.count, 0);

/** Colonies 2 and 3 side by side with a stockpile each, and colony 4 (asleep, far off) keeping gold. */
function rivals(): World {
  const w = flatWorld(80, 60);
  // Deep night, so nobody at colony 4 is up to see the thieves.
  w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 23 * TICKS_PER_HOUR;
  for (const [id, x] of [
    [2, 10],
    [3, 20],
    [4, 60],
  ] as const) {
    w.factions.set(id, { id, name: `C${id}`, color: 0xffffff, home: { x, y: 30 }, isPlayer: true });
    const z = w.createZone(id, 'stockpile');
    for (let y = 28; y < 33; y++) w.addZoneCell(z, w.map.idx(x, y));
  }
  return w;
}

describe('two players, one thing, one tick', () => {
  it('the same stack stolen by two colonies: one thief takes it, the other is turned away, nothing is copied', () => {
    const w = rivals();
    w.placeItemNear('gold', 30, w.map.idx(60, 30));
    const gold = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => i.def === 'gold')!;
    const a = addPawn(w, 40, 29, 2);
    const b = addPawn(w, 40, 31, 3);
    w.enqueue(2, { c: 'steal', pawn: a.id, item: gold.id });
    w.enqueue(3, { c: 'steal', pawn: b.id, item: gold.id });
    w.step();
    expect(a.job?.type).toBe('haul');
    expect(b.job?.type === 'haul' && b.job.item === gold.id).toBe(false);
    run(w, 3000);
    expect(total(w, 'gold')).toBe(30);
    expect(stored(w, 2, 'gold')).toBe(30);
    expect(stored(w, 3, 'gold')).toBe(0);
  });

  it('the same weapon picked up by two colonies: one wields it, the other gets nothing', () => {
    const w = rivals();
    w.placeItemNear('rifle', 1, w.map.idx(15, 40));
    const rifle = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => i.def === 'rifle')!;
    const a = addPawn(w, 12, 40, 2);
    const b = addPawn(w, 18, 40, 3);
    w.enqueue(2, { c: 'draft', pawns: [a.id], on: true });
    w.enqueue(3, { c: 'draft', pawns: [b.id], on: true });
    w.enqueue(3, { c: 'equip', pawn: b.id, item: rifle.id });
    w.enqueue(2, { c: 'equip', pawn: a.id, item: rifle.id });
    run(w, 600);
    expect([a.weapon, b.weapon].sort()).toEqual(['', 'rifle']);
    expect(b.weapon).toBe('rifle');
    expect(total(w, 'rifle')).toBe(0);
  });

  it('the same downed raider captured by two colonies: one carries them off, to one bed', () => {
    const w = rivals();
    w.factions.set(9, { id: 9, name: 'Raiders', color: 0xff0000, home: { x: 0, y: 0 }, isPlayer: false, raid: { target: 2, size: 1, breakAt: 1, dead: 0, until: w.tick + 99_999, fled: false } });
    const raider = addPawn(w, 15, 45, 9);
    raider.downed = true;
    const bedA = w.spawnBuilding('bed', w.map.idx(10, 50), 2) as Building;
    const bedB = w.spawnBuilding('bed', w.map.idx(20, 50), 3) as Building;
    const a = addPawn(w, 12, 45, 2);
    const b = addPawn(w, 18, 45, 3);
    w.enqueue(3, { c: 'capture', pawns: [b.id], target: raider.id });
    w.enqueue(2, { c: 'capture', pawns: [a.id], target: raider.id });
    w.step();
    expect(b.job?.type).toBe('rescue');
    expect(a.job?.type === 'rescue').toBe(false);
    run(w, 2000);
    expect(raider.prisoner).toBe('held');
    expect(raider.faction).toBe(3);
    expect([bedA.owner, bedB.owner]).toEqual([0, raider.id]);
  });

  it('the same tree marked by two colonies: the first mark stands, and only its colonists cut it', () => {
    const w = rivals();
    const cell = w.map.idx(15, 15);
    w.spawnPlant('pine', cell, 1);
    w.enqueue(2, { c: 'designate', kind: 'chop', x0: 15, y0: 15, x1: 15, y1: 15 });
    w.enqueue(3, { c: 'designate', kind: 'chop', x0: 15, y0: 15, x1: 15, y1: 15 });
    w.step();
    expect(w.map.desigFaction[cell]).toBe(2);
    // Colony 3 can't take the mark over or cancel it either.
    w.enqueue(3, { c: 'designate', kind: 'cancel', x0: 15, y0: 15, x1: 15, y1: 15 });
    w.step();
    expect(w.map.desigFaction[cell]).toBe(2);
  });

  it('two letters spending the same goods, answered in the same tick: the first deal goes through, the second is off', () => {
    const w = rivals();
    w.placeItemNear('gold', 30, w.map.idx(10, 30));
    expect(stored(w, 2, 'gold')).toBe(30);
    // Colony 2 offers its 30 gold twice over, to 3 and to 4, for a little wood each.
    w.placeItemNear('wood', 5, w.map.idx(20, 30));
    w.placeItemNear('wood', 5, w.map.idx(60, 30));
    w.enqueue(2, { c: 'offerTrade', to: 3, give: [['gold', 20]], want: [['wood', 5]] });
    w.enqueue(2, { c: 'offerTrade', to: 4, give: [['gold', 20]], want: [['wood', 5]] });
    w.step();
    const letters = [...w.choices.values()].filter((c) => c.event === 'trade');
    expect(letters.map((c) => c.faction).sort()).toEqual([3, 4]);
    for (const c of letters) w.enqueue(c.faction, { c: 'choose', choice: c.id, option: 'accept' });
    w.step();
    run(w, 1500);
    expect(total(w, 'gold')).toBe(30);
    expect(total(w, 'wood')).toBe(10);
    // One deal happened: 20 gold went to its taker and 5 wood came back.
    const got = [3, 4].map((f) => stored(w, f, 'gold') + [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === 'gold' && !w.zoneAt(w.cellOf(i)) && w.dist(w.cellOf(i), w.map.idx(w.factions.get(f)!.home.x, w.factions.get(f)!.home.y)) < 8).reduce((a, i) => a + i.count, 0));
    expect(got.sort()).toEqual([0, 20]);
    // A letter answered twice (two tabs, or a resend after a reconnect) only counts once.
    const again = [...w.choices.values()];
    expect(again).toEqual([]);
    resolveChoice(w, letters[0].id, 'accept', letters[0].faction);
    expect(total(w, 'gold')).toBe(30);
  });

  it('an offer to a colony whose player is away still runs out on its own, declining, with nothing lost', () => {
    const w = rivals();
    w.placeItemNear('gold', 30, w.map.idx(10, 30));
    w.enqueue(2, { c: 'offerTrade', to: 3, give: [['gold', 10]], want: [] });
    w.step();
    expect([...w.choices.values()].length).toBe(1);
    run(w, 9 * TICKS_PER_HOUR);
    expect([...w.choices.values()]).toEqual([]);
    expect(stored(w, 2, 'gold')).toBe(30);
    expect(stored(w, 3, 'gold')).toBe(0);
  });
});
