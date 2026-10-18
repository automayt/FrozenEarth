import type { Delta, Entity, EntityId } from '@fe/sim';

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
      return Object.fromEntries(Object.entries(v as Obj).map(([k, s]) => [k, (s as { level: number }).level]));
    case 'needs':
      return Object.fromEntries(Object.entries(v as Obj).map(([k, n]) => [k, Math.round((n as number) * 50)]));
    case 'conditions':
      return (v as { severity: number; immunity: number }[]).map((c) => ({ ...c, severity: Math.round(c.severity * 20), immunity: Math.round(c.immunity * 20) }));
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

  pack(d: Delta): WireDelta {
    for (const id of d.removed) this.sent.delete(id);
    if (!d.ents.length) return d;
    const ents: Entity[] = [];
    const patches: EntityPatch[] = [];
    for (const e of d.ents) {
      const prev = this.sent.get(e.id);
      if (!prev || prev.kind !== e.kind) {
        this.sent.set(e.id, structuredClone(e) as unknown as Obj);
        ents.push(e);
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
        (set ??= {})[k] = v;
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
