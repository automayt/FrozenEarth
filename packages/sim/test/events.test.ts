import { describe, expect, it } from 'vitest';
import { EVENTS } from '@fe/defs';
import {
  addCondition,
  addPlayerFaction,
  createWorld,
  deserializeWorld,
  fireEvent,
  hashWorld,
  HANDLED_EVENTS,
  hasCondition,
  killPawn,
  resolveChoice,
  serializeWorld,
  startFire,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

function pawns(w: World, faction?: number): Pawn[] {
  return [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => faction === undefined || p.faction === faction);
}

function count(w: World, def: string): number {
  return [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def).reduce((a, i) => a + i.count, 0);
}

/** Two colonies with stockpiles full of goods and planted fields. */
function livelyWorld(seed = 11): World {
  const w = createWorld({ seed, width: 120, height: 120 });
  for (const name of ['North', 'South']) {
    const f = addPlayerFaction(w, name);
    const { x, y } = f.home;
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', ...rect(x - 3, y - 3, x + 3, y + 3) });
    w.enqueue(f.id, { c: 'zone', kind: 'grow', plant: 'potato', ...rect(x - 9, y + 4, x - 4, y + 8) });
    w.placeItemNear('gold', 20, w.map.idx(x, y));
    w.placeItemNear('steel', 120, w.map.idx(x, y));
  }
  run(w, 4000);
  return w;
}

describe('event catalogue', () => {
  it('every defined event has a handler', () => {
    for (const key of Object.keys(EVENTS)) expect(HANDLED_EVENTS, key).toContain(key);
  });

  it('every event fires on a lively world without throwing', () => {
    const w = livelyWorld();
    const results: Record<string, boolean> = {};
    for (const key of Object.keys(EVENTS)) {
      const data = key === 'refugee_betrayal' ? { pawn: pawns(w, 1)[0].id } : {};
      results[key] = fireEvent(w, key, 1, data);
      run(w, 50);
    }
    // A few need specific circumstances (crops ready to blight, rock near home...);
    // the rest must always succeed on this world.
    const allowedToSkip = new Set(['blight', 'bumper_crop', 'ore_discovered', 'pests', 'miracle_recovery', 'wildfire']);
    for (const [key, ok] of Object.entries(results)) if (!allowedToSkip.has(key)) expect(ok, key).toBe(true);
    run(w, 3 * TICKS_PER_DAY);
  });
});

describe('choices', () => {
  it('accepting a refugee adds a colonist', () => {
    const w = livelyWorld();
    const before = pawns(w, 1).length;
    fireEvent(w, 'refugee', 1);
    const c = [...w.choices.values()].find((x) => x.event === 'refugee')!;
    expect(c.faction).toBe(1);
    resolveChoice(w, c.id, 'accept', 1);
    expect(pawns(w, 1).length).toBe(before + 1);
    expect(w.choices.has(c.id)).toBe(false);
  });

  it('only the target colony can answer', () => {
    const w = livelyWorld();
    fireEvent(w, 'refugee', 1);
    const c = [...w.choices.values()][0];
    resolveChoice(w, c.id, 'accept', 2);
    expect(w.choices.has(c.id)).toBe(true);
  });

  it('peddler trades from stockpiles', () => {
    const w = livelyWorld();
    fireEvent(w, 'peddler', 1);
    const c = [...w.choices.values()][0];
    const before = count(w, 'gold') + count(w, 'steel') + count(w, 'wood');
    resolveChoice(w, c.id, 'accept', 1);
    expect(count(w, 'gold') + count(w, 'steel') + count(w, 'wood')).not.toBe(before);
  });

  it('unanswered choices expire to the last option', () => {
    const w = livelyWorld();
    const before = pawns(w, 1).length;
    fireEvent(w, 'refugee', 1);
    run(w, 7 * TICKS_PER_HOUR);
    expect(w.choices.size).toBe(0);
    expect(pawns(w, 1).length).toBe(before);
  });

  it('server-only choice data survives save and load', () => {
    const w = livelyWorld();
    fireEvent(w, 'refugee', 1);
    const b = deserializeWorld(serializeWorld(w));
    expect(b.choices.size).toBe(1);
    expect(hashWorld(b)).toBe(hashWorld(w));
    const c = [...b.choices.values()][0];
    resolveChoice(b, c.id, 'accept', 1);
    expect(pawns(b, 1).length).toBe(pawns(w, 1).length + 1);
  });
});

describe('health', () => {
  it('flu runs its course: recovered or dead within a week', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    w.spawnItem('survival_meal', 20, w.map.idx(6, 6));
    addCondition(w, p, 'flu');
    runUntil(w, () => !w.get(p.id) || !hasCondition(p, 'flu'), 7 * TICKS_PER_DAY);
  });

  it('contagion spreads between nearby colonists', () => {
    const w = flatWorld();
    const sick = addPawn(w, 5, 5);
    for (let k = 0; k < 4; k++) addPawn(w, 6 + k, 5);
    w.spawnItem('survival_meal', 20, w.map.idx(6, 6));
    addCondition(w, sick, 'plague');
    runUntil(w, () => pawns(w).filter((p) => p.id !== sick.id && hasCondition(p, 'plague')).length > 0, 4 * TICKS_PER_DAY);
  });

  it('extreme cold causes hypothermia and kills', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    w.coldOffset = -60;
    runUntil(w, () => hasCondition(p, 'hypothermia'), TICKS_PER_HOUR * 2);
    runUntil(w, () => !w.get(p.id), 2 * TICKS_PER_DAY);
    expect(w.dirty.msgs.some((m) => m.text.includes('died of hypothermia'))).toBe(true);
  });

  it('a warm room protects against the cold', () => {
    const w = flatWorld();
    w.coldOffset = -40;
    // A sealed 3x3 room with a heater.
    for (let x = 9; x <= 13; x++) {
      w.spawnBuilding('stone_wall', w.map.idx(x, 9), 1);
      w.spawnBuilding('stone_wall', w.map.idx(x, 13), 1);
    }
    for (let y = 10; y <= 12; y++) {
      w.spawnBuilding('stone_wall', w.map.idx(9, y), 1);
      w.spawnBuilding('stone_wall', w.map.idx(13, y), 1);
    }
    w.spawnBuilding('heater', w.map.idx(12, 12), 1);
    run(w, 300);
    const room = w.rooms.get(w.map.roomAt[w.map.idx(11, 11)])!;
    room.temp = 21;
    const p = addPawn(w, 11, 11);
    p.priorities.haul = 0;
    w.spawnItem('survival_meal', 20, w.map.idx(10, 10));
    run(w, TICKS_PER_DAY);
    expect(w.get(p.id)).toBeTruthy();
    expect(hasCondition(p, 'hypothermia')).toBe(false);
  });

  it('starvation leads to malnutrition and death', () => {
    const w = flatWorld();
    const p = addPawn(w, 5, 5);
    p.needs.food = 0;
    runUntil(w, () => hasCondition(p, 'malnutrition'), TICKS_PER_HOUR * 2);
    runUntil(w, () => !w.get(p.id), 5 * TICKS_PER_DAY);
  });

  it('a wiped-out colony gets survivors a day later', () => {
    const w = createWorld({ seed: 3, width: 80, height: 80 });
    const f = addPlayerFaction(w, 'Doomed');
    for (const p of pawns(w, f.id)) w.despawn(p.id);
    const victim = w.spawnPawn(f.id, w.map.idx(f.home.x, f.home.y), 'Last');
    killPawn(w, victim, 'bad luck');
    runUntil(w, () => pawns(w, f.id).length === 2, 2 * TICKS_PER_DAY);
  });
});

describe('fire', () => {
  it('spreads through a forest and burns it down', () => {
    const w = flatWorld(30, 30);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) w.spawnPlant('oak', w.map.idx(x, y), 1);
    startFire(w, w.map.idx(10, 10));
    run(w, 6 * TICKS_PER_HOUR);
    expect(w.kinds.plant.size).toBeLessThan(90);
  });

  it('firefighters put out fires near home', () => {
    const w = flatWorld(30, 30);
    addPawn(w, 5, 5);
    const c = w.map.idx(7, 7);
    w.spawnBuilding('bed', c, 1);
    startFire(w, c);
    runUntil(w, () => w.fireCells.size === 0, TICKS_PER_HOUR * 3);
  });
});

describe('storyteller', () => {
  it('a long multiplayer game sees a wide spread of events and stays deterministic', () => {
    const play = () => {
      const w = livelyWorld(21);
      const fired = new Set<string>();
      const realFire = w.message.bind(w);
      w.message = (f, text, tone, at) => realFire(f, text, tone, at);
      for (let day = 0; day < 40; day++) {
        run(w, TICKS_PER_DAY);
        for (const k of Object.keys(w.story.lastFired)) fired.add(k.split(':')[0]);
        // Answer any letters so visitors resolve.
        for (const c of [...w.choices.values()]) resolveChoice(w, c.id, c.options[0].key, c.faction);
      }
      return { w, fired };
    };
    const a = play();
    const b = play();
    expect(hashWorld(a.w)).toBe(hashWorld(b.w));
    expect(a.fired.size).toBeGreaterThan(14);
    // Unique events never repeat.
    expect(new Set(a.w.story.uniqueFired).size).toBe(a.w.story.uniqueFired.length);
  });
});
