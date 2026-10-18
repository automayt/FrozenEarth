import { ITEMS } from '@fe/defs';
import { offerChoice, registerChoice } from './choices';
import { allied } from './pacts';
import { raidPoints, startRaid } from './raids';
import { dispositionOf, FRIENDLY_AT, goodwillOf, GUARD_REACH, liveTowns, shiftGoodwill } from './settlements';
import type { Caravan, Faction } from './types';
import type { World } from './world';

/**
 * What a caravan meets on the road: towns that want a toll to cross their land (or wave friends
 * through, or shoot at enemies), raiders lying in wait in mountain passes, other colonies'
 * caravans, and at nightfall a friendly town's offer of a roof.
 */

/** A toll is about this share of the cargo's worth, within these bounds. */
const TOLL_SHARE = 0.08;
const TOLL_MIN = 15;
const TOLL_MAX = 150;
/** Chance raiders are waiting in a given pass (one ambush a journey at most). */
const AMBUSH_CHANCE = 0.35;
/** Rock cells within 4 of the route (of 81) that make it a pass. */
const PASS_ROCK = 25;
/** How far a friendly town will send word offering shelter at nightfall. */
const SHELTER_RANGE = 30;
/** Caravans this close meet on the road. */
const MEET_RANGE = 15;

export const ROAD = { tollPaid: 2, tollRefused: -12, sheltered: 1 } as const;

export function cargoValue(cargo: [string, number][]): number {
  return cargo.reduce((a, [d, n]) => a + (ITEMS[d]?.marketValue ?? 0) * n, 0);
}

/** What a town would ask to let this cargo through. */
export function tollFor(cargo: [string, number][]): number {
  return Math.round(Math.max(TOLL_MIN, Math.min(TOLL_MAX, cargoValue(cargo) * TOLL_SHARE)));
}

/** A new waypoint reached: towns whose land it is, passes, other caravans. */
export function roadEncounters(w: World, f: Faction, c: Caravan): void {
  const at = c.route[Math.min(c.leg, c.route.length - 1)];
  towns(w, f, c, at);
  ambush(w, f, c, at);
  meetOthers(w, f, c, at);
}

function towns(w: World, f: Faction, c: Caravan, at: number): void {
  const m = w.map;
  for (const t of liveTowns(w)) {
    const s = t.settlement!;
    if (s.state !== 'home' || c.dealt.includes(t.id)) continue;
    if (Math.hypot(m.cx(at) - t.home.x, m.cy(at) - t.home.y) > s.radius + GUARD_REACH) continue;
    c.dealt.push(t.id);
    w.dirty.factions.add(f.id);
    const home = m.idx(t.home.x, t.home.y);
    if (allied(w, f.id, t.id)) {
      w.message(f.id, `${t.name}, your ally, waves your caravan through.`, 'good', home);
      continue;
    }
    const mood = dispositionOf(s, f.id);
    if (mood === 'friendly') {
      w.message(f.id, `Your caravan crosses ${t.name}'s land. They call out a greeting.`, 'good', home);
      continue;
    }
    if (mood === 'hostile') {
      w.message(f.id, `Your caravan is on ${t.name}'s land, and they want you dead. Their guards will attack: hurry through, or draft your people.`, 'bad', home);
      continue;
    }
    const toll = tollFor(c.cargo);
    if (cargoValue(c.cargo) < toll) continue;
    const choice = offerChoice(
      w,
      f.id,
      'caravan_toll',
      `${t.name} asks a toll`,
      `Your caravan is crossing ${t.name}'s land. They ask goods worth ${toll} to let it pass. Refusing will sour them on you.`,
      [
        { key: 'pay', label: `Pay ${toll}` },
        { key: 'refuse', label: 'Refuse and go on' },
      ],
      2,
      { town: t.id, toll },
      home,
    );
    c.waiting = choice.id;
    return;
  }
}

registerChoice('caravan_toll', (w, ch, option, d) => {
  const f = w.factions.get(ch.faction);
  const t = w.factions.get(Number(d.town));
  const c = f?.caravan;
  if (!f || !c) return;
  if (c.waiting === ch.id) c.waiting = undefined;
  w.dirty.factions.add(f.id);
  if (!t?.settlement) return;
  const toll = Number(d.toll);
  if (option === 'pay' && payFromCargo(c, toll)) {
    shiftGoodwill(w, t, f.id, ROAD.tollPaid, 'Paid our toll', false);
    w.message(f.id, `You paid ${t.name}'s toll. Your caravan goes on.`, 'neutral');
    return;
  }
  shiftGoodwill(w, t, f.id, ROAD.tollRefused, 'Refused our toll', false);
  w.message(f.id, `Your caravan pushes on without paying. ${t.name} won't forget it.`, 'bad');
});

/** Hand over the cheapest goods first (food last) until the toll is covered. False if the cargo can't cover it. */
function payFromCargo(c: Caravan, toll: number): boolean {
  if (cargoValue(c.cargo) < toll) return false;
  const order = [...c.cargo].sort((a, b) => rank(a[0]) - rank(b[0]) || (ITEMS[a[0]]?.marketValue ?? 0) - (ITEMS[b[0]]?.marketValue ?? 0));
  let owed = toll;
  for (const line of order) {
    if (owed <= 0) break;
    const v = ITEMS[line[0]]?.marketValue ?? 0;
    if (!v || line[0] === 'sledge') continue;
    const n = Math.min(line[1], Math.ceil(owed / v));
    line[1] -= n;
    owed -= n * v;
  }
  // (order holds the same line arrays as the cargo, so the counts above already changed it.)
  c.cargo = c.cargo.filter((l) => l[1] > 0);
  return owed <= 0;
}

const rank = (def: string) => {
  const cat = ITEMS[def]?.category;
  return cat === 'resource' ? 0 : cat === 'apparel' || cat === 'weapon' ? 1 : cat === 'kit' ? 2 : 3;
};

/** A route cell hemmed in by rock on both sides. */
export function isPass(w: World, cell: number): boolean {
  const m = w.map;
  const x = m.cx(cell);
  const y = m.cy(cell);
  let rock = 0;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (m.inBounds(x + dx, y + dy) && m.rock[m.idx(x + dx, y + dy)]) rock++;
  return rock >= PASS_ROCK;
}

function ambush(w: World, f: Faction, c: Caravan, at: number): void {
  if (c.ambushed || !isPass(w, at) || !w.rng.chance(AMBUSH_CHANCE)) return;
  c.ambushed = true;
  w.dirty.factions.add(f.id);
  // They wait a little further along the pass.
  const ahead = c.route[Math.min(c.route.length - 1, c.leg + 2)];
  startRaid(w, f.id, Math.max(120, raidPoints(w, f.id) * 0.6), 'raid', undefined, ahead);
}

function meetOthers(w: World, f: Faction, c: Caravan, at: number): void {
  const m = w.map;
  for (const o of w.factions.values()) {
    const oc = o.caravan;
    if (o.id === f.id || !oc || oc.at === undefined || c.met.includes(o.id)) continue;
    if (Math.hypot(m.cx(oc.at) - m.cx(at), m.cy(oc.at) - m.cy(at)) > MEET_RANGE) continue;
    c.met.push(o.id);
    oc.met.push(f.id);
    w.dirty.factions.add(f.id);
    w.dirty.factions.add(o.id);
    w.message(f.id, `Your caravan meets ${o.name}'s caravan on the road.`, 'neutral', oc.at);
    w.message(o.id, `Your caravan meets ${f.name}'s caravan on the road.`, 'neutral', at);
  }
}

/** Nightfall: a town that likes you, close by, offers a roof for the night. */
export function nightShelter(w: World, f: Faction, c: Caravan): void {
  const m = w.map;
  const at = c.at ?? c.muster;
  let best: Faction | null = null;
  let bestD = SHELTER_RANGE;
  for (const t of liveTowns(w)) {
    const s = t.settlement!;
    if (s.state !== 'home' || !(allied(w, f.id, t.id) || goodwillOf(s, f.id) >= FRIENDLY_AT)) continue;
    const d = Math.hypot(m.cx(at) - t.home.x, m.cy(at) - t.home.y);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  if (!best) return;
  offerChoice(
    w,
    f.id,
    'caravan_shelter',
    `${best.name} offers shelter`,
    `${best.name} sends word: your caravan is welcome to spend the night inside their walls, out of the cold and safe from raiders.`,
    [
      { key: 'accept', label: 'Go to them' },
      { key: 'camp', label: 'Camp out' },
    ],
    1,
    { town: best.id },
    m.idx(best.home.x, best.home.y),
  );
}

registerChoice('caravan_shelter', (w, ch, option, d) => {
  const f = w.factions.get(ch.faction);
  const t = w.factions.get(Number(d.town));
  const c = f?.caravan;
  if (!f || !c || !t?.settlement || option !== 'accept' || c.phase !== 'camp') return;
  c.shelter = t.id;
  w.dirty.factions.add(f.id);
  shiftGoodwill(w, t, f.id, ROAD.sheltered, 'Our guests for a night', false);
  for (const id of c.members) {
    const p = w.get(id);
    if (p && p.kind === 'pawn') {
      p.job = null;
      p.path = null;
      w.markDirty(p);
    }
  }
  w.message(f.id, `Your caravan heads into ${t.name} for the night.`, 'good', w.map.idx(t.home.x, t.home.y));
});
