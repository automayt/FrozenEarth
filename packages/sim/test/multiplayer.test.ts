import { describe, expect, it } from 'vitest';
import {
  allied,
  createWorld,
  daysUntilFrost,
  SITE_MIN_FROST_DAYS,
  START_TICK,
  suggestSites,
  addPlayerFaction,
  siteProblem,
  MIN_COLONY_GAP,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type Item,
  type World,
} from '../src';
import { addPawn, flatWorld, run, runUntil } from './helpers';

/** Two player colonies, 2 at (10, 30) and 3 at (60, 30). */
function friends(): World {
  const w = flatWorld(80, 60);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Astrid', color: 0xff0000, home: { x: 10, y: 30 }, isPlayer: true });
  w.factions.set(3, { id: 3, name: 'Bjorn', color: 0x0000ff, home: { x: 60, y: 30 }, isPlayer: true });
  return w;
}

const said = (w: World, faction: number, re: RegExp) => w.dirty.msgs.some((m) => m.faction === faction && re.test(m.text));

describe('offers between players', () => {
  it('record who sent them, and wait while the recipient is offline', () => {
    const w = friends();
    w.online = new Set([2]);
    w.enqueue(2, { c: 'diplomacy', act: 'ally', target: 3 });
    run(w, 2);
    const offer = [...w.choices.values()].find((c) => c.event === 'pact_offer')!;
    expect(offer.from).toBe(2);
    expect(offer.faction).toBe(3);
    expect(said(w, 2, /offline: it will wait/)).toBe(true);
    // Three days pass with Bjorn away: the offer is still there, with hours left on it.
    run(w, TICKS_PER_DAY * 3);
    expect(w.choices.has(offer.id)).toBe(true);
    expect(offer.expires - w.tick).toBeGreaterThanOrEqual(4 * TICKS_PER_HOUR - 1);
    // Bjorn comes back and lets it lapse: Astrid hears it ran out, not that it was turned down.
    w.online.add(3);
    w.dirty.msgs.length = 0;
    runUntil(w, () => !w.choices.has(offer.id), 10 * TICKS_PER_HOUR);
    expect(allied(w, 2, 3)).toBe(false);
    expect(said(w, 2, /didn't answer your alliance in time/)).toBe(true);
    expect(said(w, 2, /declined/)).toBe(false);
  });

  it('a recipient who answers gets a plain decline message sent back', () => {
    const w = friends();
    w.enqueue(2, { c: 'diplomacy', act: 'ally', target: 3 });
    run(w, 2);
    const offer = [...w.choices.values()].find((c) => c.event === 'pact_offer')!;
    w.enqueue(3, { c: 'choose', choice: offer.id, option: 'decline' });
    run(w, 2);
    expect(said(w, 2, /declined your alliance/)).toBe(true);
  });

  it('without presence information (tests, tools) offers expire as before', () => {
    const w = friends();
    w.enqueue(2, { c: 'diplomacy', act: 'ally', target: 3 });
    run(w, 2);
    run(w, TICKS_PER_DAY + 10);
    expect([...w.choices.values()].some((c) => c.event === 'pact_offer')).toBe(false);
  });
});

describe('hauling near other colonies', () => {
  it('a hauler that set out for a loose item leaves it alone once the owner zones it', () => {
    const w = friends();
    const ours = w.createZone(2, 'stockpile');
    for (let y = 28; y < 33; y++) w.addZoneCell(ours, w.map.idx(8, y));
    // Lying loose between the two colonies, well outside either's claim.
    w.placeItemNear('wood', 20, w.map.idx(35, 30));
    const hauler = addPawn(w, 30, 30, 2);
    runUntil(w, () => hauler.job?.type === 'haul', 600);
    // Before the hauler gets there, Bjorn's colony zones that cell.
    const theirs = w.createZone(3, 'stockpile');
    w.addZoneCell(theirs, w.map.idx(35, 30));
    run(w, 600);
    expect(w.dirty.msgs.some((m) => /stealing|gone missing/.test(m.text))).toBe(false);
    const wood = [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === 'wood');
    expect(wood.reduce((a, i) => a + (w.zoneAt(w.cellOf(i))?.faction === 3 ? i.count : 0), 0)).toBe(20);
  });

  it("a neighbour's loose starting supplies near their home aren't hauled away", () => {
    const w = friends();
    const ours = w.createZone(2, 'stockpile');
    for (let y = 28; y < 33; y++) w.addZoneCell(ours, w.map.idx(8, y));
    w.placeItemNear('steel', 30, w.map.idx(62, 32));
    addPawn(w, 40, 30, 2);
    run(w, 2000);
    const steel = [...w.kinds.item].map((id) => w.get<Item>(id)!).filter((i) => i.def === 'steel');
    expect(steel.every((i) => w.zoneAt(w.cellOf(i))?.faction !== 2)).toBe(true);
  });
});

describe('joining late', () => {
  it('suggests a spot next to an existing colony, for friends who want to be neighbours', () => {
    const w = createWorld({ seed: 6, width: 160, height: 160 });
    const ann = addPlayerFaction(w, "Ann's colony", 3);
    const near = suggestSites(w, 5).filter((s) => s.region === `next to ${ann.name}`);
    expect(near.length).toBe(1);
    const d = Math.hypot(near[0].x - ann.home.x, near[0].y - ann.home.y);
    expect(d).toBeGreaterThanOrEqual(MIN_COLONY_GAP);
    expect(d).toBeLessThan(MIN_COLONY_GAP + 20);
    expect(siteProblem(w, near[0].x, near[0].y)).toBeNull();
  });

  it('suggested sites leave a newcomer at least a week before the frost', () => {
    const w = createWorld({ seed: 6, width: 160, height: 160 });
    w.tick = START_TICK + 30 * TICKS_PER_DAY;
    const sites = suggestSites(w, 5);
    expect(sites.length).toBeGreaterThan(1);
    for (const s of sites) expect(daysUntilFrost(s.x, s.y, w.map.w, w.map.h, w.tick, w.frost, 30)).toBeGreaterThanOrEqual(SITE_MIN_FROST_DAYS);
  });
});
