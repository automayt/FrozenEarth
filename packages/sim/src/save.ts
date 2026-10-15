import type { Choice, Condition, Entity, Faction, Pawn, Room, Snapshot, Zone } from './types';
import { upgradeStoryState, type StoryState } from './schedule';
import { Dirty, World } from './world';

export const SAVE_VERSION = 2;

export interface SaveData {
  version: number;
  seed: number;
  tick: number;
  rng: number[];
  w: number;
  h: number;
  terrain: Uint8Array;
  rock: Uint8Array;
  desig: Uint8Array;
  desigFaction: Uint8Array;
  fire: Uint8Array;
  ents: Entity[];
  nextId: number;
  factions: Faction[];
  zones: Zone[];
  nextZoneId: number;
  nextBillId: number;
  reservations: [string, number][];
  unreachable: [string, number][];
  rooms: Room[];
  nextRoomId: number;
  conditions: Condition[];
  choices: Choice[];
  choiceData: [number, Record<string, unknown>][];
  nextChoiceId: number;
  coldOffset: number;
  story: StoryState;
}

/** Deep copy via structuredClone so saves never alias live state. */
export function serializeWorld(w: World): SaveData {
  const m = w.map;
  return structuredClone({
    version: SAVE_VERSION,
    seed: w.seed,
    tick: w.tick,
    rng: w.rng.getState(),
    w: m.w,
    h: m.h,
    terrain: m.terrain,
    rock: m.rock,
    desig: m.desig,
    desigFaction: m.desigFaction,
    fire: m.fire,
    ents: [...w.entities.values()],
    nextId: w.nextId,
    factions: [...w.factions.values()],
    zones: [...w.zones.values()],
    nextZoneId: w.nextZoneId,
    nextBillId: w.nextBillId,
    reservations: [...w.reservations],
    unreachable: [...w.unreachable],
    rooms: [...w.rooms.values()],
    nextRoomId: w.nextRoomId,
    conditions: w.conditions,
    choices: [...w.choices.values()],
    choiceData: [...w.choiceData],
    nextChoiceId: w.nextChoiceId,
    coldOffset: w.coldOffset,
    story: w.story,
  });
}

/** Bring an older save up to the current format. */
function migrate(data: SaveData): SaveData {
  const d = data as SaveData & { version: number };
  if (d.version === 1) {
    d.fire = new Uint8Array(d.w * d.h);
    d.choices = [];
    d.choiceData = [];
    d.nextChoiceId = 1;
    for (const e of d.ents) {
      if (e.kind !== 'pawn') continue;
      const p = e as Pawn & { sickUntil?: number };
      p.conditions = p.sickUntil && p.sickUntil > d.tick ? [{ key: 'stomach_flu', severity: 0.2, immunity: 0, until: 0 }] : [];
      p.traits = [];
      delete p.sickUntil;
    }
    d.version = 2;
  }
  return d;
}

export function deserializeWorld(data: SaveData): World {
  if (data.version > SAVE_VERSION) throw new Error(`Save version ${data.version} is newer than this server`);
  const d = migrate(structuredClone(data));
  const w = new World(d.seed, d.w, d.h);
  const m = w.map;
  w.tick = d.tick;
  w.rng.setState(d.rng);
  m.terrain.set(d.terrain);
  m.rock.set(d.rock);
  m.desig.set(d.desig);
  m.desigFaction.set(d.desigFaction);
  m.fire.set(d.fire);
  for (let i = 0; i < m.n; i++) {
    if (m.desig[i]) w.desigCells.add(i);
    if (m.fire[i]) w.fireCells.add(i);
    w.refreshCell(i);
  }
  for (const e of d.ents) w.add(e);
  w.nextId = d.nextId;
  for (const f of d.factions) w.factions.set(f.id, f);
  for (const z of d.zones) {
    w.zones.set(z.id, z);
    for (const c of z.cells) m.zoneAt[c] = z.id;
  }
  w.nextZoneId = d.nextZoneId;
  w.nextBillId = d.nextBillId;
  w.reservations = new Map(d.reservations);
  w.unreachable = new Map(d.unreachable);
  for (const r of d.rooms) {
    w.rooms.set(r.id, r);
    for (const c of r.cells) m.roomAt[c] = r.id;
  }
  w.nextRoomId = d.nextRoomId;
  w.conditions = d.conditions;
  for (const c of d.choices) w.choices.set(c.id, c);
  w.choiceData = new Map(d.choiceData);
  w.nextChoiceId = d.nextChoiceId;
  w.coldOffset = d.coldOffset;
  w.story = upgradeStoryState(d.story);
  m.compDirty = true;
  m.roomsDirty = false;
  w.dirty = new Dirty();
  return w;
}

/** What a newly joined client needs. */
export function snapshot(w: World): Snapshot {
  const m = w.map;
  return {
    w: m.w,
    h: m.h,
    seed: w.seed,
    tick: w.tick,
    terrain: m.terrain,
    rock: m.rock,
    desig: m.desig,
    desigFaction: m.desigFaction,
    fire: m.fire,
    ents: [...w.entities.values()],
    zones: [...w.zones.values()],
    factions: [...w.factions.values()],
    rooms: [...w.rooms.values()],
    conditions: w.conditions,
    choices: [...w.choices.values()],
    coldOffset: w.coldOffset,
  };
}

/** FNV-1a over a canonical JSON form of the save. Equal hashes mean equal worlds. */
export function hashWorld(w: World): string {
  const s = JSON.stringify(serializeWorld(w), (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
