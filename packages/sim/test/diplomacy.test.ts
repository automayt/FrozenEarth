import { describe, expect, it } from 'vitest';
import {
  ALLY_AT,
  allied,
  areRivals,
  atWar,
  deserializeWorld,
  DIPLO,
  foundSettlement,
  goodwillOf,
  hostile,
  mediationChance,
  opinionBetween,
  pactOf,
  peacePrice,
  PLAYER_TRUCE_DAYS,
  resolveChoice,
  Rng,
  serializeWorld,
  START_TICK,
  startRaid,
  TICKS_PER_DAY,
  type Faction,
  type Pawn,
  type World,
} from '../src';
import { wellFormed } from '../src/commands';
import { addPawn, flatWorld, run } from './helpers';

/** A flat world with colony 2 at (10, 10), and towns of the given tempers spread along y = 40. */
function world(tempers: number[], size = 160): { w: World; towns: Faction[] } {
  const w = flatWorld(size, 80);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 10, y: 10 }, isPlayer: true });
  const towns = tempers.map((t, k) => foundSettlement(w, { x: 30 + k * 50, y: 40 }, t, 4));
  for (const f of towns) f.settlement!.met.push(2);
  return { w, towns };
}

const send = (w: World, cmd: Parameters<World['enqueue']>[1], faction = 2) => {
  w.enqueue(faction, cmd);
  run(w, 1);
};
const lastMsg = (w: World, faction = 2) => w.dirty.msgs.filter((m) => m.faction === faction || m.faction === 0).at(-1)?.text ?? '';
const residents = (w: World, f: number) => [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === f);
/** Make two towns rivals. */
const feud = (a: Faction, b: Faction) => {
  a.settlement!.goodwill[b.id] = -80;
  b.settlement!.goodwill[a.id] = -80;
};
const stockpile = (w: World, faction: number, x: number, y: number, def: string, n: number) => {
  const z = w.createZone(faction, 'stockpile');
  for (let dx = 0; dx < 4; dx++) w.addZoneCell(z, w.map.idx(x + dx, y));
  w.placeItemNear(def, n, w.map.idx(x, y));
};

describe('alliances with towns', () => {
  it('need goodwill, an envoy, and no alliance with their rivals; then the rivals resent it', () => {
    const { w, towns } = world([45, 45]);
    const [a, b] = towns;
    feud(a, b);
    send(w, { c: 'diplomacy', act: 'ally', target: a.id });
    expect(allied(w, 2, a.id)).toBe(false);
    expect(lastMsg(w)).toContain(`goodwill of ${ALLY_AT}`);
    a.settlement!.goodwill[2] = 70;
    send(w, { c: 'diplomacy', act: 'ally', target: a.id });
    expect(lastMsg(w)).toContain('Send a colonist');
    addPawn(w, 30, 48, 2);
    const before = goodwillOf(b.settlement!, 2);
    send(w, { c: 'diplomacy', act: 'ally', target: a.id });
    expect(allied(w, 2, a.id)).toBe(true);
    expect(allied(w, a.id, 2)).toBe(true);
    expect(goodwillOf(b.settlement!, 2)).toBe(before + DIPLO.alliedWithRival);
    expect(b.settlement!.memories?.at(-1)?.why).toContain(a.name);
    // B won't ally with a friend of its rival.
    b.settlement!.goodwill[2] = 90;
    addPawn(w, 80, 48, 2);
    send(w, { c: 'diplomacy', act: 'ally', target: b.id });
    expect(allied(w, 2, b.id)).toBe(false);
    expect(lastMsg(w)).toContain('their rival');
  });

  it('fall apart when goodwill drops below friendship', () => {
    const { w, towns } = world([45]);
    const [a] = towns;
    a.settlement!.goodwill[2] = 70;
    addPawn(w, 30, 48, 2);
    send(w, { c: 'diplomacy', act: 'ally', target: a.id });
    expect(allied(w, 2, a.id)).toBe(true);
    w.enqueue(2, { c: 'diplomacy', act: 'war', target: a.id });
    run(w, 1);
    expect(allied(w, 2, a.id)).toBe(false);
    expect(hostile(w, 2, a.id)).toBe(true);
  });

  it('send fighters when the colony is raided', () => {
    const { w, towns } = world([45]);
    const [a] = towns;
    a.settlement!.goodwill[2] = 70;
    const envoy = addPawn(w, 30, 48, 2);
    addPawn(w, 10, 10, 2);
    send(w, { c: 'diplomacy', act: 'ally', target: a.id });
    envoy.x = 12;
    envoy.y = 12;
    expect(startRaid(w, 2, 200, 'raid')).toBeTruthy();
    const helpers = residents(w, a.id).filter((p) => p.aid);
    expect(helpers.length).toBe(2);
    expect(w.dirty.msgs.some((m) => m.faction === 2 && m.text.includes('sends'))).toBe(true);
    const d0 = Math.hypot(helpers[0].x - 10, helpers[0].y - 10);
    run(w, 600);
    const still = helpers.filter((p) => !p.downed);
    if (still.length) expect(Math.min(...still.map((p) => Math.hypot(p.x - 10, p.y - 10)))).toBeLessThan(d0);
  });
});

describe('rival towns', () => {
  it('a gift to one cools its rival toward you, and the reason is remembered', () => {
    const { w, towns } = world([0, 0]);
    const [a, b] = towns;
    feud(a, b);
    expect(areRivals(w, a, b)).toBe(true);
    stockpile(w, 2, 8, 12, 'gold', 40);
    addPawn(w, 30, 48, 2);
    send(w, { c: 'settlementTrade', settlement: a.id, give: [['gold', 30]], want: [] });
    expect(goodwillOf(a.settlement!, 2)).toBeGreaterThan(0);
    expect(goodwillOf(b.settlement!, 2)).toBeLessThan(0);
    expect(b.settlement!.memories?.at(-1)?.why).toBe(`Befriended ${a.name}, our rival`);
    expect(a.settlement!.memories?.at(-1)?.why).toBe('A gift');
  });

  it('a go-between can end a feud; a failed attempt sours both, and they need time before the next', () => {
    let made = 0;
    let failed = 0;
    for (let seed = 1; seed <= 12 && (!made || !failed); seed++) {
      const { w, towns } = world([0, 0]);
      const [a, b] = towns;
      feud(a, b);
      a.settlement!.goodwill[2] = 20;
      b.settlement!.goodwill[2] = 20;
      addPawn(w, 30, 48, 2);
      w.rng = new Rng(seed);
      send(w, { c: 'diplomacy', act: 'mediate', target: a.id, other: b.id });
      if (!areRivals(w, a, b)) {
        made++;
        expect(goodwillOf(a.settlement!, 2)).toBe(20 + DIPLO.mediated);
        expect(opinionBetween(w, a, b)).toBe(-80 + DIPLO.mediationLift);
      } else {
        failed++;
        expect(goodwillOf(a.settlement!, 2)).toBe(20 + DIPLO.meddled);
        send(w, { c: 'diplomacy', act: 'mediate', target: a.id, other: b.id });
        expect(lastMsg(w)).toContain('heard enough');
      }
    }
    expect(made).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);
    expect(mediationChance(50, 50, 10)).toBeGreaterThan(mediationChance(0, 0, 0));
  });

  it('now and then send fighters at each other, who leave their own town alone', () => {
    const { w, towns } = world([-60, -60]);
    const [a, b] = towns;
    feud(a, b);
    let raid: Faction | undefined;
    for (let day = 0; day < 80 && !raid; day++) {
      w.tick = START_TICK - (START_TICK % TICKS_PER_DAY) + day * TICKS_PER_DAY + TICKS_PER_DAY / 2 - 1;
      run(w, 2);
      raid = [...w.factions.values()].find((f) => f.raid?.sponsor && !f.raid.fled);
    }
    expect(raid).toBeTruthy();
    const sponsor = raid!.raid!.sponsor!;
    const target = raid!.raid!.target;
    expect(raid!.name).toContain(w.factions.get(sponsor)!.name);
    expect(hostile(w, raid!.id, sponsor)).toBe(false);
    expect(hostile(w, raid!.id, target)).toBe(true);
  });
});

describe('peace with a hostile town', () => {
  it('costs tribute, buys a truce, and breaking it is remembered everywhere', () => {
    const { w, towns } = world([-60, 45]);
    const [a, other] = towns;
    expect(hostile(w, 2, a.id)).toBe(true);
    stockpile(w, 2, 8, 12, 'gold', 200);
    const envoy = addPawn(w, 30, 50, 2);
    send(w, { c: 'diplomacy', act: 'peace', target: a.id, give: [['gold', 1]] });
    expect(lastMsg(w)).toContain('wants tribute worth about');
    expect(hostile(w, 2, a.id)).toBe(true);
    const price = peacePrice(-60, envoy.skills.social?.level ?? 0);
    send(w, { c: 'diplomacy', act: 'peace', target: a.id, give: [['gold', Math.ceil(price / 10)]] });
    expect(pactOf(w, 2, a.id)?.kind).toBe('truce');
    expect(hostile(w, 2, a.id)).toBe(false);
    expect(goodwillOf(a.settlement!, 2)).toBe(-25);
    // Attacking them now breaks the truce.
    const otherBefore = goodwillOf(other.settlement!, 2);
    const victim = residents(w, a.id)[0];
    envoy.drafted = true;
    send(w, { c: 'attack', pawns: [envoy.id], target: victim.id });
    expect(lastMsg(w)).toContain('truce');
    // Fighting them anyway (here, an attack already under way) breaks it, and word gets around.
    envoy.job = { type: 'attack', stage: 0, target: victim.id, forced: true, chase: true, next: 0, until: 0 };
    for (let k = 0; k < 2000 && pactOf(w, 2, a.id); k++) run(w, 1);
    expect(pactOf(w, 2, a.id)).toBeUndefined();
    expect(a.settlement!.memories?.some((m) => m.why === 'Broke the truce')).toBe(true);
    // The other town hears of it (though it may not mind its rival being hurt).
    expect(other.settlement!.memories?.find((m) => m.why.startsWith('Broke a truce'))?.by).toBe(DIPLO.oathbreakerRumor);
    expect(otherBefore).toBe(45);
  });
});

describe('colony and colony', () => {
  function twoColonies() {
    const { w, towns } = world([0]);
    w.factions.set(9, { id: 9, name: 'Neighbours', color: 0x00ff00, home: { x: 140, y: 10 }, isPlayer: true });
    towns[0].settlement!.met.push(9);
    return { w, town: towns[0] };
  }

  it('alliances need both to agree; allies cannot be attacked by order', () => {
    const { w } = twoColonies();
    const mine = addPawn(w, 20, 10, 2);
    const theirs = addPawn(w, 22, 10, 9);
    send(w, { c: 'diplomacy', act: 'ally', target: 9 });
    const offer = [...w.choices.values()].find((c) => c.event === 'pact_offer' && c.faction === 9)!;
    expect(offer).toBeTruthy();
    expect(allied(w, 2, 9)).toBe(false);
    resolveChoice(w, offer.id, 'accept', 9);
    expect(allied(w, 2, 9)).toBe(true);
    mine.drafted = true;
    send(w, { c: 'attack', pawns: [mine.id], target: theirs.id });
    expect(mine.job?.type).not.toBe('attack');
    expect(lastMsg(w)).toContain('your ally');
  });

  it('war makes colonists fight on sight; peace brings a truce that runs out', () => {
    const { w } = twoColonies();
    expect(hostile(w, 2, 9)).toBe(false);
    send(w, { c: 'diplomacy', act: 'war', target: 9 });
    expect(atWar(w, 2, 9)).toBe(true);
    expect(hostile(w, 9, 2)).toBe(true);
    send(w, { c: 'diplomacy', act: 'peace', target: 2 }, 9);
    const offer = [...w.choices.values()].find((c) => c.event === 'pact_offer' && c.faction === 2)!;
    resolveChoice(w, offer.id, 'accept', 2);
    expect(pactOf(w, 2, 9)?.kind).toBe('truce');
    expect(hostile(w, 2, 9)).toBe(false);
    w.tick += PLAYER_TRUCE_DAYS * TICKS_PER_DAY;
    run(w, 260);
    expect(pactOf(w, 2, 9)).toBeUndefined();
    expect(w.factions.get(2)!.pacts).toBeUndefined();
  });

  it('a surprise attack starts a war, and the towns that know you hear of it', () => {
    const { w, town } = twoColonies();
    const mine = addPawn(w, 20, 10, 2);
    const theirs = addPawn(w, 21, 10, 9);
    const before = goodwillOf(town.settlement!, 2);
    mine.drafted = true;
    send(w, { c: 'attack', pawns: [mine.id], target: theirs.id });
    for (let k = 0; k < 400 && !atWar(w, 2, 9); k++) run(w, 1);
    expect(atWar(w, 2, 9)).toBe(true);
    expect(goodwillOf(town.settlement!, 2)).toBe(before + DIPLO.treacheryRumor);
  });
});

describe('over time and on disk', () => {
  it('goodwill fades back toward a town’s temper, a point a day', () => {
    const { w, towns } = world([0]);
    const [a] = towns;
    a.settlement!.goodwill[2] = 20;
    const start = w.tick - (w.tick % TICKS_PER_DAY) + TICKS_PER_DAY;
    w.tick = start - 1;
    run(w, 2);
    expect(goodwillOf(a.settlement!, 2)).toBe(19);
  });

  it('pacts, memories and aid survive a save', () => {
    const { w, towns } = world([45]);
    const [a] = towns;
    a.settlement!.goodwill[2] = 70;
    addPawn(w, 30, 48, 2);
    send(w, { c: 'diplomacy', act: 'ally', target: a.id });
    residents(w, a.id)[0].aid = [2, w.tick + 100];
    const back = deserializeWorld(serializeWorld(w));
    expect(allied(back, 2, a.id)).toBe(true);
    expect(back.factions.get(a.id)!.settlement!.memories?.at(-1)?.why).toBe('Swore an alliance with us');
    expect(residents(back, a.id).some((p) => p.aid)).toBe(true);
  });

  it('only well-formed diplomacy commands get through', () => {
    expect(wellFormed({ c: 'diplomacy', act: 'ally', target: 3 })).toBe(true);
    expect(wellFormed({ c: 'diplomacy', act: 'conquer', target: 3 })).toBe(false);
    expect(wellFormed({ c: 'diplomacy', act: 'ally' })).toBe(false);
    expect(wellFormed({ c: 'diplomacy', act: 'mediate', target: 3, other: '4' })).toBe(false);
  });
});
