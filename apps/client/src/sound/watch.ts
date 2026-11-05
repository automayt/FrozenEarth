import { BUILDINGS } from '@fe/defs';
import { pawnPosition, type Mirror } from '@fe/protocol';
import { calendar, type Pawn, type PathState } from '@fe/sim';
import type { Kind } from './recipes';
import type { Cue } from './score';

/**
 * Sounds the server never mentions, worked out from what changes in the mirror: a door swinging
 * as someone walks through it, an animal calling, a hurt animal going down, the seasons turning.
 */

/** Tuning: on average, seconds between calls from one animal in view. */
const ANIMAL_CALL_S = 50;
/** More removals than this at once is a fresh snapshot, not a massacre. */
const MASS_REMOVAL = 40;
const CELL = 32;

const CALLS: Record<string, Kind> = { deer: 'deer', hare: 'hare', muskox: 'muskox', wolf: 'wolf' };

export type WatchMirror = Pick<Mirror, 'w' | 'entities' | 'buildingAt'>;

export interface Heard {
  /** A sound at a world position. */
  play(kind: Kind, x: number, y: number): void;
  cue(cue: Cue): void;
}

/** Visible rectangle, in cells. */
export interface CellView {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Known {
  x: number;
  y: number;
  species?: string;
  hurt: boolean;
}

/** The first door cell a walker's path enters in (from, to], or -1. */
export function doorOnPath(path: PathState | null | undefined, from: number, to: number, isDoor: (cell: number) => boolean): number {
  if (!path) return -1;
  const { cells, times } = path;
  for (let i = 0; i < times.length; i++) {
    if (times[i] > to) break;
    if (times[i] > from && isDoor(cells[i])) return cells[i];
  }
  return -1;
}

/** A season has just turned, and it's one the score marks. */
export function seasonCue(was: string, is: string): Cue | null {
  if (!was || was === is) return null;
  if (is === 'Spring') return 'thaw';
  if (is === 'Winter') return 'frost';
  return null;
}

export class Watcher {
  private known = new Map<number, Known>();
  private primed = false;
  private lastTick = 0;
  private season = '';

  constructor(
    private out: Heard,
    private rng: () => number = Math.random,
  ) {}

  /** What changed in the mirror this frame. Light: called once per frame from the renderer. */
  note(m: WatchMirror, changed: ReadonlySet<number>, removed: ReadonlySet<number>): void {
    if (!this.primed) {
      this.primed = true;
      for (const e of m.entities.values()) if (e.kind === 'pawn') this.learn(e);
    }
    for (const id of changed) {
      const e = m.entities.get(id);
      if (e?.kind === 'pawn') this.learn(e);
    }
    if (!removed.size) return;
    const loud = removed.size <= MASS_REMOVAL;
    for (const id of removed) {
      const k = this.known.get(id);
      if (!k) continue;
      this.known.delete(id);
      if (loud && k.species && k.hurt) this.out.play('animalDeath', (k.x + 0.5) * CELL, (k.y + 0.5) * CELL);
    }
  }

  private learn(e: Pawn): void {
    const k = this.known.get(e.id);
    const hurt = !!(e.downed || e.aggro || e.hunted);
    if (k) {
      k.x = e.x;
      k.y = e.y;
      k.hurt = hurt;
    } else {
      this.known.set(e.id, { x: e.x, y: e.y, species: e.species, hurt });
    }
  }

  /** A look around, a few times a second. */
  sample(m: WatchMirror, tick: number, view: CellView, dt: number): void {
    const season = calendar(tick).season;
    const cue = seasonCue(this.season, season);
    this.season = season;
    if (cue) this.out.cue(cue);
    const from = this.lastTick;
    this.lastTick = tick;
    // A jump (joining, or time racing ahead) would hear every door at once.
    const walked = from > 0 && tick > from;
    const isDoor = (c: number) => !!BUILDINGS[(m.entities.get(m.buildingAt[c]) as { def?: string } | undefined)?.def ?? '']?.door;
    for (const [id, k] of this.known) {
      const e = m.entities.get(id);
      if (e?.kind !== 'pawn') continue;
      const at = pawnPosition(e, tick, m.w);
      k.x = at.x;
      k.y = at.y;
      if (at.x < view.x0 || at.x > view.x1 || at.y < view.y0 || at.y > view.y1) continue;
      if (e.species) {
        if (this.rng() < dt / ANIMAL_CALL_S && CALLS[e.species]) this.out.play(CALLS[e.species], (at.x + 0.5) * CELL, (at.y + 0.5) * CELL);
      } else if (walked) {
        const door = doorOnPath(e.path, from, tick, isDoor);
        if (door >= 0) this.out.play('door', ((door % m.w) + 0.5) * CELL, (Math.floor(door / m.w) + 0.5) * CELL);
      }
    }
  }
}
