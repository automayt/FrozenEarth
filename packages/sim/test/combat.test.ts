import { describe, expect, it } from 'vitest';
import {
  addPlayerFaction,
  createWorld,
  deserializeWorld,
  fireEvent,
  hashWorld,
  hasCondition,
  hitChance,
  injure,
  inCover,
  lineOfSight,
  SAVE_VERSION,
  serializeWorld,
  startRaid,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type Pawn,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

function pawns(w: World, faction?: number): Pawn[] {
  return [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => faction === undefined || p.faction === faction);
}

/** Two rival (non-player, so the storyteller stays quiet) factions on a flat map. */
function duelWorld(): World {
  const w = flatWorld(40, 40);
  w.factions.set(2, { id: 2, name: 'Rivals', color: 0, home: { x: 30, y: 30 }, isPlayer: false });
  return w;
}

function armed(w: World, x: number, y: number, faction: number, weapon: string): Pawn {
  const p = addPawn(w, x, y, faction);
  p.weapon = weapon;
  p.priorities.doctor = 0;
  return p;
}

describe('drafting and attacks', () => {
  it('a drafted pawn kills a target on order', () => {
    const w = duelWorld();
    const a = armed(w, 5, 5, 1, 'rifle');
    const b = armed(w, 16, 5, 2, '');
    w.enqueue(1, { c: 'draft', pawns: [a.id], on: true });
    w.enqueue(1, { c: 'attack', pawns: [a.id], target: b.id });
    runUntil(w, () => !w.get(b.id), TICKS_PER_DAY);
    expect(w.get(a.id)).toBeTruthy();
    expect(w.dirty.msgs.some((m) => m.text.includes(`${b.name}`) && m.text.includes('died of wounds'))).toBe(true);
  });

  it('melee fighters walk up to their target', () => {
    const w = duelWorld();
    const a = armed(w, 5, 5, 1, 'knife');
    const b = armed(w, 20, 12, 2, '');
    b.priorities = { ...b.priorities, haul: 0 };
    w.enqueue(1, { c: 'draft', pawns: [a.id], on: true });
    w.enqueue(1, { c: 'attack', pawns: [a.id], target: b.id });
    runUntil(w, () => b.conditions.some((c) => c.key === 'cut'), TICKS_PER_HOUR * 4);
  });

  it('only drafted pawns of your own faction take orders', () => {
    const w = duelWorld();
    const a = armed(w, 5, 5, 1, 'rifle');
    const b = armed(w, 12, 5, 2, '');
    // Undrafted: the attack order is ignored.
    w.enqueue(1, { c: 'attack', pawns: [a.id], target: b.id });
    // Someone else's pawn: can't draft it or order it around.
    w.enqueue(2, { c: 'draft', pawns: [a.id], on: true });
    w.enqueue(2, { c: 'move', pawns: [a.id], x: 30, y: 30 });
    run(w, 600);
    expect(a.drafted).toBe(false);
    expect(b.conditions.length).toBe(0);
  });

  it('drafted pawns never open fire on another player by themselves', () => {
    const w = duelWorld();
    const a = armed(w, 5, 5, 1, 'rifle');
    const b = armed(w, 9, 5, 2, 'rifle');
    w.enqueue(1, { c: 'draft', pawns: [a.id], on: true });
    w.enqueue(2, { c: 'draft', pawns: [b.id], on: true });
    run(w, 2000);
    expect(a.conditions.length + b.conditions.length).toBe(0);
    expect(w.dirty.shots.length).toBe(0);
  });

  it('move orders send a drafted squad to a spot', () => {
    const w = duelWorld();
    const a = armed(w, 5, 5, 1, 'bow');
    const b = armed(w, 6, 5, 1, 'bow');
    w.enqueue(1, { c: 'draft', pawns: [a.id, b.id], on: true });
    w.enqueue(1, { c: 'move', pawns: [a.id, b.id], x: 20, y: 20 });
    runUntil(w, () => w.dist(w.cellOf(a), w.map.idx(20, 20)) <= 1 && w.dist(w.cellOf(b), w.map.idx(20, 20)) <= 1, 3000);
    expect(w.cellOf(a)).not.toBe(w.cellOf(b));
    // They hold there instead of wandering off to work.
    run(w, 1500);
    expect(w.dist(w.cellOf(a), w.map.idx(20, 20))).toBeLessThanOrEqual(1);
  });
});

describe('line of sight and cover', () => {
  it('walls and rock block shots, open ground does not', () => {
    const w = duelWorld();
    const from = w.map.idx(5, 5);
    const to = w.map.idx(15, 5);
    expect(lineOfSight(w, from, to)).toBe(true);
    w.spawnBuilding('stone_wall', w.map.idx(10, 5), 1);
    expect(lineOfSight(w, from, to)).toBe(false);
    w.setRock(w.map.idx(10, 8), 1);
    expect(lineOfSight(w, w.map.idx(5, 8), w.map.idx(15, 8))).toBe(false);
  });

  it('a wall next to the target on the shooter side gives cover', () => {
    const w = duelWorld();
    const a = armed(w, 5, 10, 1, 'rifle');
    const b = armed(w, 15, 10, 2, '');
    const open = hitChance(w, a, b);
    w.spawnBuilding('stone_wall', w.map.idx(14, 9), 1);
    expect(inCover(w, w.cellOf(a), w.cellOf(b))).toBe(true);
    expect(hitChance(w, a, b)).toBeLessThan(open);
    // Cover behind the target doesn't help.
    const w2 = duelWorld();
    const a2 = armed(w2, 5, 10, 1, 'rifle');
    const b2 = armed(w2, 15, 10, 2, '');
    w2.spawnBuilding('stone_wall', w2.map.idx(16, 10), 1);
    expect(inCover(w2, w2.cellOf(a2), w2.cellOf(b2))).toBe(false);
  });
});

describe('wounds', () => {
  it('bleeding without a doctor kills', () => {
    const w = duelWorld();
    const p = armed(w, 5, 5, 1, '');
    w.spawnItem('survival_meal', 20, w.map.idx(6, 6));
    injure(w, p, 'gunshot', 0.35);
    runUntil(w, () => hasCondition(p, 'blood_loss'), TICKS_PER_HOUR * 2);
    runUntil(w, () => !w.get(p.id), 2 * TICKS_PER_DAY);
    expect(w.dirty.msgs.some((m) => m.text.includes('died of blood loss'))).toBe(true);
  });

  it('heavy pain or blood loss knocks a pawn down', () => {
    const w = duelWorld();
    const p = armed(w, 5, 5, 1, '');
    injure(w, p, 'gunshot', 0.7);
    expect(p.downed).toBe(true);
    const at = w.cellOf(p);
    run(w, 600);
    expect(w.cellOf(p)).toBe(at);
  });

  it('a doctor tends wounds, the bleeding stops and the patient lives', () => {
    const w = duelWorld();
    const patient = armed(w, 5, 5, 1, '');
    const doc = armed(w, 8, 8, 1, '');
    doc.priorities.doctor = 1;
    w.spawnItem('survival_meal', 30, w.map.idx(10, 10));
    injure(w, patient, 'gunshot', 0.4);
    runUntil(w, () => patient.conditions.every((c) => c.key !== 'gunshot' || c.tended !== undefined), TICKS_PER_HOUR * 4);
    run(w, 3 * TICKS_PER_DAY);
    expect(w.get(patient.id)).toBeTruthy();
    expect(hasCondition(patient, 'gunshot')).toBe(false);
  });

  it('wounds adding up to 100% kill outright', () => {
    const w = duelWorld();
    const p = armed(w, 5, 5, 1, '');
    expect(injure(w, p, 'cut', 0.6)).toBe(true);
    expect(injure(w, p, 'bruise', 0.45)).toBe(false);
    expect(w.get(p.id)).toBeUndefined();
  });
});

describe('raids', () => {
  function colony(seed = 5): { w: World; f: number } {
    const w = createWorld({ seed, width: 100, height: 100, settlements: false });
    const f = addPlayerFaction(w, 'Target');
    return { w, f: f.id };
  }

  it('a raid event spawns raiders at the edge who reach the colony and attack', () => {
    const { w, f } = colony();
    w.story.threat[f] = 500;
    expect(fireEvent(w, 'raid', f)).toBe(true);
    const raiders = pawns(w).filter((p) => w.factions.get(p.faction)?.raid);
    expect(raiders.length).toBeGreaterThan(0);
    const home = w.factions.get(f)!.home;
    const homeCell = w.map.idx(home.x, home.y);
    // They start at the map edge...
    expect(raiders.every((r) => Math.min(r.x, r.y, w.map.w - 1 - r.x, w.map.h - 1 - r.y) <= 3)).toBe(true);
    // ...paid from the threat budget...
    expect(w.story.threat[f]).toBeLessThan(500);
    // ...and come for the colony.
    runUntil(
      w,
      () => raiders.some((r) => w.get(r.id) && w.dist(w.cellOf(r), homeCell) <= 12) || pawns(w, f).some((p) => p.conditions.some((c) => c.key === 'gunshot' || c.key === 'cut' || c.key === 'bruise')),
      TICKS_PER_DAY,
    );
  });

  it('richer colonies get bigger raids', () => {
    const poor = colony(9);
    const rich = colony(9);
    const home = rich.w.factions.get(rich.f)!.home;
    rich.w.enqueue(rich.f, { c: 'zone', kind: 'stockpile', x0: home.x - 4, y0: home.y - 4, x1: home.x + 4, y1: home.y + 4 });
    rich.w.applyCommands();
    rich.w.placeItemNear('gold', 400, rich.w.map.idx(home.x, home.y));
    poor.w.story.threat[poor.f] = 10_000;
    rich.w.story.threat[rich.f] = 10_000;
    const before = (w: World, f: number) => pawns(w).filter((p) => p.faction !== f).length;
    const p0 = before(poor.w, poor.f);
    const r0 = before(rich.w, rich.f);
    fireEvent(poor.w, 'raid', poor.f);
    fireEvent(rich.w, 'raid', rich.f);
    expect(before(rich.w, rich.f) - r0).toBeGreaterThan(before(poor.w, poor.f) - p0);
  });

  it('raiders flee once half of them are down', () => {
    const { w, f } = colony();
    const raiders = startRaid(w, f, 400, 'raid')!;
    expect(raiders.length).toBeGreaterThanOrEqual(2);
    const rf = w.factions.get(raiders[0].faction)!;
    const half = Math.ceil(raiders.length / 2);
    for (const r of raiders.slice(0, half)) injure(w, r, 'gunshot', 0.7);
    expect(rf.raid!.fled).toBe(true);
    const standing = raiders.slice(half);
    runUntil(w, () => standing.every((r) => !w.get(r.id)), TICKS_PER_DAY);
  });

  it('a night raid picked by day waits for dark', () => {
    const { w, f } = colony();
    w.story.threat[f] = 500;
    w.tick = Math.floor(w.tick / TICKS_PER_DAY) * TICKS_PER_DAY + 12 * TICKS_PER_HOUR;
    const before = pawns(w).length;
    expect(fireEvent(w, 'night_raid', f)).toBe(true);
    expect(pawns(w).length).toBe(before);
    runUntil(w, () => pawns(w).length > before, TICKS_PER_DAY);
    expect(w.isNight()).toBe(true);
    expect(pawns(w).filter((p) => p.faction !== f).every((p) => p.weapon === 'knife' || p.weapon === 'club')).toBe(true);
  });
});

describe('combat persistence', () => {
  it('a raid in progress saves, loads and continues identically', () => {
    const w = createWorld({ seed: 4, width: 100, height: 100 });
    const f = addPlayerFaction(w, 'Holdout');
    const colonists = pawns(w, f.id);
    w.enqueue(f.id, { c: 'draft', pawns: colonists.map((p) => p.id), on: true });
    startRaid(w, f.id, 300, 'raid');
    run(w, 3000);
    const b = deserializeWorld(serializeWorld(w));
    expect(hashWorld(b)).toBe(hashWorld(w));
    run(w, 4000);
    run(b, 4000);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });

  it('old saves gain weapons, draft state and the doctor work type', () => {
    const w = createWorld({ seed: 2, width: 60, height: 60 });
    addPlayerFaction(w, 'Old');
    const save = serializeWorld(w);
    save.version = 2;
    for (const e of save.ents) {
      if (e.kind !== 'pawn') continue;
      const old = e as Partial<Pawn>;
      delete old.weapon;
      delete old.drafted;
      delete old.downed;
      delete (old.priorities as Partial<Pawn['priorities']>).doctor;
    }
    const b = deserializeWorld(save);
    expect(SAVE_VERSION).toBeGreaterThanOrEqual(4);
    for (const p of pawns(b)) {
      expect(p.weapon).toBe('');
      expect(p.drafted).toBe(false);
      expect(p.priorities.doctor).toBe(2);
    }
    run(b, 500);
  });
});
