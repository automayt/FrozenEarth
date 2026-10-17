import { describe, expect, it } from 'vitest';
import { coverAgainst, startRaid, START_TICK, TICKS_PER_HOUR, type Faction, type Pawn, type World } from '../src';
import { addPawn, flatWorld, run } from './helpers';

const pawns = (w: World, f: number) => [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === f);
const raidFaction = (w: World) => [...w.factions.values()].find((f) => f.raid) as Faction | undefined;

/**
 * Four riflemen against a raid twice their size. Fortified: a stone-walled compound with an
 * embrasure in each wall and a defender behind each. Open: the same four, same spots, no walls.
 */
function holdout(fortified: boolean, seed: number) {
  const w = flatWorld(70, 70, seed);
  w.tick = START_TICK + 8 * TICKS_PER_HOUR;
  w.factions.set(2, { id: 2, name: 'Holdouts', color: 0x3a9ae0, home: { x: 35, y: 35 }, isPlayer: true });
  const m = w.map;
  if (fortified) {
    for (let x = 31; x <= 39; x++) {
      for (let y = 31; y <= 39; y++) {
        if (x !== 31 && x !== 39 && y !== 31 && y !== 39) continue;
        const mid = (x === 35 && (y === 31 || y === 39)) || (y === 35 && (x === 31 || x === 39));
        const door = x === 37 && y === 39;
        w.spawnBuilding(door ? 'door' : mid ? 'embrasure' : 'stone_wall', m.idx(x, y), 2);
      }
    }
  }
  const spots: [number, number][] = [
    [35, 32],
    [35, 38],
    [32, 35],
    [38, 35],
  ];
  const defenders = spots.map(([x, y]) => {
    const p = addPawn(w, x, y, 2);
    p.weapon = 'rifle';
    p.drafted = true;
    p.priorities.doctor = 0;
    return p;
  });
  const raiders = startRaid(w, 2, 400, 'raid')!;
  return { w, defenders, raiders };
}

function fight(w: World, max = 24_000): void {
  for (let t = 0; t < max; t += 500) {
    run(w, 500);
    const rf = raidFaction(w);
    if (!rf || pawns(w, rf.id).every((p) => p.downed)) return;
  }
}

describe('cover and holding out', () => {
  it('AI fighters move behind cover before they open fire', () => {
    const w = flatWorld(50, 40);
    w.tick = START_TICK + 8 * TICKS_PER_HOUR;
    w.factions.set(2, { id: 2, name: 'Raiders', color: 0x8a1c1c, home: { x: 5, y: 20 }, isPlayer: false });
    // A line of sandbags between them.
    for (let y = 14; y <= 26; y++) w.spawnBuilding('sandbags', w.map.idx(20, y), 2);
    const target = addPawn(w, 30, 20, 1);
    target.drafted = true;
    const shooter = addPawn(w, 12, 20, 2);
    shooter.weapon = 'bow';
    shooter.job = { type: 'attack', stage: 0, target: target.id, forced: true, chase: true, next: 0, until: 0 };
    run(w, 400);
    expect(coverAgainst(w, w.cellOf(target), w.cellOf(shooter))).toBeGreaterThanOrEqual(0.5);
  });

  it('outnumbered two to one, defenders behind embrasures do far better than in the open', () => {
    let fortStanding = 0;
    let openStanding = 0;
    let fortRaidersDown = 0;
    let openRaidersDown = 0;
    const seeds = [1, 2, 3, 4];
    for (const seed of seeds) {
      for (const fortified of [true, false]) {
        const { w, defenders, raiders } = holdout(fortified, seed);
        fight(w);
        const standing = defenders.filter((p) => w.get(p.id) && !p.downed).length;
        // Casualties: downed, or dead (gone without fleeing off the map).
        const rf = w.factions.get(raiders[0].faction)!;
        const down = (rf.raid?.dead ?? 0) + raiders.filter((p) => w.get(p.id) && p.downed).length;
        if (fortified) {
          fortStanding += standing;
          fortRaidersDown += down;
        } else {
          openStanding += standing;
          openRaidersDown += down;
        }
      }
    }
    // Last measured: 15 of 16 standing behind embrasures against 1 of 16 in the open, and
    // 9 raiders down against 2.
    expect(fortStanding).toBeGreaterThanOrEqual(seeds.length * 3);
    expect(fortStanding).toBeGreaterThan(openStanding * 3);
    expect(fortRaidersDown).toBeGreaterThan(openRaidersDown);
  });
});

describe('raid goals', () => {
  it("a raid that can't crack a fortified colony turns to loot what's outside the walls", () => {
    const { w } = holdout(true, 5);
    // Goods left out in an open stockpile.
    const z = w.createZone(2, 'stockpile');
    for (let x = 44; x < 50; x++) w.addZoneCell(z, w.map.idx(x, 50));
    w.placeItemNear('steel', 60, w.map.idx(46, 50));
    w.placeItemNear('gold', 10, w.map.idx(48, 50));
    const seen = new Set<string>();
    for (let t = 0; t < 20_000 && !seen.has('loot'); t += 250) {
      run(w, 250);
      const rf = raidFaction(w);
      if (rf?.raid?.goal) seen.add(rf.raid.goal);
    }
    expect(seen.has('loot')).toBe(true);
    expect(w.dirty.msgs.some((m) => m.faction === 2 && m.text.includes('turning to loot'))).toBe(true);
  });

  it('when the defenders crumble, a raid that had held back storms in', () => {
    const { w, defenders } = holdout(false, 6);
    const rf = raidFaction(w)!;
    rf.raid!.goal = 'siege';
    rf.raid!.goalSince = w.tick;
    for (const d of defenders) d.downed = true;
    run(w, 260);
    expect(rf.raid!.goal).toBe('assault');
    expect(w.dirty.msgs.some((m) => m.text.includes('storming in'))).toBe(true);
  });
});
