import { describe, expect, it } from 'vitest';
import {
  deserializeWorld,
  foundSettlement,
  goodwillOf,
  hashWorld,
  injure,
  killPawn,
  RARE_TICK,
  resolveChoice,
  serializeWorld,
  startRaid,
  storedOf,
  talkChance,
  takePrisoner,
  TICKS_PER_DAY,
  type Choice,
  type Faction,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { strike } from '../src/combat';
import { offerContract } from '../src/contracts';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const pawnsOf = (w: World, f: number) => [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === f);
const choice = (w: World, event: string): Choice | undefined => [...w.choices.values()].find((c) => c.event === event);
const tales = (w: World, f: number) => (w.factions.get(f)!.chronicle ?? []).map((t) => t.text).join('\n');
const goldNear = (w: World, x: number, y: number) =>
  [...w.kinds.item]
    .map((id) => w.get<Item>(id)!)
    .filter((it) => it.def === 'gold' && Math.hypot(it.x - x, it.y - y) < 8)
    .reduce((a, it) => a + it.count, 0);

function colonist(w: World, x: number, y: number, faction = 1): Pawn {
  const p = addPawn(w, x, y, faction);
  for (const k of Object.keys(p.priorities) as (keyof Pawn['priorities'])[]) p.priorities[k] = 0;
  return p;
}

/** Down a pawn with wounds that won't kill them outright. */
function knockDown(w: World, p: Pawn): void {
  for (let k = 0; k < 20 && !p.downed; k++) injure(w, p, 'bruise', 0.1);
}

/** A player colony (faction 1) at the middle of a flat map with two colonists and some steel in a stockpile. */
function colony(seed = 1): { w: World; a: Pawn; b: Pawn } {
  const w = flatWorld(60, 60, seed);
  const f = w.factions.get(1)!;
  f.isPlayer = true;
  f.home = { x: 30, y: 30 };
  w.story.nextCheck = Infinity;
  const a = colonist(w, 30, 30);
  const b = colonist(w, 31, 30);
  w.enqueue(1, { c: 'zone', kind: 'stockpile', x0: 26, y0: 26, x1: 28, y1: 28 });
  run(w, 1);
  for (let k = 0; k < 3; k++) w.placeItemNear('steel', 75, w.map.idx(27, 27));
  return { w, a, b };
}

/** A colony facing a chief who has stopped at the edge to demand tribute (the first seed where they do). */
function demanding(): { w: World; a: Pawn; b: Pawn; rf: Faction; raiders: Pawn[]; letter: Choice } {
  for (let seed = 1; seed < 40; seed++) {
    const c = colony(seed);
    const raiders = startRaid(c.w, 1, 260, 'raid');
    const rf = raiders && c.w.factions.get(raiders[0].faction);
    const letter = choice(c.w, 'raid_demand');
    if (raiders && rf?.raid?.parley && letter) return { ...c, rf, raiders, letter };
  }
  throw new Error('no raid stopped to demand tribute');
}

describe('raider chiefs and their demands', () => {
  it('a big raid rides behind a named chief, who stops at the edge and waits for an answer', () => {
    const { w, rf, raiders, letter } = demanding();
    const chief = raiders.find((p) => p.id === rf.raid!.chief)!;
    expect(chief.name).toMatch(/^\S+ the \S+$/);
    expect(rf.raid!.chiefName).toBe(chief.name);
    expect(chief.carrying?.def).toBe('gold');
    expect(letter.options.map((o) => o.key)).toEqual(['pay', 'talk', 'fight']);
    expect(letter.text).toContain(chief.name);
    const start = raiders.map((p) => w.cellOf(p));
    run(w, 1500);
    // Still waiting where they arrived, and nobody's been hurt.
    raiders.forEach((p, k) => expect(w.dist(w.cellOf(p), start[k])).toBeLessThan(4));
    expect(pawnsOf(w, 1).every((p) => !p.conditions.length)).toBe(true);
  });

  it('paying the tribute takes goods from the stockpile and sends them away', () => {
    const { w, rf } = demanding();
    const before = storedOf(w, 1, 'steel');
    resolveChoice(w, choice(w, 'raid_demand')!.id, 'pay', 1);
    expect(storedOf(w, 1, 'steel')).toBeLessThan(before);
    expect(rf.raid!.fled).toBe(true);
    expect(tales(w, 1)).toMatch(/Paid .* to leave the colony be/);
  });

  it('refusing, or attacking them while they wait, brings them in', () => {
    const one = demanding();
    resolveChoice(one.w, one.letter.id, 'fight', 1);
    expect(one.rf.raid!.parley).toBe(0);
    expect(one.rf.raid!.fled).toBe(false);
    const home = one.w.map.idx(30, 30);
    const d0 = Math.min(...one.raiders.map((p) => one.w.dist(one.w.cellOf(p), home)));
    run(one.w, 600);
    expect(Math.min(...pawnsOf(one.w, one.rf.id).map((p) => one.w.dist(one.w.cellOf(p), home)))).toBeLessThan(d0);

    const two = demanding();
    strike(two.w, two.a, two.raiders[0]);
    expect(two.rf.raid!.parley).toBe(0);
    expect(choice(two.w, 'raid_demand')).toBeUndefined();
  });

  it('a good talker may send them off; a failed talk brings them in at once', () => {
    expect(talkChance(0)).toBeCloseTo(0.15);
    expect(talkChance(20)).toBe(0.8);
    const { w, rf, letter, a, b } = demanding();
    const speaker = w.get<Pawn>(Number(w.choiceData.get(letter.id)!.speaker))!;
    expect([a.id, b.id]).toContain(speaker.id);
    resolveChoice(w, letter.id, 'talk', 1);
    expect(rf.raid!.parley).toBe(0);
    if (rf.raid!.fled) expect(tales(w, 1)).toContain('talked');
    else expect(w.factions.get(1)!.milestones ?? []).not.toContain('first_parley');
  });

  it('bringing down the chief breaks the band, which throws down what it carried', () => {
    const { w, rf, raiders, letter, a } = demanding();
    resolveChoice(w, letter.id, 'fight', 1);
    for (const p of raiders) if (p.id !== rf.raid!.chief) p.carrying = { def: 'cloth', count: 10, rot: 0 };
    const chief = w.get<Pawn>(rf.raid!.chief!)!;
    rf.raid!.chiefBy = a.id;
    knockDown(w, chief);
    expect(rf.raid!.fled).toBe(true);
    expect(raiders.filter((p) => p.id !== chief.id && !p.carrying).length).toBeGreaterThan(0);
    expect(tales(w, 1)).toContain(`Brought down ${chief.name}`);
    expect(tales(w, 1)).toContain(a.name);
    expect(w.factions.get(1)!.milestones).toContain('first_chief');
  });

  it('a chief takes less from each blow', () => {
    const { w, rf, raiders, a } = demanding();
    const chief = w.get<Pawn>(rf.raid!.chief!)!;
    const grunt = raiders.find((p) => p.id !== chief.id)!;
    a.weapon = 'club';
    const wounds = (p: Pawn) => p.conditions.reduce((s, c) => s + c.severity, 0);
    // Melee from next door, enough blows that the dice even out.
    for (let k = 0; k < 40; k++) {
      a.x = chief.x + 1;
      a.y = chief.y;
      strike(w, a, chief);
      a.x = grunt.x + 1;
      a.y = grunt.y;
      strike(w, a, grunt);
      for (const p of [chief, grunt]) p.conditions = p.conditions.map((c) => ({ ...c, severity: Math.min(c.severity, 0.2) }));
    }
    expect(wounds(chief)).toBeLessThanOrEqual(wounds(grunt));
  });
});

describe('prisoners are worth something', () => {
  function captive(withTown: boolean) {
    const { w, rf, raiders, letter, a } = demanding();
    resolveChoice(w, letter.id, 'fight', 1);
    let town: Faction | undefined;
    if (withTown) {
      town = foundSettlement(w, { x: 48, y: 48 }, 20, 3);
      town.settlement!.met.push(1);
    }
    const chief = w.get<Pawn>(rf.raid!.chief!)!;
    knockDown(w, chief);
    takePrisoner(w, chief, a);
    expect(chief.captive?.chief).toBe(true);
    chief.captive!.offerAt = w.tick + 5;
    runUntil(w, () => !!choice(w, 'ransom'), RARE_TICK * 3);
    return { w, chief, letter: choice(w, 'ransom')!, town, raiders };
  }

  it("a day or so later their band offers to buy them back: ransom pays gold and they walk away", () => {
    const { w, chief, letter } = captive(false);
    expect(letter.text).toContain(chief.name);
    expect(letter.options.map((o) => o.key)).toEqual(['ransom', 'keep']);
    const before = goldNear(w, 30, 30);
    resolveChoice(w, letter.id, 'ransom', 1);
    expect(chief.prisoner).toBe('leaving');
    // A chief fetches far more than a fighter.
    expect(goldNear(w, 30, 30) - before).toBeGreaterThanOrEqual(15);
    expect(tales(w, 1)).toMatch(/Ransomed .* for \d+ gold/);
  });

  it('or hand them to a town you know, for goodwill and a bounty; keeping them changes nothing', () => {
    const { w, chief, letter, town } = captive(true);
    expect(letter.options.map((o) => o.key)).toEqual(['ransom', 'handover', 'keep']);
    const gw = goodwillOf(town!.settlement!, 1);
    resolveChoice(w, letter.id, 'handover', 1);
    expect(goodwillOf(town!.settlement!, 1)).toBeGreaterThan(gw);
    expect(chief.prisoner).toBe('leaving');

    const other = captive(false);
    resolveChoice(other.w, other.letter.id, 'keep', 1);
    expect(other.chief.prisoner).toBe('held');
  });
});

describe('last stands', () => {
  it('the last colonist standing against two or more is called out, and told in the story if they live', () => {
    const { w, a, b } = colony();
    w.factions.set(2, { id: 2, name: 'Raiders of the Test', color: 0, home: { x: 5, y: 5 }, isPlayer: false, raid: { target: 1, size: 2, breakAt: 9, dead: 0, until: w.tick + TICKS_PER_DAY, fled: false } });
    const r1 = addPawn(w, 3, 3, 2);
    const r2 = addPawn(w, 4, 3, 2);
    knockDown(w, b);
    run(w, RARE_TICK * 2);
    expect(w.factions.get(2)!.raid!.lastStand?.[0]).toBe(a.id);
    killPawn(w, r1, 'test');
    killPawn(w, r2, 'test');
    expect(tales(w, 1)).toContain(`${a.name} held alone against 2 raiders.`);
    expect(w.factions.get(1)!.milestones).toContain('first_stand');
  });
});

describe('town jobs', () => {
  function withTown(seed = 3) {
    const w = flatWorld(90, 90, seed);
    w.story.nextCheck = Infinity;
    w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 10, y: 10 }, isPlayer: true });
    const me = colonist(w, 10, 10, 2);
    const town = foundSettlement(w, { x: 50, y: 50 }, 20, 4);
    town.settlement!.met.push(2);
    return { w, me, town };
  }

  function take(w: World, town: Faction, kind: 'wolves' | 'bandits') {
    expect(offerContract(w, town, 2)).toBe(true);
    const letter = choice(w, 'settlement_contract')!;
    expect(letter.text).toMatch(/cells (north|south|east|west)/);
    w.choiceData.get(letter.id)!.kind = kind;
    resolveChoice(w, letter.id, 'accept', 2);
    const job = town.settlement!.contracts![0];
    expect(job.kind).toBe(kind);
    return job;
  }

  it('clearing a wolf pack for a town pays its reward at home and raises goodwill', () => {
    const { w, town } = withTown();
    const job = take(w, town, 'wolves');
    const wolves = job.targets.map((id) => w.get<Pawn>(id)!);
    expect(wolves.length).toBeGreaterThanOrEqual(3);
    expect(wolves.every((p) => p.species === 'wolf')).toBe(true);
    const gw = goodwillOf(town.settlement!, 2);
    const before = [...w.kinds.item].length;
    for (const p of wolves) killPawn(w, p, 'test');
    run(w, RARE_TICK + 1);
    expect(town.settlement!.contracts).toEqual([]);
    expect(goodwillOf(town.settlement!, 2)).toBe(gw + 15);
    expect(tales(w, 2)).toContain(`Cleared a wolf pack for ${town.name}.`);
    expect(w.factions.get(2)!.milestones).toContain('first_contract');
    // The reward (and the carcasses) are on the map.
    expect([...w.kinds.item].length).toBeGreaterThan(before);
  });

  it('bandits hold their camp on a stash of stolen goods and go for anyone who comes close', () => {
    const { w, town, me } = withTown();
    const job = take(w, town, 'bandits');
    const bandits = job.targets.map((id) => w.get<Pawn>(id)!);
    const band = w.factions.get(bandits[0].faction)!;
    expect(band.raid!.goal).toBe('camp');
    expect(band.name).toMatch(/^Bandits of /);
    const camp = band.raid!.camp!;
    expect([...w.kinds.item].map((id) => w.get<Item>(id)!).some((it) => w.dist(w.cellOf(it), camp) < 4)).toBe(true);
    run(w, 3000);
    for (const p of bandits) expect(w.dist(w.cellOf(p), camp)).toBeLessThan(8);
    // Walk in close: they come for you.
    me.x = w.map.cx(camp) + 6;
    me.y = w.map.cy(camp);
    w.markDirty(me);
    runUntil(w, () => bandits.some((p) => p.job?.type === 'attack' && p.job.target === me.id), 600);
  });

  it("a job left undone costs goodwill, and the bandits move on; dealt with, it pays", () => {
    const a = withTown();
    const job = take(a.w, a.town, 'bandits');
    const gw = goodwillOf(a.town.settlement!, 2);
    job.until = a.w.tick + 1;
    run(a.w, RARE_TICK + 1);
    expect(a.town.settlement!.contracts).toEqual([]);
    expect(goodwillOf(a.town.settlement!, 2)).toBe(gw - 8);
    expect(a.w.factions.get(a.w.get<Pawn>(job.targets[0])!.faction)!.raid!.fled).toBe(true);

    const b = withTown();
    const job2 = take(b.w, b.town, 'bandits');
    const gw2 = goodwillOf(b.town.settlement!, 2);
    for (const id of job2.targets) killPawn(b.w, b.w.get<Pawn>(id)!, 'test');
    run(b.w, RARE_TICK + 1);
    expect(goodwillOf(b.town.settlement!, 2)).toBe(gw2 + 22);
    expect(tales(b.w, 2)).toMatch(/Broke up a bandit camp/);
  });

  it('jobs, chiefs and captives survive a save', () => {
    const { w, town } = withTown();
    take(w, town, 'bandits');
    const back = deserializeWorld(serializeWorld(w));
    expect(hashWorld(back)).toBe(hashWorld(w));
    run(w, 500);
    run(back, 500);
    expect(hashWorld(back)).toBe(hashWorld(w));
  });
});
