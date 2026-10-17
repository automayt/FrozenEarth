import { describe, expect, it } from 'vitest';
import { dispositionOf, foundSettlement, goodwillOf, GOODWILL, GUARD_REACH, snapshot, START_TICK, TICKS_PER_HOUR, World, type Pawn } from '@fe/sim';
import { Mirror } from '@fe/protocol';
import { caughtStealing } from '../../../packages/sim/src/settlements';
import { canSee } from '../../../packages/sim/src/stealth';
import { fog } from '../src/render/fog';
import { goodwillShift, hostileLandAt, stealRisk, watchersAt } from '../src/ui/risk';
import { store } from '../src/store';

/**
 * The risk shown before an order must be what the sim then does: the goodwill a theft costs,
 * who can see the spot, and where a hostile town's guards come out.
 */

const ME = 1;

function world(temper: number): { w: World; town: number } {
  const w = new World(3, 80, 80);
  for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
  w.tick = START_TICK + 12 * TICKS_PER_HOUR;
  w.factions.set(ME, { id: ME, name: 'Us', color: 0xffffff, home: { x: 8, y: 8 }, isPlayer: true });
  const f = foundSettlement(w, { x: 40, y: 40 }, temper, 4);
  return { w, town: f.id };
}

function show(w: World): Mirror {
  const m = new Mirror();
  m.applySnapshot(structuredClone(snapshot(w)));
  store.mirror = m;
  store.me = { playerId: 1, faction: ME };
  store.time = { speed: 1, paused: true, reason: '' };
  store.setServerTick(w.tick);
  store.setServerTick(w.tick);
  return m;
}

describe('order risk', () => {
  it('predicts the goodwill and mood a caught theft leaves behind', () => {
    for (const temper of [45, 0, -20, -60]) {
      const { w, town } = world(temper);
      show(w);
      const predicted = goodwillShift(store.mirror.factions.get(town), ME, GOODWILL.caughtStealing)!;
      caughtStealing(w, town, ME);
      const s = w.factions.get(town)!.settlement!;
      expect(predicted.before).toBe(temper);
      expect(predicted.after).toBe(goodwillOf(s, ME));
      expect(predicted.to).toBe(dispositionOf(s, ME));
    }
  });

  it('names exactly the townsfolk the sim says can see the spot', () => {
    const { w, town } = world(0);
    // A probe colonist of ours standing at each spot in turn, checked against the sim's canSee.
    const thief = w.spawnPawn(ME, w.map.idx(8, 8), 'Sly Fox');
    show(w);
    fog.update(1e12);
    const counts: number[] = [];
    const people = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === town);
    for (const [x, y] of [
      [40, 41],
      [44, 45],
      [40, 30],
      [60, 60],
    ]) {
      thief.x = x;
      thief.y = y;
      const sim = people.filter((o) => canSee(w, o, thief)).map((o) => o.id).sort();
      const shown = watchersAt(town, x, y, store.mirror.get<Pawn>(thief.id)).map((o) => o.id).sort();
      expect(shown, `at ${x},${y}`).toEqual(sim);
      counts.push(sim.length);
    }
    // Both cases came up: seen somewhere, unseen somewhere.
    expect(Math.max(...counts)).toBeGreaterThan(0);
    expect(Math.min(...counts)).toBe(0);
  });

  it("marks a hostile town's guard reach, and nothing for a wary one", () => {
    const hostile = world(-60);
    show(hostile.w);
    const r = hostile.w.factions.get(hostile.town)!.settlement!.radius;
    expect(hostileLandAt(40 + r + GUARD_REACH, 40)).toMatchObject({ guards: true });
    expect(hostileLandAt(40 + r + GUARD_REACH + 1, 40)).toMatchObject({ guards: false });
    expect(hostileLandAt(75, 75)).toBeNull();
    // Stealing there warns about the guards first.
    expect(stealRisk(store.mirror.factions.get(hostile.town)!, 40, 41, undefined, true)[0].text).toMatch(/guards attack/);
    const wary = world(0);
    show(wary.w);
    expect(hostileLandAt(40, 45)).toBeNull();
  });
});
