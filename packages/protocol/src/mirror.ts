import { CELL_FIELDS, DEFAULT_FROST, type FrostParams, type Choice, type Condition, type Delta, type Entity, type Faction, type GameMessage, type Pawn, type Room, type Snapshot, type Zone } from '@fe/sim';
import { toU8 } from './codec';
import type { WireDelta } from './packer';

/**
 * A client's read-only replica of the world, built from a snapshot and kept current by deltas.
 * Deltas are idempotent, so applying one twice or out of join order is harmless.
 */
export class Mirror {
  w = 0;
  h = 0;
  seed = 0;
  tick = 0;
  terrain = new Uint8Array(0);
  rock = new Uint8Array(0);
  desig = new Uint8Array(0);
  desigFaction = new Uint8Array(0);
  fire = new Uint8Array(0);
  /** Mountain roofs (ROOF in defs), from the snapshot; fixed after map gen. */
  roof = new Uint8Array(0);
  /** Cells currently on fire, for cheap per-frame drawing. */
  fireCells = new Set<number>();
  zoneAt = new Int32Array(0);
  roomAt = new Int32Array(0);
  itemAt = new Int32Array(0);
  plantAt = new Int32Array(0);
  buildingAt = new Int32Array(0);
  constructAt = new Int32Array(0);
  entities = new Map<number, Entity>();
  zones = new Map<number, Zone>();
  factions = new Map<number, Faction>();
  rooms = new Map<number, Room>();
  conditions: Condition[] = [];
  choices: Choice[] = [];
  coldOffset = 0;
  /** Frost line settings, from the snapshot. */
  frost: FrostParams = { ...DEFAULT_FROST };
  messages: GameMessage[] = [];
  /** Patches for entities this mirror doesn't have: zero unless deltas were lost or applied out of order. */
  missedPatches = 0;
  /** Attacks since the renderer last drained them, flattened SHOT_FIELDS tuples. */
  shots: number[] = [];

  // Change tracking for the renderer; it clears these after reading.
  changedEnts = new Set<number>();
  removedEnts = new Set<number>();
  changedCells = new Set<number>();
  zonesChanged = false;
  allCellsChanged = false;

  applySnapshot(s: Snapshot): void {
    this.w = s.w;
    this.h = s.h;
    this.seed = s.seed;
    this.tick = s.tick;
    const n = s.w * s.h;
    this.terrain = toU8(s.terrain).slice();
    this.rock = toU8(s.rock).slice();
    this.desig = toU8(s.desig).slice();
    this.desigFaction = toU8(s.desigFaction).slice();
    this.fire = s.fire ? toU8(s.fire).slice() : new Uint8Array(n);
    this.roof = s.roof ? toU8(s.roof).slice() : new Uint8Array(n);
    this.fireCells.clear();
    for (let i = 0; i < n; i++) if (this.fire[i]) this.fireCells.add(i);
    this.zoneAt = new Int32Array(n);
    this.roomAt = new Int32Array(n);
    this.itemAt = new Int32Array(n);
    this.plantAt = new Int32Array(n);
    this.buildingAt = new Int32Array(n);
    this.constructAt = new Int32Array(n);
    for (const id of this.entities.keys()) this.removedEnts.add(id);
    this.entities.clear();
    for (const e of s.ents) this.upsert(e);
    this.zones.clear();
    for (const z of s.zones) this.setZone(z);
    this.factions = new Map(s.factions.map((f) => [f.id, f]));
    this.setRooms(s.rooms);
    this.conditions = s.conditions;
    this.choices = s.choices ?? [];
    this.coldOffset = s.coldOffset;
    this.frost = { ...DEFAULT_FROST, ...(s.frost ?? {}) };
    this.allCellsChanged = true;
    this.zonesChanged = true;
  }

  applyDelta(d: Delta | WireDelta): void {
    this.tick = Math.max(this.tick, d.tick);
    for (const id of d.removed) this.remove(id);
    for (const e of d.ents) this.upsert(e);
    const patches = (d as WireDelta).patches;
    if (patches) {
      for (const p of patches) {
        const old = this.entities.get(p.id);
        // Patches only go to clients that have the entity; a miss means a lost delta, not a new entity.
        if (!old) {
          this.missedPatches++;
          continue;
        }
        const e = { ...old, ...p.set } as Record<string, unknown>;
        if (p.del) for (const k of p.del) delete e[k];
        this.upsert(e as unknown as Entity);
      }
    }
    const c = d.cells;
    for (let k = 0; k < c.length; k += CELL_FIELDS) {
      const i = c[k];
      this.terrain[i] = c[k + 1];
      this.rock[i] = c[k + 2];
      this.desig[i] = c[k + 3];
      this.desigFaction[i] = c[k + 4];
      this.fire[i] = c[k + 5];
      if (this.fire[i]) this.fireCells.add(i);
      else this.fireCells.delete(i);
      this.changedCells.add(i);
    }
    for (const id of d.removedZones) {
      const z = this.zones.get(id);
      if (!z) continue;
      for (const cell of z.cells) if (this.zoneAt[cell] === id) this.zoneAt[cell] = 0;
      this.zones.delete(id);
      this.zonesChanged = true;
    }
    for (const z of d.zones) this.setZone(z);
    for (const f of d.factions) this.factions.set(f.id, f);
    if (d.rooms) this.setRooms(d.rooms);
    if (d.roomTemps) {
      for (let k = 0; k < d.roomTemps.length; k += 2) {
        const r = this.rooms.get(d.roomTemps[k]);
        if (r) r.temp = d.roomTemps[k + 1];
      }
    }
    if (d.conditions) this.conditions = d.conditions;
    if (d.choices) this.choices = d.choices;
    if (d.coldOffset !== undefined) this.coldOffset = d.coldOffset;
    if (d.shots?.length) {
      this.shots.push(...d.shots);
      // Nobody draining (hidden tab, headless bot): keep only the latest few hundred.
      if (this.shots.length > 4000) this.shots.splice(0, this.shots.length - 4000);
    }
    if (d.msgs.length) {
      this.messages.push(...d.msgs);
      if (this.messages.length > 200) this.messages.splice(0, this.messages.length - 200);
    }
  }

  get<T extends Entity = Entity>(id: number): T | undefined {
    return this.entities.get(id) as T | undefined;
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  private grid(e: Entity): Int32Array | null {
    switch (e.kind) {
      case 'item':
        return this.itemAt;
      case 'plant':
        return this.plantAt;
      case 'building':
        return this.buildingAt;
      case 'construct':
        return this.constructAt;
      default:
        return null;
    }
  }

  private upsert(e: Entity): void {
    const old = this.entities.get(e.id);
    if (old) this.unindex(old);
    this.entities.set(e.id, e);
    const g = this.grid(e);
    if (g) g[e.y * this.w + e.x] = e.id;
    this.changedEnts.add(e.id);
    this.removedEnts.delete(e.id);
  }

  private remove(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.unindex(e);
    this.entities.delete(id);
    this.changedEnts.delete(id);
    this.removedEnts.add(id);
  }

  private unindex(e: Entity): void {
    const g = this.grid(e);
    const i = e.y * this.w + e.x;
    if (g && g[i] === e.id) g[i] = 0;
  }

  private setZone(z: Zone): void {
    const old = this.zones.get(z.id);
    if (old) for (const c of old.cells) if (this.zoneAt[c] === z.id) this.zoneAt[c] = 0;
    this.zones.set(z.id, z);
    for (const c of z.cells) this.zoneAt[c] = z.id;
    this.zonesChanged = true;
  }

  private setRooms(rooms: Room[]): void {
    this.roomAt.fill(0);
    this.rooms = new Map(rooms.map((r) => [r.id, r]));
    for (const r of rooms) for (const c of r.cells) this.roomAt[c] = r.id;
  }
}

/** Where a pawn is drawn at a (fractional) tick, interpolating along its timed path. */
export function pawnPosition(p: Pawn, tick: number, mapW: number): { x: number; y: number } {
  const ps = p.path;
  if (!ps || ps.cells.length === 0 || tick <= ps.t0) return ps ? { x: ps.fx, y: ps.fy } : { x: p.x, y: p.y };
  const { cells, times } = ps;
  const at = (c: number) => ({ x: c % mapW, y: Math.floor(c / mapW) });
  // Mirrors only get the path when it is set, so locate the segment by time.
  let lo = 0;
  let hi = times.length - 1;
  if (tick >= times[hi]) return at(cells[hi]);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= tick) lo = mid + 1;
    else hi = mid;
  }
  const prevT = lo === 0 ? ps.t0 : times[lo - 1];
  const from = lo === 0 ? { x: ps.fx, y: ps.fy } : at(cells[lo - 1]);
  const to = at(cells[lo]);
  const f = Math.min(1, Math.max(0, (tick - prevT) / (times[lo] - prevT)));
  return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
}
