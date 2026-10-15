/** Dense per-cell layers for one map. Cell index = y * w + x. */
export class GameMap {
  readonly w: number;
  readonly h: number;
  readonly n: number;

  // Persistent layers (saved and sent to clients).
  terrain: Uint8Array;
  rock: Uint8Array;
  desig: Uint8Array;
  desigFaction: Uint8Array;

  // Derived indexes, rebuilt from entities on load.
  buildingAt: Int32Array;
  constructAt: Int32Array;
  itemAt: Int32Array;
  plantAt: Int32Array;
  zoneAt: Int32Array;
  roomAt: Int32Array;
  /** 1 if no pawn can enter (terrain, rock or a blocking building). */
  solid: Uint8Array;
  /** Faction that owns a door here, or 0. Other factions cannot pass. */
  doorFaction: Uint8Array;
  /** Extra walking ticks from plants and buildings. */
  extraCost: Uint8Array;
  /** 1 where a wall, door or rock encloses rooms. */
  wall: Uint8Array;
  /** Connected components of passable cells, ignoring door ownership. -1 = solid. */
  comp: Int32Array;
  compDirty = true;
  roomsDirty = true;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.terrain = new Uint8Array(this.n);
    this.rock = new Uint8Array(this.n);
    this.desig = new Uint8Array(this.n);
    this.desigFaction = new Uint8Array(this.n);
    this.buildingAt = new Int32Array(this.n);
    this.constructAt = new Int32Array(this.n);
    this.itemAt = new Int32Array(this.n);
    this.plantAt = new Int32Array(this.n);
    this.zoneAt = new Int32Array(this.n);
    this.roomAt = new Int32Array(this.n);
    this.solid = new Uint8Array(this.n);
    this.doorFaction = new Uint8Array(this.n);
    this.extraCost = new Uint8Array(this.n);
    this.wall = new Uint8Array(this.n);
    this.comp = new Int32Array(this.n);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  cx(i: number): number {
    return i % this.w;
  }

  cy(i: number): number {
    return (i / this.w) | 0;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /** Recompute 4-connected components of non-solid cells. */
  rebuildComponents(): void {
    const { comp, solid, w, h, n } = this;
    comp.fill(-1);
    const stack = new Int32Array(n);
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (solid[s] || comp[s] !== -1) continue;
      const id = next++;
      let sp = 0;
      stack[sp++] = s;
      comp[s] = id;
      while (sp > 0) {
        const c = stack[--sp];
        const x = c % w;
        const y = (c / w) | 0;
        if (x > 0) visit(c - 1);
        if (x < w - 1) visit(c + 1);
        if (y > 0) visit(c - w);
        if (y < h - 1) visit(c + w);
      }
      function visit(c: number) {
        if (!solid[c] && comp[c] === -1) {
          comp[c] = id;
          stack[sp++] = c;
        }
      }
    }
    this.compDirty = false;
  }

  component(i: number): number {
    if (this.compDirty) this.rebuildComponents();
    return this.comp[i];
  }
}
