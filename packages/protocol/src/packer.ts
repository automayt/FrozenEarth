import type { Delta, Entity, EntityId, PathState, Snapshot } from '@fe/sim';

/**
 * Changed fields of an entity every client already has: `set` replaces those fields, `del`
 * removes optional ones that are gone (a pawn no longer possessed, a raid mark lifted).
 */
export interface EntityPatch {
  id: EntityId;
  set: Record<string, unknown>;
  del?: string[];
}

/** A delta as it goes over the wire: new entities in full, changed ones as patches. */
export interface WireDelta extends Delta {
  patches?: EntityPatch[];
}

type Obj = Record<string, unknown>;

/**
 * A pawn's walk as it goes over the wire: each step as a direction (0-8, (dy+1)*3 + dx+1) and the
 * ticks it takes, one byte each, instead of a cell index and an absolute arrival tick (about
 * 8 bytes a step). Walks are the biggest thing left in a delta once entities are patched.
 */
export interface WirePath extends Omit<PathState, 'cells' | 'times'> {
  dir: Uint8Array;
  dt: Uint8Array;
}

/** The compact form of a walk, or the walk itself if a step isn't to a neighbour or takes over 255 ticks. */
export function packPath(ps: PathState, mapW: number): PathState | WirePath {
  const n = ps.cells.length;
  const dir = new Uint8Array(n);
  const dt = new Uint8Array(n);
  let px = ps.fx;
  let py = ps.fy;
  let pt = ps.t0;
  for (let i = 0; i < n; i++) {
    const c = ps.cells[i];
    const x = c % mapW;
    const y = (c - x) / mapW;
    const dx = x - px;
    const dy = y - py;
    const d = ps.times[i] - pt;
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || d < 0 || d > 255) return ps;
    dir[i] = (dy + 1) * 3 + dx + 1;
    dt[i] = d;
    px = x;
    py = y;
    pt = ps.times[i];
  }
  const { cells: _c, times: _t, ...rest } = ps;
  return { ...rest, dir, dt };
}

/** Back to cells and arrival ticks. A walk that arrived uncompacted passes through. */
export function unpackPath(p: PathState | WirePath, mapW: number): PathState {
  if (!('dir' in p)) return p;
  const { dir, dt, ...rest } = p;
  const cells: number[] = new Array(dir.length);
  const times: number[] = new Array(dir.length);
  let x = p.fx;
  let y = p.fy;
  let t = p.t0;
  for (let i = 0; i < dir.length; i++) {
    x += (dir[i] % 3) - 1;
    y += Math.floor(dir[i] / 3) - 1;
    t += dt[i];
    cells[i] = y * mapW + x;
    times[i] = t;
  }
  return { ...rest, cells, times };
}

/** An entity ready for the wire: a walking pawn's path compacted. Never mutates the sim's entity. */
function wireEntity(e: Entity, mapW: number): Entity {
  return e.kind === 'pawn' && e.path ? ({ ...e, path: packPath(e.path, mapW) } as Entity) : e;
}

/** A snapshot with every walk compacted (Mirror.applySnapshot reads either form). */
export function packSnapshot(s: Snapshot): Snapshot {
  return { ...s, ents: s.ents.map((e) => wireEntity(e, s.w)) };
}

/**
 * What a field is compared by, to decide whether it is worth resending. The value sent is always
 * the real one; this only stops a pawn's whole skill table going out because some XP accrued, or
 * its path because it stepped one cell along it. Each view matches the granularity clients are
 * promised (see tools/bots/src/visible.ts): never coarser, or mirrors would drift from the server.
 */
function view(kind: Entity['kind'], key: string, v: unknown): unknown {
  if (v == null || typeof v !== 'object') {
    if (typeof v !== 'number') return v;
    if (kind === 'plant' && key === 'growth') return Math.floor(v * 20);
    if (kind === 'item' && key === 'rot') return Math.floor(v * 10);
    return v;
  }
  if (kind !== 'pawn') return v;
  switch (key) {
    case 'path': {
      // The walk is drawn from its timings; how far along it the server has got is server-side.
      const { idx: _idx, ...rest } = v as Obj;
      return rest;
    }
    case 'skills':
      // XP accrues every work tick and no client shows it; levels are what change the game.
      return Object.fromEntries(
        Object.entries(v as Obj).map(([k, s]) => [k, (s as { level: number }).level]),
      );
    case 'needs':
      return Object.fromEntries(
        Object.entries(v as Obj).map(([k, n]) => [k, Math.round((n as number) * 50)]),
      );
    case 'conditions':
      return (v as { severity: number; immunity: number }[]).map((c) => ({
        ...c,
        severity: Math.round(c.severity * 20),
        immunity: Math.round(c.immunity * 20),
      }));
  }
  return v;
}

/** Structural equality for plain data; a key holding undefined counts as absent. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a !== a && b !== b; // NaN
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Obj;
  const bo = b as Obj;
  for (const k in ao) if (ao[k] !== undefined && !sameData(ao[k], bo[k])) return false;
  for (const k in bo) if (bo[k] !== undefined && ao[k] === undefined) return false;
  return true;
}

/**
 * Turns the sim's deltas into wire deltas. The server remembers each entity as it last sent it,
 * and sends an entity that changed again as just the fields that differ (or nothing, when only
 * server-side bookkeeping moved). Every connected client applied every delta, so they all hold
 * exactly what was last sent. A client joining from a snapshot holds the world's current state
 * instead, so `reset()` must be called whenever a snapshot goes out: everything is then sent in
 * full once more, as before.
 */
export class DeltaPacker {
  private sent = new Map<EntityId, Obj>();
  /** Counters for monitoring: entities sent in full, as patches, and changes dropped as invisible. */
  full = 0;
  patched = 0;
  skipped = 0;

  reset(): void {
    this.sent.clear();
  }

  /** `mapW` is the map's width, for compacting walks. */
  pack(d: Delta, mapW: number): WireDelta {
    for (const id of d.removed) this.sent.delete(id);
    if (!d.ents.length) return d;
    const ents: Entity[] = [];
    const patches: EntityPatch[] = [];
    for (const e of d.ents) {
      const prev = this.sent.get(e.id);
      if (!prev || prev.kind !== e.kind) {
        this.sent.set(e.id, structuredClone(e) as unknown as Obj);
        ents.push(wireEntity(e, mapW));
        this.full++;
        continue;
      }
      const cur = e as unknown as Obj;
      let set: Obj | null = null;
      let del: string[] | null = null;
      for (const k in cur) {
        const v = cur[k];
        if (v === undefined) continue;
        const old = prev[k];
        if (old !== undefined && (v === old || sameData(view(e.kind, k, v), view(e.kind, k, old)))) continue;
        (set ??= {})[k] = k === 'path' && e.kind === 'pawn' && v ? packPath(v as PathState, mapW) : v;
        prev[k] = typeof v === 'object' && v !== null ? structuredClone(v) : v;
      }
      for (const k in prev) {
        if (prev[k] === undefined || cur[k] !== undefined) continue;
        (del ??= []).push(k);
        delete prev[k];
      }
      if (!set && !del) {
        this.skipped++;
        continue;
      }
      const p: EntityPatch = { id: e.id, set: set ?? {} };
      if (del) p.del = del;
      patches.push(p);
      this.patched++;
    }
    const out: WireDelta = { ...d, ents };
    if (patches.length) out.patches = patches;
    return out;
  }
}
