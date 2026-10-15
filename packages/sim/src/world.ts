import { BUILDINGS, DEFAULT_PRIORITY, ITEMS, PLANTS, TERRAINS, WORK_TYPES, type WorkType } from '@fe/defs';
import * as C from './constants';
import { GameMap } from './map';
import { Rng } from './rng';
import type {
  Building,
  Command,
  Condition,
  Construct,
  Delta,
  Entity,
  EntityId,
  Faction,
  GameMessage,
  Item,
  Kind,
  Pawn,
  Plant,
  Room,
  Tone,
  Zone,
  ZoneKind,
} from './types';
import { DESIG } from './types';
import { applyCommand } from './commands';
import { tickPawn } from './pawns';
import { rareTick } from './rare';
import { tickStoryteller, type StoryState, newStoryState } from './storyteller';
import { outdoorTempAt } from './time';

/** Everything that changed since the last delta was taken. */
export class Dirty {
  ents = new Set<EntityId>();
  removed = new Set<EntityId>();
  cells = new Set<number>();
  zones = new Set<number>();
  removedZones = new Set<number>();
  factions = new Set<number>();
  msgs: GameMessage[] = [];
  rooms = false;
  roomTemps = false;
  conditions = false;
  coldOffset = false;
}

export class World {
  seed: number;
  rng: Rng;
  tick = C.START_TICK;
  map: GameMap;
  entities = new Map<EntityId, Entity>();
  kinds: Record<Kind, Set<EntityId>> = {
    pawn: new Set(),
    item: new Set(),
    plant: new Set(),
    building: new Set(),
    construct: new Set(),
  };
  nextId = 1;
  factions = new Map<number, Faction>();
  zones = new Map<number, Zone>();
  nextZoneId = 1;
  nextBillId = 1;
  /** Reservation key ("e<id>" entity, "c<cell>" cell, "d<id>" delivery) -> pawn id. */
  reservations = new Map<string, EntityId>();
  /** "<faction>:<cell>" -> tick until which pathing there is known to fail. */
  unreachable = new Map<string, number>();
  desigCells = new Set<number>();
  rooms = new Map<number, Room>();
  nextRoomId = 1;
  conditions: Condition[] = [];
  /** Degrees added to outdoor temperature. The future winter front drives this. */
  coldOffset = 0;
  story: StoryState = newStoryState();
  dirty = new Dirty();
  private queue: { faction: number; cmd: Command }[] = [];

  constructor(seed: number, w: number, h: number) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.map = new GameMap(w, h);
  }

  // ---------------------------------------------------------------- simulation

  enqueue(faction: number, cmd: Command): void {
    this.queue.push({ faction, cmd });
  }

  /** Apply queued commands without advancing time (used while paused). */
  applyCommands(): void {
    const q = this.queue;
    this.queue = [];
    for (const { faction, cmd } of q) applyCommand(this, faction, cmd);
  }

  step(): void {
    this.applyCommands();
    for (const id of [...this.kinds.pawn]) {
      const p = this.entities.get(id) as Pawn | undefined;
      if (p) tickPawn(this, p);
    }
    rareTick(this);
    tickStoryteller(this);
    this.tick++;
  }

  // ---------------------------------------------------------------- time & climate

  hour(tick = this.tick): number {
    return (tick % C.TICKS_PER_DAY) / C.TICKS_PER_HOUR;
  }

  day(tick = this.tick): number {
    return Math.floor(tick / C.TICKS_PER_DAY);
  }

  seasonIndex(tick = this.tick): number {
    return Math.floor(this.day(tick) / C.DAYS_PER_SEASON) % C.SEASONS.length;
  }

  isNight(): boolean {
    const h = this.hour();
    return h >= 22 || h < 6;
  }

  hasCondition(key: string, faction = 0): boolean {
    return this.conditions.some((c) => c.key === key && (c.faction === 0 || c.faction === faction));
  }

  /** 0 at night, 1 at midday. */
  daylight(): number {
    if (this.hasCondition('eclipse')) return 0;
    const h = this.hour();
    if (h < 5 || h > 20) return 0;
    if (h < 7) return (h - 5) / 2;
    if (h > 18) return (20 - h) / 2;
    return 1;
  }

  outdoorTemp(tick = this.tick): number {
    return outdoorTempAt(tick, this.coldOffset, this.conditions);
  }

  /** Temperature at a cell: its room's, or outdoors. */
  tempAt(cell: number): number {
    const r = this.map.roomAt[cell];
    const room = r ? this.rooms.get(r) : undefined;
    return room ? room.temp : this.outdoorTemp();
  }

  // ---------------------------------------------------------------- entities

  get<T extends Entity = Entity>(id: EntityId): T | undefined {
    return this.entities.get(id) as T | undefined;
  }

  cellOf(e: { x: number; y: number }): number {
    return e.y * this.map.w + e.x;
  }

  add<T extends Entity>(e: T): T {
    this.entities.set(e.id, e);
    this.kinds[e.kind].add(e.id);
    this.index(e, true);
    this.dirty.ents.add(e.id);
    return e;
  }

  newId(): EntityId {
    return this.nextId++;
  }

  despawn(id: EntityId): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.index(e, false);
    this.entities.delete(id);
    this.kinds[e.kind].delete(id);
    this.dirty.ents.delete(id);
    this.dirty.removed.add(id);
    if (e.kind === 'pawn') {
      this.releaseAll(id);
      const bed = e.bed ? this.get<Building>(e.bed) : undefined;
      if (bed && bed.owner === id) {
        bed.owner = 0;
        this.markDirty(bed);
      }
    } else if (e.kind === 'building' && e.owner) {
      const p = this.get<Pawn>(e.owner);
      if (p && p.bed === id) {
        p.bed = 0;
        this.markDirty(p);
      }
    } else if (e.kind === 'plant') {
      const c = this.cellOf(e);
      if (this.map.desig[c] === DESIG.cut || this.map.desig[c] === DESIG.harvest) this.setDesig(c, 0, 0);
    }
  }

  markDirty(e: Entity): void {
    this.dirty.ents.add(e.id);
  }

  private index(e: Entity, add: boolean): void {
    const m = this.map;
    const i = this.cellOf(e);
    const v = add ? e.id : 0;
    switch (e.kind) {
      case 'item':
        if (add || m.itemAt[i] === e.id) m.itemAt[i] = v;
        break;
      case 'plant':
        if (add || m.plantAt[i] === e.id) m.plantAt[i] = v;
        this.refreshCell(i);
        break;
      case 'building':
        if (add || m.buildingAt[i] === e.id) m.buildingAt[i] = v;
        this.refreshCell(i);
        break;
      case 'construct':
        if (add || m.constructAt[i] === e.id) m.constructAt[i] = v;
        break;
      case 'pawn':
        break;
    }
  }

  /** Recompute the derived pathing layers for one cell. */
  refreshCell(i: number): void {
    const m = this.map;
    const t = TERRAINS[m.terrain[i]];
    let solid = !t.passable || m.rock[i] > 0;
    let wall = m.rock[i] > 0;
    let door = 0;
    let extra = 0;
    const b = m.buildingAt[i] ? this.get<Building>(m.buildingAt[i]) : undefined;
    if (b) {
      const d = BUILDINGS[b.def];
      if (d.blocksMovement) solid = true;
      if (d.wall) wall = true;
      if (d.door) {
        door = b.faction;
        extra += 4;
      }
    }
    const p = m.plantAt[i] ? this.get<Plant>(m.plantAt[i]) : undefined;
    if (p) extra += PLANTS[p.def].moveCostAdd;
    const s = solid ? 1 : 0;
    if (m.solid[i] !== s) {
      m.solid[i] = s;
      m.compDirty = true;
    }
    const wv = wall ? 1 : 0;
    if (m.wall[i] !== wv) {
      m.wall[i] = wv;
      m.roomsDirty = true;
    }
    m.doorFaction[i] = door;
    m.extraCost[i] = extra;
  }

  // ---------------------------------------------------------------- cells

  passable(i: number, faction: number): boolean {
    const m = this.map;
    if (m.solid[i]) return false;
    const d = m.doorFaction[i];
    return d === 0 || d === faction;
  }

  /** Ticks to step into cell i. */
  stepCost(i: number, diagonal: boolean): number {
    const base = C.PAWN_TICKS_PER_CELL * TERRAINS[this.map.terrain[i]].moveCost + this.map.extraCost[i];
    return diagonal ? base * 1.41421356 : base;
  }

  setTerrain(i: number, t: number): void {
    if (this.map.terrain[i] === t) return;
    this.map.terrain[i] = t;
    this.refreshCell(i);
    this.dirty.cells.add(i);
  }

  setRock(i: number, r: number): void {
    if (this.map.rock[i] === r) return;
    this.map.rock[i] = r;
    this.refreshCell(i);
    this.dirty.cells.add(i);
  }

  setDesig(i: number, kind: number, faction: number): void {
    const m = this.map;
    if (m.desig[i] === kind && m.desigFaction[i] === faction) return;
    m.desig[i] = kind;
    m.desigFaction[i] = kind ? faction : 0;
    if (kind) this.desigCells.add(i);
    else this.desigCells.delete(i);
    this.dirty.cells.add(i);
  }

  /** Chebyshev distance between two cells. */
  dist(a: number, b: number): number {
    const w = this.map.w;
    return Math.max(Math.abs((a % w) - (b % w)), Math.abs(((a / w) | 0) - ((b / w) | 0)));
  }

  // ---------------------------------------------------------------- items

  spawnItem(def: string, count: number, cell: number, rot = 0): Item {
    const m = this.map;
    return this.add<Item>({
      kind: 'item',
      id: this.newId(),
      x: m.cx(cell),
      y: m.cy(cell),
      faction: 0,
      def,
      count,
      rot,
    });
  }

  /** How many of def can be dropped into this cell. */
  roomFor(cell: number, def: string): number {
    const m = this.map;
    if (m.solid[cell]) return 0;
    const id = m.itemAt[cell];
    if (!id) return ITEMS[def].stackLimit;
    const it = this.get<Item>(id)!;
    return it.def === def ? ITEMS[def].stackLimit - it.count : 0;
  }

  /** Add to a cell, merging with an existing stack. Returns how many were placed. */
  dropInto(cell: number, def: string, count: number, rot = 0): number {
    const room = this.roomFor(cell, def);
    const n = Math.min(room, count);
    if (n <= 0) return 0;
    const id = this.map.itemAt[cell];
    if (id) {
      const it = this.get<Item>(id)!;
      it.rot = (it.rot * it.count + rot * n) / (it.count + n);
      it.count += n;
      this.markDirty(it);
    } else {
      this.spawnItem(def, n, cell, rot);
    }
    return n;
  }

  /** Drop items as close to a cell as possible, spreading over neighbours. */
  placeItemNear(def: string, count: number, cell: number, rot = 0): void {
    const m = this.map;
    const seen = new Set<number>([cell]);
    const queue = [cell];
    for (let qi = 0; qi < queue.length && count > 0 && qi < 600; qi++) {
      const c = queue[qi];
      count -= this.dropInto(c, def, count, rot);
      const x = m.cx(c);
      const y = m.cy(c);
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!m.inBounds(nx, ny)) continue;
        const ni = m.idx(nx, ny);
        if (seen.has(ni) || m.solid[ni]) continue;
        seen.add(ni);
        queue.push(ni);
      }
    }
  }

  takeFromItem(it: Item, n: number): number {
    const take = Math.min(n, it.count);
    it.count -= take;
    if (it.count <= 0) this.despawn(it.id);
    else this.markDirty(it);
    return take;
  }

  // ---------------------------------------------------------------- other spawns

  spawnPlant(def: string, cell: number, growth: number): Plant {
    const m = this.map;
    return this.add<Plant>({ kind: 'plant', id: this.newId(), x: m.cx(cell), y: m.cy(cell), faction: 0, def, growth });
  }

  spawnBuilding(def: string, cell: number, faction: number): Building {
    const m = this.map;
    return this.add<Building>({
      kind: 'building',
      id: this.newId(),
      x: m.cx(cell),
      y: m.cy(cell),
      faction,
      def,
      owner: 0,
      bills: [],
    });
  }

  spawnConstruct(def: string, cell: number, faction: number): Construct {
    const m = this.map;
    return this.add<Construct>({
      kind: 'construct',
      id: this.newId(),
      x: m.cx(cell),
      y: m.cy(cell),
      faction,
      def,
      delivered: {},
      progress: 0,
    });
  }

  spawnPawn(faction: number, cell: number, name: string): Pawn {
    const m = this.map;
    const priorities = Object.fromEntries(WORK_TYPES.map((w) => [w, DEFAULT_PRIORITY])) as Record<WorkType, number>;
    return this.add<Pawn>({
      kind: 'pawn',
      id: this.newId(),
      x: m.cx(cell),
      y: m.cy(cell),
      faction,
      name,
      needs: { food: 0.8, rest: 0.9, mood: 0.6 },
      priorities,
      job: null,
      path: null,
      carrying: null,
      bed: 0,
      asleep: false,
      sickUntil: 0,
      thoughts: [],
    });
  }

  // ---------------------------------------------------------------- zones

  createZone(faction: number, kind: ZoneKind, plant = ''): Zone {
    const z: Zone = {
      id: this.nextZoneId++,
      faction,
      kind,
      cells: [],
      plant,
      allow: ['resource', 'raw_food', 'meal'],
    };
    this.zones.set(z.id, z);
    this.dirty.zones.add(z.id);
    return z;
  }

  addZoneCell(z: Zone, cell: number): void {
    if (this.map.zoneAt[cell]) return;
    this.map.zoneAt[cell] = z.id;
    z.cells.push(cell);
    this.dirty.zones.add(z.id);
  }

  removeZoneCell(cell: number): void {
    const zid = this.map.zoneAt[cell];
    if (!zid) return;
    const z = this.zones.get(zid)!;
    this.map.zoneAt[cell] = 0;
    const k = z.cells.indexOf(cell);
    if (k >= 0) z.cells.splice(k, 1);
    if (z.cells.length === 0) {
      this.zones.delete(zid);
      this.dirty.zones.delete(zid);
      this.dirty.removedZones.add(zid);
    } else {
      this.dirty.zones.add(zid);
    }
  }

  zoneAt(cell: number): Zone | undefined {
    const id = this.map.zoneAt[cell];
    return id ? this.zones.get(id) : undefined;
  }

  // ---------------------------------------------------------------- reservations

  reserve(key: string, pawn: EntityId): boolean {
    const cur = this.reservations.get(key);
    if (cur !== undefined && cur !== pawn && this.entities.has(cur)) return false;
    this.reservations.set(key, pawn);
    return true;
  }

  reservedByOther(key: string, pawn: EntityId): boolean {
    const cur = this.reservations.get(key);
    return cur !== undefined && cur !== pawn && this.entities.has(cur);
  }

  releaseAll(pawn: EntityId): void {
    for (const [k, v] of this.reservations) if (v === pawn) this.reservations.delete(k);
  }

  markUnreachable(faction: number, cell: number): void {
    this.unreachable.set(`${faction}:${cell}`, this.tick + 2500);
  }

  isUnreachable(faction: number, cell: number): boolean {
    const until = this.unreachable.get(`${faction}:${cell}`);
    if (until === undefined) return false;
    if (until <= this.tick) {
      this.unreachable.delete(`${faction}:${cell}`);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- messages & deltas

  message(faction: number, text: string, tone: Tone = 'neutral', at?: number): void {
    this.dirty.msgs.push({ tick: this.tick, faction, text, tone, at });
  }

  takeDelta(): Delta {
    const d = this.dirty;
    const m = this.map;
    const cells: number[] = [];
    for (const i of d.cells) cells.push(i, m.terrain[i], m.rock[i], m.desig[i], m.desigFaction[i]);
    const delta: Delta = {
      tick: this.tick,
      ents: [...d.ents].map((id) => this.entities.get(id)!).filter(Boolean),
      removed: [...d.removed],
      cells,
      zones: [...d.zones].map((id) => this.zones.get(id)!).filter(Boolean),
      removedZones: [...d.removedZones],
      factions: [...d.factions].map((id) => this.factions.get(id)!).filter(Boolean),
      msgs: d.msgs,
    };
    if (d.rooms) delta.rooms = [...this.rooms.values()];
    else if (d.roomTemps) delta.roomTemps = [...this.rooms.values()].flatMap((r) => [r.id, r.temp]);
    if (d.conditions) delta.conditions = this.conditions;
    if (d.coldOffset) delta.coldOffset = this.coldOffset;
    this.dirty = new Dirty();
    return delta;
  }
}

export const NEIGHBORS4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const NEIGHBORS8: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
