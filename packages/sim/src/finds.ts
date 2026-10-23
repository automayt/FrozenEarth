import { ANIMALS, ITEMS, T } from '@fe/defs';
import { tell } from './chronicle';
import { offerChoice, registerChoice } from './choices';
import { addCondition } from './health';
import { pawnName } from './names';
import { adoptAnimal } from './taming';
import type { Caravan, Faction, Pawn } from './types';
import { spawnAnimal } from './wildlife';
import type { World } from './world';

/**
 * What a caravan finds on the road, rolled at waypoints: tracks of game close by, a frozen
 * traveller's pack, a stray pack animal that falls in behind, a lost traveller who asks to come
 * along, thin ice. A trip has at most a couple of these, so each one is an event.
 */

/** Chance at each waypoint (past the first few) that the road holds something. */
export const FIND_CHANCE = 0.09;
/** Most finds in one trip. */
export const MAX_FINDS = 2;

export type RoadFind = 'tracks' | 'pack' | 'stray' | 'traveller' | 'ice';

const PACK_NOTES = [
  'A letter in the pack, never sent: "We are nearly there."',
  'They had wrapped their boots in strips of a flag.',
  'Their compass still points true. They were walking inward.',
  'A tin of matches, each one counted off on the lid.',
];

export function roadFinds(w: World, f: Faction, c: Caravan, at: number): void {
  if (c.waiting !== undefined || c.leg < 2 || (c.finds ?? 0) >= MAX_FINDS || !c.members.length) return;
  const onIce = nearIce(w, at);
  if (!w.rng.chance(onIce ? FIND_CHANCE * 2.5 : FIND_CHANCE)) return;
  const pool: [RoadFind, number][] = [
    ['tracks', 3],
    ['pack', 3],
    ['stray', 1.5],
    ['traveller', 1],
    ['ice', onIce ? 8 : 0],
  ];
  const total = pool.reduce((a, [, n]) => a + n, 0);
  let r = w.rng.next() * total;
  let kind: RoadFind = 'pack';
  for (const [k, n] of pool) {
    r -= n;
    if (r <= 0) {
      kind = k;
      break;
    }
  }
  if (roadFind(w, f, c, at, kind)) {
    c.finds = (c.finds ?? 0) + 1;
    w.dirty.factions.add(f.id);
  }
}

function nearIce(w: World, at: number): boolean {
  const m = w.map;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = m.cx(at) + dx;
      const y = m.cy(at) + dy;
      if (m.inBounds(x, y) && m.terrain[m.idx(x, y)] === T.ice) return true;
    }
  }
  return false;
}

/** Open ground about `dist` cells off the road from `at`, reachable from it, or -1. */
function offRoad(w: World, at: number, dist: number): number {
  const m = w.map;
  const comp = m.component(at);
  for (let tries = 0; tries < 30; tries++) {
    const a = w.rng.next() * Math.PI * 2;
    const d = dist * (0.7 + w.rng.next() * 0.6);
    const x = Math.round(m.cx(at) + Math.cos(a) * d);
    const y = Math.round(m.cy(at) + Math.sin(a) * d);
    if (x < 1 || y < 1 || x >= m.w - 1 || y >= m.h - 1) continue;
    const c = m.idx(x, y);
    if (!m.solid[c] && m.component(c) === comp && !m.buildingAt[c]) return c;
  }
  return -1;
}

/** One find on the road, by kind. False if there was nowhere to put it. */
export function roadFind(w: World, f: Faction, c: Caravan, at: number, kind: RoadFind): boolean {
  const lead = w.get<Pawn>(c.members[0]);
  const who = lead && lead.kind === 'pawn' ? lead.name.split(' ')[0] : 'Someone';
  switch (kind) {
    case 'tracks': {
      const def = w.rng.chance(0.35) ? ANIMALS.muskox : ANIMALS.deer;
      const spot = offRoad(w, at, 10);
      if (spot < 0) return false;
      const n = def.group[0] + w.rng.int(def.group[1] - def.group[0] + 1);
      const m = w.map;
      for (let k = 0; k < n; k++) {
        const x = Math.max(1, Math.min(m.w - 2, m.cx(spot) + w.rng.int(5) - 2));
        const y = Math.max(1, Math.min(m.h - 2, m.cy(spot) + w.rng.int(5) - 2));
        const cell = m.idx(x, y);
        spawnAnimal(w, def.key, m.solid[cell] ? spot : cell);
      }
      w.message(f.id, `${who} found fresh tracks crossing the road: ${def.label.toLowerCase()}, not far off. Mark them to hunt, or to tame.`, 'good', spot);
      return true;
    }
    case 'pack': {
      const goods: [string, number][] = [['survival_meal', 3 + w.rng.int(6)]];
      const extra = w.rng.pick(['cloth', 'steel', 'parka', 'tuque', 'gold'] as const);
      goods.push([extra, extra === 'parka' || extra === 'tuque' ? 1 : extra === 'gold' ? 3 + w.rng.int(5) : 15 + w.rng.int(25)]);
      for (const [def, n] of goods) {
        const line = c.cargo.find((l) => l[0] === def);
        if (line) line[1] += n;
        else c.cargo.push([def, n]);
      }
      const what = goods.map(([d, n]) => (n === 1 ? `a ${ITEMS[d].label.toLowerCase()}` : `${n} ${ITEMS[d].label.toLowerCase()}`)).join(' and ');
      w.message(f.id, `Beside the road, a traveller who didn't make it, frozen where they sat. Their pack held ${what}; it goes in with your things. ${w.rng.pick(PACK_NOTES)}`, 'neutral', at);
      return true;
    }
    case 'stray': {
      const def = w.rng.chance(0.6) ? ANIMALS.muskox : ANIMALS.deer;
      const spot = offRoad(w, at, 3);
      if (spot < 0) return false;
      const a = spawnAnimal(w, def.key, spot);
      const name = adoptAnimal(w, a, f.id);
      (c.beasts ??= []).push(a.id);
      w.message(f.id, `A ${def.label.toLowerCase()} with a frayed halter falls in behind the caravan. Someone lost it, and it has chosen you. You call it ${name}.`, 'good', spot);
      tell(w, f.id, `A stray ${def.label.toLowerCase()} joined the caravan on the road. They called it ${name}.`);
      return true;
    }
    case 'traveller': {
      offerChoice(
        w,
        f.id,
        'road_traveller',
        'A traveller on the road',
        'Someone is walking the same road, alone, with almost nothing on their back. They ask if they can walk with your caravan, and stay with you at the end of it.',
        [
          { key: 'take', label: 'Take them along' },
          { key: 'leave', label: 'Wish them luck' },
        ],
        1.5,
        {},
        at,
      );
      return true;
    }
    case 'ice': {
      const p = w.get<Pawn>(w.rng.pick(c.members));
      if (!p || p.kind !== 'pawn') return false;
      if (w.rng.chance(0.5)) {
        w.message(f.id, `The ice groans under the caravan, and ${p.name.split(' ')[0]} freezes mid-step. It holds.`, 'neutral', w.cellOf(p));
        return true;
      }
      const cold = p.conditions.find((k) => k.key === 'hypothermia');
      if (cold) cold.severity = Math.min(0.9, cold.severity + 0.3);
      else addCondition(w, p, 'hypothermia', 0.32);
      w.markDirty(p);
      w.message(f.id, `The ice gave way under ${p.name.split(' ')[0]}. The others hauled them out, soaked and freezing. Get them warm.`, 'bad', w.cellOf(p));
      tell(w, f.id, `${p.name} went through the ice on the road, and was pulled out alive.`);
      return true;
    }
  }
}

registerChoice('road_traveller', (w, ch, option) => {
  const f = w.factions.get(ch.faction);
  const c = f?.caravan;
  if (!f || !c || option !== 'take' || c.at === undefined) return;
  const m = w.map;
  let cell = c.at;
  for (let r = 1; r <= 3 && m.solid[cell]; r++) cell = m.idx(Math.min(m.w - 1, m.cx(c.at) + r), m.cy(c.at));
  const p = w.spawnPawn(f.id, cell, pawnName(w.rng), undefined, w.rng.pick(['', 'knife', 'club']));
  p.needs.food = 0.5;
  p.needs.rest = 0.6;
  c.members.push(p.id);
  w.dirty.factions.add(f.id);
  w.message(f.id, `${p.name} walks with your caravan now, and will make a home with you at the end of the road.`, 'good', cell);
  tell(w, f.id, `${p.name}, met on the road, joined the colony.`, 'first_colonist');
});
