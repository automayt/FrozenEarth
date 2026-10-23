import { describe, expect, it } from 'vitest';
import { EVENTS } from '@fe/defs';
import { addPlayerFaction, createWorld, fireEvent, hasCondition, killPawn, resolveChoice, START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR, type Pawn, type World } from '../src';
import { OPENING, fireOrForeshadow } from '../src/opening';
import { bondOf, brawl, chemistry, CHILD_DAYS, exchange, FRIEND_AT, opinion, sleepTime, socialThoughts, socialTick, TALK } from '../src/social';
import { addPawn, flatWorld, run } from './helpers';

function colony(n = 2): { w: World; ps: Pawn[] } {
  const w = flatWorld(60, 60);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 30, y: 30 }, isPlayer: true });
  const ps: Pawn[] = [];
  for (let k = 0; k < n; k++) {
    const p = addPawn(w, 30 + k, 30, 2);
    p.name = ['Yara Crane', 'Bram Rook', 'Ilse Vale', 'Tova Drift'][k];
    p.traits = [];
    ps.push(p);
  }
  return { w, ps };
}

const msgs = (w: World) => w.dirty.msgs.map((m) => m.text);
const story = (w: World) => (w.factions.get(2)!.chronicle ?? []).map((t) => t.text);
const setOp = (p: Pawn, q: Pawn, v: number) => ((p.social ??= { op: {} }).op[q.id] = v);

describe('bonds between colonists', () => {
  it('chemistry is the same both ways and stays in range', () => {
    const { w, ps } = colony();
    const c = chemistry(w, ps[0].id, ps[1].id);
    expect(c).toBe(chemistry(w, ps[1].id, ps[0].id));
    expect(Math.abs(c)).toBeLessThanOrEqual(1);
  });

  it('colonists who spend the day near each other talk, and form opinions', () => {
    const { w, ps } = colony(3);
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      w.step();
      for (const p of ps) p.needs.food = 1;
    }
    const talked = ps.filter((p) => p.social?.talk);
    expect(talked.length).toBeGreaterThan(0);
    const [partner, kind, tick] = talked[0].social!.talk!;
    expect(ps.map((p) => p.id)).toContain(partner);
    expect(TALK[kind]).toBeTruthy();
    expect(tick).toBeGreaterThan(START_TICK);
    expect(Object.keys(ps[0].social!.op).length).toBeGreaterThan(0);
  });

  it('nobody talks in a town or a raiding party', () => {
    const w = flatWorld(40, 40);
    const a = addPawn(w, 10, 10);
    const b = addPawn(w, 11, 10);
    for (let k = 0; k < 400; k++) socialTick(w, a);
    expect(a.social).toBeUndefined();
    expect(b.social).toBeUndefined();
  });

  it('friends close by lift each other; a rival close by grates', () => {
    const { w, ps } = colony(3);
    const [a, b, c] = ps;
    setOp(a, b, 60);
    setOp(b, a, 60);
    setOp(a, c, -70);
    expect(bondOf(a, b)).toBe('friend');
    expect(bondOf(a, c)).toBe('rival');
    const th = socialThoughts(w, a).map(([l]) => l);
    expect(th).toContain('Near a friend');
    expect(th).toContain('Has to put up with Ilse');
  });

  it('becoming friends is news once, and goes in the story', () => {
    const { w, ps } = colony();
    const [a, b] = ps;
    setOp(a, b, FRIEND_AT - 0.5);
    setOp(b, a, FRIEND_AT - 0.5);
    exchange(w, a, b, 'comfort');
    exchange(w, b, a, 'comfort');
    exchange(w, a, b, 'comfort');
    expect(bondOf(a, b)).toBe('friend');
    expect(msgs(w).filter((t) => t.includes('have become friends')).length).toBe(1);
    expect(story(w)).toContain('Yara Crane and Bram Rook became friends.');
  });

  it('close friends who flirt fall in love; it is a milestone', () => {
    const { w, ps } = colony();
    const [a, b] = ps;
    setOp(a, b, 80);
    setOp(b, a, 80);
    expect(exchange(w, a, b, 'flirt')).toBe('love');
    expect(a.social!.love).toBe(b.id);
    expect(b.social!.love).toBe(a.id);
    expect(bondOf(a, b)).toBe('lover');
    expect(msgs(w)).toContain('Yara Crane and Bram Rook have fallen in love.');
    expect(w.factions.get(2)!.milestones).toContain('first_love');
    expect(socialThoughts(w, a).map(([l]) => l)).toContain('In love with Bram');
  });

  it('a brawl: punches, bruises, both sore, and a line in the story', () => {
    const { w, ps } = colony();
    const [a, b] = ps;
    brawl(w, a, b, ' over the last of the good meat');
    for (const p of [a, b]) {
      expect(hasCondition(p, 'brawled')).toBe(true);
      expect(hasCondition(p, 'bruise')).toBe(true);
    }
    expect(w.dirty.shots.length).toBe(16);
    expect(opinion(a, b.id)).toBeLessThan(0);
    expect(story(w).at(-1)).toBe('Yara Crane and Bram Rook came to blows over the last of the good meat.');
  });

  it("a lover's death breaks their heart; a friend's is grief on top of mourning", () => {
    const { w, ps } = colony(3);
    const [a, b, c] = ps;
    setOp(a, b, 80);
    setOp(b, a, 80);
    exchange(w, a, b, 'flirt');
    setOp(c, a, 60);
    setOp(a, c, 60);
    killPawn(w, a, 'wounds');
    expect(hasCondition(b, 'heartbroken')).toBe(true);
    expect(b.social!.love).toBeUndefined();
    expect(hasCondition(c, 'lost_friend')).toBe(true);
    expect(hasCondition(c, 'mourning')).toBe(true);
    expect(c.social!.op[a.id]).toBeUndefined();
    expect(story(w)).toContain('Bram Rook lost Yara Crane, the one they loved.');
  });

  it('lovers together a while may have a child, who grows up', () => {
    const { w, ps } = colony();
    const [a, b] = ps;
    setOp(a, b, 90);
    setOp(b, a, 90);
    exchange(w, a, b, 'flirt');
    a.social!.loveSince = b.social!.loveSince = w.tick - 4 * TICKS_PER_DAY;
    const lower = a.id < b.id ? a : b;
    let baby: Pawn | undefined;
    for (let k = 0; k < 50_000 && !baby; k++) {
      socialTick(w, lower);
      baby = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).find((p) => p.traits.includes('child'));
    }
    expect(baby).toBeDefined();
    expect(baby!.name.endsWith(lower.name.split(' ')[1])).toBe(true);
    expect(w.factions.get(2)!.milestones).toContain('first_birth');
    expect(hasCondition(a, 'newborn')).toBe(true);
    // Ten days on, a child is grown.
    baby!.social!.born = w.tick - CHILD_DAYS * TICKS_PER_DAY - 1;
    socialTick(w, baby!);
    expect(baby!.traits).not.toContain('child');
    expect(msgs(w).some((t) => t.includes(`${baby!.name} has grown up`))).toBe(true);
  });
});

describe('minds you can read', () => {
  it('warns once when someone is close to breaking, naming what weighs on them', () => {
    const { w, ps } = colony(1);
    const p = ps[0];
    p.needs.mood = 0.2;
    p.thoughts = ['Hungry -12', 'Sheltered +5', 'No bed -6', 'Cold -4'];
    socialTick(w, p);
    socialTick(w, p);
    const warn = msgs(w).filter((t) => t.includes('close to breaking'));
    expect(warn).toEqual(["Yara Crane is close to breaking. What's weighing on Yara: hungry, no bed, cold."]);
    // Once their mood recovers, a new low spell is news again.
    p.needs.mood = 0.5;
    socialTick(w, p);
    p.needs.mood = 0.2;
    socialTick(w, p);
    expect(msgs(w).filter((t) => t.includes('close to breaking')).length).toBe(2);
  });

  it('a Southerner downs tools rather than work outdoors in a freeze', () => {
    const { w, ps } = colony(1);
    const p = ps[0];
    p.traits = ['heat_lover'];
    w.coldOffset = -40;
    let struck = false;
    for (let k = 0; k < 200 && !struck; k++) {
      p.job = { type: 'mine', stage: 0, cell: w.map.idx(40, 40), progress: 0 };
      socialTick(w, p);
      struck = hasCondition(p, 'cold_strike');
    }
    expect(struck).toBe(true);
    expect(p.job).toBeNull();
    expect(msgs(w).some((t) => t.includes('refuses to work out in this cold'))).toBe(true);
  });

  it('night owls keep the opposite hours', () => {
    const { w, ps } = colony(2);
    ps[1].traits = ['night_owl'];
    w.tick = START_TICK + 18 * TICKS_PER_HOUR; // midnight
    expect(w.isNight()).toBe(true);
    expect(sleepTime(w, ps[0])).toBe(true);
    expect(sleepTime(w, ps[1])).toBe(false);
  });
});

describe('dramas you decide', () => {
  it('a quarrel: siding with one vindicates them and slights the other', () => {
    const { w, ps } = colony(2);
    expect(fireEvent(w, 'quarrel', 2)).toBe(true);
    const c = [...w.choices.values()].find((x) => x.event === 'quarrel')!;
    expect(c.options.map((o) => o.key)).toEqual(['a', 'b', 'leave']);
    resolveChoice(w, c.id, 'a', 2);
    const sided = ps.filter((p) => hasCondition(p, 'vindicated'));
    const slighted = ps.filter((p) => hasCondition(p, 'slighted'));
    expect(sided.length).toBe(1);
    expect(slighted.length).toBe(1);
    expect(opinion(slighted[0], sided[0].id)).toBeLessThan(0);
  });

  it('a feast costs food and lifts everyone', () => {
    const w = createWorld({ seed: 3, width: 100, height: 100, settlements: false, wildlife: false });
    const f = addPlayerFaction(w, 'North');
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', x0: f.home.x - 3, y0: f.home.y - 3, x1: f.home.x + 3, y1: f.home.y + 3 });
    run(w, 600);
    const meals = () => [...w.kinds.item].map((id) => w.get(id) as { def: string; count: number }).filter((i) => i.def === 'survival_meal').reduce((a, i) => a + i.count, 0);
    const before = meals();
    expect(fireEvent(w, 'feast', f.id)).toBe(true);
    const c = [...w.choices.values()].find((x) => x.event === 'feast')!;
    resolveChoice(w, c.id, 'feast', f.id);
    expect(meals()).toBeLessThan(before);
    const people = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === f.id);
    expect(people.every((p) => hasCondition(p, 'feasted'))).toBe(true);
  });
});

describe('the rhythm of play', () => {
  it('an omen: the warning now, the raid hours later', () => {
    const { w } = colony(2);
    const def = { ...EVENTS.raid, omen: { chance: 1, hours: [2, 3] as [number, number] } };
    expect(fireOrForeshadow(w, def, 2)).toBe(true);
    expect(msgs(w).some((t) => t.includes('Someone is watching the colony'))).toBe(true);
    const due = w.story.scheduled.find((e) => e.key === 'raid');
    expect(due?.faction).toBe(2);
    expect(due!.tick - w.tick).toBeGreaterThanOrEqual(2 * TICKS_PER_HOUR);
    expect([...w.factions.values()].some((f) => f.raid)).toBe(false);
    run(w, 3 * TICKS_PER_HOUR + 10);
    expect([...w.factions.values()].some((f) => f.raid?.target === 2)).toBe(true);
  });

  it('a new colony gets its opening beats in order', () => {
    const w = createWorld({ seed: 5, width: 120, height: 120, settlements: false, wildlife: false });
    const f = addPlayerFaction(w, 'North');
    expect(w.story.opening?.[f.id]).toEqual([w.tick, 0]);
    run(w, Math.ceil(OPENING[0][0] * TICKS_PER_DAY) + TICKS_PER_HOUR);
    expect(w.story.opening![f.id][1]).toBe(1);
    expect([...w.choices.values()].some((c) => c.faction === f.id && OPENING[0][1].includes(c.event))).toBe(true);
  });
});
