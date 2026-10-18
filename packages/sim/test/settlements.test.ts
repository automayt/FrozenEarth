import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '@fe/defs';
import {
  askForHelp,
  createWorld,
  resolveChoice,
  storedOf,
  deserializeWorld,
  dispositionOf,
  foundSettlement,
  frostDistance,
  frostLevel,
  frostRadius,
  hashWorld,
  hostile,
  killPawn,
  serializeWorld,
  siteProblem,
  START_TICK,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type Building,
  type Faction,
  type Item,
  type Pawn,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

const residents = (w: World, f: number) => [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === f);
const buildings = (w: World, f: number) => [...w.kinds.building].map((id) => w.get<Building>(id)!).filter((b) => b.faction === f);
const stock = (w: World, f: number, def: string) => {
  let n = 0;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (it.def === def && z?.faction === f) n += it.count;
  }
  return n;
};

/** A flat world with one player colony (faction 2) and a settlement of the given temper at (40, 40). */
function withSettlement(temper: number): { w: World; s: Faction; player: number } {
  const w = flatWorld(80, 80);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 10, y: 10 }, isPlayer: true });
  const s = foundSettlement(w, { x: 40, y: 40 }, temper, 4);
  return { w, s, player: 2 };
}

describe('settlements', () => {
  it('are founded toward the center with walls, beds, a fire, stores and armed residents', () => {
    const w = createWorld({ seed: 21, width: 200, height: 200 });
    const all = [...w.factions.values()].filter((f) => f.settlement);
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const f of all) {
      expect(frostDistance(f.home.x, f.home.y, 200, 200)).toBeLessThan(0.75);
      const defs = buildings(w, f.id).map((b) => b.def);
      expect(defs).toContain('door');
      expect(defs).toContain('campfire');
      expect(defs.filter((d) => d === 'bed').length).toBe(residents(w, f.id).length);
      expect(defs.filter((d) => BUILDINGS[d].wall).length).toBeGreaterThan(20);
      expect(residents(w, f.id).every((p) => p.weapon)).toBe(true);
      expect(stock(w, f.id, 'steel')).toBeGreaterThan(0);
      // Nobody can found a colony on their doorstep.
      expect(siteProblem(w, f.home.x + 5, f.home.y)).toMatch(/Too close|open/);
    }
    // Their people stay home and stay alive, sleep at night and get up in the morning.
    const before = all.map((f) => residents(w, f.id).length);
    run(w, 2 * TICKS_PER_DAY);
    run(w, 6 * TICKS_PER_HOUR);
    const people = all.flatMap((f) => residents(w, f.id));
    expect(people.filter((p) => p.asleep).length).toBeLessThan(people.length / 4);
    all.forEach((f, k) => {
      const people = residents(w, f.id);
      expect(people.length).toBe(before[k]);
      for (const p of people) expect(Math.hypot(p.x - f.home.x, p.y - f.home.y)).toBeLessThan(20);
    });
  });

  it('hostile guards attack colonists who come close; friendly ones leave them be', () => {
    for (const [temper, fights] of [
      [-60, true],
      [45, false],
    ] as const) {
      const { w, s, player } = withSettlement(temper);
      const visitor = addPawn(w, 40, 50, player);
      expect(hostile(w, s.id, player)).toBe(fights);
      // (The visitor, not drafted, runs for it once they come at them.)
      let attacked = false;
      let ran = false;
      for (let t = 0; t < 600; t++) {
        w.step();
        attacked ||= residents(w, s.id).some((p) => p.job?.type === 'attack' && p.job.target === visitor.id);
        ran ||= visitor.job?.type === 'shelter';
      }
      expect(attacked).toBe(fights);
      expect(ran).toBe(fights);
    }
  });

  it("haulers don't walk onto hostile land for loose items", () => {
    const { w, player } = withSettlement(-60);
    const z = w.createZone(player, 'stockpile');
    for (let x = 4; x < 12; x++) w.addZoneCell(z, w.map.idx(x, 12));
    const hauler = addPawn(w, 10, 14, player);
    w.placeItemNear('steel', 20, w.map.idx(40, 50));
    run(w, 600);
    expect(hauler.job?.type).not.toBe('haul');
    expect(Math.hypot(hauler.x - 40, hauler.y - 40)).toBeGreaterThan(20);
  });

  it('turn hostile when your colonists attack them', () => {
    const { w, s, player } = withSettlement(0);
    expect(dispositionOf(s.settlement!, player)).toBe('wary');
    const shooter = addPawn(w, 40, 48, player);
    shooter.weapon = 'rifle';
    const target = residents(w, s.id)[0];
    // Out in the open, in front of the gate.
    target.x = 40;
    target.y = 45;
    target.path = null;
    w.enqueue(player, { c: 'draft', pawns: [shooter.id], on: true });
    run(w, 1);
    w.enqueue(player, { c: 'attack', pawns: [shooter.id], target: target.id });
    run(w, 900);
    expect(dispositionOf(s.settlement!, player)).toBe('hostile');
    expect(w.dirty.msgs.some((m) => m.text.includes('considers you enemies'))).toBe(true);
  });

  it('trade only with a colonist on hand, at their price, and like you more for it', () => {
    const { w, s, player } = withSettlement(0);
    const z = w.createZone(player, 'stockpile');
    for (let x = 8; x < 14; x++) w.addZoneCell(z, w.map.idx(x, 12));
    w.placeItemNear('gold', 30, w.map.idx(10, 12));
    const steel = stock(w, s.id, 'steel');
    const want: [string, number][] = [['steel', 10]];
    // Nobody there yet.
    w.enqueue(player, { c: 'settlementTrade', settlement: s.id, give: [['gold', 3]], want });
    run(w, 2);
    expect(stock(w, s.id, 'steel')).toBe(steel);
    expect(w.dirty.msgs.at(-1)!.text).toMatch(/Send a colonist/);
    // A refusal answers the command, so the client can show it right away rather than as news.
    expect(w.dirty.msgs.at(-1)!.reply).toBe(true);
    addPawn(w, 40, 47, player);
    // 1 gold (10) for 10 steel (19): not enough.
    w.enqueue(player, { c: 'settlementTrade', settlement: s.id, give: [['gold', 1]], want });
    run(w, 2);
    expect(stock(w, s.id, 'steel')).toBe(steel);
    // 3 gold (30) covers 19 x 1.5.
    w.enqueue(player, { c: 'settlementTrade', settlement: s.id, give: [['gold', 3]], want });
    run(w, 2);
    expect(stock(w, s.id, 'steel')).toBe(steel - 10);
    expect(stock(w, s.id, 'gold')).toBeGreaterThanOrEqual(3);
    expect(s.settlement!.goodwill[player]).toBeGreaterThan(0);
    expect(w.dirty.msgs.find((m) => m.text.startsWith('Trade done'))?.reply).toBe(true);
    // News from the world in the same tick is not a reply.
    w.message(player, 'Something happened.');
    expect(w.dirty.msgs.at(-1)!.reply).toBeUndefined();
  });

  it('flee inward when the frost arrives, leaving their old home to anyone', () => {
    // A seed whose outermost settlement has room to move inward (about 1 in 4 maps has none, old and new map gen alike).
    const w = createWorld({ seed: 22, width: 200, height: 200 });
    const f = [...w.factions.values()].filter((x) => x.settlement).sort((a, b) => frostDistance(b.home.x, b.home.y, 200, 200) - frostDistance(a.home.x, a.home.y, 200, 200))[0];
    const old = { ...f.home };
    const oldBuildings = buildings(w, f.id).map((b) => b.id);
    w.frost = { ...w.frost, startDay: 0, pace: 6 };
    // Skip the quiet days (nothing happens there until the frost is close), stopping a day short.
    const home = w.map.idx(f.home.x, f.home.y);
    const bite = (tick: number) => frostLevel(f.home.x, f.home.y, 200, 200, frostRadius(tick, w.frost));
    expect(w.frostAt(home)).toBe(0);
    while (bite(w.tick + TICKS_PER_DAY) <= 0.25) w.tick += TICKS_PER_HOUR;
    expect(w.tick - START_TICK).toBeLessThan(30 * TICKS_PER_DAY);
    runUntil(w, () => f.settlement!.state !== 'home', 2 * TICKS_PER_DAY);
    expect(f.settlement!.state).toBe('leaving');
    // Nothing is theirs any more (a rival's fighters may have smashed a wall or two first).
    for (const id of oldBuildings) expect(w.get<Building>(id)?.faction ?? 0).toBe(0);
    runUntil(w, () => f.settlement!.state !== 'leaving', 5 * TICKS_PER_DAY);
    expect(f.settlement!.state).toBe('home');
    expect(frostDistance(f.home.x, f.home.y, 200, 200)).toBeLessThan(frostDistance(old.x, old.y, 200, 200));
    expect(buildings(w, f.id).some((b) => b.def === 'campfire')).toBe(true);
  });

  it('fall when their last resident dies, and their stores are free to take', () => {
    const { w, s } = withSettlement(-60);
    for (const p of residents(w, s.id)) killPawn(w, p, 'testing');
    runUntil(w, () => s.settlement!.state === 'fallen', 2000);
    expect(stock(w, s.id, 'steel')).toBe(0);
    expect(buildings(w, s.id).length).toBe(0);
  });

  it('save, load and carry on identically', () => {
    const w = createWorld({ seed: 9, width: 140, height: 140 });
    run(w, 1000);
    const b = deserializeWorld(serializeWorld(w));
    expect(hashWorld(b)).toBe(hashWorld(w));
    run(w, 3000);
    run(b, 3000);
    expect(hashWorld(b)).toBe(hashWorld(w));
  });

  it('ask colonies they know for help, reward deliveries, and remember broken promises', () => {
    const { w, s, player } = withSettlement(45);
    // Strangers don't get asked.
    expect(askForHelp(w, s)).toBe(false);
    s.settlement!.met.push(player);
    expect(askForHelp(w, s)).toBe(true);
    const c = [...w.choices.values()].find((x) => x.event === 'settlement_request')!;
    expect(c.faction).toBe(player);
    resolveChoice(w, c.id, 'accept', player);
    const r = s.settlement!.requests![0];
    expect(r.faction).toBe(player);

    // Stock up what they asked for, then go there and hand it over.
    const z = w.createZone(player, 'stockpile');
    for (let x = 4; x < 20; x++) w.addZoneCell(z, w.map.idx(x, 12));
    const def = r.item.startsWith('cat:') ? ({ 'cat:raw_food': 'potato', 'cat:meal': 'simple_meal' } as Record<string, string>)[r.item] : r.item;
    w.placeItemNear(def, r.count, w.map.idx(10, 12));
    expect(storedOf(w, player, r.item)).toBe(r.count);
    w.enqueue(player, { c: 'deliverRequest', settlement: s.id, request: r.id });
    run(w, 2);
    expect(s.settlement!.requests!.length).toBe(1); // nobody there yet
    const courier = addPawn(w, 40, 47, player);
    const before = residents(w, player).length;
    w.enqueue(player, { c: 'deliverRequest', settlement: s.id, request: r.id });
    run(w, 2);
    expect(s.settlement!.requests!.length).toBe(0);
    expect(storedOf(w, player, r.item)).toBe(0);
    expect(s.settlement!.goodwill[player]).toBeGreaterThanOrEqual(60);
    if (r.reward === 'recruit') expect(residents(w, player).length).toBe(before + 1);
    else expect(w.dirty.msgs.some((m) => m.text.includes(`${courier.name} has`))).toBe(true);

    // Agree again and never come.
    askForHelp(w, s);
    const c2 = [...w.choices.values()].find((x) => x.event === 'settlement_request')!;
    resolveChoice(w, c2.id, 'accept', player);
    const g = s.settlement!.goodwill[player];
    run(w, 4 * TICKS_PER_DAY + 2000);
    expect(s.settlement!.requests!.length).toBe(0);
    expect(s.settlement!.goodwill[player]).toBeLessThan(g);
    expect(w.dirty.msgs.some((m) => m.text.includes('never came'))).toBe(true);
  });

  it("a settler who joins you gives up their bed, and clients are told it's free", () => {
    const { w, s, player } = withSettlement(45);
    s.settlement!.met.push(player);
    const beds = buildings(w, s.id).filter((b) => BUILDINGS[b.def].bed);
    residents(w, s.id).forEach((p, k) => {
      p.bed = beds[k].id;
      beds[k].owner = p.id;
    });
    s.settlement!.requests = [{ id: 99, faction: player, item: 'wood', count: 10, reward: 'recruit', goodwill: 15, until: w.tick + TICKS_PER_DAY, why: 'test' }];
    const z = w.createZone(player, 'stockpile');
    for (let x = 4; x < 20; x++) w.addZoneCell(z, w.map.idx(x, 12));
    w.placeItemNear('wood', 10, w.map.idx(10, 12));
    addPawn(w, 40, 47, player);
    w.takeDelta();
    w.enqueue(player, { c: 'deliverRequest', settlement: s.id, request: 99 });
    w.applyCommands();
    expect(residents(w, player).length).toBe(2);
    const freed = beds.find((b) => b.owner === 0)!;
    expect(freed).toBeDefined();
    expect(w.takeDelta().ents.find((e) => e.id === freed.id)).toMatchObject({ owner: 0 });
  });

  describe('theft', () => {
    /** A colony with a stockpile and a thief, next to a wary settlement, at the given hour. */
    function heist(hour: number) {
      const { w, s, player } = withSettlement(0);
      w.tick = Math.floor(w.tick / TICKS_PER_DAY) * TICKS_PER_DAY + hour * TICKS_PER_HOUR;
      const z = w.createZone(player, 'stockpile');
      for (let x = 30; x < 40; x++) w.addZoneCell(z, w.map.idx(x, 60));
      const thief = addPawn(w, 40, 50, player);
      return { w, s, player, thief };
    }
    const mark = (w: World, player: number) => w.enqueue(player, { c: 'designate', kind: 'steal', x0: 36, y0: 37, x1: 44, y1: 43 });

    it('at night, while they sleep, a practised thief sneaks in through the open gate and gets away with it', () => {
      const { w, s, player, thief } = heist(23);
      thief.sneaking = true;
      thief.skills.stealth = { level: 18, xp: 0 };
      runUntil(w, () => residents(w, s.id).every((p) => p.asleep), 3000);
      const steel = stock(w, s.id, 'steel');
      mark(w, player);
      runUntil(w, () => stock(w, player, 'steel') > 0, 4000);
      expect(stock(w, s.id, 'steel')).toBeLessThan(steel);
      expect(s.settlement!.goodwill[player] ?? 0).toBe(0);
    });

    it('by day, haulers leave marked goods alone, and anyone watching a thief raises the alarm', () => {
      const { w, s, player, thief } = heist(12);
      // A settler minding the stores.
      const guard = residents(w, s.id)[0];
      guard.x = 40;
      guard.y = 41;
      guard.path = null;
      guard.job = { type: 'hold', stage: 0, until: w.tick + 50_000 };
      // Haulers wait for dark, so send the thief in person.
      mark(w, player);
      run(w, 300);
      expect(thief.job?.type).not.toBe('haul');
      const it = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => w.zoneAt(w.cellOf(i))?.faction === s.id)!;
      w.enqueue(player, { c: 'steal', pawn: thief.id, item: it.id });
      runUntil(w, () => (s.settlement!.goodwill[player] ?? 0) < 0, 4000);
      expect(dispositionOf(s.settlement!, player)).toBe('hostile');
      expect(w.dirty.msgs.some((m) => m.faction === 0 && m.text.includes('stealing'))).toBe(true);
    });

    it('a colonist sent to steal goes at once, even from their bed', () => {
      const { w, s, player, thief } = heist(23);
      thief.job = { type: 'sleep', stage: 1, bed: 0, cell: w.cellOf(thief), rest: false };
      thief.asleep = true;
      const z = w.zones.get(w.map.zoneAt[w.map.idx(37, 42)])!;
      expect(z.faction).toBe(s.id);
      const it = [...w.kinds.item].map((id) => w.get<Item>(id)!).find((i) => w.zoneAt(w.cellOf(i))?.faction === s.id)!;
      w.enqueue(player, { c: 'steal', pawn: thief.id, item: it.id });
      run(w, 2);
      expect(thief.job?.type).toBe('haul');
      expect(thief.asleep).toBe(false);
    });
  });

  it('accept gifts even as enemies, and enough of them make peace', () => {
    const { w, s, player } = withSettlement(-60);
    const z = w.createZone(player, 'stockpile');
    for (let x = 4; x < 20; x++) w.addZoneCell(z, w.map.idx(x, 12));
    w.placeItemNear('gold', 75, w.map.idx(10, 12));
    addPawn(w, 40, 47, player);
    w.enqueue(player, { c: 'settlementTrade', settlement: s.id, give: [['gold', 1]], want: [['steel', 1]] });
    run(w, 2);
    expect(w.dirty.msgs.at(-1)!.text).toMatch(/won't trade/);
    for (let k = 0; k < 2; k++) {
      w.enqueue(player, { c: 'settlementTrade', settlement: s.id, give: [['gold', 30]], want: [] });
      run(w, 2);
    }
    expect(dispositionOf(s.settlement!, player)).toBe('wary');
    expect(w.dirty.msgs.some((m) => m.text.includes('accepts your gift'))).toBe(true);
  });
});
