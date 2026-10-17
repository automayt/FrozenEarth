import { beforeEach, describe, expect, it } from 'vitest';
import { lineOfSight, Rng, sightRange, snapshot, START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR, World, type Pawn } from '@fe/sim';
import { decode, encode, Mirror, type ServerMsg } from '@fe/protocol';
import { canSee } from '../../../packages/sim/src/stealth';
import { Fog } from '../src/render/fog';
import { store } from '../src/store';

/**
 * The client's fog must follow the sim's rules for sight exactly: if the fog says you can see
 * someone, the sim agrees (and vice versa), or players are shown thieves the sim says nobody
 * saw, or told nobody can see them when someone can.
 */

const US = 1;
const THEM = 2;

function world(seed: number): World {
  const w = new World(seed, 48, 48);
  for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
  w.factions.set(US, { id: US, name: 'Us', color: 0xffffff, home: { x: 5, y: 5 }, isPlayer: true });
  w.factions.set(THEM, { id: THEM, name: 'Them', color: 0xff0000, home: { x: 40, y: 40 }, isPlayer: true });
  return w;
}

/** Hand the client a mirror of this world, as a join over the wire would. */
function show(w: World): Mirror {
  const m = new Mirror();
  m.applySnapshot(decode<Extract<ServerMsg, { t: 'welcome' }>>(encode({ t: 'welcome', playerId: 1, faction: US, token: '', snap: snapshot(w) })).snap);
  store.mirror = m;
  store.me = { playerId: 1, faction: US };
  store.time = { speed: 1, paused: true, reason: '' };
  store.setServerTick(w.tick);
  store.setServerTick(w.tick);
  return m;
}

/** Scatter walls, embrasures, doors, rock, trees and light sources. */
function clutter(w: World, rng: Rng): void {
  const defs = ['wood_wall', 'stone_wall', 'embrasure', 'door', 'sandbags', 'campfire', 'heater', 'bed'];
  for (let k = 0; k < 260; k++) {
    const c = rng.int(w.map.n);
    if (w.map.buildingAt[c] || w.map.rock[c]) continue;
    if (rng.chance(0.25)) w.setRock(c, 1);
    else w.spawnBuilding(rng.pick(defs), c, rng.chance(0.5) ? US : THEM);
  }
}

beforeEach(() => {
  store.me = null;
});

describe('fog of war matches the sim', () => {
  it('a line of sight is clear for the client exactly when it is for the sim', () => {
    for (const seed of [1, 2, 3]) {
      const w = world(seed);
      const rng = new Rng(seed);
      clutter(w, rng);
      show(w);
      const fog = new Fog();
      fog.update(1e9);
      for (let k = 0; k < 3000; k++) {
        const a = rng.int(w.map.n);
        const b = rng.int(w.map.n);
        const m = w.map;
        expect(fog.lineClear(m.cx(a), m.cy(a), m.cx(b), m.cy(b)), `${a} -> ${b}`).toBe(lineOfSight(w, a, b));
      }
    }
  });

  it('day, night, and firelight give the same sight range as the sim', () => {
    const w = world(4);
    clutter(w, new Rng(4));
    const day0 = START_TICK - (START_TICK % TICKS_PER_DAY);
    for (const hour of [3, 6, 12, 21.5, 22, 23]) {
      w.tick = day0 + TICKS_PER_DAY + Math.round(hour * TICKS_PER_HOUR);
      show(w);
      const fog = new Fog();
      fog.update(1e9);
      for (let c = 0; c < w.map.n; c += 7) expect(fog.sightAt(c), `hour ${hour} cell ${c}`).toBe(sightRange(w, c));
    }
  });

  it('who can see whom agrees with the sim, sneaking and stealth skill included', () => {
    const rng = new Rng(9);
    for (const hour of [12, 23]) {
      const w = world(5);
      clutter(w, rng);
      w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + TICKS_PER_DAY + hour * TICKS_PER_HOUR;
      const pawns: Pawn[] = [];
      for (let k = 0; k < 40; k++) {
        const c = rng.int(w.map.n);
        if (w.map.solid[c]) continue;
        const p = w.spawnPawn(rng.chance(0.5) ? US : THEM, c, `P${k}`);
        p.sneaking = rng.chance(0.4);
        p.skills.stealth.level = rng.int(20);
        p.asleep = rng.chance(0.1);
        pawns.push(p);
      }
      show(w);
      const fog = new Fog();
      fog.update(1e9);
      let seen = 0;
      for (const a of pawns) {
        for (const b of pawns) {
          if (a === b) continue;
          const sim = canSee(w, a, b);
          expect(fog.sees(store.mirror.get<Pawn>(a.id)!, store.mirror.get<Pawn>(b.id)!), `${a.name} sees ${b.name} at ${hour}h`).toBe(sim);
          if (sim) seen++;
        }
      }
      expect(seen).toBeGreaterThan(0);
    }
  });

  it('you only see into a building where one of your people can look in', () => {
    const w = world(6);
    // A closed stone hut with a door, and a stranger inside.
    for (let x = 20; x <= 26; x++) {
      for (let y = 20; y <= 26; y++) {
        if (x === 20 || x === 26 || y === 20 || y === 26) w.spawnBuilding(x === 23 && y === 26 ? 'door' : 'stone_wall', w.map.idx(x, y), THEM);
      }
    }
    w.step();
    expect(w.map.roomAt[w.map.idx(23, 23)]).not.toBe(0);
    const stranger = w.spawnPawn(THEM, w.map.idx(23, 23), 'Stranger');
    const scout = w.spawnPawn(US, w.map.idx(23, 30), 'Scout');
    const m = show(w);
    const fog = new Fog();
    fog.update(1e9);
    expect(fog.hidden(w.map.idx(23, 23))).toBe(true);
    expect(fog.shows(m.get<Pawn>(stranger.id)!)).toBe(false);
    // Outdoors is always on view, and your own people always show.
    expect(fog.hidden(w.map.idx(23, 35))).toBe(false);
    expect(fog.shows(m.get<Pawn>(scout.id)!)).toBe(true);
    // Step inside: now the room is seen.
    m.get<Pawn>(scout.id)!.y = 24;
    expect(fog.update(1e9 + 100)).toBe(false); // throttled
    expect(fog.update(1e9 + 1000)).toBe(true);
    expect(fog.shows(m.get<Pawn>(stranger.id)!)).toBe(true);
    // A sleeping colonist sees nothing.
    m.get<Pawn>(scout.id)!.asleep = true;
    fog.update(1e9 + 2000);
    expect(fog.shows(m.get<Pawn>(stranger.id)!)).toBe(false);
  });
});
