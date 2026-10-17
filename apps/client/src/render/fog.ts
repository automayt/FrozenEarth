import { BUILDINGS } from '@fe/defs';
import { calendar, SIGHT_DAY, SIGHT_NIGHT, stealthMult, type Building, type Pawn } from '@fe/sim';
import { store } from '../store';

/**
 * What your colonists can see. Open ground is always on view (the land is big and flat), but
 * the inside of a building is only known where one of your people can see into it: a thief
 * doesn't know who's asleep in your storeroom, and you won't know a thief is in there unless
 * someone of yours lays eyes on them.
 */
export class Fog {
  /** 1 where one of your colonists can see right now. */
  visible = new Uint8Array(0);
  private blocks = new Uint8Array(0);
  private lit = new Uint8Array(0);
  private last = 0;
  /** Bumped on every recompute, so the renderer knows when to redraw the shading. */
  version = 0;

  isNight(): boolean {
    const h = calendar(store.estTick()).hour;
    return h >= 22 || h < 6;
  }

  /** How far someone sees something at this cell, like the sim's sightRange. */
  sightAt(cell: number): number {
    return this.isNight() && !this.lit[cell] ? SIGHT_NIGHT : SIGHT_DAY;
  }

  /** Recompute at most a few times a second. Returns true if it changed. */
  update(now: number): boolean {
    if (now - this.last < 250) return false;
    this.last = now;
    const m = store.mirror;
    const n = m.w * m.h;
    if (!n) return false;
    if (this.visible.length !== n) {
      this.visible = new Uint8Array(n);
      this.blocks = new Uint8Array(n);
      this.lit = new Uint8Array(n);
    }
    // Walls, doors and rock block sight (embrasures don't), as in the sim; fires and heaters light their surroundings.
    this.blocks.set(m.rock);
    this.lit.fill(0);
    for (const e of m.entities.values()) {
      if (e.kind !== 'building') continue;
      const d = BUILDINGS[(e as Building).def];
      if (!d) continue;
      if (d.wall && !d.seeThrough) this.blocks[e.y * m.w + e.x] = 1;
      if (d.radiant || (d.heat && d.heat > 0)) {
        const r = d.radiant ? d.radiant[1] + 2 : 4;
        for (let y = Math.max(0, e.y - r); y <= Math.min(m.h - 1, e.y + r); y++) {
          for (let x = Math.max(0, e.x - r); x <= Math.min(m.w - 1, e.x + r); x++) this.lit[y * m.w + x] = 1;
        }
      }
    }
    this.visible.fill(0);
    const me = store.me?.faction;
    const night = this.isNight();
    for (const e of m.entities.values()) {
      if (e.kind !== 'pawn' || e.faction !== me || e.downed || (e.asleep && !e.possessed)) continue;
      this.cast(e.x, e.y, night ? SIGHT_NIGHT + 2 : SIGHT_DAY);
    }
    this.version++;
    return true;
  }

  /** Mark everything within r cells of (x, y) that a straight line reaches. */
  private cast(x0: number, y0: number, r: number): void {
    const m = store.mirror;
    for (let y = Math.max(0, y0 - r); y <= Math.min(m.h - 1, y0 + r); y++) {
      for (let x = Math.max(0, x0 - r); x <= Math.min(m.w - 1, x0 + r); x++) {
        if ((x - x0) ** 2 + (y - y0) ** 2 > r * r) continue;
        if (this.lineClear(x0, y0, x, y)) this.visible[y * m.w + x] = 1;
      }
    }
  }

  /** Bresenham; the far cell itself may be a wall (you see the wall). */
  lineClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const w = store.mirror.w;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      if (x === x1 && y === y1) return true;
      if ((x !== x0 || y !== y0) && this.blocks[y * w + x]) return false;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Indoors and out of your sight. */
  hidden(cell: number): boolean {
    return store.mirror.roomAt[cell] !== 0 && !this.visible[cell];
  }

  /** Should this pawn be drawn for you? Your own always; anyone else unless they're indoors where you can't see. */
  shows(p: Pawn): boolean {
    if (p.faction === store.me?.faction) return true;
    return !this.hidden(p.y * store.mirror.w + p.x);
  }

  /** Can `watcher` see `target` right now (the same rule the sim uses for spotting thieves)? */
  sees(watcher: Pawn, target: Pawn): boolean {
    if (watcher.asleep || watcher.downed) return false;
    const w = store.mirror.w;
    const r = this.sightAt(target.y * w + target.x) * (target.sneaking ? 0.4 + 0.6 * stealthMult(target) : 1);
    return Math.hypot(watcher.x - target.x, watcher.y - target.y) <= r && this.lineClear(watcher.x, watcher.y, target.x, target.y);
  }
}

export const fog = new Fog();
