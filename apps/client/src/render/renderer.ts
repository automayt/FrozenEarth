import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { BUILDINGS, PLANTS, ROCKS, TERRAINS } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import { DESIG, TICKS_PER_DAY, TICKS_PER_HOUR, hash2, type Construct, type Entity, type Pawn } from '@fe/sim';
import { store } from '../store';
import { TextureBank } from './textures';
import { Input } from './input';

/** World units per cell. */
export const TILE = 32;
/** Pixels per cell in the terrain and overlay canvases. */
const PX = 4;

interface EntityView {
  root: Container;
  sprite?: Sprite;
  label?: Text;
  extra?: Graphics;
  key: string;
  /** Set for walls, so neighbours can re-join when this one goes away. */
  wallCell?: number;
}

export class GameRenderer {
  app = new Application();
  world = new Container();
  private terrainCanvas = document.createElement('canvas');
  private overlayCanvas = document.createElement('canvas');
  private terrainTex!: Texture;
  private overlayTex!: Texture;
  private layers = {
    terrain: new Container(),
    overlay: new Container(),
    floorThings: new Container(),
    items: new Container(),
    buildings: new Container(),
    plants: new Container(),
    pawns: new Container(),
    ui: new Container(),
  };
  ui = new Graphics();
  private night = new Graphics();
  private views = new Map<number, EntityView>();
  tex!: TextureBank;
  input!: Input;
  private mapW = 0;
  private mapH = 0;
  private destroyed = false;

  async init(el: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: el, background: 0x0d1014, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    el.appendChild(this.app.canvas);
    this.tex = new TextureBank(this.app.renderer);
    await this.tex.loadArt();
    this.app.stage.addChild(this.world, this.night);
    for (const l of Object.values(this.layers)) this.world.addChild(l);
    this.layers.ui.addChild(this.ui);
    this.input = new Input(this, this.app.canvas);
    this.app.ticker.add(() => this.frame());
  }

  destroy(): void {
    this.destroyed = true;
    this.input?.destroy();
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // init may not have finished
    }
  }

  // ---------------------------------------------------------------- camera

  screenToCell(sx: number, sy: number): { x: number; y: number } {
    const s = this.world.scale.x;
    return { x: Math.floor((sx - this.world.x) / s / TILE), y: Math.floor((sy - this.world.y) / s / TILE) };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const s = this.world.scale.x;
    return { x: (sx - this.world.x) / s / TILE, y: (sy - this.world.y) / s / TILE };
  }

  centerOn(x: number, y: number): void {
    const s = this.world.scale.x;
    this.world.x = this.app.screen.width / 2 - (x + 0.5) * TILE * s;
    this.world.y = this.app.screen.height / 2 - (y + 0.5) * TILE * s;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const old = this.world.scale.x;
    const s = Math.max(0.15, Math.min(3, old * factor));
    this.world.x = sx - ((sx - this.world.x) * s) / old;
    this.world.y = sy - ((sy - this.world.y) * s) / old;
    this.world.scale.set(s);
  }

  // ---------------------------------------------------------------- per frame

  private frame(): void {
    const m = store.mirror;
    if (!m.w) return;
    if (m.w !== this.mapW || m.h !== this.mapH) this.setupMap();
    if (store.focus) {
      this.centerOn(store.focus.x, store.focus.y);
      store.focus = null;
    }
    this.input.update(this.app.ticker.deltaMS);

    if (m.allCellsChanged) {
      this.drawAllTerrain();
      m.allCellsChanged = false;
      m.changedCells.clear();
      m.zonesChanged = true;
      for (const id of [...this.views.keys()]) if (!m.entities.has(id)) this.removeView(id);
      for (const id of m.entities.keys()) m.changedEnts.add(id);
    }
    if (m.changedCells.size) {
      const ctx = this.terrainCanvas.getContext('2d')!;
      // Neighbours below and right re-bevel when rock next to them changes.
      const n = m.w * m.h;
      for (const c of m.changedCells) for (const k of [c, c + 1, c + m.w]) if (k < n) this.drawTerrainCell(ctx, k);
      this.terrainTex.source.update();
    }
    if (m.zonesChanged || m.changedCells.size) {
      this.drawOverlay();
      m.zonesChanged = false;
    }
    m.changedCells.clear();

    // Walls join up with their neighbours, so a wall appearing or vanishing redraws the ones around it.
    const wallCells: number[] = [];
    for (const id of m.removedEnts) {
      const c = this.views.get(id)?.wallCell;
      if (c !== undefined) wallCells.push(c);
    }
    for (const id of m.changedEnts) {
      const e = m.entities.get(id);
      if (e && isWall(e)) wallCells.push(e.y * m.w + e.x);
    }
    for (const c of wallCells) {
      const x = c % m.w;
      for (const n of [x > 0 ? c - 1 : -1, x < m.w - 1 ? c + 1 : -1, c - m.w, c + m.w]) {
        if (n < 0 || n >= m.w * m.h) continue;
        const id = m.buildingAt[n];
        if (id && isWall(m.entities.get(id))) m.changedEnts.add(id);
      }
    }
    for (const id of m.removedEnts) this.removeView(id);
    m.removedEnts.clear();
    for (const id of m.changedEnts) {
      const e = m.entities.get(id);
      if (e) this.updateView(e);
    }
    m.changedEnts.clear();

    const tick = store.estTick();
    for (const id of m.entities.keys()) {
      const e = m.entities.get(id)!;
      if (e.kind !== 'pawn') continue;
      const v = this.views.get(id);
      if (!v) continue;
      const pos = pawnPosition(e, tick, m.w);
      v.root.position.set((pos.x + 0.5) * TILE, (pos.y + 0.5) * TILE);
    }
    this.layers.pawns.children.sort((a, b) => a.y - b.y);
    this.drawUi();
    this.drawNight(tick);
  }

  private setupMap(): void {
    const m = store.mirror;
    this.mapW = m.w;
    this.mapH = m.h;
    this.terrainCanvas.width = m.w * PX;
    this.terrainCanvas.height = m.h * PX;
    this.overlayCanvas.width = m.w * PX;
    this.overlayCanvas.height = m.h * PX;
    this.terrainTex?.destroy(true);
    this.overlayTex?.destroy(true);
    this.terrainTex = Texture.from(this.terrainCanvas);
    this.overlayTex = Texture.from(this.overlayCanvas);
    this.terrainTex.source.scaleMode = 'nearest';
    this.overlayTex.source.scaleMode = 'nearest';
    this.layers.terrain.removeChildren();
    this.layers.overlay.removeChildren();
    const ts = new Sprite(this.terrainTex);
    ts.scale.set(TILE / PX);
    const os = new Sprite(this.overlayTex);
    os.scale.set(TILE / PX);
    this.layers.terrain.addChild(ts);
    this.layers.overlay.addChild(os);
    m.allCellsChanged = true;
  }

  private drawAllTerrain(): void {
    const m = store.mirror;
    const img = new ImageData(m.w * PX, m.h * PX);
    const n = m.w * m.h;
    for (let c = 0; c < n; c++) this.paintCell(img.data, m.w * PX, c, (c % m.w) * PX, ((c / m.w) | 0) * PX);
    this.terrainCanvas.getContext('2d')!.putImageData(img, 0, 0);
    this.terrainTex.source.update();
  }

  private drawTerrainCell(ctx: CanvasRenderingContext2D, c: number): void {
    const m = store.mirror;
    const img = new ImageData(PX, PX);
    this.paintCell(img.data, PX, c, 0, 0);
    ctx.putImageData(img, (c % m.w) * PX, ((c / m.w) | 0) * PX);
  }

  /** Write one cell's PX x PX pixels into an RGBA buffer of the given stride, at (ox, oy). */
  private paintCell(data: Uint8ClampedArray, stride: number, c: number, ox: number, oy: number): void {
    const m = store.mirror;
    const x = c % m.w;
    const y = (c / m.w) | 0;
    const rock = m.rock[c];
    const base = rock ? ROCKS[rock].color : TERRAINS[m.terrain[c]].color;
    const openUp = rock && y > 0 && !m.rock[c - m.w];
    const openLeft = rock && x > 0 && !m.rock[c - 1];
    for (let py = 0; py < PX; py++) {
      for (let px = 0; px < PX; px++) {
        let f = 0.92 + hash2(x * PX + px, y * PX + py, 7) * 0.16;
        if (rock) {
          // Bevel rock edges that face open ground.
          if ((py === 0 && openUp) || (px === 0 && openLeft)) f *= 1.35;
          if (rock === 2 && hash2(x * PX + px, y * PX + py, 3) > 0.8) f *= 1.6;
        }
        const o = ((oy + py) * stride + ox + px) * 4;
        data[o] = Math.min(255, ((base >> 16) & 255) * f);
        data[o + 1] = Math.min(255, ((base >> 8) & 255) * f);
        data[o + 2] = Math.min(255, (base & 255) * f);
        data[o + 3] = 255;
      }
    }
  }

  private drawOverlay(): void {
    const m = store.mirror;
    const ctx = this.overlayCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    for (const z of m.zones.values()) {
      const f = m.factions.get(z.faction);
      const color = z.kind === 'grow' ? 0x7ac04a : (f?.color ?? 0xffffff);
      ctx.fillStyle = rgba(color, z.faction === store.me?.faction ? 0.22 : 0.12);
      for (const c of z.cells) ctx.fillRect((c % m.w) * PX, ((c / m.w) | 0) * PX, PX, PX);
    }
    const n = m.w * m.h;
    for (let c = 0; c < n; c++) {
      const d = m.desig[c];
      if (!d) continue;
      const x = (c % m.w) * PX;
      const y = ((c / m.w) | 0) * PX;
      ctx.fillStyle = d === DESIG.mine ? 'rgba(240,180,60,0.85)' : d === DESIG.cut ? 'rgba(230,80,60,0.85)' : 'rgba(120,220,90,0.85)';
      // Corner brackets so the cell content stays visible.
      ctx.fillRect(x, y, 2, 1);
      ctx.fillRect(x, y, 1, 2);
      ctx.fillRect(x + PX - 2, y + PX - 1, 2, 1);
      ctx.fillRect(x + PX - 1, y + PX - 2, 1, 2);
    }
    this.overlayTex.source.update();
  }

  // ---------------------------------------------------------------- entities

  private removeView(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    v.root.destroy({ children: true });
    this.views.delete(id);
  }

  private viewKey(e: Entity): string {
    switch (e.kind) {
      case 'plant':
        return `p:${e.def}:${Math.floor(e.growth * 10)}:${e.blighted ? 1 : 0}`;
      case 'item':
        return `i:${e.def}:${e.count}:${e.rot >= 0.5 ? 1 : 0}`;
      case 'building':
        return isWall(e) ? `b:${e.def}:${e.faction}:${this.wallMask(e.x, e.y)}` : `b:${e.def}:${e.faction}`;
      case 'construct': {
        const total = Object.values(BUILDINGS[e.def].cost).reduce((a, b) => a + b, 0);
        const got = Object.values(e.delivered).reduce((a, b) => a + b, 0);
        return `c:${e.def}:${got}/${total}:${Math.floor((e.progress / BUILDINGS[e.def].work) * 10)}`;
      }
      case 'pawn':
        return `w:${e.faction}:${e.name}:${e.asleep ? 1 : 0}:${e.carrying?.def ?? ''}`;
    }
  }

  private updateView(e: Entity): void {
    const key = this.viewKey(e);
    const old = this.views.get(e.id);
    if (old && old.key === key) return;
    if (old) this.removeView(e.id);
    const root = new Container();
    const v: EntityView = { root, key };
    const cx = (e.x + 0.5) * TILE;
    const cy = (e.y + 0.5) * TILE;
    root.position.set(cx, cy);
    switch (e.kind) {
      case 'plant': {
        const d = PLANTS[e.def];
        const s = new Sprite(this.tex.plant(e.def));
        s.anchor.set(0.5);
        const size = (d.tree ? 1.5 : 1) * TILE * (0.3 + 0.7 * Math.min(1, e.growth));
        s.width = s.height = size;
        if (e.blighted) s.tint = 0x9a7a4a;
        root.addChild(s);
        (d.tree ? this.layers.plants : this.layers.floorThings).addChild(root);
        break;
      }
      case 'item': {
        const s = new Sprite(this.tex.item(e.def));
        s.anchor.set(0.5);
        s.width = s.height = TILE * 0.9;
        if (e.rot >= 0.5) s.tint = 0xa0b070;
        root.addChild(s);
        if (e.count > 1) {
          const t = new Text({ text: String(e.count), style: { fontFamily: 'IBM Plex Mono', fontSize: 11, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } }, resolution: 3 });
          t.anchor.set(1, 1);
          t.position.set(TILE / 2 - 1, TILE / 2);
          root.addChild(t);
        }
        this.layers.items.addChild(root);
        break;
      }
      case 'building': {
        const d = BUILDINGS[e.def];
        const wall = isWall(e);
        if (wall) v.wallCell = e.y * store.mirror.w + e.x;
        const s = new Sprite(wall ? this.tex.wall(e.def, this.wallMask(e.x, e.y)) : this.tex.building(e.def));
        s.anchor.set(0.5);
        s.width = s.height = TILE;
        root.addChild(s);
        if (d.door) {
          const f = store.mirror.factions.get(e.faction);
          const g = new Graphics().rect(-TILE / 2, TILE / 2 - 4, TILE, 3).fill(f?.color ?? 0xffffff);
          root.addChild(g);
        }
        (d.floorTerrain ? this.layers.floorThings : this.layers.buildings).addChild(root);
        break;
      }
      case 'construct':
        this.drawConstruct(root, e);
        this.layers.buildings.addChild(root);
        break;
      case 'pawn':
        this.drawPawn(root, e);
        this.layers.pawns.addChild(root);
        break;
    }
    this.views.set(e.id, v);
  }

  /** Bits: 1 = wall above, 2 = right, 4 = below, 8 = left. */
  private wallMask(x: number, y: number): number {
    const m = store.mirror;
    const at = (cx: number, cy: number) => m.inBounds(cx, cy) && isWall(m.entities.get(m.buildingAt[m.idx(cx, cy)]));
    return (at(x, y - 1) ? 1 : 0) | (at(x + 1, y) ? 2 : 0) | (at(x, y + 1) ? 4 : 0) | (at(x - 1, y) ? 8 : 0);
  }

  private drawConstruct(root: Container, e: Construct): void {
    const d = BUILDINGS[e.def];
    const cost = d.cost;
    const total = Object.values(cost).reduce((a, b) => a + b, 0);
    const got = Object.values(e.delivered).reduce((a, b) => a + b, 0);
    const ready = got >= total;
    const ghost = new Sprite(this.tex.building(e.def));
    ghost.anchor.set(0.5);
    ghost.width = ghost.height = TILE;
    ghost.alpha = ready ? 0.65 : 0.3;
    ghost.tint = ready ? 0xd8c8a0 : 0x8ac8ff;
    const frame = new Graphics()
      .rect(-TILE / 2 + 1, -TILE / 2 + 1, TILE - 2, TILE - 2)
      .fill({ color: ready ? 0x8a7050 : 0x3a7ac0, alpha: ready ? 0.25 : 0.2 })
      .stroke({ width: 1.5, color: ready ? 0xc8a878 : 0x8ac8ff, alpha: 0.9 });
    root.addChild(frame, ghost);
    const p = ready ? e.progress / d.work : total ? got / total : 0;
    if (p > 0) root.addChild(new Graphics().rect(-TILE / 2 + 3, TILE / 2 - 6, (TILE - 6) * Math.min(1, p), 3).fill(ready ? 0xf0c060 : 0x8ac8ff));
  }

  private drawPawn(root: Container, e: Pawn): void {
    const f = store.mirror.factions.get(e.faction);
    const color = f?.color ?? 0xffffff;
    const ring = new Graphics().ellipse(0, TILE * 0.3, TILE * 0.38, TILE * 0.16).fill({ color: 0x000000, alpha: 0.35 });
    ring.ellipse(0, TILE * 0.28, TILE * 0.34, TILE * 0.13).stroke({ width: 2.5, color });
    const body = new Sprite(this.tex.pawn());
    body.anchor.set(0.5, 0.6);
    body.width = body.height = TILE * 1.05;
    if (!this.tex.hasArt('pawn')) body.tint = color;
    if (e.asleep) {
      body.rotation = Math.PI / 2;
      body.alpha = 0.85;
    }
    root.addChild(ring, body);
    if (e.carrying) {
      const c = new Sprite(this.tex.item(e.carrying.def));
      c.anchor.set(0.5);
      c.width = c.height = TILE * 0.45;
      c.position.set(TILE * 0.3, -TILE * 0.05);
      root.addChild(c);
    }
    const label = new Text({
      text: e.name.split(' ')[0] + (e.asleep ? ' z' : ''),
      style: { fontFamily: 'IBM Plex Sans', fontSize: 10, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      resolution: 3,
    });
    label.anchor.set(0.5, 0);
    label.position.set(0, TILE * 0.42);
    root.addChild(label);
  }

  // ---------------------------------------------------------------- UI overlay

  private drawUi(): void {
    const g = this.ui;
    g.clear();
    const m = store.mirror;
    const sel = store.selected ? m.entities.get(store.selected) : undefined;
    if (sel) {
      const v = this.views.get(sel.id);
      const x = v ? v.root.x : (sel.x + 0.5) * TILE;
      const y = v ? v.root.y : (sel.y + 0.5) * TILE;
      const r = TILE * 0.55;
      g.rect(x - r, y - r, r * 2, r * 2).stroke({ width: 2 / this.world.scale.x, color: 0xffffff, alpha: 0.9 });
      if (sel.kind === 'pawn' && sel.path) {
        const pts = sel.path.cells.filter((_, i) => sel.path!.times[i] > store.estTick());
        if (pts.length) {
          g.moveTo(x, y);
          for (const c of pts) g.lineTo(((c % m.w) + 0.5) * TILE, (((c / m.w) | 0) + 0.5) * TILE);
          g.stroke({ width: 1.5 / this.world.scale.x, color: 0xffffff, alpha: 0.35 });
        }
      }
    } else if (store.selectedCell !== null) {
      const c = store.selectedCell;
      g.rect((c % m.w) * TILE, ((c / m.w) | 0) * TILE, TILE, TILE).stroke({ width: 2 / this.world.scale.x, color: 0xffffff, alpha: 0.6 });
    }
    this.input.drawPreview(g);
  }

  private drawNight(tick: number): void {
    const hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    // 0 at midday, 1 deep night, smooth through dusk and dawn.
    const dark = hour < 5 || hour > 21 ? 1 : hour < 7 ? (7 - hour) / 2 : hour > 19 ? (hour - 19) / 2 : 0;
    const eclipse = store.mirror.conditions.some((c) => c.key === 'eclipse');
    const a = Math.max(eclipse ? 0.8 : 0, dark) * 0.5;
    this.night.clear();
    if (a > 0.01) this.night.rect(0, 0, this.app.screen.width, this.app.screen.height).fill({ color: 0x0a1430, alpha: a });
  }
}

function isWall(e: Entity | undefined): boolean {
  if (!e || e.kind !== 'building') return false;
  const d = BUILDINGS[e.def];
  return !!d?.wall && !d.door;
}

function rgba(color: number, a: number): string {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${a})`;
}
