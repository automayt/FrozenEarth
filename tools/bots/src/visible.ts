/**
 * What a client's Mirror is expected to agree with the server on. Some fields are sent at coarse
 * granularity on purpose (needs, XP, work progress) and some are server-only bookkeeping, so
 * both sides are projected through these before comparing.
 */
import type { Mirror } from '@fe/protocol';
import type { Entity, Faction, World } from '@fe/sim';

/** A deep copy with every object's keys in sorted order, so JSON comparisons don't depend on the order fields were set in. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => [k, sorted(o[k])]),
  );
}

/** An entity as a client should see it, with intentionally coarse fields rounded. Keys are sorted: field patches add fields in a different order. */
export function visibleEntity(e: Entity): unknown {
  return sorted(visibleFields(e));
}

function visibleFields(e: Entity): unknown {
  const c = structuredClone(e) as unknown as Record<string, unknown>;
  if (e.kind === 'pawn') {
    // Position is interpolated from the path, which is sent when it's set.
    if (e.path) {
      delete c.x;
      delete c.y;
      const path = { ...(c.path as object) } as Record<string, unknown>;
      delete path.idx;
      c.path = path;
    }
    if (c.job) {
      const job = { ...(c.job as object) } as Record<string, unknown>;
      delete job.progress;
      // When the next blow lands: a cooldown the server keeps; the blows themselves are sent as shots.
      delete job.next;
      c.job = job;
    }
    // Needs and conditions are resent when they move a visible step, not every tick.
    c.needs = Object.fromEntries(Object.entries(e.needs).map(([k, v]) => [k, Math.round(v * 50)]));
    c.conditions = e.conditions.map((x) => ({ ...x, severity: Math.round(x.severity * 20), immunity: Math.round(x.immunity * 20) }));
    // XP accrues every work tick; only level-ups are sent.
    c.skills = Object.fromEntries(Object.entries(e.skills).map(([k, v]) => [k, v.level]));
  }
  if (e.kind === 'construct') delete c.progress;
  if (e.kind === 'plant') c.growth = Math.floor(e.growth * 20);
  if (e.kind === 'item') c.rot = Math.floor(e.rot * 10);
  return c;
}

/** A faction as a client uses it: identity, raid intent, and how a settlement stands with everyone. */
export function visibleFaction(f: Faction): unknown {
  return sorted(visibleFactionFields(f));
}

function visibleFactionFields(f: Faction): unknown {
  const r = f.raid;
  const s = f.settlement;
  return {
    id: f.id,
    name: f.name,
    color: f.color,
    home: f.home,
    isPlayer: f.isPlayer,
    wild: f.wild,
    raid: r && { target: r.target, fled: r.fled, goal: r.goal ?? 'assault', sapper: !!r.sapper },
    settlement: s && { temper: s.temper, goodwill: s.goodwill, radius: s.radius, state: s.state, met: s.met, requests: s.requests ?? [], memories: s.memories ?? [], mediated: s.mediated ?? {} },
    pacts: f.pacts ?? {},
  };
}

/** Everything one client's mirror gets wrong about the server's world. */
export function differences(m: Mirror, w: World): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (m.tick !== w.tick) out.push(`tick ${m.tick} vs ${w.tick}`);
  for (const e of w.entities.values()) {
    const mine = m.entities.get(e.id);
    if (!mine) out.push(`missing ${e.kind} ${e.id}`);
    else if (!same(visibleEntity(mine), visibleEntity(e))) out.push(`${e.kind} ${e.id} differs:\n  client ${JSON.stringify(visibleEntity(mine))}\n  server ${JSON.stringify(visibleEntity(e))}`);
  }
  for (const id of m.entities.keys()) if (!w.entities.has(id)) out.push(`stale entity ${id}`);
  for (const f of w.factions.values()) {
    const mine = m.factions.get(f.id);
    if (!mine || !same(visibleFaction(mine), visibleFaction(f))) out.push(`faction ${f.id} (${f.name}) differs`);
  }
  for (const k of ['terrain', 'rock', 'desig', 'desigFaction', 'fire', 'zoneAt', 'roomAt', 'itemAt', 'buildingAt', 'plantAt', 'constructAt'] as const) {
    const a = m[k];
    const b = w.map[k];
    for (let i = 0; i < b.length; i++) {
      if (a[i] !== b[i]) {
        out.push(`${k}[${i}] ${a[i]} vs ${b[i]}`);
        break;
      }
    }
  }
  if (!same(m.choices, [...w.choices.values()])) out.push('choices differ');
  if (!same(m.conditions, w.conditions)) out.push('conditions differ');
  return out;
}
