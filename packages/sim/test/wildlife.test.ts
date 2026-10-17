import { describe, expect, it } from 'vitest';
import {
  createWorld,
  deserializeWorld,
  frostDistance,
  hashWorld,
  hostile,
  serializeWorld,
  spawnAnimal,
  START_TICK,
  TICKS_PER_DAY,
  type Item,
  type Job,
  type Pawn,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const animals = (w: World, species?: string) => [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.species && (!species || p.species === species));
const loose = (w: World, def: string) => [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === def).reduce((a, i) => a + i.count, 0);

/** A flat world with a player colony (faction 2). */
function field(): { w: World; player: number } {
  const w = flatWorld(80, 80);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 10, y: 10 }, isPlayer: true });
  return { w, player: 2 };
}

describe('wildlife', () => {
  it('a new world has herds of several kinds, none on frozen land, and no wolves yet', () => {
    const w = createWorld({ seed: 31, width: 200, height: 200 });
    const all = animals(w);
    expect(all.length).toBeGreaterThan(12);
    expect(new Set(all.map((a) => a.species)).size).toBeGreaterThanOrEqual(2);
    expect(animals(w, 'wolf').length).toBe(0);
    for (const a of all) expect(w.frostAt(w.cellOf(a))).toBe(0);
  });

  it('prey bolt from people who come close', () => {
    const { w, player } = field();
    const deer = spawnAnimal(w, 'deer', w.map.idx(40, 40));
    addPawn(w, 36, 40, player);
    run(w, 400);
    expect(Math.hypot(deer.x - 36, deer.y - 40)).toBeGreaterThan(8);
  });

  it('hunters with a rifle bring down marked animals, leaving meat and a hide', () => {
    const { w, player } = field();
    const z = w.createZone(player, 'stockpile');
    for (let x = 5; x < 15; x++) w.addZoneCell(z, w.map.idx(x, 10));
    const deer = spawnAnimal(w, 'deer', w.map.idx(30, 30));
    const hunter = addPawn(w, 26, 30, player);
    hunter.weapon = 'rifle';
    w.enqueue(player, { c: 'hunt', pawns: [deer.id], on: true });
    runUntil(w, () => !w.get(deer.id), 6000);
    expect(loose(w, 'meat')).toBeGreaterThan(10);
    expect(loose(w, 'cloth')).toBeGreaterThan(0);
  });

  it("won't hunt without a ranged weapon", () => {
    const { w, player } = field();
    const deer = spawnAnimal(w, 'deer', w.map.idx(30, 30));
    const p = addPawn(w, 26, 30, player);
    p.weapon = 'knife';
    w.enqueue(player, { c: 'hunt', pawns: [deer.id], on: true });
    run(w, 300);
    expect(p.job?.type).not.toBe('attack');
  });

  it('a muskox turns on whoever shoots it', () => {
    const { w, player } = field();
    const ox = spawnAnimal(w, 'muskox', w.map.idx(40, 40));
    const shooter = addPawn(w, 34, 40, player);
    shooter.weapon = 'rifle';
    w.enqueue(player, { c: 'draft', pawns: [shooter.id], on: true });
    run(w, 1);
    w.enqueue(player, { c: 'attack', pawns: [shooter.id], target: ox.id });
    runUntil(w, () => ox.job?.type === 'attack' || !w.get(ox.id), 3000);
    if (w.get(ox.id)) expect(ox.job?.type === 'attack' && ox.job.target).toBe(shooter.id);
  });

  it('wolves are enemies to people; grazing animals never are', () => {
    const { w, player } = field();
    const wolf = spawnAnimal(w, 'wolf', w.map.idx(60, 60));
    const deer = spawnAnimal(w, 'deer', w.map.idx(20, 60));
    expect(hostile(w, wolf.faction, player)).toBe(true);
    expect(hostile(w, deer.faction, player)).toBe(false);
    expect(hostile(w, wolf.faction, deer.faction)).toBe(false);
  });

  it('hungry wolves hunt prey, and in winter they hunt people', () => {
    const { w, player } = field();
    const wolf = spawnAnimal(w, 'wolf', w.map.idx(40, 40));
    const hare = spawnAnimal(w, 'hare', w.map.idx(48, 40));
    wolf.needs.food = 0.2;
    runUntil(w, () => !w.get(hare.id), 4000);
    expect(loose(w, 'meat')).toBeGreaterThan(0);
    expect(wolf.needs.food).toBe(1);
    // Fed, in summer: a colonist walking past is left alone.
    const walker = addPawn(w, Math.min(78, wolf.x + 5), wolf.y, player);
    run(w, 300);
    expect(wolf.job?.type === 'attack' && wolf.job.target === walker.id).toBe(false);
    // Winter.
    w.tick = START_TICK + 15 * TICKS_PER_DAY + 10 * 1250;
    walker.x = Math.min(78, wolf.x + 5);
    walker.y = wolf.y;
    walker.path = null;
    wolf.job = null;
    run(w, 5);
    const job = wolf.job as Job | null;
    expect(job?.type === 'attack' && job.target).toBe(walker.id);
  });

  it('animals on frozen ground drift toward the warm middle', () => {
    const w = createWorld({ seed: 31, width: 160, height: 160, settlements: false });
    w.frost = { ...w.frost, startDay: 0, pace: 4 };
    run(w, 2 * TICKS_PER_DAY);
    const outer = animals(w).filter((a) => w.frostAt(w.cellOf(a)) > 0.05);
    const before = outer.map((a) => frostDistance(a.x, a.y, 160, 160));
    run(w, TICKS_PER_DAY / 2);
    const moved = outer.filter((a, k) => w.get(a.id) && frostDistance(a.x, a.y, 160, 160) < before[k] - 0.02).length;
    expect(moved).toBeGreaterThanOrEqual(Math.min(outer.length, 1));
  });

  it('save, load and carry on identically with animals about', () => {
    const w = createWorld({ seed: 33, width: 120, height: 120 });
    run(w, 2000);
    const b = deserializeWorld(serializeWorld(w));
    expect(hashWorld(b)).toBe(hashWorld(w));
    run(w, 3000);
    run(b, 3000);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });
});
