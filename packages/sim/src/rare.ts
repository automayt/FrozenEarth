import { chronicleTick } from './chronicle';
import { BUILDINGS, COMFORT_MAX, COMFORT_MIN, EVENTS, ITEMS, PLANTS, T, TERRAINS } from '@fe/defs';
import { CAVE_TEMP, RARE_TICK, ROOF_SHELTER, TICKS_PER_DAY } from './constants';
import { FROST_BAND, FROST_COLD, frostDistance } from './frost';
import { effectsOf, healthTick } from './health';
import { endJob, exposureSeverity, needsWarmth, warmthJob } from './pawns';
import { isRaider } from './combat';
import { prisonerTick, reviewRaids } from './raids';
import { settlementsTick } from './settlements';
import { diplomacyTick } from './diplomacy';
import { animalNeeds, wildlifeTick } from './wildlife';
import { answerUrgentCare } from './work';
import { socialThoughts, socialTick } from './social';
import type { Building, Item, Pawn, Plant, Room } from './types';
import { NEIGHBORS4, type World } from './world';

/** Enclosed regions larger than this count as outdoors. */
const MAX_ROOM_CELLS = 1600;

export function rareTick(w: World): void {
  const t = w.tick;
  for (const id of w.kinds.pawn) {
    if ((t + id) % RARE_TICK === 0) needsTick(w, w.get<Pawn>(id)!);
  }
  if (t % RARE_TICK !== 0) return;
  if (w.map.roomsDirty) rebuildRooms(w);
  else if (w.map.wallChanges.length) updateRooms(w);
  roomTemps(w);
  plantsTick(w);
  freezeWater(w);
  settlementsTick(w);
  diplomacyTick(w);
  chronicleTick(w);
  reviewRaids(w);
  wildlifeTick(w);
  rotTick(w);
  conditionsTick(w);
}

// ---------------------------------------------------------------- ice

/** How far into the frost band water must be before it freezes hard enough to walk on. */
const FREEZE_LEVEL = 0.75;

/**
 * Lakes and rivers well inside the frost freeze into walkable ice, opening new paths across the map.
 * The front only ever advances, so ice never thaws: a pointer walks a list sorted outermost-first.
 */
function freezeWater(w: World): void {
  const m = w.map;
  let q = w.waterQueue;
  if (!q) {
    const dist = new Float64Array(m.w * m.h);
    q = [];
    for (let i = 0; i < m.w * m.h; i++) {
      if (m.terrain[i] !== T.deep_water && m.terrain[i] !== T.shallow_water) continue;
      dist[i] = frostDistance(m.cx(i), m.cy(i), m.w, m.h);
      q.push(i);
    }
    q.sort((a, b) => dist[b] - dist[a] || a - b);
    w.waterQueue = q;
    w.waterNext = 0;
  }
  const edge = w.frostRadius() + FROST_BAND * FREEZE_LEVEL;
  while (w.waterNext < q.length) {
    const c = q[w.waterNext];
    if (frostDistance(m.cx(c), m.cy(c), m.w, m.h) < edge) break;
    w.waterNext++;
    if (m.terrain[c] === T.deep_water || m.terrain[c] === T.shallow_water) w.setTerrain(c, T.ice);
  }
}

// ---------------------------------------------------------------- needs & mood

function needsTick(w: World, p: Pawn): void {
  const n = p.needs;
  const cell = w.cellOf(p);
  const e = effectsOf(w, p);
  // Animals: wounds and weather; wolves get hungry.
  if (p.species) {
    animalNeeds(w, p);
    if (healthTick(w, p, e)) w.markPawnIfChanged(p);
    return;
  }
  // Raiders only stay a day or so: wounds and weather matter, hunger and moods don't.
  if (isRaider(w, p.faction)) {
    if (healthTick(w, p, e)) w.markDirty(p);
    return;
  }
  // Settlers live off stores we don't model, but still tire and sleep.
  const settler = !!w.factions.get(p.faction)?.settlement;
  if (!settler) n.food = Math.max(0, n.food - (RARE_TICK * e.foodDrain) / (p.asleep ? 90_000 : 45_000));
  if (p.asleep) {
    const inBed = p.bed && p.job?.type === 'sleep' && p.job.bed === p.bed;
    n.rest = Math.min(1, n.rest + (RARE_TICK * (inBed ? 1 : 0.6)) / 9000);
  } else {
    n.rest = Math.max(0, n.rest - (RARE_TICK * e.restDrain) / 24_000);
  }

  if (!healthTick(w, p, e)) return; // died
  if (settler) {
    w.markPawnIfChanged(p);
    return;
  }
  if (p.prisoner) prisonerTick(w, p);

  const thoughts: string[] = [];
  let target = 0.55;
  const add = (label: string, v: number) => {
    thoughts.push(`${label} ${v > 0 ? '+' : ''}${Math.round(v * 100)}`);
    target += v;
  };
  if (n.food <= 0) add('Starving', -0.35);
  else if (n.food < 0.25) add('Hungry', -0.12);
  if (n.rest < 0.2) add('Exhausted', -0.1);
  if (!p.bed) add('No bed', -0.06);
  const temp = w.tempAt(cell);
  if (temp < COMFORT_MIN + e.coldShift) add('Cold', -0.04);
  else if (temp > COMFORT_MAX + e.heatShift) add('Too hot', -0.04);
  if (w.map.roomAt[cell] || w.map.roof[cell]) add('Sheltered', 0.05);
  for (const [label, v] of effectsOf(w, p).thoughts) add(label, v);
  for (const [label, v] of socialThoughts(w, p)) add(label, v);
  n.mood += (Math.max(0, Math.min(1, target)) - n.mood) * 0.2;
  p.thoughts = thoughts;
  socialTick(w, p);

  // Urgent needs, sickness and mental breaks interrupt work.
  const jt = p.job?.type;
  // Drafted pawns ignore all of it until the player releases them.
  // Downed pawns can't act, wherever they lie, so there is nothing to interrupt.
  const busy = !p.drafted && !p.downed && jt && jt !== 'eat' && jt !== 'sleep' && jt !== 'warm';
  // Too cold or hot here, and somewhere better exists: go there, even out of bed when freezing.
  const seekWarmth =
    (busy || (jt === 'sleep' && !p.downed && exposureSeverity(p) > 0.3)) && !p.drafted && needsWarmth(w, p, e) && warmthJob(w, p, e) !== null;
  if (seekWarmth || (busy && (n.food < 0.12 || n.rest < 0.08 || e.bedRest || (e.noWork && jt !== 'wander')))) endJob(w, p);
  // A colony-mate bleeding out or lying downed comes before routine work, and even sleep if it's dire.
  else answerUrgentCare(w, p, e);
  w.markPawnIfChanged(p);
}

// ---------------------------------------------------------------- plants

function plantsTick(w: World): void {
  const m = w.map;
  const light = w.daylight();
  const outdoor = w.outdoorTemp();
  // Plants only grow in daylight (~14 h/day), so scale up to keep growDays honest.
  const lightFactor = light > 0.3 ? (24 / 14) * w.growthMult() : 0;
  const killed = new Map<number, number>();
  for (const id of [...w.kinds.plant]) {
    const p = w.get<Plant>(id)!;
    const def = PLANTS[p.def];
    const cell = w.cellOf(p);
    const temp = m.roomAt[cell] ? w.tempAt(cell) : outdoor - FROST_COLD * w.frostAt(cell);
    if (p.blighted) {
      p.growth -= 0.08;
      w.markDirty(p);
      if (p.growth <= 0) w.despawn(id);
      continue;
    }
    if (def.sowable && temp < -6) {
      const z = w.zoneAt(cell);
      if (z) killed.set(z.faction, (killed.get(z.faction) ?? 0) + 1);
      w.despawn(id);
      continue;
    }
    if (p.growth >= 1) continue;
    const fert = TERRAINS[m.terrain[cell]].fertility;
    if (fert < def.minFertility) continue;
    const tempFactor = temp < 0 || temp > 45 ? 0 : temp < 10 ? temp / 10 : 1;
    const before = p.growth;
    p.growth = Math.min(1, p.growth + (RARE_TICK / (def.growDays * TICKS_PER_DAY)) * fert * tempFactor * lightFactor);
    if (Math.floor(before * 20) !== Math.floor(p.growth * 20)) w.markDirty(p);
  }
  for (const [faction, n] of killed) w.message(faction, `${n} crops froze to death.`, 'bad');

  // Wild plants slowly reseed so wood stays renewable.
  if (outdoor > 5 && w.rng.chance(0.5)) {
    const c = w.rng.int(m.n);
    if (!m.plantAt[c] && !m.solid[c] && !m.zoneAt[c] && !m.buildingAt[c] && !m.constructAt[c] && !m.itemAt[c] && !w.frostAt(c)) {
      const fert = TERRAINS[m.terrain[c]].fertility;
      if (fert >= 0.9) w.spawnPlant(w.rng.chance(0.5) ? (w.rng.chance(0.5) ? 'oak' : 'pine') : 'bush', c, 0.05);
    }
  }
}

// ---------------------------------------------------------------- spoilage

function rotTick(w: World): void {
  const rotted = new Map<string, number>();
  for (const id of [...w.kinds.item]) {
    const it = w.get<Item>(id)!;
    const def = ITEMS[it.def];
    if (!def.spoilDays) continue;
    const temp = w.tempAt(w.cellOf(it));
    const factor = temp <= 0 ? 0 : temp < 10 ? 0.4 : 1;
    if (factor === 0) continue;
    const before = it.rot;
    it.rot += (RARE_TICK / (def.spoilDays * TICKS_PER_DAY)) * factor;
    if (it.rot >= 1) {
      rotted.set(def.label, (rotted.get(def.label) ?? 0) + it.count);
      w.despawn(id);
    } else if (Math.floor(before * 10) !== Math.floor(it.rot * 10)) {
      w.markDirty(it);
    }
  }
  for (const [label, n] of rotted) w.message(0, `${n} ${label.toLowerCase()} rotted away.`, 'bad');
}

// ---------------------------------------------------------------- rooms & temperature

export function rebuildRooms(w: World): void {
  const m = w.map;
  const old = m.roomAt.slice();
  const oldRooms = w.rooms;
  m.roomAt.fill(0);
  w.rooms = new Map();
  const seen = new Uint8Array(m.n);
  const stack: number[] = [];
  for (let s = 0; s < m.n; s++) {
    if (seen[s] || m.wall[s]) continue;
    const cells: number[] = [];
    let touchesEdge = false;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const x = m.cx(c);
      const y = m.cy(c);
      if (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1) touchesEdge = true;
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!m.inBounds(nx, ny)) continue;
        const ni = m.idx(nx, ny);
        if (seen[ni] || m.wall[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (touchesEdge || cells.length > MAX_ROOM_CELLS) continue;
    // Inherit temperature from whatever rooms these cells belonged to before.
    let sum = 0;
    for (const c of cells) {
      const r = old[c] ? oldRooms.get(old[c]) : undefined;
      sum += r ? r.temp : w.ambientTempAtCell(c);
    }
    const room: Room = { id: w.nextRoomId++, cells, temp: sum / cells.length };
    for (const c of cells) m.roomAt[c] = room.id;
    w.rooms.set(room.id, room);
  }
  m.roomsDirty = false;
  m.wallChanges = [];
  w.dirty.rooms = true;
}

/**
 * Re-detect only the rooms around changed walls. Each flood stops as soon as it proves a region
 * is outdoors (too big, touches the map edge, or reaches a region already proven outdoors),
 * so the open world is never flooded in full.
 */
export function updateRooms(w: World): void {
  const m = w.map;
  const changes = m.wallChanges;
  m.wallChanges = [];
  const seeds = new Set<number>();
  for (const c of changes) {
    seeds.add(c);
    const x = m.cx(c);
    const y = m.cy(c);
    for (const [dx, dy] of NEIGHBORS4) if (m.inBounds(x + dx, y + dy)) seeds.add(m.idx(x + dx, y + dy));
  }
  // Dissolve every room touching a change, remembering its temperature per cell.
  const oldTemp = new Map<number, number>();
  for (const c of [...seeds]) {
    const id = m.roomAt[c];
    const room = id ? w.rooms.get(id) : undefined;
    if (!room) continue;
    for (const rc of room.cells) {
      oldTemp.set(rc, room.temp);
      m.roomAt[rc] = 0;
      seeds.add(rc);
    }
    w.rooms.delete(id);
  }
  // 0 = unseen, 1 = seen in the current flood, 2 = proven outdoors.
  const state = new Map<number, number>();
  const stack: number[] = [];
  for (const s of seeds) {
    if (m.wall[s] || state.has(s)) continue;
    const cells: number[] = [];
    let outside = false;
    stack.length = 0;
    stack.push(s);
    state.set(s, 1);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const x = m.cx(c);
      const y = m.cy(c);
      if (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1 || cells.length > MAX_ROOM_CELLS) {
        outside = true;
        break;
      }
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!m.inBounds(nx, ny)) continue;
        const ni = m.idx(nx, ny);
        if (m.wall[ni]) continue;
        const st = state.get(ni);
        if (st === 2) {
          outside = true;
          break;
        }
        if (st === 1) continue;
        state.set(ni, 1);
        stack.push(ni);
      }
      if (outside) break;
    }
    if (outside) {
      for (const c of cells) state.set(c, 2);
      for (const c of stack) state.set(c, 2);
      continue;
    }
    let sum = 0;
    for (const c of cells) sum += oldTemp.get(c) ?? w.ambientTempAtCell(c);
    const room: Room = { id: w.nextRoomId++, cells, temp: sum / cells.length };
    for (const c of cells) m.roomAt[c] = room.id;
    w.rooms.set(room.id, room);
  }
  w.dirty.rooms = true;
}

function roomTemps(w: World): void {
  if (w.rooms.size === 0) return;
  const outdoor = w.outdoorTemp();
  const heat = new Map<number, number>();
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    const d = BUILDINGS[b.def];
    if (!d.heat) continue;
    const r = w.map.roomAt[w.cellOf(b)];
    if (!r) continue;
    const room = w.rooms.get(r)!;
    const wants = d.heat > 0 ? room.temp < d.targetTemp! : room.temp > d.targetTemp!;
    if (wants) heat.set(r, (heat.get(r) ?? 0) + d.heat);
  }
  for (const room of w.rooms.values()) {
    const size = room.cells.length;
    const leak = 0.04 / (1 + size / 60);
    // Rooms out in the frozen zone leak toward much colder air.
    let outside = outdoor - FROST_COLD * w.frostAt(room.cells[0]);
    // Rooms dug into a mountain leak toward the rock's steadier temperature instead.
    let shelter = 0;
    for (const c of room.cells) shelter += ROOF_SHELTER[w.map.roof[c]];
    if (shelter > 0) outside += (CAVE_TEMP - outside) * (shelter / size);
    room.temp += (outside - room.temp) * leak + ((heat.get(room.id) ?? 0) * 2) / size;
  }
  w.dirty.roomTemps = true;
}

// ---------------------------------------------------------------- conditions

function conditionsTick(w: World): void {
  const before = w.conditions.length;
  const ended = w.conditions.filter((c) => c.until <= w.tick);
  if (ended.length === 0) return;
  w.conditions = w.conditions.filter((c) => c.until > w.tick);
  for (const c of ended) w.message(c.faction, `${endedName(EVENTS[c.key]?.label ?? c.key)} ended.`, 'neutral');
  if (w.conditions.length !== before) w.dirty.conditions = true;
}

/** "The cold snap has", "The gentle rains have", "The Long Night has": a condition's name ready for "ended". */
export function endedName(label: string): string {
  const name = /^the /i.test(label) ? label : `The ${label.toLowerCase()}`;
  const plural = /[^s]s$/.test(label);
  return `${name} ${plural ? 'have' : 'has'}`;
}
