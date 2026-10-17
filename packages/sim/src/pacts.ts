import type { Faction, Pact, PactKind } from './types';
import type { World } from './world';

/** What reading relations needs: the server's World, or a client's mirror of it. */
export interface RelView {
  factions: Map<number, Faction>;
  tick: number;
  seed: number;
}

/** The agreement between two factions right now, if any (a truce that has run out counts as none). */
export function pactOf(w: RelView, a: number, b: number): Pact | undefined {
  const p = w.factions.get(a)?.pacts?.[b];
  if (!p || (p.until !== undefined && w.tick >= p.until)) return undefined;
  return p;
}

export function allied(w: RelView, a: number, b: number): boolean {
  return pactOf(w, a, b)?.kind === 'ally';
}

export function atWar(w: RelView, a: number, b: number): boolean {
  return pactOf(w, a, b)?.kind === 'war';
}

/** Make (or with null, end) an agreement, on both sides. */
export function setPact(w: World, a: number, b: number, kind: PactKind | null, until?: number): void {
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    const f = w.factions.get(x);
    if (!f) continue;
    if (kind) (f.pacts ??= {})[y] = until === undefined ? { kind, since: w.tick } : { kind, since: w.tick, until };
    else if (f.pacts?.[y]) {
      delete f.pacts[y];
      if (!Object.keys(f.pacts).length) delete f.pacts;
    }
    w.dirty.factions.add(x);
  }
}
