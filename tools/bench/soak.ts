/**
 * Soak test: a long run with everything on (settlements, wildlife, raids on colonies and
 * settlements, theft, direct control, trade, a moving frost line) and random player commands,
 * sampling every collection that could grow without bound, plus tick cost per window.
 *
 *   npm run soak -- --ticks 120000 --colonies 4 [--size 160] [--seed 3] [--every 10000]
 *
 * Exits non-zero if a tracked collection keeps growing past its bound (see LIMITS).
 */
import { parseArgs } from 'node:util';
import { encode } from '@fe/protocol';
import { addPlayerFaction, createWorld, fireEvent, resolveChoice, Rng, serializeWorld, TICKS_PER_DAY, TICKS_PER_HOUR, type Pawn, type World } from '@fe/sim';
import { Chaos } from '../bots/src/chaos';

const { values: args } = parseArgs({
  options: {
    ticks: { type: 'string', default: '120000' },
    colonies: { type: 'string', default: '4' },
    size: { type: 'string', default: '160' },
    seed: { type: 'string', default: '3' },
    every: { type: 'string', default: '10000' },
    pace: { type: 'string', default: '3' },
    bare: { type: 'boolean', default: false },
  },
});

const TICKS = Number(args.ticks);
const EVERY = Number(args.every);

function setup(): World {
  const w = createWorld({ seed: Number(args.seed), width: Number(args.size), height: Number(args.size), settlements: !args.bare, wildlife: !args.bare });
  // The frost moves from day 1, so over a long run it reaches colonies and settlements.
  w.frost = { startDay: 1, pace: Number(args.pace), minRadius: 0.18 };
  for (let i = 0; i < Number(args.colonies); i++) {
    const f = addPlayerFaction(w, `C${i}`, 4);
    const { x, y } = f.home;
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', x0: x - 3, y0: y - 3, x1: x + 3, y1: y + 3 });
    w.enqueue(f.id, { c: 'zone', kind: 'grow', plant: 'potato', x0: x - 12, y0: y + 5, x1: x - 5, y1: y + 11 });
    w.enqueue(f.id, { c: 'designate', kind: 'chop', x0: x - 20, y0: y - 20, x1: x + 20, y1: y + 20 });
  }
  return w;
}

/** Sizes of everything that should stay bounded over a long game. */
function sample(w: World) {
  const pawns = [...w.kinds.pawn].map((id) => w.get<Pawn>(id)!);
  const facs = [...w.factions.values()];
  let requests = 0;
  let met = 0;
  let goodwill = 0;
  let helpers = 0;
  for (const f of facs) {
    requests += f.settlement?.requests?.length ?? 0;
    met += f.settlement?.met.length ?? 0;
    goodwill += Object.keys(f.settlement?.goodwill ?? {}).length;
    helpers += Object.keys(f.raid?.helpers ?? {}).length;
  }
  const s = w.story;
  return {
    entities: w.entities.size,
    pawns: pawns.length,
    items: w.kinds.item.size,
    factions: w.factions.size,
    raiderFactions: facs.filter((f) => f.raid).length,
    zones: w.zones.size,
    reservations: w.reservations.size,
    unreachable: w.unreachable.size,
    staleUnreachable: [...w.unreachable.values()].filter((until) => until <= w.tick).length,
    choices: w.choices.size,
    choiceData: w.choiceData.size,
    desigCells: w.desigCells.size,
    fireCells: w.fireCells.size,
    damaged: w.damaged.size,
    radiant: w.radiant.size,
    rooms: w.rooms.size,
    conditions: w.conditions.length,
    giveUp: pawns.filter((p) => p.giveUp).length,
    staleGiveUp: pawns.filter((p) => p.giveUp && p.giveUp[1] <= w.tick).length,
    maxThoughts: Math.max(0, ...pawns.map((p) => p.thoughts.length)),
    maxPawnConditions: Math.max(0, ...pawns.map((p) => p.conditions.length)),
    requests,
    met,
    goodwill,
    helpers,
    scheduled: s.scheduled.length,
    lastFired: Object.keys(s.lastFired).length,
    storyKeys: Object.keys(s.threat).length + Object.keys(s.lastBad).length + Object.keys(s.frostNotice ?? {}).length,
    uniqueFired: s.uniqueFired.length,
    pendingMsgs: w.dirty.msgs.length,
    wallChanges: w.map.wallChanges.length,
  };
}

type Sample = ReturnType<typeof sample>;

/** Bounds a healthy world stays inside, whatever the length of the game. */
const LIMITS: Partial<Record<keyof Sample, (s: Sample) => number>> = {
  staleGiveUp: (s) => s.pawns,
  choices: (s) => 6 * s.factions,
  choiceData: (s) => s.choices,
  pendingMsgs: () => 0,
  raiderFactions: () => 12,
  scheduled: () => 40,
};

const w = setup();
const rng = new Rng(Number(args.seed) * 977 + 1);
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
const players = [...w.factions.values()].filter((f) => f.isPlayer).map((f) => f.id);
const rows: (Sample & { tick: number; msPerTick: number; worstMs: number; deltaKB: number; saveKB: number; heapMB: number })[] = [];
let windowMs = 0;
let worst = 0;
let deltaBytes = 0;
let cmds = 0;
let events = 0;
const t0 = performance.now();
for (let t = 1; t <= TICKS; t++) {
  // A few commands a second across the colonies, roughly what busy players send.
  if (rng.chance(0.05)) {
    const who = players[rng.int(players.length)];
    const got = chaos.random(who);
    if (got) {
      w.enqueue(who, got.cmd);
      cmds++;
    }
  }
  // Trouble every half day or so, on top of whatever the storyteller sends.
  if (t % (TICKS_PER_DAY / 2) === 0) {
    const ev = ['raid', 'settlement_raid', 'settlement_plea', 'peddler', 'night_raid'][rng.int(5)];
    if (fireEvent(w, ev, ev === 'settlement_raid' ? 0 : players[rng.int(players.length)])) events++;
  }
  // Players answer letters now and then; the rest expire on their own.
  if (t % TICKS_PER_HOUR === 0) {
    for (const c of [...w.choices.values()]) if (rng.chance(0.3)) resolveChoice(w, c.id, c.options[rng.int(c.options.length)].key, c.faction);
  }
  const s = performance.now();
  w.step();
  const dt = performance.now() - s;
  windowMs += dt;
  worst = Math.max(worst, dt);
  if (t % 4 === 0) deltaBytes += encode({ t: 'delta', d: w.takeDelta(), time: { speed: 3, paused: false, reason: '' } }).length;
  if (t % EVERY === 0) {
    (globalThis as { gc?: () => void }).gc?.();
    const row = {
      tick: t,
      msPerTick: +(windowMs / EVERY).toFixed(3),
      worstMs: +worst.toFixed(1),
      deltaKB: Math.round(deltaBytes / 1024),
      saveKB: Math.round(encode({ t: 'pong', at: 0, save: serializeWorld(w) } as never).length / 1024),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      ...sample(w),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    windowMs = 0;
    worst = 0;
    deltaBytes = 0;
  }
}

const problems: string[] = [];
const last = rows.at(-1)!;
for (const [k, limit] of Object.entries(LIMITS) as [keyof Sample, (s: Sample) => number][]) {
  for (const r of rows) if (r[k] > limit(r)) problems.push(`${k} = ${r[k]} at tick ${r.tick} (limit ${limit(r)})`);
}
// Tick cost must not drift: the last window no slower than 3x the cheapest one.
const cheapest = Math.min(...rows.map((r) => r.msPerTick));
if (rows.length >= 3 && last.msPerTick > cheapest * 3 + 0.2) problems.push(`tick cost drifted from ${cheapest} to ${last.msPerTick} ms`);
// What is lying around at the end, outside any stockpile: the usual source of slow growth.
const loose = new Map<string, number>();
for (const id of w.kinds.item) {
  const it = w.get(id) as { def: string; x: number; y: number; rot: number };
  if (w.zoneAt(w.map.idx(it.x, it.y))?.kind === 'stockpile') continue;
  const k = `${it.def}${it.rot >= 1 ? ' (rotten)' : ''}`;
  loose.set(k, (loose.get(k) ?? 0) + 1);
}
console.log(`loose item stacks: ${[...loose].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(
  JSON.stringify({ ticks: TICKS, days: +(TICKS / TICKS_PER_DAY).toFixed(1), seconds: +((performance.now() - t0) / 1000).toFixed(1), cmds, events, frostRadius: +w.frostRadius().toFixed(3), problems }),
);
process.exit(problems.length ? 1 : 0);
