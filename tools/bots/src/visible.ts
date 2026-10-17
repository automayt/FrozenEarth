/**
 * What a client's Mirror is expected to agree with the server on. Some fields are sent at coarse
 * granularity on purpose (needs, XP, work progress) and some are server-only bookkeeping, so
 * both sides are projected through these before comparing.
 */
import type { Entity, Faction } from '@fe/sim';

/** An entity as a client should see it, with intentionally coarse fields rounded. */
export function visibleEntity(e: Entity): unknown {
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
    settlement: s && { temper: s.temper, goodwill: s.goodwill, radius: s.radius, state: s.state, met: s.met, requests: s.requests ?? [] },
  };
}
