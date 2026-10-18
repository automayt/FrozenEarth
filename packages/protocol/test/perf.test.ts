import { describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, type World } from '@fe/sim';
import { DeltaPacker, encode } from '../src';

/**
 * Cheap guards against performance regressions. A busy world (four colonies of five, two
 * settlements' worth of townsfolk, wildlife) currently runs at about 0.02 ms per tick on a
 * laptop; the time budget is 20x that, so a slow CI machine never trips it, but an accidental
 * O(n^2) in a per-tick path does. It sends about 6 KB/s of deltas (20 KB/s before changed
 * entities went out as field patches). The bandwidth budgets are exact counts on a seeded world,
 * so they never flake; raise them deliberately (with the new numbers in the message) when a
 * feature really needs to send more.
 */

const TICKS = 8000;

function busy(): World {
  const w = createWorld({ seed: 5, width: 200, height: 200 });
  for (let i = 0; i < 4; i++) {
    const f = addPlayerFaction(w, `C${i}`, 5);
    const { x, y } = f.home;
    const r = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', ...r(x - 3, y - 3, x + 3, y + 3) });
    w.enqueue(f.id, { c: 'zone', kind: 'grow', plant: 'potato', ...r(x - 12, y + 5, x - 5, y + 11) });
    w.enqueue(f.id, { c: 'build', def: 'wood_wall', hollow: true, ...r(x + 5, y - 5, x + 12, y + 2) });
    w.enqueue(f.id, { c: 'designate', kind: 'chop', ...r(x - 20, y - 20, x + 20, y + 20) });
    w.enqueue(f.id, { c: 'designate', kind: 'mine', ...r(x - 25, y - 25, x + 25, y + 25) });
  }
  for (let i = 0; i < 2000; i++) w.step();
  w.takeDelta();
  return w;
}

describe('performance budget', () => {
  it('a busy world stays well inside its tick and bandwidth budgets', () => {
    const w = busy();
    const packer = new DeltaPacker();
    let bytes = 0;
    let rawBytes = 0;
    let resent = 0;
    // Best of a few slices, so one GC pause or a busy CI neighbour doesn't count against it.
    let best = Infinity;
    for (let slice = 0; slice < 4; slice++) {
      const t0 = performance.now();
      for (let i = 0; i < TICKS / 4; i++) {
        w.step();
        if (i % 4 === 0) {
          const raw = w.takeDelta();
          rawBytes += encode({ t: 'delta', d: raw, time: { speed: 3, paused: false, reason: '' } }).length;
          // What the server sends: entities seen before go out as patches of what changed.
          const d = packer.pack(raw, w.map.w);
          resent += d.ents.length + (d.patches?.length ?? 0);
          bytes += encode({ t: 'delta', d, time: { speed: 3, paused: false, reason: '' } }).length;
        }
      }
      best = Math.min(best, (performance.now() - t0) / (TICKS / 4));
    }
    expect(best, `ms per tick (${w.entities.size} entities)`).toBeLessThan(0.4);
    const seconds = TICKS / 60;
    // On the wire, after field patching and compact walks (protocol 9): was ~6,100. Whole entities, as protocol 8 sent them: ~20,500.
    expect(bytes / seconds, `wire delta bytes per game second (was ~6,100)`).toBeLessThan(9_000);
    // What the sim marks as changed, sent whole: a guard on the sim's own dirty-marking.
    expect(rawBytes / seconds, `unpacked delta bytes per game second (was ~20,500)`).toBeLessThan(30_000);
    expect(resent / seconds, `entities resent per game second (was ~48)`).toBeLessThan(80);
  });
});
