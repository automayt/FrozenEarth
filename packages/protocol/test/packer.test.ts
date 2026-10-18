import { describe, expect, it } from 'vitest';
import { snapshot, type Pawn } from '@fe/sim';
import { flatWorld, addPawn } from '../../sim/test/helpers';
import {
  decode,
  DeltaPacker,
  encode,
  Mirror,
  packPath,
  packSnapshot,
  unpackPath,
  type ServerMsg,
  type WireDelta,
} from '../src';

type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;
const time = { speed: 1, paused: false, reason: '' };
const wire = (d: WireDelta): WireDelta => decode<DeltaMsg>(encode({ t: 'delta', d, time })).d;
const joined = (w: ReturnType<typeof flatWorld>): Mirror => {
  const m = new Mirror();
  m.applySnapshot(
    decode<Extract<ServerMsg, { t: 'welcome' }>>(
      encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) }),
    ).snap,
  );
  return m;
};

function setup() {
  const w = flatWorld(30, 30);
  const p = addPawn(w, 5, 5);
  const packer = new DeltaPacker();
  const m = joined(w);
  w.takeDelta();
  // First time an entity changes it goes out whole.
  w.markDirty(p);
  const first = packer.pack(w.takeDelta(), w.map.w);
  expect(first.ents.map((e) => e.id)).toEqual([p.id]);
  m.applyDelta(wire(first));
  return { w, p, packer, m };
}

describe('delta packer: changed entities go out as field patches', () => {
  it('sends just the fields that changed, removes fields that are gone, and skips changes nobody can see', () => {
    const { w, p, packer, m } = setup();
    p.sneaking = true;
    p.weapon = 'knife';
    w.markDirty(p);
    const d = packer.pack(w.takeDelta(), w.map.w);
    expect(d.ents).toEqual([]);
    expect(d.patches).toEqual([{ id: p.id, set: { sneaking: true, weapon: 'knife' } }]);
    m.applyDelta(wire(d));
    expect(m.get<Pawn>(p.id)).toEqual(p);

    delete p.sneaking;
    w.markDirty(p);
    const d2 = packer.pack(w.takeDelta(), w.map.w);
    expect(d2.patches).toEqual([{ id: p.id, set: {}, del: ['sneaking'] }]);
    m.applyDelta(wire(d2));
    expect(m.get<Pawn>(p.id)!.sneaking).toBeUndefined();
    expect('sneaking' in m.get<Pawn>(p.id)!).toBe(false);

    // XP alone, or a step along the same path, is not worth a resend; nothing else changed, so nothing goes.
    const skill = Object.keys(p.skills)[0] as keyof Pawn['skills'];
    p.skills[skill].xp += 3;
    w.markDirty(p);
    expect(packer.pack(w.takeDelta(), w.map.w).patches).toBeUndefined();
    // A level-up sends the skill table, XP and all.
    p.skills[skill].level++;
    w.markDirty(p);
    const d3 = packer.pack(w.takeDelta(), w.map.w);
    expect(d3.patches).toEqual([{ id: p.id, set: { skills: p.skills } }]);
    m.applyDelta(wire(d3));
    expect(m.get<Pawn>(p.id)!.skills).toEqual(p.skills);
  });

  it('a snapshot resets it, so a late joiner never misses a field that changed back', () => {
    for (const reset of [false, true]) {
      const { w, p, packer, m } = setup();
      // Changed without being sent (a coarse field, or one the sim didn't mark): the joiner's snapshot has it...
      p.sneaking = true;
      const late = joined(w);
      if (reset) packer.reset();
      // ...and then it changes back to what everyone else was last sent.
      delete p.sneaking;
      p.asleep = !p.asleep;
      w.markDirty(p);
      const d = wire(packer.pack(w.takeDelta(), w.map.w));
      m.applyDelta(d);
      late.applyDelta(d);
      expect(m.get(p.id)).toEqual(p);
      if (reset) expect(late.get(p.id)).toEqual(p);
      else expect(late.get<Pawn>(p.id)!.sneaking).toBe(true);
    }
  });

  it('a removed entity is forgotten, and a patch for an entity a mirror lacks is counted, not invented', () => {
    const { w, p, packer, m } = setup();
    w.despawn(p.id);
    m.applyDelta(wire(packer.pack(w.takeDelta(), w.map.w)));
    expect(m.get(p.id)).toBeUndefined();
    const q = addPawn(w, 8, 8);
    const d = packer.pack(w.takeDelta(), w.map.w);
    expect(d.ents.map((e) => e.id)).toEqual([q.id]);
    const fresh = new Mirror();
    fresh.applyDelta({ ...d, ents: [], patches: [{ id: 999, set: { x: 1 } }] });
    expect(fresh.get(999)).toBeUndefined();
    expect(fresh.missedPatches).toBe(1);
  });
});

describe('walks on the wire', () => {
  it('a path goes out as one byte of direction and one of time per step, and comes back exact', () => {
    const w = flatWorld(30, 30);
    const p = addPawn(w, 5, 5);
    const packer = new DeltaPacker();
    const m = joined(w);
    w.enqueue(1, { c: 'draft', pawns: [p.id], on: true });
    w.enqueue(1, { c: 'move', pawns: [p.id], x: 20, y: 25 });
    w.step();
    w.step();
    expect(p.path?.cells.length).toBeGreaterThan(10);
    const d = packer.pack(w.takeDelta(), w.map.w);
    const sent = d.ents.find((e) => e.id === p.id) as unknown as {
      path: { dir: Uint8Array; cells?: number[] };
    };
    expect(sent.path.cells).toBeUndefined();
    expect(sent.path.dir.length).toBe(p.path!.cells.length);
    // The sim's own pawn is untouched.
    expect(Array.isArray(p.path!.cells)).toBe(true);
    const bytes = encode({ t: 'delta', d, time }).length;
    expect(bytes).toBeLessThan(
      encode({ t: 'delta', d: { ...d, ents: [p] }, time }).length - 4 * p.path!.cells.length,
    );
    m.applyDelta(wire(d));
    expect(m.get<Pawn>(p.id)!.path).toEqual(p.path);
    // A snapshot carries walks the same way.
    const late = new Mirror();
    late.applySnapshot(
      decode<Extract<ServerMsg, { t: 'welcome' }>>(
        encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: packSnapshot(snapshot(w)) }),
      ).snap,
    );
    expect(late.get<Pawn>(p.id)!.path).toEqual(p.path);
  });

  it('a walk with a step that is not to a neighbour, or too slow for a byte, goes out as it is', () => {
    const base = { idx: 0, goal: 0, adj: false, t0: 100, fx: 1, fy: 1 };
    const odd = { ...base, cells: [2 * 30 + 2, 2 * 30 + 5], times: [110, 120] };
    expect(packPath(odd, 30)).toBe(odd);
    const slow = { ...base, cells: [2 * 30 + 2], times: [400] };
    expect(packPath(slow, 30)).toBe(slow);
    const ok = { ...base, cells: [2 * 30 + 2, 2 * 30 + 1, 30 + 1], times: [113, 131, 144] };
    expect(unpackPath(packPath(ok, 30), 30)).toEqual(ok);
  });
});
