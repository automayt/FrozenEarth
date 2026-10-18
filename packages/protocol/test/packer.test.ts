import { describe, expect, it } from 'vitest';
import { snapshot, type Pawn } from '@fe/sim';
import { flatWorld, addPawn } from '../../sim/test/helpers';
import { decode, DeltaPacker, encode, Mirror, type ServerMsg, type WireDelta } from '../src';

type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;
const time = { speed: 1, paused: false, reason: '' };
const wire = (d: WireDelta): WireDelta => decode<DeltaMsg>(encode({ t: 'delta', d, time })).d;
const joined = (w: ReturnType<typeof flatWorld>): Mirror => {
  const m = new Mirror();
  m.applySnapshot(decode<Extract<ServerMsg, { t: 'welcome' }>>(encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) })).snap);
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
  const first = packer.pack(w.takeDelta());
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
    const d = packer.pack(w.takeDelta());
    expect(d.ents).toEqual([]);
    expect(d.patches).toEqual([{ id: p.id, set: { sneaking: true, weapon: 'knife' } }]);
    m.applyDelta(wire(d));
    expect(m.get<Pawn>(p.id)).toEqual(p);

    delete p.sneaking;
    w.markDirty(p);
    const d2 = packer.pack(w.takeDelta());
    expect(d2.patches).toEqual([{ id: p.id, set: {}, del: ['sneaking'] }]);
    m.applyDelta(wire(d2));
    expect(m.get<Pawn>(p.id)!.sneaking).toBeUndefined();
    expect('sneaking' in m.get<Pawn>(p.id)!).toBe(false);

    // XP alone, or a step along the same path, is not worth a resend; nothing else changed, so nothing goes.
    const skill = Object.keys(p.skills)[0] as keyof Pawn['skills'];
    p.skills[skill].xp += 3;
    w.markDirty(p);
    expect(packer.pack(w.takeDelta()).patches).toBeUndefined();
    // A level-up sends the skill table, XP and all.
    p.skills[skill].level++;
    w.markDirty(p);
    const d3 = packer.pack(w.takeDelta());
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
      const d = wire(packer.pack(w.takeDelta()));
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
    m.applyDelta(wire(packer.pack(w.takeDelta())));
    expect(m.get(p.id)).toBeUndefined();
    const q = addPawn(w, 8, 8);
    const d = packer.pack(w.takeDelta());
    expect(d.ents.map((e) => e.id)).toEqual([q.id]);
    const fresh = new Mirror();
    fresh.applyDelta({ ...d, ents: [], patches: [{ id: 999, set: { x: 1 } }] });
    expect(fresh.get(999)).toBeUndefined();
    expect(fresh.missedPatches).toBe(1);
  });
});
