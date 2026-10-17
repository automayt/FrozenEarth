import { describe, expect, it } from 'vitest';
import { coverAgainst, foundSettlement, startRaid, START_TICK, TICKS_PER_HOUR, type Faction, type Pawn, type World } from '../src';
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

describe('towns holding out', () => {
  function town(seed: number, residents = 5) {
    const w = flatWorld(80, 80, seed);
    w.tick = START_TICK + 8 * TICKS_PER_HOUR;
    w.factions.set(2, { id: 2, name: 'Neighbours', color: 0x3a9ae0, home: { x: 10, y: 10 }, isPlayer: true });
    const s = foundSettlement(w, { x: 40, y: 40 }, 45, residents);
    s.settlement!.met.push(2);
    run(w, 260); // rooms
    return { w, s };
  }

  it('the gate opens for visitors but stays shut to raiders', () => {
    const { w, s } = town(1);
    const gate = w.map.idx(s.home.x, s.home.y + 3);
    expect(w.passable(gate, 2)).toBe(true);
    startRaid(w, s.id, 200, 'raid');
    const rf = raidFaction(w)!;
    expect(w.passable(gate, rf.id)).toBe(false);
  });

  it('guards man the firing slits when raiders come, and a garrisoned town holds out', () => {
    let held = 0;
    let manned = 0;
    for (const seed of [1, 2, 3, 4]) {
      const { w, s } = town(seed);
      startRaid(w, s.id, 260, 'raid');
      let sawPost = false;
      for (let t = 0; t < 20_000; t += 250) {
        run(w, 250);
        // Someone standing right behind an embrasure.
        for (const p of pawns(w, s.id)) {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const b = w.map.buildingAt[w.map.idx(p.x + dx, p.y + dy)];
            if (b && (w.get(b) as { def?: string })?.def === 'embrasure') sawPost = true;
          }
        }
        const rf = raidFaction(w);
        if (!rf || pawns(w, rf.id).every((p) => p.downed)) break;
      }
      if (sawPost) manned++;
      if (s.settlement!.state === 'home' && pawns(w, s.id).filter((p) => !p.downed).length >= 2) held++;
    }
    expect(manned).toBeGreaterThanOrEqual(3);
    expect(held).toBeGreaterThanOrEqual(3);
  });

  it('colonies that know the town hear of the attack, and those who help are thanked', () => {
    const { w, s } = town(7, 3);
    const raiders = startRaid(w, s.id, 220, 'raid')!;
    expect(w.dirty.msgs.some((m) => m.faction === 2 && m.text.includes(`attacking ${s.name}`))).toBe(true);
    // A rifleman of ours drafted between them and the town, picking raiders off as they come.
    const hx = Math.round((raiders[0].x + 40) / 2);
    const hy = Math.round((raiders[0].y + 40) / 2);
    const helper = addPawn(w, hx, hy, 2);
    helper.weapon = 'rifle';
    helper.drafted = true;
    const before = s.settlement!.goodwill[2] ?? s.settlement!.temper;
    for (let t = 0; t < 24_000 && pawns(w, raiders[0].faction).length; t += 500) run(w, 500);
    const rf = w.factions.get(raiders[0].faction)!;
    const helped = (rf.raid?.helpers?.[2] ?? 0) > 0 || (s.settlement!.goodwill[2] ?? before) > before;
    expect(helped).toBe(true);
    // Letters about someone else's fight talk about them, not "your colony".
    expect(w.dirty.msgs.filter((m) => m.faction === 2).some((m) => /your colony|your fields/.test(m.text))).toBe(false);
  });
});
