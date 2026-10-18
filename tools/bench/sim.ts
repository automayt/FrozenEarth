/**
 * Sim + network benchmark: a busy 8-colony world, measuring tick cost and delta bandwidth.
 *
 *   npm run bench -- --days 6 --colonies 8 [--bare]
 */
import { parseArgs } from 'node:util';
import { addPlayerFaction, createWorld, resolveChoice, snapshot, TICKS_PER_DAY, type World } from '@fe/sim';
import { encode } from '@fe/protocol';

const { values: args } = parseArgs({ options: { days: { type: 'string', default: '6' }, colonies: { type: 'string', default: '8' }, size: { type: 'string', default: '250' }, seed: { type: 'string', default: '5' }, bare: { type: 'boolean', default: false } } });

function setup(): World {
  // --bare: no settlements or wildlife, for comparing with older numbers.
  const w = createWorld({ seed: Number(args.seed), width: Number(args.size), height: Number(args.size), settlements: !args.bare, wildlife: !args.bare });
  for (let i = 0; i < Number(args.colonies); i++) {
    const f = addPlayerFaction(w, `C${i}`, 5);
    const { x, y } = f.home;
    const r = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', ...r(x - 3, y - 3, x + 3, y + 3) });
    w.enqueue(f.id, { c: 'zone', kind: 'grow', plant: 'potato', ...r(x - 12, y + 5, x - 5, y + 11) });
    w.enqueue(f.id, { c: 'build', def: 'wood_wall', hollow: true, ...r(x + 5, y - 5, x + 12, y + 2) });
    w.enqueue(f.id, { c: 'designate', kind: 'chop', ...r(x - 20, y - 20, x + 20, y + 20) });
    w.enqueue(f.id, { c: 'designate', kind: 'mine', ...r(x - 25, y - 25, x + 25, y + 25) });
  }
  return w;
}

const w = setup();
const snapBytes = encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) }).length;
let deltaBytes = 0;
let deltas = 0;
let worst = 0;
const t0 = performance.now();
const ticks = Number(args.days) * TICKS_PER_DAY;
for (let i = 0; i < ticks; i++) {
  const s = performance.now();
  w.step();
  // The first ticks pay for JIT warm-up and the first room flood fill: not a spike worth reporting.
  if (i > 100) worst = Math.max(worst, performance.now() - s);
  if (i % 4 === 0) {
    deltaBytes += encode({ t: 'delta', d: w.takeDelta(), time: { speed: 3, paused: false, reason: '' } }).length;
    deltas++;
  }
  if (i % TICKS_PER_DAY === 0) for (const c of [...w.choices.values()]) resolveChoice(w, c.id, c.options[0].key, c.faction);
}
const ms = performance.now() - t0;
console.log(
  JSON.stringify({
    ticks,
    msPerTick: +(ms / ticks).toFixed(4),
    worstTickMs: +worst.toFixed(1),
    pawns: w.kinds.pawn.size,
    items: w.kinds.item.size,
    plants: w.kinds.plant.size,
    buildings: w.kinds.building.size,
    snapshotKB: Math.round(snapBytes / 1024),
    // Deltas every 4 ticks at 3x speed = 45/s.
    deltaKBps3x: +((deltaBytes / deltas) * 45 / 1024).toFixed(1),
  }),
);
