import { describe, expect, it } from 'vitest';
import {
  askForHelp,
  deserializeWorld,
  foundSettlement,
  hashWorld,
  injure,
  killPawn,
  resolveChoice,
  serializeWorld,
  START_TICK,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type Faction,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

/**
 * Edge cases where two systems meet at a bad moment: an order given to a colonist someone is
 * steering, stolen goods put down by hand, a settlement that moves or dies while a colony has
 * promised it something, a world saved halfway through all of it.
 */

/** Thieves (2) at x=10, victims (3) with 30 gold in an open stockpile at x=48..52, y=30. */
function neighbours() {
  const w = flatWorld(80, 60);
  w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + 23 * TICKS_PER_HOUR;
  w.factions.set(2, { id: 2, name: 'Rogues', color: 0xff0000, home: { x: 10, y: 30 }, isPlayer: true });
  w.factions.set(3, { id: 3, name: 'Marks', color: 0x0000ff, home: { x: 50, y: 30 }, isPlayer: true });
  const ours = w.createZone(2, 'stockpile');
  for (let y = 28; y < 33; y++) w.addZoneCell(ours, w.map.idx(8, y));
  const theirs = w.createZone(3, 'stockpile');
  for (let x = 48; x < 53; x++) w.addZoneCell(theirs, w.map.idx(x, 30));
  w.placeItemNear('gold', 30, w.map.idx(50, 30));
  const thief = addPawn(w, 30, 30, 2);
  const gold = () => [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => i.def === 'gold')!;
  return { w, thief, gold };
}

describe('direct control meets orders', () => {
  it('pressing E while a steered colonist carries out a steal order leaves the order alone', () => {
    const { w, thief, gold } = neighbours();
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    w.enqueue(2, { c: 'steal', pawn: thief.id, item: gold().id });
    runUntil(w, () => !!thief.carrying, 3000);
    expect(thief.job?.type).toBe('haul');
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    // The haul used to find its hands empty and throw, taking the whole server with it.
    expect(() => run(w, 2000)).not.toThrow();
  });

  it('stolen goods put down by hand end the theft, so later pickups are not "stolen"', () => {
    const { w, thief } = neighbours();
    thief.x = 50;
    thief.y = 31;
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    run(w, 1);
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    run(w, 1);
    expect(thief.carrying?.def).toBe('gold');
    const job = () => thief.job as Extract<Pawn['job'], { type: 'control' }>;
    expect(job().stolen).toBe(3);
    // Out of sight, put it down in the open.
    thief.x = 30;
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    run(w, 1);
    expect(thief.carrying).toBeNull();
    expect(job().stolen).toBeUndefined();
    expect(w.dirty.msgs.some((m) => m.faction === 3 && m.text.includes('gone missing'))).toBe(true);
    // Their own wood, picked up later, is just wood.
    w.placeItemNear('wood', 10, w.map.idx(30, 30));
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    run(w, 1);
    expect(thief.carrying?.def).toBe('gold');
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    thief.x = 8;
    run(w, 1);
    expect(job().stolen).toBeUndefined();
  });

  it('letting go of a thief mid-theft drops the goods, and the owner finds them missing', () => {
    const { w, thief } = neighbours();
    thief.x = 50;
    thief.y = 31;
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    run(w, 1);
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    run(w, 1);
    expect(thief.carrying?.def).toBe('gold');
    thief.x = 30;
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: false });
    run(w, 1);
    expect(thief.carrying).toBeNull();
    expect(w.dirty.msgs.some((m) => m.faction === 3 && m.text.includes('gone missing'))).toBe(true);
  });

  it('a steered colonist knocked down is let go, and gets up without walking off', () => {
    const { w, thief } = neighbours();
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: 1, dy: 0 });
    run(w, 5);
    expect(thief.possessed).toBe(true);
    for (let k = 0; k < 40 && !thief.downed; k++) injure(w, thief, 'cut', 0.05);
    expect(thief.downed).toBe(true);
    expect(thief.possessed).toBe(false);
    expect(thief.steer).toBeUndefined();
  });

  it('a downed colonist can still be let go of', () => {
    const { w, thief } = neighbours();
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    run(w, 1);
    // As an old save might have it: steered and down.
    thief.downed = true;
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: false });
    run(w, 1);
    expect(thief.possessed).toBe(false);
  });

  it('saved mid-steer, mid-theft and mid-hunt, a world carries on identically', () => {
    const { w, thief } = neighbours();
    thief.x = 50;
    thief.y = 31;
    w.enqueue(2, { c: 'possess', pawn: thief.id, on: true });
    w.enqueue(2, { c: 'sneak', pawn: thief.id, on: true });
    run(w, 1);
    w.enqueue(2, { c: 'interact', pawn: thief.id });
    w.enqueue(2, { c: 'steer', pawn: thief.id, dx: -1, dy: 0 });
    const hunter = addPawn(w, 12, 40, 2);
    hunter.weapon = 'bow';
    const deer = w.spawnPawn(1, w.map.idx(20, 45), 'Deer');
    deer.species = 'deer';
    w.enqueue(2, { c: 'hunt', pawns: [deer.id], on: true });
    run(w, 30);
    expect((thief.job as { stolen?: number }).stolen).toBe(3);
    const b = deserializeWorld(serializeWorld(w));
    expect(hashWorld(b)).toBe(hashWorld(w));
    run(w, 600);
    run(b, 600);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });
});

/** A colony (2) that has promised a settlement near the west edge some goods. */
function promised(): { w: World; s: Faction } {
  const w = flatWorld(160, 160);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 120, y: 80 }, isPlayer: true });
  const s = foundSettlement(w, { x: 24, y: 80 }, 45, 4);
  s.settlement!.met.push(2);
  expect(askForHelp(w, s, 2)).toBe(true);
  const c = [...w.choices.values()].find((x) => x.event === 'settlement_request')!;
  resolveChoice(w, c.id, 'accept', 2);
  expect(s.settlement!.requests).toHaveLength(1);
  return { w, s };
}

describe('promises to settlements', () => {
  it('lapse without blame when the settlement falls', () => {
    const { w, s } = promised();
    const g = s.settlement!.goodwill[2];
    // A second letter asking for help is still waiting when they fall.
    w.factions.set(4, { id: 4, name: 'Other', color: 0xff00, home: { x: 120, y: 120 }, isPlayer: true });
    s.settlement!.met.push(4);
    expect(askForHelp(w, s, 4)).toBe(true);
    for (const id of [...w.kinds.pawn]) {
      const p = w.get<Pawn>(id)!;
      if (p.faction === s.id) killPawn(w, p, 'testing');
    }
    runUntil(w, () => s.settlement!.state === 'fallen', 2000);
    expect(s.settlement!.requests).toEqual([]);
    expect(w.dirty.msgs.some((m) => m.faction === 2 && m.text.includes('no longer stands'))).toBe(true);
    expect([...w.choices.values()].filter((c) => c.event === 'settlement_request')).toEqual([]);
    expect(w.choiceData.size).toBe(w.choices.size);
    run(w, 5 * TICKS_PER_DAY / 10);
    expect(s.settlement!.goodwill[2]).toBe(g);
    expect(w.dirty.msgs.some((m) => m.text.includes('never came'))).toBe(false);
  });

  it("don't run out while the settlement is on the move, where nobody can deliver", () => {
    const { w, s } = promised();
    const r = s.settlement!.requests![0];
    // The frost arrives now, and the delivery is due soon: they pack up and head inward.
    w.frost = { startDay: 0, pace: 3, minRadius: 0.18 };
    const home = w.map.idx(s.home.x, s.home.y);
    while (w.frostAt(home) <= 0.3) w.tick += TICKS_PER_HOUR;
    w.tick -= w.tick % 1000;
    r.until = w.tick + 500;
    run(w, 1);
    expect(s.settlement!.state).toBe('leaving');
    // Past the deadline, at their next look round, still on the road (or just arrived): the promise stands.
    run(w, 1000);
    expect(s.settlement!.requests).toContain(r);
    expect(r.until).toBeGreaterThan(w.tick);
    expect(w.dirty.msgs.some((m) => m.text.includes('never came'))).toBe(false);
  });
});
