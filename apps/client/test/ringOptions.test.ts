import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pawn } from '@fe/sim';
import { store } from '../src/store';
import { ringPlan } from '../src/render/ringOptions';

const sent: unknown[] = [];
vi.mock('../src/net', () => ({ command: (c: unknown) => sent.push(c), send: vi.fn() }));

const ME = 2;
const FOE = 7;

function pawn(id: number, faction: number, over: Partial<Pawn> = {}): Pawn {
  return { id, kind: 'pawn', x: 5, y: 5, faction, name: `Person${id} Test`, drafted: false, downed: false, prisoner: '', conditions: [], job: null, path: null, ...over } as Pawn;
}

const spot = (target: Pawn | undefined, x = 5, y = 5) => ({ target, x, y, flash: vi.fn(), inspect: vi.fn() });
const keys = (p: ReturnType<typeof ringPlan>) => p.options.map((o) => o.key);

describe('the ring of orders', () => {
  const m = store.mirror;
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    sent.length = 0;
    m.w = m.h = 20;
    const n = m.w * m.h;
    m.rock = new Uint8Array(n);
    m.desig = new Uint8Array(n);
    m.desigFaction = new Uint8Array(n);
    m.itemAt = new Int32Array(n) as never;
    m.plantAt = new Int32Array(n) as never;
    m.buildingAt = new Int32Array(n) as never;
    m.constructAt = new Int32Array(n) as never;
    m.zoneAt = new Int32Array(n) as never;
    m.entities.clear();
    m.factions.clear();
    m.factions.set(ME, { id: ME, name: 'Us', isPlayer: true } as never);
    m.factions.set(FOE, { id: FOE, name: 'Red Band', raid: { target: ME } } as never);
    store.me = { playerId: 1, faction: ME };
    store.squad = [];
    store.selected = null;
  });
  afterEach(() => {
    store.me = null;
    store.squad = [];
  });

  function draft(): Pawn {
    const p = pawn(1, ME, { drafted: true, x: 2, y: 2 });
    m.entities.set(p.id, p);
    store.squad = [p.id];
    return p;
  }

  it('offers nothing on empty ground with nobody drafted, so the old right-click still deselects', () => {
    const p = ringPlan(spot(undefined));
    expect(p.options).toEqual([]);
    expect(p.quick).toBeNull();
  });

  it('moves at once on open ground with drafted colonists', () => {
    draft();
    const s = spot(undefined, 9, 10);
    const p = ringPlan(s);
    expect(p.quick?.key).toBe('move');
    p.quick!.run();
    expect(sent).toEqual([{ c: 'move', pawns: [1], x: 9, y: 10 }]);
    expect(s.flash).toHaveBeenCalledWith(9, 10, false);
  });

  it('holding on open ground gives the move first and a way to stand down', () => {
    draft();
    expect(keys(ringPlan(spot(undefined)))).toEqual(['move', 'undraft']);
  });

  it('a drafted squad still moves past a tree on a plain click, with the tree\'s orders in the ring', () => {
    draft();
    m.plantAt[m.idx(5, 5)] = 50;
    m.entities.set(50, { id: 50, kind: 'plant', def: 'oak', x: 5, y: 5, growth: 1 } as never);
    const p = ringPlan(spot(undefined));
    expect(p.quick?.key).toBe('move');
    expect(keys(p)).toContain('chop');
  });

  it('attacks a raider first, and moves second, with drafted colonists', () => {
    draft();
    const foe = pawn(2, FOE);
    m.entities.set(foe.id, foe);
    const p = ringPlan(spot(foe));
    expect(p.quick).toBeNull();
    expect(keys(p).slice(0, 2)).toEqual(['attack', 'move']);
    p.options[0].run();
    expect(sent).toEqual([{ c: 'attack', pawns: [1], target: 2 }]);
  });

  it('captures a downed raider first', () => {
    draft();
    const foe = pawn(2, FOE, { downed: true });
    m.entities.set(foe.id, foe);
    const p = ringPlan(spot(foe));
    expect(p.options[0].key).toBe('capture');
    p.options[0].run();
    expect(sent).toEqual([{ c: 'capture', pawns: [1], target: 2 }]);
  });

  it('offers hunt and tame on a wild deer, marked state and all, drafted or not', () => {
    const deer = pawn(3, 0, { species: 'deer' });
    m.entities.set(deer.id, deer);
    let p = ringPlan(spot(deer));
    expect(p.title).toBe('Deer');
    expect(keys(p).slice(0, 2)).toEqual(['hunt', 'tame']);
    p.options[1].run();
    expect(sent).toEqual([{ c: 'tame', pawns: [3], on: true }]);
    deer.hunted = ME;
    deer.taming = ME;
    p = ringPlan(spot(deer));
    expect(p.options[0].label).toBe('Stop hunting');
    expect(p.options[1].label).toBe('Stop taming');
  });

  it('does not offer to tame what can\'t be', () => {
    const wolf = pawn(3, 0, { species: 'wolf' });
    m.entities.set(wolf.id, wolf);
    expect(keys(ringPlan(spot(wolf)))).not.toContain('tame');
  });

  it('asks before an attack that starts a war, and says what it means', () => {
    draft();
    m.factions.set(9, { id: 9, name: 'Neighbours', isPlayer: true } as never);
    const other = pawn(4, 9);
    m.entities.set(other.id, other);
    const o = ringPlan(spot(other)).options[0];
    expect(o.key).toBe('attack');
    expect(o.confirm).toBe(true);
    expect(o.detail).toContain('starts a war with Neighbours');
  });

  it('marks rock for mining, and offers to take it back', () => {
    const c = m.idx(5, 5);
    m.rock[c] = 1;
    let p = ringPlan(spot(undefined));
    expect(p.title).toBe('Rock');
    expect(p.options[0].key).toBe('mine');
    p.options[0].run();
    expect(sent).toEqual([{ c: 'designate', kind: 'mine', x0: 5, y0: 5, x1: 5, y1: 5 }]);
    m.desig[c] = 1;
    m.desigFaction[c] = ME;
    p = ringPlan(spot(undefined));
    expect(p.options[0].label).toBe('Stop mining');
  });

  it('gives your own colonist draft and control, and Inspect last', () => {
    const me = pawn(6, ME);
    m.entities.set(me.id, me);
    const s = spot(me);
    const p = ringPlan(s);
    expect(keys(p)).toEqual(['draft', 'possess', 'inspect']);
    p.options[2].run();
    expect(s.inspect).toHaveBeenCalled();
  });

  it('gives nothing to someone still choosing where to settle', () => {
    store.me = { playerId: 1, faction: 0 };
    expect(ringPlan(spot(undefined)).options).toEqual([]);
  });
});
