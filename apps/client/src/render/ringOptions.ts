import { ANIMALS, BUILDINGS, ITEMS, LANDMARKS, PLANTS, WEAPONS, type LandmarkKind } from '@fe/defs';
import { attackRefusal, atWar, DESIG, dispositionOf, type Item, type Pawn } from '@fe/sim';
import { helpers, mySquad } from '../actions';
import { command } from '../net';
import { store } from '../store';
import type { RingOption, RingPlan } from './ring';

const first = (p: Pawn) => p.name.split(' ')[0];

export interface RingSpot {
  /** The pawn under the cursor, if any. */
  target: Pawn | undefined;
  x: number;
  y: number;
  /** Marks where an order went. */
  flash: (x: number, y: number, attack: boolean) => void;
  /** Selects what's under the cursor. */
  inspect: () => void;
}

const opt = (key: string, label: string, icon: string, run: () => void, more?: Partial<RingOption>): RingOption => ({ key, label, icon, run, ...more });

/** Orders about another faction's pawn for drafted colonists: capture, attack or a reason why not. */
function fightOptions(s: RingSpot, t: Pawn, ids: number[]): RingOption[] {
  const m = store.mirror;
  const me = store.me!.faction;
  const f = m.factions.get(t.faction);
  const raider = !!f?.raid;
  if (t.downed && raider) {
    return [
      opt('capture', 'Capture', 'haul', () => {
        command({ c: 'capture', pawns: ids, target: t.id });
        store.toast(`Capturing ${first(t)}: they'll be carried to a free bed.`, 'neutral');
        s.flash(t.x, t.y, false);
      }, { detail: 'Carry them to a free bed and hold them prisoner.' }),
    ];
  }
  // Allies and truces: your colonists won't (the server says the same).
  const refused = attackRefusal(m, me, t.faction) ?? undefined;
  // Attacking someone you aren't at war with starts a war: the ring says so and makes you mean it.
  const st = f?.settlement;
  const colonyAtPeace = !!f?.isPlayer && !atWar(m, me, t.faction);
  const peaceful = !t.species && !raider && !t.prisoner && (colonyAtPeace || (!!st && st.state !== 'fallen' && dispositionOf(st, me) !== 'hostile'));
  const detail = refused ?? (peaceful ? (f?.isPlayer ? `A surprise attack: it starts a war with ${f.name}, and every town that knows you hears of it.` : `${f?.name} will treat you as enemies.`) : undefined);
  return [
    opt('attack', 'Attack', 'fight', () => {
      command({ c: 'attack', pawns: ids, target: t.id });
      s.flash(t.x, t.y, !t.downed);
    }, { detail, danger: peaceful, confirm: peaceful, refused }),
  ];
}

/** Everything that can be done about one spot, most likely first. */
export function ringPlan(s: RingSpot): RingPlan {
  const m = store.mirror;
  const me = store.me?.faction ?? 0;
  const none: RingPlan = { title: '', options: [], quick: null };
  if (!me || !m.inBounds(s.x, s.y)) return none;
  const c = m.idx(s.x, s.y);
  const { target: t, x, y } = s;
  const squad = mySquad().filter((p) => p.drafted && !p.downed);
  const ids = squad.map((p) => p.id);
  const options: RingOption[] = [];
  const add = (o: RingOption) => options.push(o);
  const foreign = !!t && t.faction !== me;
  let title = 'Here';
  // A target: a drafted squad's plain right-click opens the ring on these rather than walking there.
  let target = false;

  if (t) {
    title = t.species ? (t.tamed ? t.name : (ANIMALS[t.species]?.label ?? t.name)) : first(t);
    if (foreign && squad.length) {
      fightOptions(s, t, ids).forEach(add);
      target = true;
    } else if (foreign && !t.species && t.downed && m.factions.get(t.faction)?.raid) {
      const able = helpers(t.x, t.y);
      if (able.length) {
        add(opt('capture', 'Capture', 'haul', () => command({ c: 'capture', pawns: able.map((h) => h.id), target: t.id }), { detail: 'Carry them to a free bed and hold them prisoner.' }));
        target = true;
      }
    }
    if (t.species && !t.tamed) {
      const def = ANIMALS[t.species];
      const hunted = t.hunted === me;
      const taming = t.taming === me;
      add(opt('hunt', hunted ? 'Stop hunting' : 'Hunt', 'fight', () => command({ c: 'hunt', pawns: [t.id], on: !hunted }), { detail: 'Hunters with a bow or rifle will go after it.' }));
      if (def?.tame) add(opt('tame', taming ? 'Stop taming' : 'Tame', 'tame', () => command({ c: 'tame', pawns: [t.id], on: !taming }), { detail: 'Colonists on Hunt work will try to win it over.' }));
      target = true;
    }
    if (t.faction === me && !t.species) {
      if (t.prisoner === 'held') add(opt('release', 'Release', 'walk', () => command({ c: 'release', pawn: t.id }), { detail: 'Let them walk away.' }));
      else if (!t.prisoner && !t.downed) {
        add(opt('draft', t.drafted ? 'Undraft' : 'Draft', 'flee', () => command({ c: 'draft', pawns: [t.id], on: !t.drafted }), { detail: t.drafted ? 'Back to work.' : 'Stop work and take orders.' }));
        add(opt('possess', t.possessed ? 'Let go' : 'Take control', 'walk', () => command({ c: 'possess', pawn: t.id, on: !t.possessed }), { detail: 'Steer them yourself: WASD to walk, C to sneak, E to take or drop.' }));
      }
    }
  }

  // Goods under the cursor.
  const it = m.get<Item>(m.itemAt[c]);
  if (it?.kind === 'item') {
    const name = ITEMS[it.def]?.label.toLowerCase() ?? 'goods';
    const zone = m.zones.get(m.zoneAt[c]);
    const owner = zone ? m.factions.get(zone.faction) : undefined;
    const able = squad.length ? squad : helpers(x, y);
    if (!t) title = ITEMS[it.def]?.label ?? title;
    if (zone?.kind === 'stockpile' && zone.faction !== me && (owner?.settlement || owner?.isPlayer)) {
      const who = able.length ? able.reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a)) : undefined;
      add(opt('steal', who ? `Steal (${first(who)})` : 'Steal', 'steal', () => {
        if (!who) return;
        command({ c: 'steal', pawn: who.id, item: it.id });
        store.toast(`${first(who)} goes to steal the ${name}. Anyone awake who sees it raises the alarm.`, 'neutral');
        s.flash(x, y, true);
      }, { detail: 'Carry it off now.', refused: who ? undefined : 'No colonist free to go.' }));
      add(opt('steal-later', 'After dark', 'sleep', () => command({ c: 'designate', kind: 'steal', x0: x, y0: y, x1: x, y1: y }), { detail: 'Mark it: haulers sneak in after dark.' }));
      target = true;
    } else if (WEAPONS[it.def] && able.length) {
      const who = able.find((p) => p.drafted) ?? helpers(x, y)[0] ?? able[0];
      add(opt('equip', `Pick up (${first(who)})`, 'fight', () => {
        command({ c: 'equip', pawn: who.id, item: it.id });
        store.toast(`${first(who)} will pick up the ${name}.`, 'neutral');
        s.flash(x, y, false);
      }, { detail: `Wield the ${name}.` }));
      target = true;
    }
  }

  // The ground itself: rock, plants, what's built here. On a drafted squad's plain click these don't get in the way of a move.
  const mine = m.desig[c] && m.desigFaction[c] === me;
  const cancel = (label: string) => add(opt('cancel', label, 'stop', () => command({ c: 'designate', kind: 'cancel', x0: x, y0: y, x1: x, y1: y })));
  let thing = false;
  if (m.rock[c]) {
    thing = true;
    if (!t) title = 'Rock';
    if (mine) cancel('Stop mining');
    else add(opt('mine', 'Mine', 'mine', () => command({ c: 'designate', kind: 'mine', x0: x, y0: y, x1: x, y1: y }), { detail: 'Dig it out for stone and ore.' }));
  }
  const plant = m.get(m.plantAt[c]);
  if (plant?.kind === 'plant') {
    const def = PLANTS[plant.def];
    const zone = m.zones.get(m.zoneAt[c]);
    if (def && (!zone || zone.faction === me)) {
      thing = true;
      if (!t) title = def.label;
      if (m.desig[c] === DESIG.cut && mine) cancel('Leave it');
      else if (m.desig[c] === DESIG.harvest && mine) cancel('Leave it');
      else {
        if (def.tree) add(opt('chop', 'Chop', 'chop', () => command({ c: 'designate', kind: 'chop', x0: x, y0: y, x1: x, y1: y }), { detail: 'Cut it down for wood.' }));
        else {
          if (def.yieldItem) add(opt('harvest', 'Harvest', 'plant', () => command({ c: 'designate', kind: 'harvest', x0: x, y0: y, x1: x, y1: y })));
          add(opt('cut', 'Cut', 'chop', () => command({ c: 'designate', kind: 'cut', x0: x, y0: y, x1: x, y1: y }), { detail: 'Clear it away.' }));
        }
      }
    }
  }
  const con = m.get(m.constructAt[c]);
  if (con?.kind === 'construct' && con.faction === me) {
    thing = true;
    if (!t) title = BUILDINGS[con.def]?.label ?? title;
    cancel('Cancel');
  }
  const b = m.get(m.buildingAt[c]);
  if (b?.kind === 'building') {
    const def = BUILDINGS[b.def];
    if (!t) title = def?.label ?? title;
    if (def?.landmark) {
      const who = helpers(b.x, b.y)[0];
      const seen = m.factions.get(me)?.seen?.includes(b.id);
      if (who && seen) {
        thing = true;
        add(opt('send', `Send ${first(who)}`, 'trek', () => {
          command({ c: 'draft', pawns: [who.id], on: true });
          command({ c: 'move', pawns: [who.id], x: b.x, y: Math.min(m.h - 1, b.y + 1) });
          store.toast(`${first(who)} is heading out to the ${LANDMARKS[b.def as LandmarkKind]?.label.toLowerCase() ?? 'landmark'} (drafted: R sends them back to work).`, 'good');
        }, { detail: 'Walk up to it and search it.' }));
      }
    } else if (b.faction === me) {
      thing = true;
      add(opt('deconstruct', 'Take down', 'build', () => command({ c: 'deconstruct', x0: x, y0: y, x1: x, y1: y }), { detail: 'Remove it; 75% of the materials come back.' }));
    }
  }

  let quick: RingOption | null = null;
  if (squad.length) {
    const move = opt('move', 'Move here', 'walk', () => {
      command({ c: 'move', pawns: ids, x, y });
      s.flash(x, y, false);
    }, { detail: 'They stand there and hold, shooting what comes in range.' });
    if (target) add(move);
    else {
      // Open ground, or only the ground's own orders: a plain click moves, and the move comes first if held.
      quick = move;
      options.unshift(move);
      add(opt('undraft', 'Undraft', 'stop', () => command({ c: 'draft', pawns: ids, on: false }), { detail: 'Back to work.' }));
    }
  }
  if (t || it?.kind === 'item' || thing || b?.kind === 'building') add(opt('inspect', 'Inspect', 'look', s.inspect, { detail: 'Select it and show its panel.' }));
  return { title, options, quick };
}
