import { describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, deserializeWorld, fireEvent, hashWorld, Rng, serializeWorld, TICKS_PER_HOUR, type Command, type World } from '../src';
import { Chaos, type ChaosKind } from '../../../tools/bots/src/chaos';

/**
 * Property test for determinism with every system switched on: settlements, wildlife, raids
 * (on colonies and on settlements), theft, direct control and stealth, trade and requests, and
 * a frost line that moves during the run. Random but valid commands are fed in; the world must
 * come out the same whether it runs straight through, is saved and loaded halfway, or is
 * rebuilt from scratch by replaying the command log.
 */

type Action = { tick: number; faction: number; cmd: Command } | { tick: number; faction: number; event: string };

const SIZE = 110;
const TICKS = 12_000;
const MID = 5000;
/** Story events forced at fixed points, so raids and pleas are certain to be in the mix. */
const EVENTS: [at: number, event: string, target: 'a' | 'b' | 'any'][] = [
  [300, 'settlement_plea', 'a'],
  [600, 'raid', 'a'],
  [900, 'settlement_raid', 'any'],
  [1500, 'peddler', 'b'],
  [2400, 'settlement_plea', 'b'],
  [3600, 'raid', 'b'],
  [5200, 'settlement_raid', 'any'],
  [6000, 'night_raid', 'a'],
];

function setup(seed: number): World {
  const w = createWorld({ seed, width: SIZE, height: SIZE });
  // Start in the evening so the run crosses nightfall (thieves and sleepers), with a frost line that moves now.
  w.tick += 14 * TICKS_PER_HOUR;
  w.frost = { startDay: 0, pace: 60, minRadius: 0.18 };
  for (const name of ['North', 'South']) {
    const f = addPlayerFaction(w, name);
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', x0: f.home.x - 2, y0: f.home.y - 2, x1: f.home.x + 2, y1: f.home.y + 2 });
  }
  return w;
}

function players(w: World): number[] {
  return [...w.factions.values()].filter((f) => f.isPlayer).map((f) => f.id);
}

function apply(w: World, a: Action): boolean {
  if ('cmd' in a) {
    w.enqueue(a.faction, a.cmd);
    return true;
  }
  return fireEvent(w, a.event, a.faction);
}

/** Run a world forward, applying the logged actions due at each tick. */
function replay(w: World, log: Action[], until: number): void {
  let k = log.findIndex((a) => a.tick >= w.tick);
  if (k < 0) k = log.length;
  while (w.tick < until) {
    while (k < log.length && log[k].tick === w.tick) apply(w, log[k++]);
    w.step();
  }
}

function fuzz(seed: number) {
  const a = setup(seed);
  const start = a.tick;
  const rng = new Rng(seed * 7919 + 13);
  const chaos = new Chaos(rng, {
    w: a.map.w,
    h: a.map.h,
    entities: a.entities,
    factions: a.factions,
    zones: a.zones,
    zoneAt: a.map.zoneAt,
    get choices() {
      return a.choices.values();
    },
  });
  const [p1, p2] = players(a);
  const log: Action[] = [];
  const kinds = new Map<ChaosKind, number>();
  const fired: string[] = [];
  let b: World | null = null;
  let midHash = '';

  for (let t = 0; t < TICKS; t++) {
    const now: Action[] = [];
    for (const [at, event, who] of EVENTS) if (at === t) now.push({ tick: a.tick, faction: who === 'a' ? p1 : who === 'b' ? p2 : 0, event });
    // A few commands a second across both colonies, roughly what busy players send.
    if (rng.chance(0.08)) {
      const who = rng.chance(0.5) ? p1 : p2;
      const got = chaos.random(who);
      if (got) {
        kinds.set(got.kind, (kinds.get(got.kind) ?? 0) + 1);
        now.push({ tick: a.tick, faction: who, cmd: got.cmd });
      }
    }
    for (const act of now) {
      log.push(act);
      if (apply(a, act) && 'event' in act) fired.push(act.event);
      if (b) apply(b, act);
    }
    a.step();
    b?.step();
    if (t === MID) {
      b = deserializeWorld(serializeWorld(a));
      midHash = hashWorld(a);
      expect(hashWorld(b)).toBe(midHash);
    }
  }
  return { a, b: b!, log, kinds, fired, start, midHash };
}

describe('determinism under random play', () => {
  it.each([4242, 77, 1009])('seed %i: save/load mid-run and a replayed command log both reproduce the same world', (seed) => {
    const { a, b, log, kinds, fired, start, midHash } = fuzz(seed);
    const final = hashWorld(a);
    expect(hashWorld(b)).toBe(final);

    // From scratch, replaying only the log.
    const c = setup(seed);
    expect(c.tick).toBe(start);
    replay(c, log, start + MID + 1);
    expect(hashWorld(c)).toBe(midHash);
    replay(c, log, a.tick);
    expect(hashWorld(c)).toBe(final);

    // The run really exercised the newer systems.
    for (const k of ['possess', 'steer', 'sneak', 'interact', 'steal', 'hunt', 'settlementTrade', 'attack', 'build', 'designate'] as ChaosKind[]) {
      expect(kinds.get(k) ?? 0, k).toBeGreaterThan(0);
    }
    expect(fired).toContain('raid');
    expect(fired).toContain('settlement_raid');
    expect(a.frostRadius()).toBeLessThan(1.4);

    // Tripwires for state that piles up over a long game (see tools/bench/soak.ts for the long run).
    const pawns = [...a.kinds.pawn].map((id) => a.get(id) as import('../src').Pawn);
    expect([...a.unreachable.values()].filter((until) => until < a.tick - TICKS_PER_HOUR), 'expired unreachable marks').toEqual([]);
    expect(a.choiceData.size).toBe(a.choices.size);
    expect([...a.reservations.values()].every((id) => a.entities.has(id)), 'reservations held by the gone').toBe(true);
    expect([...a.factions.values()].filter((f) => f.raid).length).toBeLessThanOrEqual(6);
    expect(pawns.filter((p) => p.possessed && p.downed).length, 'steered while down').toBe(0);
    expect(a.commandErrors).toBe(0);
  });
});
