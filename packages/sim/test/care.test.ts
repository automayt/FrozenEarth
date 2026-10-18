import { describe, expect, it } from 'vitest';
import {
  damageBuilding,
  deserializeWorld,
  hashWorld,
  hoursToBleedOut,
  inBed,
  injure,
  RARE_TICK,
  SAVE_VERSION,
  serializeWorld,
  TICKS_PER_HOUR,
  type Building,
  type Pawn,
  type World,
} from '../src';
import { layInBed } from '../src/jobs';
import { careUrgency, CRITICAL, CRITICAL_BLEED_HOURS, ROUTINE, URGENT } from '../src/work';
import { addPawn, flatWorld, run, runUntil } from './helpers';

/** A flat map with a player colony (storyteller silenced). */
function careWorld(): World {
  const w = flatWorld(50, 50);
  w.factions.get(1)!.isPlayer = true;
  w.story.nextCheck = Infinity;
  return w;
}

function colonist(w: World, x: number, y: number): Pawn {
  const p = addPawn(w, x, y, 1);
  for (const k of Object.keys(p.priorities) as (keyof Pawn['priorities'])[]) p.priorities[k] = 0;
  return p;
}

/** A row of badly damaged walls: hours of repair work for anyone doing construction. */
function repairWork(w: World): Building[] {
  const walls: Building[] = [];
  for (let x = 30; x < 40; x++) {
    const b = w.spawnBuilding('wood_wall', w.map.idx(x, 40), 1);
    damageBuilding(w, b, 200);
    walls.push(b);
  }
  return walls;
}

/** Dressed wounds, so a patient stays down from pain without bleeding. */
function dress(p: Pawn): void {
  for (const c of p.conditions) if (c.key === 'gunshot') c.tended = 0.8;
}

/** Put a pawn to sleep in a bed for the night, the way findSleep would. */
function asleepInBed(w: World, p: Pawn, x: number, y: number): void {
  const bed = w.spawnBuilding('bed', w.map.idx(x, y), 1);
  bed.owner = p.id;
  p.bed = bed.id;
  p.x = x;
  p.y = y;
  p.job = { type: 'sleep', stage: 1, bed: bed.id, cell: w.cellOf(bed), rest: false };
  p.asleep = true;
  p.needs.rest = 0.2;
}

describe('urgent care', () => {
  it('rates patients by how soon they would die', () => {
    const w = careWorld();
    const a = colonist(w, 5, 5);
    injure(w, a, 'cut', 0.15);
    expect(careUrgency(w, a)).toBe(ROUTINE);
    const b = colonist(w, 7, 5);
    injure(w, b, 'gunshot', 0.5);
    expect(b.downed).toBe(false);
    expect(careUrgency(w, b)).toBe(URGENT);
    const c = colonist(w, 9, 5);
    injure(w, c, 'gunshot', 0.7);
    expect(hoursToBleedOut(c)).toBeLessThan(CRITICAL_BLEED_HOURS);
    expect(careUrgency(w, c)).toBe(CRITICAL);
    // Downed but dressed and in bed: nothing urgent left, until they starve.
    const d = colonist(w, 11, 5);
    layInBed(w, d, w.spawnBuilding('bed', w.map.idx(11, 6), 1));
    injure(w, d, 'gunshot', 0.7);
    dress(d);
    expect(d.downed).toBe(true);
    expect(careUrgency(w, d)).toBe(ROUTINE);
    d.needs.food = 0;
    expect(careUrgency(w, d)).toBe(URGENT);
  });

  it('a doctor drops higher-priority work to tend someone bleeding fast', () => {
    const w = careWorld();
    repairWork(w);
    const doc = colonist(w, 20, 20);
    doc.priorities.construct = 1;
    doc.priorities.doctor = 3;
    const patient = colonist(w, 10, 10);
    runUntil(w, () => doc.job?.type === 'repair', 600);
    // A slow bleed waits for the doctor to finish.
    injure(w, patient, 'cut', 0.15);
    run(w, RARE_TICK * 2);
    expect(doc.job?.type).toBe('repair');
    // A fast one doesn't.
    injure(w, patient, 'gunshot', 0.5);
    runUntil(w, () => doc.job?.type === 'tend', RARE_TICK + 10);
    runUntil(w, () => patient.conditions.every((c) => !c.key.match(/cut|gunshot/) || c.tended !== undefined), TICKS_PER_HOUR * 3);
  });

  it('the downed and bleeding are seen before work ranked above doctoring', () => {
    const w = careWorld();
    repairWork(w);
    const doc = colonist(w, 20, 20);
    doc.priorities.construct = 1;
    doc.priorities.doctor = 4;
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.7);
    expect(patient.downed).toBe(true);
    // Straight to the patient, not to the walls.
    runUntil(w, () => !!doc.job, 5);
    expect(doc.job?.type).toBe('tend');
  });

  it('never makes someone doctor whose doctor priority is off', () => {
    const w = careWorld();
    repairWork(w);
    const doc = colonist(w, 20, 20);
    doc.priorities.construct = 1;
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.7);
    for (let t = 0; t < RARE_TICK * 4; t++) {
      w.step();
      expect(doc.job?.type === 'tend' || doc.job?.type === 'rescue').toBe(false);
    }
  });

  it('wakes a sleeping doctor for a patient who will die within hours', () => {
    const w = careWorld();
    const doc = colonist(w, 20, 20);
    doc.priorities.doctor = 2;
    asleepInBed(w, doc, 20, 20);
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.7);
    runUntil(w, () => doc.job?.type === 'tend', RARE_TICK + 10);
    expect(doc.asleep).toBe(false);
    runUntil(w, () => patient.conditions.every((c) => c.key !== 'gunshot' || c.tended !== undefined), TICKS_PER_HOUR * 3);
  });

  it('lets a sleeping doctor sleep through anything less, or when someone else is up', () => {
    const w = careWorld();
    const doc = colonist(w, 20, 20);
    doc.priorities.doctor = 2;
    asleepInBed(w, doc, 20, 20);
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.5);
    run(w, RARE_TICK * 2);
    expect(doc.job?.type).toBe('sleep');
    expect(doc.asleep).toBe(true);

    // Critical now, but another doctor is awake and sees to it.
    const other = colonist(w, 30, 30);
    other.priorities.doctor = 3;
    injure(w, patient, 'gunshot', 0.2);
    expect(careUrgency(w, patient)).toBe(CRITICAL);
    runUntil(w, () => other.job?.type === 'tend', RARE_TICK + 10);
    expect(doc.asleep).toBe(true);
  });
});

describe('feeding patients', () => {
  it('a doctor brings a meal to a hungry downed colonist', () => {
    const w = careWorld();
    const patient = colonist(w, 12, 12);
    layInBed(w, patient, w.spawnBuilding('bed', w.map.idx(12, 12), 1));
    injure(w, patient, 'gunshot', 0.7);
    dress(patient);
    patient.needs.food = 0.1;
    const meal = w.spawnItem('simple_meal', 3, w.map.idx(25, 25));
    const doc = colonist(w, 20, 20);
    doc.priorities.doctor = 1;
    runUntil(w, () => doc.job?.type === 'feed', 60);
    expect(w.reservedByOther(meal.id * 8, 0)).toBe(true);
    runUntil(w, () => patient.needs.food > 0.9, TICKS_PER_HOUR * 2);
    expect(meal.count).toBe(2);
    expect(inBed(w, patient)).toBe(true);
    expect(patient.downed).toBe(true);
  });

  it('feeds a downed pawn lying where they fell when there is no bed', () => {
    const w = careWorld();
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.7);
    dress(patient);
    patient.needs.food = 0.2;
    w.spawnItem('potato', 30, w.map.idx(25, 25));
    const doc = colonist(w, 20, 20);
    doc.priorities.doctor = 1;
    const at = w.cellOf(patient);
    runUntil(w, () => patient.needs.food > 0.9, TICKS_PER_HOUR * 2);
    expect(w.cellOf(patient)).toBe(at);
  });

  it('a prisoner kept to bed is fed there', () => {
    const w = careWorld();
    const pris = colonist(w, 12, 12);
    pris.prisoner = 'held';
    pris.conditions.push({ key: 'blood_loss', severity: 0.5, immunity: 0, until: 0 });
    layInBed(w, pris, w.spawnBuilding('bed', w.map.idx(12, 12), 1));
    pris.needs.food = 0.2;
    w.spawnItem('simple_meal', 1, w.map.idx(25, 25));
    const warden = colonist(w, 20, 20);
    warden.priorities.doctor = 2;
    runUntil(w, () => pris.needs.food > 0.9, TICKS_PER_HOUR * 2);
    expect(inBed(w, pris)).toBe(true);
  });

  it('only one feeder per patient, and nobody feeds those who can feed themselves', () => {
    const w = careWorld();
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.7);
    dress(patient);
    patient.needs.food = 0.2;
    const up = colonist(w, 14, 14);
    up.needs.food = 0.2;
    // Separate stacks: whoever eats or fetches from one holds it.
    w.spawnItem('simple_meal', 5, w.map.idx(25, 25));
    w.spawnItem('simple_meal', 5, w.map.idx(30, 25));
    w.spawnItem('simple_meal', 5, w.map.idx(35, 25));
    const a = colonist(w, 20, 20);
    const b = colonist(w, 21, 20);
    a.priorities.doctor = 1;
    b.priorities.doctor = 1;
    run(w, 5);
    const feeding = [a, b].filter((d) => d.job?.type === 'feed');
    expect(feeding.length).toBe(1);
    expect(feeding[0].job?.type === 'feed' && feeding[0].job.patient).toBe(patient.id);
  });

  it('stays deterministic across a save mid-feed', () => {
    const w = careWorld();
    const patient = colonist(w, 12, 12);
    injure(w, patient, 'gunshot', 0.7);
    dress(patient);
    patient.needs.food = 0.1;
    w.spawnItem('simple_meal', 2, w.map.idx(25, 25));
    w.spawnItem('potato', 20, w.map.idx(5, 30));
    const doc = colonist(w, 20, 20);
    doc.priorities.doctor = 1;
    runUntil(w, () => doc.job?.type === 'feed' && doc.job.stage === 1, TICKS_PER_HOUR);
    const save = serializeWorld(w);
    expect(save.version).toBe(SAVE_VERSION);
    const b = deserializeWorld(save);
    run(w, 2000);
    run(b, 2000);
    expect(hashWorld(b)).toBe(hashWorld(w));
    expect(patient.needs.food).toBeGreaterThan(0.9);
  });
});

describe('save format 5', () => {
  it('version 4 saves still load', () => {
    const w = careWorld();
    colonist(w, 10, 10);
    const save = serializeWorld(w);
    save.version = 4;
    const b = deserializeWorld(save);
    expect(SAVE_VERSION).toBe(7);
    run(b, 300);
  });
});

describe('letters about conditions', () => {
  it("blood loss wavering across a stage is reported once, not every time it crosses back", () => {
    const w = flatWorld(30, 30);
    const p = addPawn(w, 10, 10);
    p.priorities.doctor = 0;
    // A bleeding cut, and blood loss just under 'severe'.
    p.conditions.push({ key: 'cut', severity: 0.3, immunity: 0, until: 0 });
    p.conditions.push({ key: 'blood_loss', severity: 0.39, immunity: 0, until: 0 });
    const count = () => w.dirty.msgs.filter((m) => m.text.includes('blood loss (severe)')).length;
    for (let k = 0; k < 4; k++) {
      // Crosses into severe, then gets pushed back under (as tending and reopening would).
      run(w, 600);
      const bl = p.conditions.find((c) => c.key === 'blood_loss');
      if (!bl || !w.get(p.id)) break;
      bl.severity = 0.39;
    }
    expect(count()).toBe(1);
  });
});
