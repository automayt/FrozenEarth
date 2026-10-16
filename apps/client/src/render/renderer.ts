import { Application, BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { BUILDINGS, maxHp, PLANTS, ROCKS, TERRAINS, WEAPON_KEYS, weaponOf, type TerrainDef } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import { DESIG, FROST_BAND, MIN_COLONY_GAP, SHOT_FIELDS, TICKS_PER_DAY, TICKS_PER_HOUR, bleedRate, calendar, frostLevel, frostRadius, hash2, outdoorTempAt, woundTotal, type Construct, type Entity, type Pawn } from '@fe/sim';
import { ease, Particles, Tweens, Weather, type Precip } from './fx';
import { sound } from '../audio';
import { store } from '../store';
import { TextureBank } from './textures';
import { Input } from './input';

/** World units per cell. */
export const TILE = 32;
/** Cells per culling chunk. */
const CHUNK = 16;
/** Bitmap text is generated at 2x and drawn at half scale so it stays sharp when zoomed. */
const LABEL_STYLE = { fontFamily: 'IBM Plex Sans', fontSize: 22, fill: 0xffffff, stroke: { color: 0x000000, width: 5 } };
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
  key: string;
  kind: Entity['kind'];
  def: string;
  /** Set for walls, so neighbours can re-join when this one goes away. */
  wallCell?: number;
  // Pawn animation state (purely visual).
  /** Inner container for body, weapon and carried item: bobs, leans and flips without moving the label. */
  rig?: Container;
  body?: Sprite;
  baseTint?: number;
  lastX?: number;
  lastY?: number;
  /** Walk cycle phase in radians. */
  phase?: number;
  facing?: number;
  flashUntil?: number;
  nextFx?: number;
  nextZ?: number;
}

/** What a working pawn is working on, and what that throws up. */
type WorkFx = 'stone' | 'wood' | 'leaf' | 'build' | 'soil' | 'craft' | 'steam' | 'tend';

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
    /** Frost over the frozen zone: whitens ground, buildings and trees alike. */
    frost: new Container(),
    pawns: new Container(),
    fx: new Container(),
    ui: new Container(),
  };
  private fireGfx = new Graphics();
  private shotGfx = new Graphics();
  private shots: ShotFx[] = [];
  private lastShotDrain = 0;
  private orderMark: { x: number; y: number; attack: boolean; born: number } | null = null;
  private particles = new Particles();
  private tweens = new Tweens();
  private weather = new Weather();
  /** True once the first snapshot has been drawn; only later arrivals and departures animate. */
  private built = false;
  /** Rock layer as last drawn, to spot freshly mined cells. */
  private prevRock = new Uint8Array(0);
  private glide: { fx: number; fy: number; tx: number; ty: number; t0: number } | null = null;
  private lastFrame = performance.now();
  private frostCanvas = document.createElement('canvas');
  private frostTex: Texture | null = null;
  /** Radius the frost overlay was last drawn at. */
  private frostDrawn = -1;
  private frostRing = new Graphics();
  ui = new Graphics();
  private night = new Graphics();
  private views = new Map<number, EntityView>();
  private pawnIds = new Set<number>();
  /** Static entity views are grouped into CHUNK x CHUNK cell containers so off-screen ones can be hidden. */
  private chunks = new Map<string, Container>();
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
    this.app.stage.addChild(this.world, this.night, this.weather.g);
    for (const l of Object.values(this.layers)) this.world.addChild(l);
    this.layers.ui.addChild(this.ui);
    this.layers.fx.addChild(this.fireGfx, this.particles.g, this.shotGfx);
    this.layers.frost.addChild(this.frostRing);
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

  /** The cell at the centre of the screen. */
  private viewCenter(): { x: number; y: number } {
    const s = this.world.scale.x;
    return { x: (this.app.screen.width / 2 - this.world.x) / s / TILE - 0.5, y: (this.app.screen.height / 2 - this.world.y) / s / TILE - 0.5 };
  }

  /** Smoothly pan to a cell (jumps if it's far away). */
  glideTo(x: number, y: number): void {
    const c = this.viewCenter();
    if (Math.hypot(c.x - x, c.y - y) > 80) {
      this.centerOn(x, y);
      this.glide = null;
      return;
    }
    this.glide = { fx: c.x, fy: c.y, tx: x, ty: y, t0: performance.now() };
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
    const now = performance.now();
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    if (store.focus) {
      if (this.built) this.glideTo(store.focus.x, store.focus.y);
      else this.centerOn(store.focus.x, store.focus.y);
      store.focus = null;
    }
    if (this.glide) {
      const k = Math.min(1, (now - this.glide.t0) / 380);
      const e = ease.outQuad(k);
      this.centerOn(this.glide.fx + (this.glide.tx - this.glide.fx) * e, this.glide.fy + (this.glide.ty - this.glide.fy) * e);
      if (k >= 1) this.glide = null;
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
    if (this.prevRock.length !== m.w * m.h) this.prevRock = m.rock.slice();
    if (m.changedCells.size && this.built) {
      // Freshly mined rock bursts into dust and chips.
      for (const c of m.changedCells) {
        if (this.prevRock[c] && !m.rock[c]) {
          const x = ((c % m.w) + 0.5) * TILE;
          const y = (((c / m.w) | 0) + 0.5) * TILE;
          this.particles.burst(x, y, { count: 14, color: [0x8a8580, 0x6a6560, 0xa8a49c], speed: 70, size: 2.2, life: 700, gravity: 60, drag: 3, chips: true });
          this.particles.burst(x, y, { count: 8, color: 0xb0aaa0, speed: 25, size: 4, grow: 6, life: 900, lift: 10, alpha: 0.5 });
          sound.play('rock', x, y);
        }
      }
    }
    for (const c of m.changedCells) this.prevRock[c] = m.rock[c];
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
    for (const id of m.removedEnts) this.removeView(id, true);
    m.removedEnts.clear();
    for (const id of m.changedEnts) {
      const e = m.entities.get(id);
      if (e) this.updateView(e);
    }
    m.changedEnts.clear();

    if (!this.built && m.entities.size) this.built = true;

    const tick = store.estTick();
    for (const id of this.pawnIds) {
      const e = m.entities.get(id);
      const v = this.views.get(id);
      if (!e || e.kind !== 'pawn' || !v) continue;
      const pos = pawnPosition(e, tick, m.w);
      v.root.position.set((pos.x + 0.5) * TILE, (pos.y + 0.5) * TILE);
      this.animatePawn(e, v, now);
    }
    this.cullChunks();
    {
      const a = this.screenToWorld(0, 0);
      const b = this.screenToWorld(this.app.screen.width, this.app.screen.height);
      store.view = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      sound.setListener(((a.x + b.x) / 2) * TILE, ((a.y + b.y) / 2) * TILE, (b.x - a.x) * TILE);
    }
    this.drawFrost(tick);
    this.swayPlants(now);
    this.layers.pawns.children.sort((a, b) => a.y - b.y);
    this.drawFire(dt);
    this.drawShots();
    this.particles.update(dt);
    this.tweens.update(now);
    this.drawUi();
    this.drawNight(tick);
    this.drawWeather(tick, dt);
  }

  // ---------------------------------------------------------------- animation

  /** Bob while walking, face the direction of travel, swing at work, breathe in sleep, flash when hit. */
  private animatePawn(e: Pawn, v: EntityView, now: number): void {
    const rig = v.rig;
    if (!rig) return;
    const x = v.root.x;
    const y = v.root.y;
    const dx = v.lastX === undefined ? 0 : x - v.lastX;
    const dy = v.lastY === undefined ? 0 : y - v.lastY;
    v.lastX = x;
    v.lastY = y;
    const moved = Math.hypot(dx, dy);
    if (Math.abs(dx) > 0.05) v.facing = dx > 0 ? 1 : -1;
    let bob = 0;
    let lean = 0;
    let sx = 1;
    let sy = 1;
    if (e.asleep || e.downed) {
      // Slow breathing; a "z" now and then for sleepers.
      const b = Math.sin(now / 700 + e.id) * 0.04;
      sx = 1 + b;
      sy = 1 - b;
      if (e.asleep && !e.downed && now >= (v.nextZ ?? 0)) {
        this.particles.zed(x + 6, y - TILE * 0.4);
        v.nextZ = now + 1300 + Math.random() * 500;
      }
    } else if (moved > 0.02) {
      // A step every half cell or so.
      v.phase = ((v.phase ?? 0) + (moved / TILE) * Math.PI * 2.2) % (Math.PI * 2);
      bob = -Math.abs(Math.sin(v.phase)) * 3.2;
      lean = Math.sin(v.phase) * 0.06;
      this.setWalkFrame(v, v.phase);
    } else {
      this.setWalkFrame(v, -1);
      const work = this.workTarget(e);
      if (work) {
        // Face the work and swing at it.
        const tx = (work.cell % store.mirror.w) + 0.5;
        const ty = Math.floor(work.cell / store.mirror.w) + 0.5;
        if (Math.abs(tx * TILE - x) > 2) v.facing = tx * TILE > x ? 1 : -1;
        const gentle = work.fx === 'soil' || work.fx === 'tend' || work.fx === 'craft';
        const swing = Math.sin((now / 1000) * (gentle ? 7 : 11) + e.id);
        lean = swing * (work.fx === 'tend' || work.fx === 'craft' ? 0.08 : 0.22);
        bob = -Math.max(0, swing) * 1.5;
        if (now >= (v.nextFx ?? 0)) {
          this.workParticles(work.fx, tx * TILE, ty * TILE);
          v.nextFx = now + 280 + Math.random() * 200;
        }
      } else {
        // Idle: a slight sway.
        lean = Math.sin(now / 900 + e.id) * 0.02;
      }
    }
    const facing = v.facing ?? 1;
    rig.position.y = bob;
    rig.rotation = lean * facing;
    rig.scale.set(facing * sx, sy);
    if (v.body) v.body.tint = (v.flashUntil ?? 0) > now ? 0xff7060 : (v.baseTint ?? 0xffffff);
  }

  /** Swap the body texture for walk-cycle frames, if the art exists. phase < 0 = standing. */
  private setWalkFrame(v: EntityView, phase: number): void {
    if (!v.body) return;
    const frames = this.tex.walkFrames();
    if (!frames.length) return;
    v.body.texture = phase < 0 ? this.tex.pawn() : frames[Math.floor((phase / (Math.PI * 2)) * frames.length * 2) % frames.length];
  }

  /** The cell a pawn is working on right now, if it's standing next to it. */
  private workTarget(e: Pawn): { cell: number; fx: WorkFx } | null {
    const j = e.job;
    if (!j || e.path) return null;
    const m = store.mirror;
    const cellOf = (id: number) => {
      const t = m.entities.get(id);
      return t ? t.y * m.w + t.x : -1;
    };
    let cell = -1;
    let fx: WorkFx = 'build';
    switch (j.type) {
      case 'mine':
        cell = j.cell;
        fx = 'stone';
        break;
      case 'cut': {
        cell = cellOf(j.target);
        const t = m.entities.get(j.target);
        fx = t && t.kind === 'plant' && PLANTS[t.def]?.tree ? 'wood' : 'leaf';
        break;
      }
      case 'build':
        cell = cellOf(j.target);
        break;
      case 'sow':
        cell = j.cell;
        fx = 'soil';
        break;
      case 'bill':
        if (j.stage !== 3) return null;
        cell = cellOf(j.bench);
        fx = 'craft';
        break;
      case 'extinguish':
        cell = j.cell;
        fx = 'steam';
        break;
      case 'tend':
        cell = cellOf(j.patient);
        fx = 'tend';
        break;
      default:
        return null;
    }
    if (cell < 0) return null;
    const px = cell % m.w;
    const py = Math.floor(cell / m.w);
    return Math.max(Math.abs(px - e.x), Math.abs(py - e.y)) <= 1 ? { cell, fx } : null;
  }

  private workParticles(fx: WorkFx, x: number, y: number): void {
    const p = this.particles;
    sound.play(fx, x, y);
    switch (fx) {
      case 'stone':
        p.burst(x, y, { count: 4, color: [0x8a8580, 0xa8a49c], speed: 60, size: 1.6, life: 450, gravity: 120, chips: true });
        break;
      case 'wood':
        p.burst(x, y + 6, { count: 4, color: [0xc89058, 0xe0b078, 0x8a5a30], speed: 70, size: 1.8, life: 500, gravity: 140, chips: true });
        break;
      case 'leaf':
        p.burst(x, y, { count: 3, color: [0x6aa040, 0x4a8030], speed: 40, size: 1.8, life: 700, gravity: 30, chips: true });
        break;
      case 'build':
        p.burst(x, y, { count: 3, color: [0xd8c8a0, 0xffe090], speed: 55, size: 1.4, life: 350, gravity: 60 });
        break;
      case 'soil':
        p.burst(x, y + 4, { count: 3, color: [0x6b5a3e, 0x4f4128], speed: 35, size: 1.6, life: 400, gravity: 90 });
        break;
      case 'craft':
        p.burst(x, y - 4, { count: 2, color: [0xffd070, 0xfff0c0], speed: 45, size: 1.2, life: 300, gravity: 40 });
        break;
      case 'steam':
        p.burst(x, y, { count: 3, color: 0xe8eef4, speed: 20, size: 3, grow: 8, life: 900, lift: 25, alpha: 0.6 });
        break;
      case 'tend':
        break;
    }
  }

  /** Trees and crops sway gently in the wind; storms push harder. Visible chunks only. */
  private swayPlants(now: number): void {
    const windy = store.mirror.conditions.some((c) => c.key === 'thunderstorm' || c.key === 'blizzard' || c.key === 'cold_wind') ? 2.6 : 1;
    const t = now / 1000;
    for (const layer of [this.layers.plants, this.layers.floorThings]) {
      const tree = layer === this.layers.plants;
      for (const chunk of layer.children) {
        if (!chunk.visible) continue;
        for (const root of chunk.children) {
          if (root.label !== 'plant') continue;
          const s = root.children[0];
          if (s) s.rotation = Math.sin(t * (tree ? 1.3 : 2.1) + root.x * 0.031 + root.y * 0.047) * (tree ? 0.03 : 0.07) * windy;
        }
      }
    }
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
          // Rock samples a finer, darker version so cracks don't read as huge repeating stripes.
          const step = rock ? TEX_STEP * 2 : TEX_STEP;
          const tx = (gx * step) % tex.w;
          const ty = (gy * step) % tex.h;
          const o = (ty * tex.w + tx) * 4;
          r = tex.data[o];
          g = tex.data[o + 1];
          b = tex.data[o + 2];
          if (rock) {
            const base1 = ROCKS[1].color;
            r = r * 0.45 + ((base1 >> 16) & 255) * 0.75;
            g = g * 0.45 + ((base1 >> 8) & 255) * 0.75;
            b = b * 0.45 + (base1 & 255) * 0.75;
          }
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

  /** Drop a view. With `leaving`, the entity left the world, so play an exit if it has one. */
  private removeView(id: number, leaving = false): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    this.pawnIds.delete(id);
    const root = v.root;
    if (!leaving || !this.built || !root.visible || !root.parent?.visible) {
      root.destroy({ children: true });
      return;
    }
    const kill = () => root.destroy({ children: true });
    if (v.kind === 'plant' && PLANTS[v.def]?.tree) {
      // Timber: the tree tips over from its base and fades, shedding leaves.
      const s = root.children[0] as Sprite | undefined;
      if (s) {
        const h = s.height;
        s.anchor.set(0.5, 0.92);
        s.position.y = h * 0.42;
      }
      const dir = Math.random() < 0.5 ? -1 : 1;
      sound.play('fall', root.x, root.y);
      this.particles.burst(root.x, root.y, { count: 10, color: [0x4a8030, 0x6aa040, 0x2f5a2a], speed: 50, size: 2, life: 900, gravity: 40, chips: true });
      this.tweens.add(
        800,
        (k) => {
          if (s) s.rotation = dir * ease.inQuad(k) * 1.45;
          root.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
        },
        kill,
      );
    } else if (v.kind === 'building') {
      // Collapse into a puff of dust and debris.
      sound.play('crumble', root.x, root.y);
      this.particles.burst(root.x, root.y, { count: 14, color: [0x8a7a68, 0x6a5a48, 0xa89880], speed: 60, size: 2, life: 700, gravity: 80, chips: true });
      this.particles.burst(root.x, root.y, { count: 6, color: 0xb0a898, speed: 20, size: 5, grow: 8, life: 900, lift: 12, alpha: 0.45 });
      this.tweens.add(220, (k) => root.scale.set(1 - 0.4 * k, 1 - 0.7 * k), kill);
    } else if (v.kind === 'item') {
      // Picked up: a quick shrink.
      this.tweens.add(140, (k) => root.scale.set(1 - k), kill);
    } else if (v.kind === 'pawn') {
      this.tweens.add(600, (k) => (root.alpha = 1 - k), kill);
    } else {
      kill();
    }
  }

  /** Arrivals pop in with a little overshoot. */
  private popIn(root: Container, dur = 260): void {
    this.tweens.add(dur, (k) => root.scale.set(0.35 + 0.65 * ease.outBack(k)));
  }

  /** Add a static view to its layer's chunk container. */
  private place(layer: 'plants' | 'floorThings' | 'items' | 'buildings', root: Container, x: number, y: number): void {
    const key = `${layer}:${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Container();
      chunk.label = key;
      (chunk as Container & { cx: number; cy: number }).cx = Math.floor(x / CHUNK);
      (chunk as Container & { cx: number; cy: number }).cy = Math.floor(y / CHUNK);
      this.layers[layer].addChild(chunk);
      this.chunks.set(key, chunk);
    }
    chunk.addChild(root);
  }

  /** Hide chunks outside the camera view (plus a margin for big tree sprites). */
  private cullChunks(): void {
    const a = this.screenToCell(0, 0);
    const b = this.screenToCell(this.app.screen.width, this.app.screen.height);
    const x0 = Math.floor((a.x - 2) / CHUNK);
    const y0 = Math.floor((a.y - 2) / CHUNK);
    const x1 = Math.floor((b.x + 2) / CHUNK);
    const y1 = Math.floor((b.y + 2) / CHUNK);
    for (const c of this.chunks.values()) {
      const { cx, cy } = c as Container & { cx: number; cy: number };
      c.visible = cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    }
  }

  private viewKey(e: Entity): string {
    switch (e.kind) {
      case 'plant':
        return `p:${e.def}:${Math.floor(e.growth * 10)}:${e.blighted ? 1 : 0}`;
      case 'item':
        return `i:${e.def}:${e.count}:${e.rot >= 0.5 ? 1 : 0}`;
      case 'building': {
        // Damage in eighths, so a wall being smashed redraws a few times rather than every blow.
        const dmg = Math.ceil((1 - e.hp / maxHp(e.def)) * 8);
        return isWall(e) ? `b:${e.def}:${e.faction}:${this.wallMask(e.x, e.y)}:${dmg}` : `b:${e.def}:${e.faction}:${dmg}`;
      }
      case 'construct': {
        const total = Object.values(BUILDINGS[e.def].cost).reduce((a, b) => a + b, 0);
        const got = Object.values(e.delivered).reduce((a, b) => a + b, 0);
        return `c:${e.def}:${got}/${total}:${Math.floor((e.progress / BUILDINGS[e.def].work) * 10)}`;
      }
      case 'pawn':
        return `w:${e.faction}:${e.name}:${e.asleep ? 1 : 0}:${e.carrying?.def ?? ''}:${e.weapon}:${e.drafted ? 1 : 0}:${e.downed ? 1 : 0}:${Math.ceil(woundTotal(e) * 20)}:${bleedRate(e) > 0 ? 1 : 0}:${e.prisoner}`;
    }
  }

  private updateView(e: Entity): void {
    const key = this.viewKey(e);
    const old = this.views.get(e.id);
    if (old && old.key === key) return;
    if (old) this.removeView(e.id);
    const root = new Container();
    const v: EntityView = { root, key, kind: e.kind, def: 'def' in e ? e.def : '' };
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
        root.label = 'plant';
        this.place(d.tree ? 'plants' : 'floorThings', root, e.x, e.y);
        break;
      }
      case 'item': {
        const s = new Sprite(this.tex.item(e.def));
        s.anchor.set(0.5);
        s.width = s.height = TILE * 0.9;
        if (e.rot >= 0.5) s.tint = 0xa0b070;
        root.addChild(s);
        if (e.count > 1) {
          const t = new BitmapText({ text: String(e.count), style: LABEL_STYLE });
          t.scale.set(0.5);
          t.anchor.set(1, 1);
          t.position.set(TILE / 2 - 1, TILE / 2);
          root.addChild(t);
        }
        this.place('items', root, e.x, e.y);
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
        const health = e.hp / maxHp(e.def);
        if (health < 1) {
          // Battered: darker, with a strip showing what's left.
          const k = Math.round(0x60 + 0x9f * health);
          s.tint = (k << 16) | (k << 8) | k;
          root.addChild(
            new Graphics()
              .rect(-TILE / 2 + 2, -TILE / 2 + 2, TILE - 4, 3)
              .fill(0x301010)
              .rect(-TILE / 2 + 2, -TILE / 2 + 2, (TILE - 4) * health, 3)
              .fill(health < 0.35 ? 0xe05040 : 0xe0b040),
          );
        }
        if (d.door) {
          const f = store.mirror.factions.get(e.faction);
          const g = new Graphics().rect(-TILE / 2, TILE / 2 - 4, TILE, 3).fill(f?.color ?? 0xffffff);
          root.addChild(g);
        }
        this.place(d.floorTerrain ? 'floorThings' : 'buildings', root, e.x, e.y);
        break;
      }
      case 'construct':
        this.drawConstruct(root, e);
        this.place('buildings', root, e.x, e.y);
        break;
      case 'pawn':
        this.drawPawn(root, e, v);
        this.layers.pawns.addChild(root);
        this.pawnIds.add(e.id);
        break;
    }
    this.views.set(e.id, v);
    if (!old && this.built) {
      if (e.kind === 'pawn') this.tweens.add(400, (k) => (root.alpha = k));
      else this.popIn(root);
      if (e.kind === 'building') sound.play('pop', root.x, root.y);
    }
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

  private drawPawn(root: Container, e: Pawn, v: EntityView): void {
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
    // Body, weapon and load ride on a rig so they can bob and swing together.
    const rig = new Container();
    rig.addChild(body);
    root.addChild(ring, rig);
    v.rig = rig;
    v.body = body;
    v.baseTint = body.tint;
    const wd = weaponOf(e.weapon);
    if (e.weapon && !e.downed) {
      // A small weapon glyph at the pawn's side: a bow arc, a long barrel, or a short blade.
      const g = new Graphics();
      if (e.weapon === 'bow') g.arc(TILE * 0.3, 0, TILE * 0.18, -Math.PI / 2.2, Math.PI / 2.2).stroke({ width: 2, color: 0xc8a070 });
      else
        g.moveTo(TILE * 0.22, TILE * 0.12)
          .lineTo(TILE * (wd.melee ? 0.42 : 0.55), -TILE * (wd.melee ? 0.12 : 0.18))
          .stroke({ width: wd.melee ? 2.5 : 2, color: wd.melee ? 0xd8d8d8 : 0x6a5a48 });
      rig.addChild(g);
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
      rig.addChild(c);
    }
    const label = new BitmapText({ text: e.name.split(' ')[0] + (e.prisoner ? ' (prisoner)' : '') + (e.downed ? ' (down)' : e.asleep ? ' z' : ''), style: LABEL_STYLE });
    label.scale.set(0.45);
    label.anchor.set(0.5, 0);
    label.position.set(0, TILE * 0.42);
    root.addChild(label);
  }

  // ---------------------------------------------------------------- UI overlay

  private drawUi(): void {
    const g = this.ui;
    g.clear();
    const m = store.mirror;
    if (store.me?.faction === 0) {
      this.drawSettleUi(g);
      return;
    }
    if (store.tool.kind === 'moveHome') {
      // Picking a new home: show where other colonies keep their distance, and the spot under the cursor.
      const hc = store.hoverCell;
      store.settlePick = hc === null ? null : { x: hc % m.w, y: Math.floor(hc / m.w) };
      this.drawSettleUi(g, store.me?.faction);
      return;
    }
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

  /** While choosing a start: other colonies' exclusion zones, suggested sites, and the picked spot. */
  private drawSettleUi(g: Graphics, self = 0): void {
    const m = store.mirror;
    const w = 2 / this.world.scale.x;
    for (const f of m.factions.values()) {
      if (!f.isPlayer || f.id === self) continue;
      const cx = (f.home.x + 0.5) * TILE;
      const cy = (f.home.y + 0.5) * TILE;
      g.circle(cx, cy, MIN_COLONY_GAP * TILE).fill({ color: f.color, alpha: 0.08 }).stroke({ width: w, color: f.color, alpha: 0.6 });
    }
    for (const s of store.sites) {
      g.circle((s.x + 0.5) * TILE, (s.y + 0.5) * TILE, 5 * TILE).stroke({ width: w * 1.5, color: 0x8ac8ff, alpha: 0.9 });
    }
    const p = store.settlePick;
    if (p) {
      const cx = (p.x + 0.5) * TILE;
      const cy = (p.y + 0.5) * TILE;
      g.circle(cx, cy, 5 * TILE).fill({ color: 0xf0b43c, alpha: 0.15 }).stroke({ width: w * 2, color: 0xf0b43c });
      g.circle(cx, cy, TILE * 0.4).fill(0xf0b43c);
    }
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
      const shot = { shooter: q[k], target: q[k + 1], sx: q[k + 2], sy: q[k + 3], tx: q[k + 4], ty: q[k + 5], hit: q[k + 6] === 1, weapon: WEAPON_KEYS[q[k + 7]] ?? '', born: now };
      this.shots.push(shot);
      if (!stale) {
        const sv = this.views.get(shot.shooter)?.root;
        const wdef = weaponOf(shot.weapon);
        sound.play(wdef.melee ? 'melee' : shot.weapon === 'bow' ? 'bow' : 'rifle', sv?.x ?? (shot.sx + 0.5) * TILE, sv?.y ?? (shot.sy + 0.5) * TILE);
      }
      if (shot.hit && !stale) {
        const melee = weaponOf(shot.weapon).melee;
        this.tweens.add(melee ? 60 : SHOT_FLY_MS, () => {}, () => {
          const tv = this.views.get(shot.target);
          if (!tv) return;
          tv.flashUntil = performance.now() + 160;
          sound.play('hit', tv.root.x, tv.root.y);
          this.particles.burst(tv.root.x, tv.root.y - TILE * 0.15, { count: 6, color: [0xc02020, 0x901010], speed: 55, size: 1.5, life: 450, gravity: 120 });
        });
      }
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

  private drawFire(dt = 16): void {
    const g = this.fireGfx;
    g.clear();
    const m = store.mirror;
    if (!m.fireCells.size) return;
    const t = performance.now() / 120;
    for (const c of m.fireCells) {
      const level = m.fire[c];
      const x = ((c % m.w) + 0.5) * TILE;
      const y = (((c / m.w) | 0) + 0.5) * TILE;
      // Smoke and the odd ember, more for bigger fires.
      if (Math.random() < (dt / 1000) * (1.5 + level * 1.5)) {
        this.particles.burst(x, y - 6, { count: 1, color: [0x3a3634, 0x5a5450], speed: 10, size: 4, grow: 10, life: 1800, lift: 28, alpha: 0.45, drag: 0.5 });
      }
      if (Math.random() < (dt / 1000) * level) {
        this.particles.burst(x, y, { count: 1, color: [0xffb040, 0xff7020], speed: 30, size: 1.2, life: 700, lift: 50, drag: 1 });
      }
      if (Math.random() < (dt / 1000) * (2 + level * 2)) sound.play('fire', x, y);
      const flick = 0.85 + 0.15 * Math.sin(t + c * 1.7);
      const r = TILE * (0.22 + 0.1 * level) * flick;
      g.circle(x, y, r * 1.4).fill({ color: 0xff5010, alpha: 0.25 });
      g.circle(x, y + 2, r).fill({ color: 0xff7a20, alpha: 0.85 });
      g.circle(x + Math.sin(t * 1.3 + c) * 2, y - 2, r * 0.55).fill({ color: 0xffd060, alpha: 0.9 });
    }
  }

  /** Redraw the frost overlay when the line has moved a little, plus a faint ring along its edge. */
  private drawFrost(tick: number): void {
    const m = store.mirror;
    const r = frostRadius(tick, m.frost);
    if (Math.abs(r - this.frostDrawn) > 0.001) {
      this.frostDrawn = r;
      const c = this.frostCanvas;
      if (c.width !== m.w || c.height !== m.h) {
        c.width = m.w;
        c.height = m.h;
      }
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(m.w, m.h);
      const d = img.data;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const f = frostLevel(x, y, m.w, m.h, r);
          if (!f) continue;
          const o = (y * m.w + x) * 4;
          // A little per-cell sparkle so it reads as snow, not paint.
          const k = 0.92 + hash2(x, y, 17) * 0.08;
          d[o] = 232 * k;
          d[o + 1] = 242 * k;
          d[o + 2] = 255;
          d[o + 3] = 175 * f;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (!this.frostTex) {
        this.frostTex = Texture.from(c);
        const s = new Sprite(this.frostTex);
        s.scale.set(TILE);
        this.layers.frost.addChildAt(s, 0);
      } else {
        this.frostTex.source.update();
      }
      const ring = this.frostRing;
      ring.clear();
      if (r < 1.42) {
        const half = Math.min(m.w, m.h) / 2;
        ring.circle((m.w / 2) * TILE, (m.h / 2) * TILE, r * half * TILE).stroke({ width: 3, color: 0xcfe8ff, alpha: 0.35 });
        ring.circle((m.w / 2) * TILE, (m.h / 2) * TILE, (r + FROST_BAND) * half * TILE).stroke({ width: 2, color: 0xffffff, alpha: 0.18 });
      }
    }
  }

  private drawWeather(tick: number, dt: number): void {
    let { kind, wind } = precipFor(tick);
    // Looking out over frozen ground: it's always snowing out there.
    const m = store.mirror;
    const c = this.screenToCell(this.app.screen.width / 2, this.app.screen.height / 2);
    const frozenView = m.w ? frostLevel(c.x, c.y, m.w, m.h, frostRadius(tick, m.frost)) : 0;
    if (kind === 'none' && frozenView > 0.5) {
      kind = 'snow';
      wind = 0.6;
    }
    sound.ambience(Math.min(1, 0.12 + wind * 0.75 + frozenView * 0.3), kind === 'rain' ? 0.6 : kind === 'storm' ? 1 : 0);
    this.weather.update(dt, kind, this.app.screen.width, this.app.screen.height, wind);
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

function precipFor(tick: number): { kind: Precip; wind: number } {
  const m = store.mirror;
  const active = new Set(m.conditions.map((c) => c.key));
  if (active.has('blizzard')) return { kind: 'blizzard', wind: 1 };
  if (active.has('thunderstorm')) return { kind: 'storm', wind: 0.8 };
  if (active.has('spring_rains')) return { kind: 'rain', wind: 0.3 };
  if (active.has('ash_fall')) return { kind: 'ash', wind: 0.4 };
  // Light snow on most winter days, whenever it's below freezing.
  const cal = calendar(tick);
  const cold = outdoorTempAt(tick, m.coldOffset, m.conditions) < 0;
  if (cold && (cal.season === 'Winter' || active.has('cold_snap') || active.has('early_frost')) && hash2(cal.day, 7, m.seed) < 0.6) return { kind: 'snow', wind: 0.35 };
  return { kind: 'none', wind: 0 };
}

function isWall(e: Entity | undefined): boolean {
  if (!e || e.kind !== 'building') return false;
  const d = BUILDINGS[e.def];
  return !!d?.wall && !d.door;
}

function rgba(color: number, a: number): string {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${a})`;
}
