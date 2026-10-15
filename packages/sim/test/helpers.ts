import { World, type Pawn } from '../src';

/** A flat all-soil world with one non-player faction (so the storyteller stays quiet). */
export function flatWorld(w = 40, h = 40, seed = 1): World {
  const world = new World(seed, w, h);
  for (let i = 0; i < world.map.n; i++) world.refreshCell(i);
  world.factions.set(1, { id: 1, name: 'Test', color: 0xffffff, home: { x: 5, y: 5 }, isPlayer: false });
  return world;
}

export function addPawn(w: World, x: number, y: number, faction = 1): Pawn {
  const p = w.spawnPawn(faction, w.map.idx(x, y), 'Tester');
  p.needs.food = 1;
  p.needs.rest = 1;
  return p;
}

export function run(w: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.step();
}

/** Run until cond() is true or the budget runs out. Returns ticks used. */
export function runUntil(w: World, cond: () => boolean, max = 20_000): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    w.step();
  }
  throw new Error(`condition not met within ${max} ticks`);
}
