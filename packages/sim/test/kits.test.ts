import { describe, expect, it } from 'vitest';
import { BUILDINGS, ITEMS, KIT_WORK, kitKey, packable } from '@fe/defs';
import { deserializeWorld, serializeWorld, START_TICK, type Building, type Construct, type Item, type World } from '../src';
import { addPawn, flatWorld, runUntil } from './helpers';

const items = (w: World, def: string) => [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def);
const count = (w: World, def: string) => items(w, def).reduce((a, i) => a + i.count, 0);

function colony(): World {
  const w = flatWorld(60, 60);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 20, y: 20 }, isPlayer: true });
  const z = w.createZone(2, 'stockpile');
  for (let x = 14; x < 20; x++) for (let y = 14; y < 17; y++) w.addZoneCell(z, w.map.idx(x, y));
  return w;
}

describe('packed buildings', () => {
  it('furniture, benches and heaters pack; walls, floors and doors do not', () => {
    for (const k of ['bed', 'workbench', 'heater', 'campfire', 'table']) {
      expect(packable(k), k).toBe(true);
      expect(ITEMS[kitKey(k)]?.category, k).toBe('kit');
    }
    for (const k of ['wood_wall', 'door', 'wood_floor', 'sun_shard']) expect(packable(k), k).toBe(false);
    // A kit is worth what went into it.
    expect(ITEMS[kitKey('workbench')].marketValue).toBeGreaterThan(50);
  });

  it('packing up a site folds furniture into kits and takes walls apart', () => {
    const w = colony();
    w.spawnBuilding('bed', w.map.idx(30, 30), 2);
    w.spawnBuilding('workbench', w.map.idx(32, 30), 2);
    w.spawnBuilding('wood_wall', w.map.idx(34, 30), 2);
    w.enqueue(2, { c: 'packUp', x0: 28, y0: 28, x1: 36, y1: 32 });
    w.step();
    expect([...w.kinds.building].length).toBe(0);
    expect(count(w, kitKey('bed'))).toBe(1);
    expect(count(w, kitKey('workbench'))).toBe(1);
    expect(count(w, 'wood')).toBe(Math.floor(BUILDINGS.wood_wall.cost.wood * 0.75));
  });

  it('a blueprint uses a stored kit, gets it hauled over, and goes up in a quarter of the time', () => {
    const w = colony();
    addPawn(w, 18, 18, 2);
    w.placeItemNear(kitKey('bed'), 1, w.map.idx(15, 15));
    // Two beds placed, one kit: one blueprint takes the kit, the other wants wood.
    w.enqueue(2, { c: 'build', def: 'bed', hollow: false, x0: 24, y0: 20, x1: 25, y1: 20 });
    w.step();
    const cons = [...w.kinds.construct].map((id) => w.get<Construct>(id)!);
    expect(cons.map((c) => !!c.kit).sort()).toEqual([false, true]);
    const fromKit = cons.find((c) => c.kit)!;
    runUntil(w, () => !w.entities.has(fromKit.id), 6000);
    const bed = [...w.kinds.building].map((id) => w.get<Building>(id)!).find((b) => b.def === 'bed');
    expect(bed).toBeTruthy();
    expect(count(w, kitKey('bed'))).toBe(0);
    expect(KIT_WORK).toBeLessThan(0.5);
  });

  it('stockpiles in older saves that took everything take kits and gear too', () => {
    const w = colony();
    const save = serializeWorld(w);
    save.version = 6;
    for (const z of save.zones) z.allow = ['resource', 'raw_food', 'meal', 'apparel', 'weapon'];
    const back = deserializeWorld(save);
    const z = [...back.zones.values()][0];
    expect(z.allow).toContain('kit');
    expect(z.allow).toContain('gear');
  });
});
