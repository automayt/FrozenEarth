import { describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, snapshot, type Entity, type World } from '@fe/sim';
import { decode, encode, Mirror, type ServerMsg } from '../src';

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

/** Strip fields that are intentionally sent at coarse granularity. */
function normalize(e: Entity): unknown {
  const c = structuredClone(e) as unknown as Record<string, unknown>;
  if (e.kind === 'pawn') {
    if (e.path) {
      delete c.x;
      delete c.y;
      const path = { ...(c.path as object) } as Record<string, unknown>;
      delete path.idx;
      c.path = path;
    }
    if (c.job) {
      const job = { ...(c.job as object) } as Record<string, unknown>;
      delete job.progress;
      c.job = job;
    }
    // Needs and conditions are resent when they move a visible step, not every tick.
    c.needs = Object.fromEntries(Object.entries(e.needs).map(([k, v]) => [k, Math.round(v * 50)]));
    c.conditions = e.conditions.map((x) => ({ ...x, severity: Math.round(x.severity * 20), immunity: Math.round(x.immunity * 20) }));
  }
  if (e.kind === 'construct') delete c.progress;
  if (e.kind === 'plant') c.growth = Math.floor(e.growth * 20);
  if (e.kind === 'item') c.rot = Math.floor(e.rot * 10);
  return c;
}

function busyWorld(): World {
  const w = createWorld({ seed: 3, width: 100, height: 100 });
  for (const name of ['A', 'B', 'C']) addPlayerFaction(w, name);
  for (const f of w.factions.values()) {
    const { x, y } = f.home;
    w.enqueue(f.id, { c: 'zone', kind: 'stockpile', ...rect(x - 2, y - 2, x + 2, y + 2) });
    w.enqueue(f.id, { c: 'build', def: 'wood_wall', hollow: true, ...rect(x + 4, y - 3, x + 8, y + 1) });
    w.enqueue(f.id, { c: 'designate', kind: 'chop', ...rect(x - 12, y - 12, x + 12, y + 12) });
    w.enqueue(f.id, { c: 'designate', kind: 'mine', ...rect(x - 20, y - 20, x + 20, y + 20) });
  }
  return w;
}

describe('codec', () => {
  it('round-trips a snapshot with byte layers', () => {
    const w = busyWorld();
    const msg: ServerMsg = { t: 'welcome', playerId: 1, faction: 1, token: 'abc', snap: snapshot(w) };
    const back = decode<ServerMsg>(encode(msg));
    expect(back.t).toBe('welcome');
    if (back.t !== 'welcome') return;
    expect(Array.from(back.snap.terrain)).toEqual(Array.from(w.map.terrain));
    expect(back.snap.ents.length).toBe(w.entities.size);
  });
});

describe('replication', () => {
  it('mirror applying deltas matches the server world', () => {
    const w = busyWorld();
    w.takeDelta(); // drop setup noise; the snapshot covers it
    const mirror = new Mirror();
    mirror.applySnapshot(decode<Extract<ServerMsg, { t: 'welcome' }>>(encode({ t: 'welcome', playerId: 1, faction: 1, token: '', snap: snapshot(w) })).snap);

    // A second client that joins halfway through.
    let late: Mirror | null = null;
    for (let i = 0; i < 15_000; i++) {
      w.step();
      if (i % 4 === 0) {
        const bytes = encode({ t: 'delta', d: w.takeDelta(), time: { speed: 1, paused: false, reason: '' } });
        const msg = decode<Extract<ServerMsg, { t: 'delta' }>>(bytes);
        mirror.applyDelta(msg.d);
        late?.applyDelta(msg.d);
      }
      if (i === 7000) {
        late = new Mirror();
        late.applySnapshot(decode<Extract<ServerMsg, { t: 'welcome' }>>(encode({ t: 'welcome', playerId: 2, faction: 2, token: '', snap: snapshot(w) })).snap);
      }
    }
    const final = w.takeDelta();
    mirror.applyDelta(final);
    late!.applyDelta(final);

    for (const m of [mirror, late!]) {
      expect(m.entities.size).toBe(w.entities.size);
      for (const e of w.entities.values()) expect(normalize(m.get(e.id)!)).toEqual(normalize(e));
      expect(Array.from(m.rock)).toEqual(Array.from(w.map.rock));
      expect(Array.from(m.terrain)).toEqual(Array.from(w.map.terrain));
      expect(Array.from(m.desig)).toEqual(Array.from(w.map.desig));
      expect(Array.from(m.fire)).toEqual(Array.from(w.map.fire));
      expect(Array.from(m.zoneAt)).toEqual(Array.from(w.map.zoneAt));
    }
  });
});
