import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { BUILDINGS, PLANTS, ROCKS, TERRAINS, WEAPON_KEYS, weaponOf, type TerrainDef } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import { DESIG, SHOT_FIELDS, TICKS_PER_DAY, TICKS_PER_HOUR, bleedRate, hash2, woundTotal, type Construct, type Entity, type Pawn } from '@fe/sim';
import { store } from '../store';
import { TextureBank } from './textures';
import { Input } from './input';

/** World units per cell. */
export const TILE = 32;
/** Pixels per cell in the terrain and overlay canvases. */
const PX = 8;
/** Texture pixels skipped per canvas pixel when sampling terrain art (texture repeats every 128/(PX*STEP) cells). */
const TEX_STEP = 2;

/** One attack being animated: a projectile flies, then its tracer fades. */
interface ShotFx {
  shooter: number;
  target: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  hit: boolean;
  weapon: string;
  born: number;
}

/** Projectile flight time and how long the tracer lingers after, in ms. */
const SHOT_FLY_MS = 140;
const SHOT_FADE_MS = 260;

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
    fx: new Container(),
    ui: new Container(),
  };
  private fireGfx = new Graphics();
  private shotGfx = new Graphics();
  private shots: ShotFx[] = [];
  private lastShotDrain = 0;
  private orderMark: { x: number; y: number; attack: boolean; born: number } | null = null;
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
    this.layers.fx.addChild(this.fireGfx, this.shotGfx);
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
      for (const c of m.changedCells) for (const k of [c, c + 1, c + m.w, c - m.w]) if (k >= 0 && k < n) this.drawTerrainCell(ctx, k);
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
    this.drawFire();
    this.drawShots();
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
    this.terrainTex.source.scaleMode = this.tex.pixels.size ? 'linear' : 'nearest';
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
    const terrain: TerrainDef = TERRAINS[m.terrain[c]];
    const base = rock ? ROCKS[rock].color : terrain.color;
    // Ore veins are granite tinted toward the ore colour.
    const tex = this.tex.pixels.get(rock ? 'rock_granite' : `terrain_${terrain.key}`);
    const tint = rock > 1 ? base : -1;
    const openUp = rock && y > 0 && !m.rock[c - m.w];
    const openLeft = rock && x > 0 && !m.rock[c - 1];
    const openDown = rock && y < m.h - 1 && !m.rock[c + m.w];
    for (let py = 0; py < PX; py++) {
      for (let px = 0; px < PX; px++) {
        const gx = x * PX + px;
        const gy = y * PX + py;
        let r: number;
        let g: number;
        let b: number;
        let f = 1;
        if (tex) {
          const tx = (gx * TEX_STEP) % tex.w;
          const ty = (gy * TEX_STEP) % tex.h;
          const o = (ty * tex.w + tx) * 4;
          r = tex.data[o];
          g = tex.data[o + 1];
          b = tex.data[o + 2];
          if (tint >= 0 && hash2(gx >> 2, gy >> 2, 3) > 0.55) {
            r = (r + ((tint >> 16) & 255) * 1.6) / 2;
            g = (g + ((tint >> 8) & 255) * 1.6) / 2;
            b = (b + (tint & 255) * 1.6) / 2;
          }
          // Faint per-cell variation breaks up visible tiling.
          f = 0.94 + hash2(x, y, 11) * 0.12;
        } else {
          r = (base >> 16) & 255;
          g = (base >> 8) & 255;
          b = base & 255;
          f = 0.92 + hash2(gx, gy, 7) * 0.16;
          if (rock > 1 && hash2(gx, gy, 3) > 0.8) f *= 1.6;
        }
        if (rock) {
          // Bevel rock edges that face open ground.
          if ((py < 2 && openUp) || (px < 2 && openLeft)) f *= 1.3;
          if (py >= PX - 2 && openDown) f *= 0.6;
        }
        const o = ((oy + py) * stride + ox + px) * 4;
        data[o] = Math.min(255, r * f);
        data[o + 1] = Math.min(255, g * f);
        data[o + 2] = Math.min(255, b * f);
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
      const t = PX / 4;
      const l = PX / 2;
      ctx.fillRect(x, y, l, t);
      ctx.fillRect(x, y, t, l);
      ctx.fillRect(x + PX - l, y + PX - t, l, t);
      ctx.fillRect(x + PX - t, y + PX - l, t, l);
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
        return `w:${e.faction}:${e.name}:${e.asleep ? 1 : 0}:${e.carrying?.def ?? ''}:${e.weapon}:${e.drafted ? 1 : 0}:${e.downed ? 1 : 0}:${Math.ceil(woundTotal(e) * 20)}:${bleedRate(e) > 0 ? 1 : 0}`;
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
    if (e.asleep || e.downed) {
      body.rotation = Math.PI / 2;
      body.alpha = 0.85;
    }
    if (e.downed) body.tint = 0xd07070;
    root.addChild(ring, body);
    const wd = weaponOf(e.weapon);
    if (e.weapon && !e.downed) {
      // A small weapon glyph at the pawn's side: a bow arc, a long barrel, or a short blade.
      const g = new Graphics();
      if (e.weapon === 'bow') g.arc(TILE * 0.3, 0, TILE * 0.18, -Math.PI / 2.2, Math.PI / 2.2).stroke({ width: 2, color: 0xc8a070 });
      else
        g.moveTo(TILE * 0.22, TILE * 0.12)
          .lineTo(TILE * (wd.melee ? 0.42 : 0.55), -TILE * (wd.melee ? 0.12 : 0.18))
          .stroke({ width: wd.melee ? 2.5 : 2, color: wd.melee ? 0xd8d8d8 : 0x6a5a48 });
      root.addChild(g);
    }
    if (e.drafted) {
      // Drafted: a chevron over the head in the faction colour.
      const d = new Graphics()
        .poly([-6, -TILE * 0.62, 0, -TILE * 0.5, 6, -TILE * 0.62, 6, -TILE * 0.74, 0, -TILE * 0.62, -6, -TILE * 0.74])
        .fill(color)
        .stroke({ width: 1.2, color: 0x000000, alpha: 0.8 });
      root.addChild(d);
    }
    const hurt = woundTotal(e);
    if (hurt > 0.02 || e.downed) {
      const bw = TILE * 0.7;
      const bar = new Graphics().rect(-bw / 2, -TILE * 0.46, bw, 3).fill({ color: 0x000000, alpha: 0.6 });
      bar.rect(-bw / 2, -TILE * 0.46, bw * Math.max(0, 1 - hurt), 3).fill(bleedRate(e) > 0 ? 0xe04040 : 0x60c060);
      root.addChild(bar);
    }
    if (e.carrying) {
      const c = new Sprite(this.tex.item(e.carrying.def));
      c.anchor.set(0.5);
      c.width = c.height = TILE * 0.45;
      c.position.set(TILE * 0.3, -TILE * 0.05);
      root.addChild(c);
    }
    const label = new Text({
      text: e.name.split(' ')[0] + (e.downed ? ' (down)' : e.asleep ? ' z' : ''),
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
    const sw = 1 / this.world.scale.x;
    for (const id of store.squad) {
      if (id === store.selected) continue;
      const v = this.views.get(id);
      if (!v) continue;
      const r = TILE * 0.5;
      g.rect(v.root.x - r, v.root.y - r, r * 2, r * 2).stroke({ width: 1.5 * sw, color: 0xffffff, alpha: 0.6 });
    }
    // Who your selected fighters are going after.
    for (const id of store.squad) {
      const p = m.get<Pawn>(id);
      const v = this.views.get(id);
      if (!p || !v || p.job?.type !== 'attack') continue;
      const tv = this.views.get(p.job.target);
      if (tv) g.moveTo(v.root.x, v.root.y).lineTo(tv.root.x, tv.root.y).stroke({ width: 1.5 * sw, color: 0xff5040, alpha: 0.45 });
    }
    const om = this.orderMark;
    if (om) {
      const age = (performance.now() - om.born) / 500;
      if (age >= 1) this.orderMark = null;
      else {
        const r = TILE * (0.25 + 0.35 * age);
        g.circle((om.x + 0.5) * TILE, (om.y + 0.5) * TILE, r).stroke({ width: 2 * sw, color: om.attack ? 0xff4030 : 0x80d0ff, alpha: 1 - age });
      }
    }
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

  /** Mark where a right-click order went. */
  flashOrder(x: number, y: number, attack: boolean): void {
    this.orderMark = { x, y, attack, born: performance.now() };
  }

  /** Pull new attacks from the mirror and animate them: a projectile then a fading tracer, or a swing. */
  private drawShots(): void {
    const m = store.mirror;
    const now = performance.now();
    const q = m.shots;
    // After a stretch without frames (hidden tab), skip the backlog rather than replay it all at once.
    const stale = now - this.lastShotDrain > 500;
    this.lastShotDrain = now;
    for (let k = stale ? q.length : 0; k + SHOT_FIELDS <= q.length; k += SHOT_FIELDS) {
      this.shots.push({ shooter: q[k], target: q[k + 1], sx: q[k + 2], sy: q[k + 3], tx: q[k + 4], ty: q[k + 5], hit: q[k + 6] === 1, weapon: WEAPON_KEYS[q[k + 7]] ?? '', born: now });
    }
    q.length = 0;
    this.shots = this.shots.filter((s) => now - s.born < SHOT_FLY_MS + SHOT_FADE_MS).slice(-300);
    const g = this.shotGfx;
    g.clear();
    for (const s of this.shots) {
      const wd = weaponOf(s.weapon);
      // Follow the drawn (interpolated) pawns while they're still around.
      const a = this.views.get(s.shooter)?.root;
      const b = this.views.get(s.target)?.root;
      const ax = a ? a.x : (s.sx + 0.5) * TILE;
      const ay = a ? a.y - TILE * 0.15 : (s.sy + 0.5) * TILE;
      let bx = b ? b.x : (s.tx + 0.5) * TILE;
      let by = b ? b.y - TILE * 0.15 : (s.ty + 0.5) * TILE;
      if (!s.hit) {
        // Misses fly wide and past the target.
        bx += (hash2(s.shooter, Math.floor(s.born), 5) - 0.5) * TILE * 1.6 + (bx - ax) * 0.25;
        by += (hash2(s.target, Math.floor(s.born), 9) - 0.5) * TILE * 1.6 + (by - ay) * 0.25;
      }
      const age = now - s.born;
      if (wd.melee) {
        // A swing: a short arc in front of the attacker, red if it landed.
        const f = Math.min(1, age / (SHOT_FLY_MS + SHOT_FADE_MS));
        const ang = Math.atan2(by - ay, bx - ax);
        g.arc(ax, ay, TILE * 0.55, ang - 0.7, ang + 0.7).stroke({ width: 3, color: s.hit ? 0xff5040 : 0xffffff, alpha: 0.9 * (1 - f) });
        continue;
      }
      const t = Math.min(1, age / SHOT_FLY_MS);
      const hx = ax + (bx - ax) * t;
      const hy = ay + (by - ay) * t;
      const fade = age < SHOT_FLY_MS ? 1 : 1 - (age - SHOT_FLY_MS) / SHOT_FADE_MS;
      g.moveTo(ax, ay).lineTo(hx, hy).stroke({ width: s.weapon === 'rifle' ? 1.5 : 1, color: wd.color, alpha: 0.55 * fade });
      if (t < 1) g.circle(hx, hy, s.weapon === 'rifle' ? 2.2 : 1.8).fill({ color: wd.color, alpha: 1 });
      else if (s.hit) g.circle(bx, by, 5 * fade + 1).fill({ color: 0xff3020, alpha: 0.7 * fade });
    }
  }

  private drawFire(): void {
    const g = this.fireGfx;
    g.clear();
    const m = store.mirror;
    if (!m.fireCells.size) return;
    const t = performance.now() / 120;
    for (const c of m.fireCells) {
      const level = m.fire[c];
      const x = ((c % m.w) + 0.5) * TILE;
      const y = (((c / m.w) | 0) + 0.5) * TILE;
      const flick = 0.85 + 0.15 * Math.sin(t + c * 1.7);
      const r = TILE * (0.22 + 0.1 * level) * flick;
      g.circle(x, y, r * 1.4).fill({ color: 0xff5010, alpha: 0.25 });
      g.circle(x, y + 2, r).fill({ color: 0xff7a20, alpha: 0.85 });
      g.circle(x + Math.sin(t * 1.3 + c) * 2, y - 2, r * 0.55).fill({ color: 0xffd060, alpha: 0.9 });
    }
  }

  private drawNight(tick: number): void {
    const hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    // 0 at midday, 1 deep night, smooth through dusk and dawn.
    const dark = hour < 5 || hour > 21 ? 1 : hour < 7 ? (7 - hour) / 2 : hour > 19 ? (hour - 19) / 2 : 0;
    const active = new Set(store.mirror.conditions.map((c) => c.key));
    const forcedDark = active.has('eclipse') || active.has('long_night') || active.has('ash_fall');
    const a = Math.max(forcedDark ? 0.75 : 0, dark) * 0.5;
    const g = this.night;
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    g.clear();
    if (a > 0.01) g.rect(0, 0, W, H).fill({ color: 0x0a1430, alpha: a });
    // Weather tints.
    const tint = (color: number, alpha: number) => alpha > 0.01 && g.rect(0, 0, W, H).fill({ color, alpha });
    if (active.has('fog')) tint(0xc8d0d8, 0.28);
    if (active.has('blizzard')) tint(0xe8f0ff, 0.25);
    if (active.has('ash_fall')) tint(0x3a3634, 0.3);
    if (active.has('spring_rains') || active.has('thunderstorm')) tint(0x203048, 0.15);
    if (active.has('blood_moon')) tint(0x900a0a, 0.08 + 0.2 * dark);
    if (active.has('aurora')) tint(0x20c080, 0.03 + 0.12 * dark);
    if (active.has('heat_wave') || active.has('drought')) tint(0xffa040, 0.07);
    if (active.has('false_spring') || active.has('warm_spell')) tint(0xfff0a0, 0.06);
    if (active.has('cold_wind') || active.has('cold_snap') || active.has('early_frost')) tint(0xa8d8ff, 0.1);
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
