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
  /** Fire intensity per cell: 0 none, 1-3 burning. */
  fire: Uint8Array;

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
  /** Full room rebuild needed (new or loaded maps). */
  roomsDirty = true;
  /** Cells whose wall state changed since rooms were last updated. */
  wallChanges: number[] = [];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.terrain = new Uint8Array(this.n);
    this.rock = new Uint8Array(this.n);
    this.desig = new Uint8Array(this.n);
    this.desigFaction = new Uint8Array(this.n);
    this.fire = new Uint8Array(this.n);
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

  // ---------------------------------------------------------------- connectivity
  //
  // comp[] labels each open cell with a component id; ids resolve through a union-find so that
  // opening a cell can merge regions in O(1). Closing a cell only costs a local ring check,
  // unless it might split a region, in which case a multi-source flood finds the smaller pieces.
  // The partition is always exact, so reachability answers never depend on edit history.

  private compParent: number[] = [];
  private stack = new Int32Array(0);
  private markGen = new Int32Array(0);
  private markOwner = new Int8Array(0);
  private gen = 0;

  private newComp(): number {
    const id = this.compParent.length;
    this.compParent.push(id);
    return id;
  }

  private find(c: number): number {
    const p = this.compParent;
    while (p[c] !== c) {
      p[c] = p[p[c]];
      c = p[c];
    }
    return c;
  }

  /** Recompute 4-connected components of non-solid cells from scratch. */
  rebuildComponents(): void {
    const { comp, solid, w, n } = this;
    comp.fill(-1);
    this.compParent = [];
    if (this.stack.length !== n) this.stack = new Int32Array(n);
    const stack = this.stack;
    for (let s = 0; s < n; s++) {
      if (solid[s] || comp[s] !== -1) continue;
      const id = this.newComp();
      let sp = 0;
      stack[sp++] = s;
      comp[s] = id;
      while (sp > 0) {
        const c = stack[--sp];
        const x = c % w;
        let nb = c - 1;
        if (x > 0 && !solid[nb] && comp[nb] === -1) {
          comp[nb] = id;
          stack[sp++] = nb;
        }
        nb = c + 1;
        if (x < w - 1 && !solid[nb] && comp[nb] === -1) {
          comp[nb] = id;
          stack[sp++] = nb;
        }
        nb = c - w;
        if (nb >= 0 && !solid[nb] && comp[nb] === -1) {
          comp[nb] = id;
          stack[sp++] = nb;
        }
        nb = c + w;
        if (nb < n && !solid[nb] && comp[nb] === -1) {
          comp[nb] = id;
          stack[sp++] = nb;
        }
      }
    }
    this.compDirty = false;
  }

  component(i: number): number {
    if (this.compDirty) this.rebuildComponents();
    const c = this.comp[i];
    return c < 0 ? -1 : this.find(c);
  }

  /** Open 4-neighbours of a cell. */
  private openNeighbors(i: number): number[] {
    const { w, n, solid } = this;
    const x = i % w;
    const out: number[] = [];
    if (x > 0 && !solid[i - 1]) out.push(i - 1);
    if (x < w - 1 && !solid[i + 1]) out.push(i + 1);
    if (i - w >= 0 && !solid[i - w]) out.push(i - w);
    if (i + w < n && !solid[i + w]) out.push(i + w);
    return out;
  }

  /** Cell i just became passable: join it to (and merge) its neighbours' regions. */
  cellOpened(i: number): void {
    if (this.compDirty) return;
    let root = -1;
    for (const nb of this.openNeighbors(i)) {
      const r = this.find(this.comp[nb]);
      if (root < 0) root = r;
      else if (r !== root) this.compParent[r] = root;
    }
    this.comp[i] = root >= 0 ? root : this.newComp();
  }

  /** Cell i just became solid: split its region if that cut it in two. */
  cellClosed(i: number): void {
    if (this.compDirty) return;
    this.comp[i] = -1;
    const nbs = this.openNeighbors(i);
    if (nbs.length <= 1 || this.ringConnected(i)) return;
    this.splitPieces(nbs);
  }

  /** True if all open 4-neighbours of i are joined through the 8 cells around it. */
  private ringConnected(i: number): boolean {
    const { w, solid } = this;
    const x = i % w;
    const y = (i / w) | 0;
    const open: boolean[] = [];
    for (const [dx, dy] of RING) {
      const nx = x + dx;
      const ny = y + dy;
      open.push(this.inBounds(nx, ny) && !solid[ny * w + nx]);
    }
    // Count arcs of consecutive open ring cells that contain an orthogonal neighbour.
    const start = open.indexOf(false);
    if (start < 0) return true;
    let arcs = 0;
    let inArc = false;
    let arcHasOrtho = false;
    for (let k = 1; k <= 8; k++) {
      const j = (start + k) % 8;
      if (open[j]) {
        if (!inArc) {
          inArc = true;
          arcHasOrtho = false;
        }
        if (j % 2 === 0) arcHasOrtho = true;
      } else if (inArc) {
        inArc = false;
        if (arcHasOrtho) arcs++;
      }
    }
    return arcs <= 1;
  }

  /** Flood from each neighbour at once; any piece that runs out of room before meeting the others is split off. */
  private splitPieces(seeds: number[]): void {
    const { w, n, solid, comp } = this;
    if (this.markGen.length !== n) {
      this.markGen = new Int32Array(n);
      this.markOwner = new Int8Array(n);
    }
    const gen = ++this.gen;
    const k = seeds.length;
    const queues: number[][] = [];
    const heads = new Array<number>(k).fill(0);
    const alive = new Array<boolean>(k).fill(true);
    const group = Array.from({ length: k }, (_, j) => j);
    const root = (j: number): number => {
      while (group[j] !== j) j = group[j];
      return j;
    };
    for (let j = 0; j < k; j++) {
      queues.push([seeds[j]]);
      this.markGen[seeds[j]] = gen;
      this.markOwner[seeds[j]] = j;
    }
    let groups = k;
    const nbs = [0, 0, 0, 0];
    while (groups > 1) {
      for (let j = 0; j < k && groups > 1; j++) {
        if (!alive[j]) continue;
        const q = queues[j];
        if (heads[j] < q.length) {
          const c = q[heads[j]++];
          const x = c % w;
          nbs[0] = x > 0 ? c - 1 : -1;
          nbs[1] = x < w - 1 ? c + 1 : -1;
          nbs[2] = c - w;
          nbs[3] = c + w;
          for (let t = 0; t < 4; t++) {
            const nb = nbs[t];
            if (nb < 0 || nb >= n || solid[nb]) continue;
            if (this.markGen[nb] !== gen) {
              this.markGen[nb] = gen;
              this.markOwner[nb] = j;
              q.push(nb);
            } else {
              const a = root(j);
              const b = root(this.markOwner[nb]);
              if (a !== b) {
                group[b] = a;
                groups--;
              }
            }
          }
        }
        if (heads[j] < q.length || groups <= 1) continue;
        // This search ran dry. If its whole group has, that group is sealed off from the rest.
        const g = root(j);
        let sealed = true;
        for (let o = 0; o < k; o++) if (alive[o] && root(o) === g && heads[o] < queues[o].length) sealed = false;
        if (!sealed) continue;
        const id = this.newComp();
        for (let o = 0; o < k; o++) {
          if (!alive[o] || root(o) !== g) continue;
          for (const cell of queues[o]) comp[cell] = id;
          alive[o] = false;
        }
        groups--;
      }
    }
  }
}

/** The 8 cells around a cell, in order, starting north. Even indices are orthogonal. */
const RING: [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];
