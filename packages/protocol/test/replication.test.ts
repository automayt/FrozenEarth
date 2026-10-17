import { describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, fireEvent, Rng, snapshot, TICKS_PER_HOUR, type Faction, type Pawn, type World } from '@fe/sim';
import { T } from '@fe/defs';
import { decode, encode, Mirror, type ServerMsg } from '../src';
import { Chaos } from '../../../tools/bots/src/chaos';
import { visibleEntity, visibleFaction } from '../../../tools/bots/src/visible';

type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;

const wire = <T extends ServerMsg>(m: T): T => decode<T>(encode(m));
const join = (w: World): Mirror => {
  const m = new Mirror();
  m.applySnapshot(wire<Welcome>({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) }).snap);
  return m;
};

/** A world with settlements, wildlife, two colonies, and a frost line that moves during the test. */
function liveWorld(seed: number): { w: World; players: Faction[] } {
  const w = createWorld({ seed, width: 110, height: 110 });
  w.tick += 14 * TICKS_PER_HOUR;
  w.frost = { startDay: 0, pace: 60, minRadius: 0.18 };
  const players = ['North', 'South'].map((n) => addPlayerFaction(w, n));
  for (const f of players) w.enqueue(f.id, { c: 'zone', kind: 'stockpile', x0: f.home.x - 2, y0: f.home.y - 2, x1: f.home.x + 2, y1: f.home.y + 2 });
  return { w, players };
}

function expectInSync(m: Mirror, w: World): void {
  expect(m.tick).toBe(w.tick);
  expect(m.entities.size).toBe(w.entities.size);
  for (const e of w.entities.values()) expect(visibleEntity(m.get(e.id)!), `${e.kind} ${e.id}`).toEqual(visibleEntity(e));
  expect([...m.factions.keys()].sort()).toEqual([...w.factions.keys()].sort());
  for (const f of w.factions.values()) expect(visibleFaction(m.factions.get(f.id)!), f.name).toEqual(visibleFaction(f));
  const map = w.map;
  for (const [name, a, b] of [
    ['terrain', m.terrain, map.terrain],
    ['rock', m.rock, map.rock],
    ['desig', m.desig, map.desig],
    ['desigFaction', m.desigFaction, map.desigFaction],
    ['fire', m.fire, map.fire],
    ['zoneAt', m.zoneAt, map.zoneAt],
    ['roomAt', m.roomAt, map.roomAt],
    ['itemAt', m.itemAt, map.itemAt],
    ['buildingAt', m.buildingAt, map.buildingAt],
    ['plantAt', m.plantAt, map.plantAt],
    ['constructAt', m.constructAt, map.constructAt],
  ] as const) {
    expect(Array.from(a).join(), name).toBe(Array.from(b).join());
  }
  expect(m.fireCells).toEqual(w.fireCells);
  expect(m.choices).toEqual([...w.choices.values()]);
  expect(m.conditions).toEqual(w.conditions);
  expect(m.coldOffset).toBe(w.coldOffset);
  expect([...m.rooms.values()].map((r) => [r.id, r.cells, Math.round(r.temp * 10)])).toEqual([...w.rooms.values()].map((r) => [r.id, r.cells, Math.round(r.temp * 10)]));
}

describe('codec: newer fields survive the wire', () => {
  it('settlements, wild factions, raids with goals and helpers, and requests round-trip', () => {
    const { w, players } = liveWorld(11);
    const town = [...w.factions.values()].find((f) => f.settlement)!;
    town.settlement!.goodwill[players[0].id] = -42;
    town.settlement!.met.push(players[0].id);
    town.settlement!.requests = [{ id: 7, faction: players[0].id, item: 'cat:raw_food', count: 40, reward: ['gold', 5], goodwill: 15, until: w.tick + 999, why: 'because' }, { id: 8, faction: players[1].id, item: 'wood', count: 10, reward: 'recruit', goodwill: 15, until: w.tick + 5, why: 'x' }];
    expect(fireEvent(w, 'settlement_raid', 0)).toBe(true);
    const raiders = [...w.factions.values()].find((f) => f.raid)!;
    Object.assign(raiders.raid!, { goal: 'siege', goalSince: w.tick, dealt: 0.25, taken: 1.5, fires: 2, foes: 3, helpers: { [players[0].id]: 0.75, [players[1].id]: 2 } });
    const back = wire<Welcome>({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) }).snap;
    // Full equality, not just the projection: nothing on a faction is lost or changes type.
    expect(back.factions).toEqual([...w.factions.values()]);
    expect(back.factions.some((f) => f.wild === 'prey')).toBe(true);
  });

  it("pawns' species, hunting marks, direct control, stealth, and give-up memory round-trip, as do control and ignite jobs", () => {
    const { w, players } = liveWorld(12);
    const [a, b, c] = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === players[0].id);
    const animal = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).find((p) => p.species)!;
    expect(animal).toBeDefined();
    animal.hunted = players[0].id;
    animal.aggro = a.id;
    Object.assign(a, { possessed: true, sneaking: true, steer: [-1, 1], job: { type: 'control', stage: 0, stolen: 3, stolenAt: 1234 } });
    Object.assign(b, { giveUp: [animal.id, w.tick + 500], job: { type: 'ignite', stage: 1, cell: 4321 } });
    Object.assign(c, { job: { type: 'attack', stage: 0, target: animal.id, forced: true, chase: true, next: 0, until: 9, spot: -1 } });
    for (const p of [a, b, c, animal]) w.markDirty(p);
    const d = wire<DeltaMsg>({ t: 'delta', d: w.takeDelta(), time: { speed: 1, paused: false, reason: '' } }).d;
    const got = new Map(d.ents.map((e) => [e.id, e]));
    for (const p of [a, b, c, animal]) expect(got.get(p.id)).toEqual(p);
    // Tuples stay arrays and negative numbers stay negative.
    expect((got.get(a.id) as Pawn).steer).toEqual([-1, 1]);
  });

  it('cell changes (ice, rock, designations, fire) arrive as typed sextuples', () => {
    const { w } = liveWorld(13);
    w.takeDelta();
    const ice = T.ice;
    w.setTerrain(10, ice);
    w.setRock(11, 2);
    w.setDesig(12, 4, 2);
    w.setFire(13, 3);
    const d = wire<DeltaMsg>({ t: 'delta', d: w.takeDelta(), time: { speed: 1, paused: false, reason: '' } }).d;
    expect(d.cells).toEqual([10, ice, w.map.rock[10], 0, 0, 0, 11, w.map.terrain[11], 2, 0, 0, 0, 12, w.map.terrain[12], w.map.rock[12], 4, 2, 0, 13, w.map.terrain[13], w.map.rock[13], 0, 0, 3]);
  });
});

describe('replication with every system running', () => {
  it('mirrors fed every delta, from the start and from a late join, match the server on everything clients see', () => {
    const { w, players } = liveWorld(21);
    const rng = new Rng(5);
    const chaos = new Chaos(rng, {
      w: w.map.w,
      h: w.map.h,
      entities: w.entities,
      factions: w.factions,
      zones: w.zones,
      zoneAt: w.map.zoneAt,
      get choices() {
        return w.choices.values();
      },
    });
    w.takeDelta();
    const early = join(w);
    let late: Mirror | null = null;
    const events: [number, string, number][] = [
      [200, 'raid', players[0].id],
      [400, 'settlement_raid', 0],
      [700, 'settlement_plea', players[1].id],
      [1000, 'peddler', players[0].id],
      [2500, 'night_raid', players[1].id],
      [3000, 'settlement_plea', players[0].id],
      [5000, 'settlement_plea', players[1].id],
    ];
    const seen = { ice: false, possessed: false, sneaking: false, hunted: false, goal: false, requests: false };
    for (let t = 0; t < 9000; t++) {
      for (const [at, key, f] of events) if (at === t) fireEvent(w, key, f);
      if (rng.chance(0.15)) {
        const who = rng.pick(players).id;
        const got = chaos.random(who);
        if (got) w.enqueue(who, got.cmd);
      }
      // Say yes to settlements asking for help, so open requests are replicated too.
      for (const c of w.choices.values()) if (c.event === 'settlement_request') w.enqueue(c.faction, { c: 'choose', choice: c.id, option: 'accept' });
      w.step();
      if (t % 4 === 0) {
        const msg = wire<DeltaMsg>({ t: 'delta', d: w.takeDelta(), time: { speed: 1, paused: false, reason: '' } });
        early.applyDelta(msg.d);
        late?.applyDelta(msg.d);
        for (let k = 0; k < msg.d.cells.length; k += 6) if (msg.d.cells[k + 1] === T.ice) seen.ice = true;
        for (const e of msg.d.ents) {
          if (e.kind !== 'pawn') continue;
          seen.possessed ||= !!e.possessed;
          seen.sneaking ||= !!e.sneaking;
          seen.hunted ||= !!e.hunted;
        }
        for (const f of msg.d.factions) {
          seen.goal ||= !!f.raid?.goal && f.raid.goal !== 'assault';
          seen.requests ||= !!f.settlement?.requests?.length;
        }
      }
      if (t === 4000) late = join(w);
      // Check along the way too, not just at the end: a field left stale for a while is still a bug.
      if (t % 1500 === 0 && t > 0) {
        expectInSync(early, w);
        if (late) expectInSync(late, w);
      }
    }
    const final = wire<DeltaMsg>({ t: 'delta', d: w.takeDelta(), time: { speed: 1, paused: false, reason: '' } }).d;
    early.applyDelta(final);
    late!.applyDelta(final);
    expectInSync(early, w);
    expectInSync(late!, w);
    expect(seen).toEqual({ ice: true, possessed: true, sneaking: true, hunted: true, goal: true, requests: true });
  });
});
