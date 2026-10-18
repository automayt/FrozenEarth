import { describe, expect, it } from 'vitest';
import { snapshot, START_TICK, TICKS_PER_DAY, World, type Faction, type Pawn, type RaidGoal } from '@fe/sim';
import { Mirror } from '@fe/protocol';
import { computeAlerts } from '../src/ui/Alerts';
import { store } from '../src/store';

const ME = 2;

/** A colony of three, fed and bedded, at the start of a game, as the client sees it. */
function colony(): { w: World; m: Mirror; pawns: Pawn[] } {
  const w = new World(1, 60, 60);
  for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
  w.tick = START_TICK;
  w.factions.set(ME, { id: ME, name: 'Us', color: 0xffffff, home: { x: 30, y: 30 }, isPlayer: true });
  const pawns = [0, 1, 2].map((k) => w.spawnPawn(ME, w.map.idx(30 + k, 30), `Col${k} Onist`));
  for (const [k, p] of pawns.entries()) {
    w.spawnBuilding('bed', w.map.idx(28 + k, 25), ME);
    p.job = { type: 'build', stage: 0, target: 0 };
  }
  w.placeItemNear('survival_meal', 40, w.map.idx(32, 32));
  return { w, m: load(w), pawns };
}

function load(w: World): Mirror {
  const m = new Mirror();
  m.applySnapshot(structuredClone(snapshot(w)));
  store.mirror = m;
  store.me = { playerId: 1, faction: ME };
  store.time = { speed: 1, paused: true, reason: '' };
  store.setServerTick(w.tick);
  return m;
}

const keys = () => computeAlerts().map((a) => a.key);

describe('alerts', () => {
  it('nothing before you have a colony, and a quiet, provisioned colony has nothing to nag about', () => {
    colony();
    store.me = null;
    expect(computeAlerts()).toEqual([]);
    store.me = { playerId: 1, faction: ME };
    expect(computeAlerts()).toEqual([]);
  });

  it('a raid on you says what the raiders are up to, and goes once they flee or if it is on someone else', () => {
    const { w } = colony();
    const raiders: Faction = { id: 5, name: 'Raiders of Test', color: 0, home: { x: 0, y: 0 }, isPlayer: false, raid: { target: ME, size: 2, breakAt: 1, dead: 0, until: w.tick + 9999, fled: false } };
    w.factions.set(5, raiders);
    w.spawnPawn(5, w.map.idx(5, 5), 'Bad Guy');
    const m = load(w);
    const raid = () => computeAlerts().find((a) => a.key === 'raid-5');
    expect(raid()).toMatchObject({ severity: 'critical', title: 'Raiders of Test: attacking (1)', focus: { x: 5, y: 5 } });
    const titles: Record<RaidGoal, string> = { assault: 'attacking', loot: 'looting your stores', burn: 'setting fires', siege: 'besieging you' };
    for (const [goal, what] of Object.entries(titles)) {
      m.factions.get(5)!.raid!.goal = goal as RaidGoal;
      expect(raid()?.title).toBe(`Raiders of Test: ${what} (1)`);
    }
    m.factions.get(5)!.raid!.fled = true;
    expect(raid()).toBeUndefined();
    m.factions.get(5)!.raid!.fled = false;
    m.factions.get(5)!.raid!.target = 9;
    expect(raid()).toBeUndefined();
  });

  it("promises to settlements show how long is left, turning to a warning on the last day", () => {
    const { w } = colony();
    const until = w.tick + 2 * TICKS_PER_DAY;
    w.factions.set(7, {
      id: 7,
      name: 'Pinewick',
      color: 0,
      home: { x: 50, y: 50 },
      isPlayer: false,
      settlement: { temper: 0, goodwill: {}, radius: 8, state: 'home', dest: -1, until: 0, met: [ME], requests: [{ id: 3, faction: ME, item: 'cat:raw_food', count: 40, reward: ['gold', 4], goodwill: 15, until, why: '' }, { id: 4, faction: 99, item: 'wood', count: 5, reward: 'recruit', goodwill: 15, until, why: '' }] },
    });
    load(w);
    const req = computeAlerts().filter((a) => a.key.startsWith('request-'));
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ key: 'request-3', severity: 'info', title: 'Pinewick wants 40 raw food', focus: { x: 50, y: 50 } });
    expect(req[0].detail).toMatch(/^2 days left/);
    store.setServerTick(until - TICKS_PER_DAY / 4);
    expect(computeAlerts().find((a) => a.key === 'request-3')).toMatchObject({ severity: 'warning', detail: expect.stringMatching(/^Under 6 hours left/) });
  });

  it('hunger, bedlessness, idleness, letters and the frost line, most urgent first', () => {
    const { w, pawns } = colony();
    for (const id of [...w.kinds.item]) w.despawn(id);
    for (const id of [...w.kinds.building]) w.despawn(id);
    pawns[0].needs.food = 0.05;
    pawns[1].job = null;
    w.choices.set(1, { id: 1, faction: ME, event: 'peddler', title: 't', text: '', options: [{ key: 'ok', label: 'ok' }], expires: w.tick + 100 });
    w.choices.set(2, { id: 2, faction: 99, event: 'peddler', title: 't', text: '', options: [{ key: 'ok', label: 'ok' }], expires: w.tick + 100 });
    // The frost has already swallowed all but the middle of the map, and the colony sits near the edge.
    w.frost = { startDay: 0, pace: 100, minRadius: 0.18 };
    w.factions.get(ME)!.home = { x: 4, y: 4 };
    w.tick += 20 * TICKS_PER_DAY;
    load(w);
    const all = computeAlerts();
    expect(all.map((a) => a.key).sort()).toEqual(['beds', 'food', 'frost', 'hungry-' + pawns[0].id, 'idle', 'letters'].sort());
    expect(all.find((a) => a.key === 'food')).toMatchObject({ severity: 'critical', detail: 'About 0.0 days of food left.' });
    expect(all.find((a) => a.key === 'frost')).toMatchObject({ severity: 'critical', title: 'Your colony is in the frozen zone' });
    expect(all.find((a) => a.key === 'letters')?.title).toBe('1 decision waiting');
    expect(all.find((a) => a.key === 'beds')?.detail).toBe('3 colonists sleep on the ground.');
    const order = { critical: 0, warning: 1, info: 2 };
    expect(all.map((a) => order[a.severity])).toEqual([...all.map((a) => order[a.severity])].sort());
  });

  it('a fire near home is critical; far away it is not your problem', () => {
    const { w } = colony();
    w.setFire(w.map.idx(58, 58), 2);
    let m = load(w);
    expect(keys()).not.toContain('fire');
    w.setFire(w.map.idx(40, 40), 2);
    m = load(w);
    expect(m.fireCells.size).toBe(2);
    expect(computeAlerts().find((a) => a.key === 'fire')).toMatchObject({ severity: 'critical', focus: { x: 40, y: 40 } });
  });

  it('a war with another colony is always listed, and urgent once their people reach you; allies hear when it reaches theirs', () => {
    const { w } = colony();
    w.factions.set(3, { id: 3, name: 'Rivals', color: 0x00ff00, home: { x: 55, y: 55 }, isPlayer: true, pacts: { [ME]: { kind: 'war', since: w.tick } } });
    w.factions.get(ME)!.pacts = { 3: { kind: 'war', since: w.tick } };
    load(w);
    expect(computeAlerts().find((a) => a.key === 'war-3')).toMatchObject({ severity: 'warning', title: 'At war with Rivals', diplo: 3 });
    w.spawnPawn(3, w.map.idx(35, 35), 'Foe One');
    load(w);
    expect(keys()).not.toContain('war-3');
    expect(computeAlerts().find((a) => a.key === 'war-near-3')).toMatchObject({ severity: 'critical', title: 'Rivals: 1 of theirs at your colony' });
    // Seen from a third colony allied with us: our war at our door is their alert too.
    w.factions.set(4, { id: 4, name: 'Friends', color: 0x0000ff, home: { x: 5, y: 55 }, isPlayer: true, pacts: { [ME]: { kind: 'ally', since: w.tick } } });
    w.factions.get(ME)!.pacts![4] = { kind: 'ally', since: w.tick };
    load(w);
    store.me = { playerId: 9, faction: 4 };
    expect(computeAlerts().find((a) => a.key === `allywar-${ME}-3`)).toMatchObject({ severity: 'warning', title: 'Your ally Us is under attack (1)' });
  });
});
