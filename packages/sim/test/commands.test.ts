import { describe, expect, it } from 'vitest';
import { BUILDINGS, ITEMS, PLANTS, RECIPES, WORK_TYPES } from '@fe/defs';
import { addPlayerFaction, createWorld, deserializeWorld, hashWorld, Rng, serializeWorld, TICKS_PER_HOUR, type Command, type Construct, type Pawn, type World } from '../src';
import { applyCommand } from '../src/commands';
import { offerChoice } from '../src/choices';
import { run } from './helpers';

/**
 * Command validation. Players send whatever they like over the wire, so every command must
 * survive garbage (wrong types, NaN, prototype keys, ids of things that don't exist or aren't
 * theirs) without throwing, and nothing one colony sends may change another colony's pawns,
 * zones, buildings, bills, prisoners or letters.
 */

const KINDS: Command['c'][] = [
  'designate',
  'build',
  'zone',
  'unzone',
  'deconstruct',
  'packUp',
  'setHome',
  'setPriority',
  'zoneSettings',
  'addBill',
  'updateBill',
  'removeBill',
  'choose',
  'offerTrade',
  'settlementTrade',
  'deliverRequest',
  'steal',
  'hunt',
  'possess',
  'steer',
  'sneak',
  'interact',
  'draft',
  'move',
  'attack',
  'capture',
  'equip',
  'release',
];

/** Field names any command might read. */
const FIELDS = ['kind', 'def', 'hollow', 'plant', 'x', 'y', 'x0', 'y0', 'x1', 'y1', 'pawn', 'pawns', 'work', 'prio', 'zone', 'allow', 'bench', 'recipe', 'mode', 'target', 'bill', 'suspended', 'choice', 'option', 'to', 'give', 'want', 'note', 'settlement', 'request', 'item', 'on', 'dx', 'dy'];

/** Values that have broken naive validation somewhere. */
const NASTY: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -1,
  1,
  0.5,
  -0,
  NaN,
  Infinity,
  -Infinity,
  1e308,
  2 ** 31,
  2 ** 53,
  '',
  'x',
  '1',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  [],
  [1],
  [[1]],
  [['__proto__', 1]],
  [['constructor', 5]],
  [['wood', NaN]],
  [['wood', -5]],
  [['wood', 1e9]],
  {},
  // What msgpack hands over for {"toString":1,"valueOf":1}: String() and Number() throw on it.
  { toString: 1, valueOf: 1 },
  { length: 1e9 },
];

const PROTO = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

interface Scene {
  w: World;
  attacker: number;
  victim: number;
  /** Ids worth aiming at: the victim's things, the attacker's own, wildlife, settlements. */
  ids: number[];
  /** Coordinates in and around the victim's colony, for areas and move orders. */
  coords: number[];
}

function scene(seed: number): Scene {
  const w = createWorld({ seed, width: 90, height: 90 });
  const a = addPlayerFaction(w, 'Attacker');
  const b = addPlayerFaction(w, 'Victim');
  const v = b.home;
  // The victim: a stockpile, a field, a bench with a bill, a possessed and sneaking colonist, a drafted one, a prisoner, an open letter.
  w.enqueue(b.id, { c: 'zone', kind: 'stockpile', x0: v.x - 2, y0: v.y - 2, x1: v.x + 2, y1: v.y + 2 });
  w.enqueue(b.id, { c: 'zone', kind: 'grow', plant: 'potato', x0: v.x + 4, y0: v.y - 2, x1: v.x + 7, y1: v.y + 2 });
  w.enqueue(a.id, { c: 'zone', kind: 'stockpile', x0: a.home.x - 2, y0: a.home.y - 2, x1: a.home.x + 2, y1: a.home.y + 2 });
  run(w, 5);
  const bench = w.spawnBuilding('crafting_spot', w.map.idx(v.x - 4, v.y + 4), b.id);
  bench.bills.push({ id: w.nextBillId++, recipe: 'make_club', mode: 'forever', target: 0, suspended: false });
  w.spawnBuilding('bed', w.map.idx(v.x - 5, v.y + 4), b.id);
  const field = [...w.zones.values()].find((z) => z.faction === b.id && z.kind === 'grow')!;
  for (const c of field.cells.slice(0, 6)) if (!w.map.plantAt[c]) w.spawnPlant('potato', c, 0.9);
  const bp = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === b.id);
  w.enqueue(b.id, { c: 'possess', pawn: bp[0].id, on: true });
  w.enqueue(b.id, { c: 'sneak', pawn: bp[0].id, on: true });
  w.enqueue(b.id, { c: 'steer', pawn: bp[0].id, dx: 1, dy: 0 });
  w.enqueue(b.id, { c: 'draft', pawns: [bp[1].id], on: true });
  const prisoner = w.spawnPawn(b.id, w.map.idx(v.x - 5, v.y + 4), 'Captive');
  prisoner.prisoner = 'held';
  offerChoice(w, b.id, 'trade', 'A letter', 'For the victim only.', [
    { key: 'accept', label: 'Accept' },
    { key: 'decline', label: 'Decline' },
  ], 24, { from: a.id, give: [], want: [['wood', 1]] });
  // The attacker gets a weapon to pick up and a choice of its own too.
  w.spawnItem('bow', 1, w.map.idx(a.home.x + 1, a.home.y + 1));
  run(w, 3);
  const ids = [...w.entities.keys(), ...w.zones.keys(), ...w.factions.keys(), ...w.choices.keys(), bench.bills[0].id];
  const coords = [v.x, v.y].flatMap((c) => [c - 6, c - 2, c, c + 3, c + 7]);
  return { w, attacker: a.id, victim: b.id, ids, coords };
}

/** Everything the victim owns that another colony's commands must never touch. */
function victimState(w: World, f: number): string {
  const ents = [...w.entities.values()].filter((e) => e.faction === f && e.kind !== 'plant' && e.kind !== 'item').sort((x, y) => x.id - y.id);
  const zones = [...w.zones.values()].filter((z) => z.faction === f);
  const fieldDesig = zones.filter((z) => z.kind === 'grow').flatMap((z) => z.cells.map((c) => w.map.desig[c]));
  const crops = zones.filter((z) => z.kind === 'grow').flatMap((z) => z.cells.map((c) => w.map.plantAt[c]));
  const letters = [...w.choices.values()].filter((c) => c.faction === f && c.event !== 'trade').map((c) => c.id);
  const trades = [...w.choices.values()].filter((c) => c.faction === f && c.event === 'trade').map((c) => c.id);
  return JSON.stringify({ ents, zones, fieldDesig, crops, letters, trades: trades.slice(0, 1), faction: w.factions.get(f) });
}

function nasty(rng: Rng, s: Scene): unknown {
  const r = rng.next();
  if (r < 0.35) return s.ids[rng.int(s.ids.length)];
  if (r < 0.45) return [s.ids[rng.int(s.ids.length)], s.ids[rng.int(s.ids.length)]];
  if (r < 0.5) return PROTO[rng.int(PROTO.length)];
  return NASTY[rng.int(NASTY.length)];
}

const NUMS = new Set(['x', 'y', 'x0', 'y0', 'x1', 'y1', 'pawn', 'prio', 'zone', 'bench', 'target', 'bill', 'choice', 'to', 'settlement', 'request', 'item', 'dx', 'dy']);
const NAMES: Record<string, string[]> = {
  kind: ['mine', 'chop', 'cut', 'harvest', 'steal', 'cancel', 'stockpile', 'grow'],
  def: Object.keys(BUILDINGS),
  plant: Object.keys(PLANTS),
  work: [...WORK_TYPES],
  mode: ['count', 'forever', 'until'],
  recipe: Object.keys(RECIPES),
  option: ['accept', 'decline', 'yes', 'no'],
  note: ['hello'],
};

/** A value of the right type for the field, aimed at something real: passes the wire checks and reaches the game rules. */
function typed(rng: Rng, s: Scene, f: string): unknown {
  const id = () => s.ids[rng.int(s.ids.length)];
  if (/^[xy]\d?$/.test(f) && rng.chance(0.7)) return s.coords[rng.int(s.coords.length)];
  if (NUMS.has(f)) return rng.chance(0.6) ? id() : [0, -1, 1, 45, 89, 90, 1e6, -1e6][rng.int(8)];
  if (NAMES[f]) return NAMES[f][rng.int(NAMES[f].length)];
  if (f === 'pawns') return [id(), id(), id()];
  if (f === 'allow') return ['resource', 'meal', 'bogus'];
  if (f === 'give' || f === 'want') return [[Object.keys(ITEMS)[rng.int(Object.keys(ITEMS).length)], 1 + rng.int(40)]];
  return rng.chance(0.5);
}

function randomCommand(rng: Rng, s: Scene): Command {
  const cmd: Record<string, unknown> = { c: KINDS[rng.int(KINDS.length)] };
  const wellTyped = rng.chance(0.6);
  for (const f of FIELDS) if (rng.chance(0.6)) cmd[f] = wellTyped ? typed(rng, s, f) : nasty(rng, s);
  if (wellTyped && rng.chance(0.7)) {
    // A sensible area over the victim's colony.
    cmd.x0 = s.coords[rng.int(5)];
    cmd.y0 = s.coords[5 + rng.int(5)];
    cmd.x1 = (cmd.x0 as number) + rng.int(9);
    cmd.y1 = (cmd.y0 as number) + rng.int(9);
  }
  return cmd as unknown as Command;
}

/** No NaN or Infinity may get into saved state: it breaks the save format and every comparison after. */
function badNumbers(w: World): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (typeof v === 'number' && !Number.isFinite(v)) out.push(path);
    else if (v && typeof v === 'object' && depth < 6 && !ArrayBuffer.isView(v)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
  };
  for (const e of w.entities.values()) walk(e, `${e.kind}${e.id}`, 0);
  for (const z of w.zones.values()) walk(z, `zone${z.id}`, 0);
  for (const f of w.factions.values()) walk(f, `faction${f.id}`, 0);
  return out;
}

describe('command validation', () => {
  it('garbage and cross-colony commands never throw and never touch another colony', () => {
    for (const seed of [3, 11]) {
      const s = scene(seed);
      const { w } = s;
      const rng = new Rng(seed * 31 + 7);
      for (let round = 0; round < 40; round++) {
        for (let k = 0; k < 50; k++) {
          const cmd = randomCommand(rng, s);
          const before = victimState(w, s.victim);
          expect(() => applyCommand(w, s.attacker, cmd), JSON.stringify(cmd)).not.toThrow();
          const after = victimState(w, s.victim);
          if (after !== before) expect.fail(`${JSON.stringify(cmd)} changed the victim's colony`);
        }
        // Let the attacker's orders play out a little, so later commands meet pawns mid-job.
        expect(() => run(w, 10)).not.toThrow();
        expect(badNumbers(w), `round ${round}`).toEqual([]);
      }
      // The world still saves and loads.
      expect(hashWorld(deserializeWorld(serializeWorld(w)))).toBe(hashWorld(w));
    }
  });

  it("commands naming another colony's pawns are ignored", () => {
    const s = scene(5);
    const { w } = s;
    const theirs = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).filter((p) => p.faction === s.victim);
    const steered = theirs.find((p) => p.possessed)!;
    const prisoner = theirs.find((p) => p.prisoner)!;
    const item = [...w.kinds.item].find((id) => w.get(id)!.kind === 'item')!;
    const settlement = [...w.factions.values()].find((f) => f.settlement)!;
    const cmds: Command[] = theirs.flatMap((p): Command[] => [
      { c: 'possess', pawn: p.id, on: true },
      { c: 'possess', pawn: p.id, on: false },
      { c: 'steer', pawn: p.id, dx: -1, dy: 1 },
      { c: 'sneak', pawn: p.id, on: !p.sneaking },
      { c: 'interact', pawn: p.id },
      { c: 'steal', pawn: p.id, item },
      { c: 'draft', pawns: [p.id], on: !p.drafted },
      { c: 'move', pawns: [p.id], x: 1, y: 1 },
      { c: 'attack', pawns: [p.id], target: steered.id },
      { c: 'equip', pawn: p.id, item: 0 },
      { c: 'setPriority', pawn: p.id, work: 'haul', prio: 0 },
      { c: 'release', pawn: prisoner.id },
      { c: 'capture', pawns: [p.id], target: prisoner.id },
      { c: 'hunt', pawns: [p.id], on: true },
      { c: 'settlementTrade', settlement: s.victim, give: [], want: [['wood', 5]] },
      { c: 'deliverRequest', settlement: settlement.id, request: 1 },
    ]);
    const before = victimState(w, s.victim);
    for (const cmd of cmds) applyCommand(w, s.attacker, cmd);
    expect(victimState(w, s.victim)).toBe(before);
    expect(steered.possessed).toBe(true);
    expect(steered.steer).toEqual([1, 0]);
    expect(prisoner.prisoner).toBe('held');
  });

  it("a colony can't mark another colony's crops to cut or harvest", () => {
    const s = scene(5);
    const { w } = s;
    const field = [...w.zones.values()].find((z) => z.faction === s.victim && z.kind === 'grow')!;
    const xs = field.cells.map((c) => w.map.cx(c));
    const ys = field.cells.map((c) => w.map.cy(c));
    const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    for (const kind of ['cut', 'harvest', 'chop'] as const) applyCommand(w, s.attacker, { c: 'designate', kind, ...rect });
    expect(field.cells.map((c) => w.map.desig[c]).every((d) => d === 0)).toBe(true);
    // Their own colonists still can.
    applyCommand(w, s.victim, { c: 'designate', kind: 'cut', ...rect });
    expect(field.cells.some((c) => w.map.desig[c] !== 0)).toBe(true);
  });

  it('prototype keys are not item, building, plant or recipe names', () => {
    const s = scene(5);
    const { w } = s;
    const a = w.factions.get(s.attacker)!;
    const town = [...w.factions.values()].find((f) => f.settlement)!;
    const before = w.entities.size;
    for (const def of PROTO) {
      applyCommand(w, s.attacker, { c: 'build', def, hollow: false, x0: a.home.x + 4, y0: a.home.y + 4, x1: a.home.x + 6, y1: a.home.y + 6 });
      expect(() => applyCommand(w, s.attacker, { c: 'offerTrade', to: s.victim, give: [], want: [[def, 1]] })).not.toThrow();
      expect(() => applyCommand(w, s.attacker, { c: 'settlementTrade', settlement: town.id, give: [[def, 1]], want: [] })).not.toThrow();
    }
    expect(w.entities.size).toBe(before);
    expect([...w.kinds.construct].map((id) => w.get<Construct>(id)!.def).filter((d) => PROTO.includes(d))).toEqual([]);
  });

  it('a bad priority number leaves the priority alone', () => {
    const s = scene(5);
    const { w } = s;
    const p = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!).find((x) => x.faction === s.attacker)!;
    const was = p.priorities.haul;
    for (const prio of [NaN, 'abc', undefined, null, {}, Infinity]) applyCommand(w, s.attacker, { c: 'setPriority', pawn: p.id, work: 'haul', prio: prio as number });
    expect(Number.isFinite(p.priorities.haul)).toBe(true);
    expect([was, 4, 0]).toContain(p.priorities.haul);
  });

  it('only stockpiles and fields can be zoned', () => {
    const s = scene(5);
    const { w } = s;
    const a = w.factions.get(s.attacker)!;
    for (const kind of ['farm', '', 7, null, '__proto__']) applyCommand(w, s.attacker, { c: 'zone', kind: kind as 'grow', x0: a.home.x + 5, y0: a.home.y + 5, x1: a.home.x + 7, y1: a.home.y + 7 });
    expect([...w.zones.values()].every((z) => z.kind === 'stockpile' || z.kind === 'grow')).toBe(true);
  });

  it('a whole hour of garbage through the queue keeps the world deterministic', () => {
    const go = () => {
      const s = scene(9);
      const rng = new Rng(99);
      for (let t = 0; t < TICKS_PER_HOUR; t++) {
        for (let k = 0; k < 3; k++) s.w.enqueue(rng.chance(0.5) ? s.attacker : s.victim, randomCommand(rng, s));
        s.w.step();
      }
      return hashWorld(s.w);
    };
    expect(go()).toBe(go());
  });
});
