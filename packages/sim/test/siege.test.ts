import { describe, expect, it } from 'vitest';
import { maxHp } from '@fe/defs';
import {
  addPlayerFaction,
  createWorld,
  damageBuilding,
  deserializeWorld,
  fireEvent,
  hashWorld,
  inBed,
  injure,
  SAVE_VERSION,
  serializeWorld,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type Building,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { layInBed } from '../src/jobs';
import { prisonerTick } from '../src/raids';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const RAIDERS = 2;

/** A flat map where faction 1 is a player colony (storyteller silenced) and faction 2 is raiding it. */
function siegeWorld(sapper = false): World {
  const w = flatWorld(50, 50);
  w.factions.get(1)!.isPlayer = true;
  w.story.nextCheck = Infinity;
  w.factions.set(RAIDERS, {
    id: RAIDERS,
    name: 'Raiders of the Test',
    color: 0,
    home: { x: 25, y: 25 },
    isPlayer: false,
    raid: { target: 1, size: 1, breakAt: 5, dead: 0, until: w.tick + 5 * TICKS_PER_DAY, fled: false, sapper },
  });
  return w;
}

function colonist(w: World, x: number, y: number): Pawn {
  const p = addPawn(w, x, y, 1);
  for (const k of Object.keys(p.priorities) as (keyof Pawn['priorities'])[]) p.priorities[k] = 0;
  return p;
}

function raider(w: World, x: number, y: number, weapon = 'club'): Pawn {
  const p = addPawn(w, x, y, RAIDERS);
  p.weapon = weapon;
  return p;
}

/** A hollow box of walls from (x0,y0) to (x1,y1), built and owned by faction 1, with optional door. */
function box(w: World, x0: number, y0: number, x1: number, y1: number, door?: [number, number]): Building[] {
  const out: Building[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
      const isDoor = door && door[0] === x && door[1] === y;
      out.push(w.spawnBuilding(isDoor ? 'door' : 'wood_wall', w.map.idx(x, y), 1));
    }
  }
  return out;
}

function hurt(p: Pawn): boolean {
  return p.conditions.some((c) => c.key === 'bruise' || c.key === 'cut' || c.key === 'gunshot');
}

describe('raiders break in', () => {
  it('a raider who cannot walk to anyone smashes through a wall or door', () => {
    const w = siegeWorld();
    const walls = box(w, 22, 22, 28, 28, [25, 22]);
    const c = colonist(w, 25, 25);
    w.enqueue(1, { c: 'draft', pawns: [c.id], on: true });
    const r = raider(w, 5, 25);
    runUntil(w, () => r.job?.type === 'bash', 600);
    runUntil(w, () => walls.some((b) => !w.get(b.id)), TICKS_PER_DAY / 2);
    expect(w.dirty.msgs.some((m) => m.faction === 1 && m.text.includes('smashed through'))).toBe(true);
    // Through the gap and on to the colonist.
    runUntil(w, () => hurt(c), TICKS_PER_DAY / 2);
  });

  it('wrecked buildings open their cell and leave some scrap', () => {
    const w = siegeWorld();
    const cell = w.map.idx(10, 10);
    const b = w.spawnBuilding('wood_wall', cell, 1);
    expect(w.map.solid[cell]).toBe(1);
    expect(damageBuilding(w, b, 50)).toBe(false);
    expect(b.hp).toBe(maxHp('wood_wall') - 50);
    expect(damageBuilding(w, b, 1000)).toBe(true);
    expect(w.get(b.id)).toBeUndefined();
    expect(w.map.solid[cell]).toBe(0);
    expect(w.map.itemAt[cell]).not.toBe(0);
  });

  it('ordinary raiders leave rock alone, sappers dig through it', () => {
    for (const sapper of [false, true]) {
      const w = siegeWorld(sapper);
      // A colonist sealed in a pocket inside solid rock.
      for (let y = 18; y <= 32; y++) for (let x = 18; x <= 32; x++) w.setRock(w.map.idx(x, y), 1);
      w.setRock(w.map.idx(25, 25), 0);
      const c = colonist(w, 25, 25);
      const r = raider(w, 5, 25);
      if (!sapper) {
        run(w, TICKS_PER_HOUR * 3);
        expect(hurt(c)).toBe(false);
        expect(r.job?.type).not.toBe('bash');
        continue;
      }
      runUntil(w, () => r.job?.type === 'bash', 600);
      runUntil(w, () => hurt(c), TICKS_PER_DAY * 2);
      expect(w.map.rock[w.map.idx(18, 25)]).toBe(0);
    }
  });

  it('colonists repair damaged buildings', () => {
    const w = siegeWorld();
    const b = w.spawnBuilding('stone_wall', w.map.idx(12, 12), 1);
    damageBuilding(w, b, 300);
    expect(w.damaged.has(b.id)).toBe(true);
    const c = colonist(w, 8, 8);
    c.priorities.construct = 1;
    runUntil(w, () => b.hp === maxHp('stone_wall'), TICKS_PER_DAY / 2);
    expect(w.damaged.has(b.id)).toBe(false);
  });

  it('a sapper raid event sends diggers', () => {
    const w = createWorld({ seed: 5, width: 100, height: 100 });
    const f = addPlayerFaction(w, 'Target');
    w.story.threat[f.id] = 500;
    expect(fireEvent(w, 'sapper_raid', f.id)).toBe(true);
    const raid = [...w.factions.values()].find((x) => x.raid);
    expect(raid?.raid?.sapper).toBe(true);
  });

  it('a siege saves, loads and continues identically', () => {
    const w = siegeWorld();
    box(w, 22, 22, 28, 28, [25, 22]);
    const c = colonist(w, 25, 25);
    w.enqueue(1, { c: 'draft', pawns: [c.id], on: true });
    raider(w, 5, 25);
    raider(w, 5, 30, 'knife');
    run(w, 900);
    const b = deserializeWorld(serializeWorld(w));
    expect(hashWorld(b)).toBe(hashWorld(w));
    run(w, 3000);
    run(b, 3000);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });
});

describe('rescue and capture', () => {
  it('a doctor carries a downed colony-mate to a bed', () => {
    const w = siegeWorld();
    const bed = w.spawnBuilding('bed', w.map.idx(20, 20), 1);
    const patient = colonist(w, 5, 5);
    const doc = colonist(w, 10, 10);
    doc.priorities.doctor = 1;
    injure(w, patient, 'gunshot', 0.7);
    expect(patient.downed).toBe(true);
    runUntil(w, () => inBed(w, patient), TICKS_PER_HOUR * 2);
    expect(w.cellOf(patient)).toBe(w.cellOf(bed));
    expect(bed.owner).toBe(patient.id);
    // Then patches them up there.
    runUntil(w, () => patient.conditions.every((c) => c.key !== 'gunshot' || c.tended !== undefined), TICKS_PER_HOUR * 2);
  });

  it('a pawn who collapses in bed stays in it', () => {
    const w = siegeWorld();
    const p = colonist(w, 5, 5);
    const bed = w.spawnBuilding('bed', w.map.idx(6, 6), 1);
    layInBed(w, p, bed);
    injure(w, p, 'gunshot', 0.7);
    expect(p.downed).toBe(true);
    expect(inBed(w, p)).toBe(true);
  });

  it('with no bed, the doctor tends a downed pawn where they lie', () => {
    const w = siegeWorld();
    const patient = colonist(w, 5, 5);
    const doc = colonist(w, 10, 10);
    doc.priorities.doctor = 1;
    injure(w, patient, 'gunshot', 0.7);
    const at = w.cellOf(patient);
    runUntil(w, () => patient.conditions.every((c) => c.key !== 'gunshot' || c.tended !== undefined), TICKS_PER_HOUR * 2);
    expect(w.cellOf(patient)).toBe(at);
  });

  it('doctors see patients in bed before nearer ones', () => {
    const w = siegeWorld();
    const doc = colonist(w, 10, 10);
    doc.priorities.doctor = 1;
    const near = colonist(w, 13, 10);
    injure(w, near, 'cut', 0.15);
    const far = colonist(w, 25, 10);
    layInBed(w, far, w.spawnBuilding('bed', w.map.idx(25, 10), 1));
    injure(w, far, 'cut', 0.15);
    runUntil(w, () => doc.job?.type === 'tend', 100);
    expect(doc.job?.type === 'tend' && doc.job.patient).toBe(far.id);
  });

  it('colonists capture a downed raider and hold them prisoner', () => {
    const w = siegeWorld();
    const bed = w.spawnBuilding('bed', w.map.idx(20, 20), 1);
    const c = colonist(w, 10, 10);
    const r = raider(w, 14, 14, 'rifle');
    injure(w, r, 'gunshot', 0.7);
    expect(r.downed).toBe(true);
    expect(r.weapon).toBe('');
    // The rifle fell where they went down.
    const dropped = w.get<Item>(w.map.itemAt[w.cellOf(r)])!;
    expect(dropped.def).toBe('rifle');
    w.enqueue(1, { c: 'capture', pawns: [c.id], target: r.id });
    runUntil(w, () => r.prisoner === 'held', TICKS_PER_HOUR * 2);
    expect(r.faction).toBe(1);
    expect(w.cellOf(r)).toBe(w.cellOf(bed));
    expect(Object.values(r.priorities).every((v) => v === 0)).toBe(true);
    // Prisoners can't be drafted or ordered about.
    w.enqueue(1, { c: 'draft', pawns: [r.id], on: true });
    w.applyCommands();
    expect(r.drafted).toBe(false);
  });

  it('a prisoner may join; a released one walks off the map', () => {
    const w = siegeWorld();
    const keep = colonist(w, 10, 10);
    keep.prisoner = 'held';
    for (let k = 0; k < 20_000 && keep.prisoner; k++) prisonerTick(w, keep);
    expect(keep.prisoner).toBe('');
    expect(keep.priorities.haul).toBeGreaterThan(0);

    const go = colonist(w, 20, 20);
    go.prisoner = 'held';
    w.enqueue(1, { c: 'release', pawn: go.id });
    runUntil(w, () => !w.get(go.id), TICKS_PER_DAY / 2);
  });

  it('only downed raiders can be captured', () => {
    const w = siegeWorld();
    w.spawnBuilding('bed', w.map.idx(20, 20), 1);
    const c = colonist(w, 10, 10);
    const r = raider(w, 14, 14);
    const mate = colonist(w, 12, 12);
    injure(w, mate, 'gunshot', 0.7);
    w.enqueue(1, { c: 'capture', pawns: [c.id], target: r.id });
    w.enqueue(1, { c: 'capture', pawns: [c.id], target: mate.id });
    w.applyCommands();
    expect(c.job?.type === 'rescue').toBe(false);
  });
});

describe('weapons as items', () => {
  it('the dead drop their weapon', () => {
    const w = siegeWorld();
    const r = raider(w, 10, 10, 'bow');
    const cell = w.cellOf(r);
    injure(w, r, 'cut', 0.3);
    expect(injure(w, r, 'gunshot', 0.8)).toBe(false);
    const items = [...w.kinds.item].map((id) => w.get<Item>(id)!);
    expect(items.some((it) => it.def === 'bow' && w.dist(w.cellOf(it), cell) <= 1)).toBe(true);
  });

  it('a colonist picks up a weapon on order, dropping the old one, and can drop it again', () => {
    const w = siegeWorld();
    const c = colonist(w, 5, 5);
    c.weapon = 'club';
    const rifle = w.spawnItem('rifle', 1, w.map.idx(12, 5));
    w.enqueue(1, { c: 'equip', pawn: c.id, item: rifle.id });
    runUntil(w, () => c.weapon === 'rifle', 600);
    expect(w.get(rifle.id)).toBeUndefined();
    const club = w.get<Item>(w.map.itemAt[w.cellOf(c)]);
    expect(club?.def).toBe('club');
    w.enqueue(1, { c: 'equip', pawn: c.id, item: 0 });
    runUntil(w, () => c.weapon === '', 10);
    expect([...w.kinds.item].some((id) => w.get<Item>(id)!.def === 'rifle')).toBe(true);
  });

  it("can't equip non-weapons or weapons in another colony's stockpile", () => {
    const w = siegeWorld();
    w.factions.set(3, { id: 3, name: 'Neighbours', color: 0, home: { x: 40, y: 40 }, isPlayer: false });
    const c = colonist(w, 5, 5);
    const wood = w.spawnItem('wood', 10, w.map.idx(8, 8));
    w.enqueue(3, { c: 'zone', kind: 'stockpile', x0: 30, y0: 30, x1: 32, y1: 32 });
    w.applyCommands();
    const theirs = w.spawnItem('knife', 1, w.map.idx(31, 31));
    w.enqueue(1, { c: 'equip', pawn: c.id, item: wood.id });
    w.enqueue(1, { c: 'equip', pawn: c.id, item: theirs.id });
    w.applyCommands();
    expect(c.job?.type === 'equip').toBe(false);
  });

  it('the workbench makes weapons, and stockpiles take them', () => {
    const w = siegeWorld();
    const bench = w.spawnBuilding('workbench', w.map.idx(10, 10), 1);
    w.spawnItem('steel', 40, w.map.idx(12, 12));
    w.enqueue(1, { c: 'zone', kind: 'stockpile', x0: 2, y0: 2, x1: 4, y1: 4 });
    w.enqueue(1, { c: 'addBill', bench: bench.id, recipe: 'make_knife', mode: 'count', target: 1 });
    const c = colonist(w, 8, 8);
    c.priorities.craft = 1;
    c.priorities.haul = 2;
    runUntil(w, () => [...w.kinds.item].some((id) => w.get<Item>(id)!.def === 'knife'), TICKS_PER_DAY / 2);
    runUntil(w, () => [...w.kinds.item].some((id) => {
      const it = w.get<Item>(id)!;
      return it.def === 'knife' && w.zoneAt(w.cellOf(it))?.kind === 'stockpile';
    }), TICKS_PER_DAY / 4);
  });
});

describe('save format 4', () => {
  it('old saves gain building hit points, prisoner state and weapon stockpiling', () => {
    const w = createWorld({ seed: 3, width: 60, height: 60 });
    const f = addPlayerFaction(w, 'Old');
    const home = f.home;
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', x0: home.x - 1, y0: home.y - 1, x1: home.x + 1, y1: home.y + 1 });
    w.applyCommands();
    w.spawnBuilding('wood_wall', w.map.idx(home.x + 4, home.y + 4), f.id);
    const save = serializeWorld(w);
    save.version = 3;
    for (const e of save.ents) {
      if (e.kind === 'building') delete (e as Partial<Building>).hp;
      if (e.kind === 'pawn') delete (e as Partial<Pawn>).prisoner;
    }
    for (const z of save.zones) z.allow = z.allow.filter((a) => a !== 'weapon');
    const b = deserializeWorld(save);
    expect(SAVE_VERSION).toBe(4);
    for (const id of b.kinds.building) {
      const bd = b.get<Building>(id)!;
      expect(bd.hp).toBe(maxHp(bd.def));
    }
    for (const id of b.kinds.pawn) expect(b.get<Pawn>(id)!.prisoner).toBe('');
    for (const z of b.zones.values()) if (z.kind === 'stockpile') expect(z.allow).toContain('weapon');
    expect(b.damaged.size).toBe(0);
    run(b, 300);
  });
});
