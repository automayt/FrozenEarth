import { Application, BitmapText, Container, Graphics, GraphicsContext, Sprite, TextStyle } from 'pixi.js';
import { ANIMALS, BUILDINGS, maxHp, PLANTS, ROCKS, TERRAINS, WEAPON_KEYS, weaponOf, type TerrainDef } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import { DESIG, FROST_BAND, MIN_COLONY_GAP, SHOT_FIELDS, TICKS_PER_DAY, TICKS_PER_HOUR, bleedRate, calendar, dispositionOf, GUARD_REACH, hostile, NOISE, SETTLEMENT_WATCH, stealthMult, frostLevel, frostRadius, hash2, outdoorTempAt, weaponFor, woundTotal, type Construct, type Entity, type Pawn, type World } from '@fe/sim';
import { ease, Particles, Tweens, Weather, type Precip } from './fx';
import { sound } from '../audio';
import { fog } from './fog';
import { store } from '../store';
import { TextureBank } from './textures';
import { ChunkedBitmap, MapBitmap } from './bitmap';
import { FOG_RES, paintFog, paintOverlayCell, PX } from './paint';
import { coverColor, coverFrom, type CoverHit } from './cover';
import { Marks } from './marks';
import { Input } from './input';

/** World units per cell. */
export const TILE = 32;
/** Cells per culling chunk. */
const CHUNK = 16;
/** Bitmap text is generated at 2x and drawn at half scale so it stays sharp when zoomed. */
/** How a settlement feels about you, as a colour. */
export const DISPOSITION_COLOR = { friendly: 0x7ad07a, wary: 0xf0b43c, hostile: 0xf07a5a } as const;

const LABEL_STYLE = { fontFamily: 'IBM Plex Sans', fontSize: 22, fill: 0xffffff, stroke: { color: 0x000000, width: 5 } };
/**
 * One shared TextStyle for every label. A stroked style keys its bitmap font by TextStyle instance,
 * so handing BitmapText a plain style object built a whole new glyph atlas per label (~15 ms each,
 * and never freed); sharing the instance means one atlas for all of them.
 */
const LABEL_TEXT = new TextStyle(LABEL_STYLE);
/** Texture pixels skipped per canvas pixel when sampling terrain art (texture repeats every 128/(PX*STEP) cells). */
const TEX_STEP = 2;
/** Colour and strength of the night shade at its darkest (light pools are carved out of it). */
const NIGHT_COLOR = 0x0c1838;

const NIGHT_ALPHA = 0.5;

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
  /** For a miss: the cover cell that stopped it (-1 if it just flew wide), and how far wide it flew. */
  stop: number;
  wideX: number;
  wideY: number;
}

/** Projectile flight time and how long the tracer lingers after, in ms. */
const SHOT_FLY_MS = 140;
const SHOT_FADE_MS = 260;
const MUZZLE_MS = 70;
/** Nearest threats each colonist's cover is shown against. */
const COVER_THREATS = 3;

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
  /** Wild animals keep their own sprite: no walk-cycle frames. */
  animal?: boolean;
  baseTint?: number;
  lastX?: number;
  lastY?: number;
  /** Walk cycle phase in radians. */
  phase?: number;
  facing?: number;
  flashUntil?: number;
  nextFx?: number;
  nextZ?: number;
  /** Pawn name, or an item stack's count: hidden or resized by zoom level. */
  label?: BitmapText;
}

/** What a working pawn is working on, and what that throws up. */
type WorkFx = 'stone' | 'wood' | 'leaf' | 'build' | 'soil' | 'craft' | 'steam' | 'tend';

export class GameRenderer {
  app = new Application();
  world = new Container();
  /** Ground art and the zone/designation overlay, PX pixels a cell, in chunk textures. */
  private terrainMap: ChunkedBitmap | null = null;
  private overlayMap: ChunkedBitmap | null = null;
  /** What each overlay cell was last painted as (see overlayCell()), to skip unchanged cells. */
  private overlayKeys = new Int32Array(0);
  /** Faction the overlay was drawn for: your zones are drawn stronger, and only your theft plans show. */
  private overlayFor = -1;
  private layers = {
    terrain: new Container(),
    overlay: new Container(),
    floorThings: new Container(),
    items: new Container(),
    buildings: new Container(),
    plants: new Container(),
    /** Shade over building interiors none of your people can see into. */
    fog: new Container(),
    /** Frost over the frozen zone: whitens ground, buildings and trees alike. */
    frost: new Container(),
    /** Night shade with pools of light; pawns and markers sit above it. */
    night: new Container(),
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
  /** Frost over the frozen zone, one pixel a cell. */
  private frostMap: MapBitmap | null = null;
  /** Radius the frost overlay was last drawn at. */
  private frostDrawn = -1;
  private frostRing = new Graphics();
  ui = new Graphics();
  private settlementLabels = new Map<number, BitmapText>();
  private settlementGfx = new Graphics();
  private settlementKey = '';
  private night = new Graphics();
  private views = new Map<number, EntityView>();
  /** Shared geometry for the small shapes on entity views (see shape()). */
  private shapes = new Map<string, GraphicsContext>();
  private pawnIds = new Set<number>();
  /** Static entity views are grouped into CHUNK x CHUNK cell containers so off-screen ones can be hidden. */
  private chunks = new Map<string, Container>();
  tex!: TextureBank;
  input!: Input;
  private mapW = 0;
  private mapH = 0;
  private destroyed = false;
  /** The pawn you're steering, kept current from entity changes so controlled() needn't scan. */
  private possessedId = 0;
  /** Zoom detail level last applied to labels: 0 far (no names or counts), 1 mid (names), 2 near. */
  private lod = -1;
  /** World scale pawn name labels were last sized for. */
  private labelZoom = -1;

  async init(el: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: el, background: 0x0d1014, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    el.appendChild(this.app.canvas);
    this.tex = new TextureBank(this.app.renderer);
    await this.tex.loadArt();
    this.app.stage.addChild(this.world, this.night, this.weather.view);
    for (const l of Object.values(this.layers)) {
      // Each layer is its own render group: redrawing the per-frame Graphics (ui, shots, fire, particles)
      // or moving pawns then only rebuilds that layer's draw list, not one covering thousands of
      // static sprites, and panning only moves the group transforms.
      l.isRenderGroup = true;
      this.world.addChild(l);
    }
    this.layers.pawns.sortableChildren = true;
    this.layers.ui.addChild(this.settlementGfx, this.marks.view, this.ui);
    this.layers.fx.addChild(this.fireGfx, this.particles.view, this.shotGfx);
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
    // Shared shape geometry outlives the Graphics that used it; free it once they're gone.
    for (const c of this.shapes.values()) c.destroy();
    this.shapes.clear();
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
    if (m.changedCells.size) this.drawTerrainCells(m.changedCells);
    if (m.zonesChanged || this.overlayFor !== (store.me?.faction ?? 0)) {
      this.drawOverlay(null);
      m.zonesChanged = false;
    } else if (m.changedCells.size) this.drawOverlay(m.changedCells);
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
    const mine = store.me?.faction;
    for (const id of m.changedEnts) {
      const e = m.entities.get(id);
      if (!e) continue;
      this.updateView(e);
      if (e.kind === 'pawn' && e.possessed && e.faction === mine) this.possessedId = e.id;
    }
    m.changedEnts.clear();

    if (!this.built && m.entities.size) this.built = true;

    const tick = store.estTick();
    if (fog.update(now)) this.drawFog();
    const me = store.me?.faction;
    for (const id of this.pawnIds) {
      const e = m.entities.get(id);
      const v = this.views.get(id);
      if (!e || e.kind !== 'pawn' || !v) continue;
      const pos = pawnPosition(e, tick, m.w);
      v.root.position.set((pos.x + 0.5) * TILE, (pos.y + 0.5) * TILE);
      // Lower on screen draws in front. Only re-sorts the pawn layer, and only when the order can change.
      v.root.zIndex = Math.round(v.root.y);
      // Others indoors, out of your people's sight, aren't shown.
      v.root.visible = e.faction === me || !fog.hidden(Math.round(pos.y) * m.w + Math.round(pos.x));
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
    // Too small to see when zoomed out, and it touches every visible plant.
    if (this.world.scale.x >= 0.35) this.swayPlants(now);
    this.updateLod();
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
      // No "z" over a sleeper you can't see: it would give away who's in a dark room.
      if (e.asleep && !e.downed && v.root.visible && now >= (v.nextZ ?? 0)) {
        this.particles.zed(x + 6, y - TILE * 0.4);
        v.nextZ = now + 1300 + Math.random() * 500;
      }
    } else if (moved > 0.02) {
      // About one step per cell (half a cycle): faster and the walk frames flicker past.
      v.phase = ((v.phase ?? 0) + (moved / TILE) * Math.PI * 1.2) % (Math.PI * 2);
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
    if (!v.body || v.animal) return;
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
  private swayParity = 0;

  private swayPlants(now: number): void {
    const windy = store.mirror.conditions.some((c) => c.key === 'thunderstorm' || c.key === 'blizzard' || c.key === 'cold_wind') ? 2.6 : 1;
    const t = now / 1000;
    // The sway is slow, so each plant moves every other frame: half the transform updates, same look.
    const parity = this.swayParity ^= 1;
    for (const layer of [this.layers.plants, this.layers.floorThings]) {
      const tree = layer === this.layers.plants;
      for (const chunk of layer.children) {
        if (!chunk.visible) continue;
        const kids = chunk.children;
        for (let i = parity; i < kids.length; i += 2) {
          const root = kids[i];
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
    this.terrainMap?.destroy();
    this.overlayMap?.destroy();
    this.terrainMap = new ChunkedBitmap({ w: m.w, h: m.h, px: PX, tile: TILE, linear: this.tex.pixels.size > 0 });
    this.overlayMap = new ChunkedBitmap({ w: m.w, h: m.h, px: PX, tile: TILE });
    this.layers.terrain.addChild(this.terrainMap.root);
    this.layers.overlay.addChild(this.overlayMap.root);
    this.overlayKeys = new Int32Array(m.w * m.h).fill(-1);
    m.allCellsChanged = true;
  }

  private drawAllTerrain(): void {
    const t = this.terrainMap!;
    const n = store.mirror.w * store.mirror.h;
    for (let c = 0; c < n; c++) {
      const s = t.cell(c);
      this.paintCell(s.data, s.stride, c, s.ox, s.oy);
    }
    t.flush();
  }

  /** Repaint changed cells, and the neighbours whose rock bevel depends on them; upload only their rows. */
  private drawTerrainCells(cells: Set<number>): void {
    const m = store.mirror;
    const t = this.terrainMap!;
    const n = m.w * m.h;
    const todo = new Set<number>();
    for (const c of cells) for (const k of [c, c + 1, c + m.w, c - m.w]) if (k >= 0 && k < n) todo.add(k);
    for (const c of todo) {
      const s = t.cell(c);
      this.paintCell(s.data, s.stride, c, s.ox, s.oy);
    }
    t.flush();
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
          // Ice: a smoother sheen with pale cracks running across it.
          if (terrain.key === 'ice') {
            // Large soft patches of clearer and cloudier ice...
            f = 0.93 + hash2(gx >> 4, gy >> 4, 7) * 0.08 + hash2(gx >> 2, gy >> 2, 8) * 0.03;
            // ...glinting diagonal streaks...
            const streak = (gx + (gy >> 1) + ((hash2(gx >> 5, gy >> 5, 4) * 24) | 0)) % 44;
            if (streak < 2) f *= 1.14;
            else if (streak < 4) f *= 1.06;
            // ...and dark hairline cracks wandering cell to cell.
            const cx = gx >> 3;
            const cy = gy >> 3;
            const lx = gx & 7;
            const ly = gy & 7;
            if (hash2(cx, cy, 21) > 0.72 && (hash2(cx, cy, 22) > 0.5 ? lx === ly : lx === 7 - ly)) f *= 0.78;
            // Cold blue cast so it reads as ice, not pale stone.
            b = Math.min(255, b * 1.06);
            r *= 0.94;
          }
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

  /**
   * Zones and designations, per cell. With `cells`, only those; otherwise every cell is checked.
   * Cells whose look hasn't changed are skipped, and only touched rows are uploaded.
   */
  private drawOverlay(cells: Iterable<number> | null): void {
    const m = store.mirror;
    const o = this.overlayMap!;
    this.overlayFor = store.me?.faction ?? 0;
    if (cells) for (const c of cells) this.overlayCell(o, c);
    else for (let c = 0, n = m.w * m.h; c < n; c++) this.overlayCell(o, c);
    o.flush();
  }

  private overlayCell(o: ChunkedBitmap, c: number): void {
    const m = store.mirror;
    const me = this.overlayFor;
    const z = m.zoneAt[c] ? m.zones.get(m.zoneAt[c]) : undefined;
    const mine = z?.faction === me;
    const zoneColor = z ? (z.kind === 'grow' ? 0x7ac04a : (m.factions.get(z.faction)?.color ?? 0xffffff)) : 0;
    let d = m.desig[c];
    // Someone else's plan to rob you stays their secret.
    if (d === DESIG.steal && m.desigFaction[c] !== me) d = 0;
    const key = (z ? ((zoneColor << 1) | (mine ? 1 : 0)) + 1 : 0) * 8 + Math.min(7, d);
    if (this.overlayKeys[c] === key) return;
    this.overlayKeys[c] = key;
    const s = o.cell(c);
    paintOverlayCell(s.data, s.stride, s.ox, s.oy, z ? zoneColor : -1, mine ? 0.22 : 0.12, d);
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
    this.tweens.add(dur, (k) => root.scale.set(0.35 + 0.65 * ease.outBack(k)), undefined, root);
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
    if (old && e.kind === 'item' && old.kind === 'item' && old.def === e.def && old.root.x === (e.x + 0.5) * TILE && old.root.y === (e.y + 0.5) * TILE) {
      // A stack growing or shrinking as haulers come and go: update it in place rather than rebuild.
      (old.root.children[0] as Sprite).tint = e.rot >= 0.5 ? 0xa0b070 : 0xffffff;
      this.setCountLabel(old, e.count);
      old.key = key;
      return;
    }
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
        this.setCountLabel(v, e.count);
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
          const left = Math.round(health * 32) / 32;
          root.addChild(
            this.shape(`dmg:${left}`, (g) =>
              g
                .rect(-TILE / 2 + 2, -TILE / 2 + 2, TILE - 4, 3)
                .fill(0x301010)
                .rect(-TILE / 2 + 2, -TILE / 2 + 2, (TILE - 4) * left, 3)
                .fill(left < 0.35 ? 0xe05040 : 0xe0b040),
            ),
          );
        }
        if (d.door) {
          const color = store.mirror.factions.get(e.faction)?.color ?? 0xffffff;
          root.addChild(this.shape(`door:${color}`, (g) => g.rect(-TILE / 2, TILE / 2 - 4, TILE, 3).fill(color)));
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
      if (e.kind === 'pawn') this.tweens.add(400, (k) => (root.alpha = k), undefined, root);
      else this.popIn(root);
      if (e.kind === 'building') sound.play('pop', root.x, root.y);
    }
  }

  /**
   * A Graphics drawing a shared, cached shape. Views are rebuilt whenever their entity changes, and
   * building fresh geometry for every ring, bar and chevron each time cost ~0.5 ms per pawn at
   * render; shared contexts are tessellated once. (Destroying the Graphics leaves the context.)
   */
  private shape(key: string, draw: (g: GraphicsContext) => void): Graphics {
    let ctx = this.shapes.get(key);
    if (!ctx) {
      ctx = new GraphicsContext();
      draw(ctx);
      this.shapes.set(key, ctx);
    }
    return new Graphics(ctx);
  }

  /**
   * A pawn's health strip: dark outlined track, fill coloured by how bad it is (green, amber, red),
   * bright red while bleeding.
   */
  private healthBar(width: number, y: number, hurt: number, bleeding: boolean): Graphics {
    const left = Math.round(Math.max(0, 1 - hurt) * 24) / 24;
    const fill = bleeding ? 0xff4848 : left > 0.6 ? 0x5ccf5c : left > 0.3 ? 0xe8b83c : 0xe85a3c;
    return this.shape(`hp:${width}:${y}:${left}:${fill}`, (g) =>
      g
        .rect(-width / 2 - 1, y - 1, width + 2, 6)
        .fill({ color: 0x000000, alpha: 0.75 })
        .rect(-width / 2, y, width * left, 4)
        .fill(fill),
    );
  }

  /** The stack size in an item's corner, shown for stacks of two or more. */
  private setCountLabel(v: EntityView, count: number): void {
    if (count <= 1) {
      v.label?.destroy();
      v.label = undefined;
      return;
    }
    if (v.label) {
      v.label.text = String(count);
      return;
    }
    const t = new BitmapText({ text: String(count), style: LABEL_TEXT });
    t.scale.set(this.countLabelScale());
    t.anchor.set(1, 1);
    t.position.set(TILE / 2 - 1, TILE / 2);
    t.visible = this.lod !== 0 && this.lod !== 1;
    v.label = t;
    v.root.addChild(t);
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
    const frame = this.shape(`cframe:${ready}`, (g) =>
      g
        .rect(-TILE / 2 + 1, -TILE / 2 + 1, TILE - 2, TILE - 2)
        .fill({ color: ready ? 0x8a7050 : 0x3a7ac0, alpha: ready ? 0.25 : 0.2 })
        .stroke({ width: 1.5, color: ready ? 0xc8a878 : 0x8ac8ff, alpha: 0.9 }),
    );
    root.addChild(frame, ghost);
    const p = Math.min(1, Math.round((ready ? e.progress / d.work : total ? got / total : 0) * 20) / 20);
    if (p > 0) root.addChild(this.shape(`cprog:${ready}:${p}`, (g) => g.rect(-TILE / 2 + 3, TILE / 2 - 6, (TILE - 6) * p, 3).fill(ready ? 0xf0c060 : 0x8ac8ff)));
  }

  /** A wild animal: its sprite on a shadow, a crosshair when your hunters are after it. */
  private drawAnimal(root: Container, e: Pawn, v: EntityView): void {
    const def = ANIMALS[e.species!];
    const size = TILE * 1.15 * (def?.size ?? 1);
    root.addChild(this.shape(`shadow:${size}`, (g) => g.ellipse(0, TILE * 0.3, size * 0.38, size * 0.12).fill({ color: 0x000000, alpha: 0.3 })));
    const body = new Sprite(this.tex.animal(e.species!));
    // The ComfyUI sprites stand on the bottom of their frame; the fallback shapes a little higher.
    body.anchor.set(0.5, this.tex.hasArt(`animal_${e.species}`) ? 0.95 : 0.85);
    body.width = body.height = size;
    body.position.y = TILE * 0.32;
    if (e.downed) {
      body.rotation = Math.PI / 2;
      body.tint = 0xd07070;
    }
    const rig = new Container();
    rig.addChild(body);
    root.addChild(rig);
    v.rig = rig;
    v.body = body;
    v.baseTint = body.tint;
    v.animal = true;
    const hurt = woundTotal(e);
    if (hurt > 0.02 || e.downed) {
      root.addChild(this.healthBar(TILE * 0.6, -size * 0.75, hurt, bleedRate(e) > 0));
    }
    if (e.hunted && e.hunted === store.me?.faction) {
      const y = -size * 0.75 - 8;
      root.addChild(
        this.shape(`hunt:${y}`, (g) =>
          g
            .circle(0, y, 5)
            .moveTo(-8, y)
            .lineTo(8, y)
            .moveTo(0, y - 8)
            .lineTo(0, y + 8)
            .stroke({ width: 1.5, color: 0xff5040 }),
        ),
      );
    }
  }

  private drawPawn(root: Container, e: Pawn, v: EntityView): void {
    if (e.species) return this.drawAnimal(root, e, v);
    const f = store.mirror.factions.get(e.faction);
    const color = f?.color ?? 0xffffff;
    const ring = this.shape(`ring:${color}`, (g) =>
      g
        .ellipse(0, TILE * 0.3, TILE * 0.38, TILE * 0.16)
        .fill({ color: 0x000000, alpha: 0.35 })
        .ellipse(0, TILE * 0.28, TILE * 0.34, TILE * 0.13)
        .stroke({ width: 2.5, color }),
    );
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
      const bow = e.weapon === 'bow';
      const melee = !!wd.melee;
      rig.addChild(
        this.shape(bow ? 'wpn:bow' : `wpn:${melee}`, (g) => {
          if (bow) g.arc(TILE * 0.3, 0, TILE * 0.18, -Math.PI / 2.2, Math.PI / 2.2).stroke({ width: 2, color: 0xc8a070 });
          else
            g.moveTo(TILE * 0.22, TILE * 0.12)
              .lineTo(TILE * (melee ? 0.42 : 0.55), -TILE * (melee ? 0.12 : 0.18))
              .stroke({ width: melee ? 2.5 : 2, color: melee ? 0xd8d8d8 : 0x6a5a48 });
        }),
      );
    }
    if (e.drafted) {
      // Drafted: a chevron over the head in the faction colour.
      root.addChild(
        this.shape(`chevron:${color}`, (g) =>
          g
            .poly([-6, -TILE * 0.86, 0, -TILE * 0.74, 6, -TILE * 0.86, 6, -TILE * 0.98, 0, -TILE * 0.86, -6, -TILE * 0.98])
            .fill(color)
            .stroke({ width: 1.2, color: 0x000000, alpha: 0.8 }),
        ),
      );
    }
    const hurt = woundTotal(e);
    if (hurt > 0.02 || e.downed) {
      root.addChild(this.healthBar(TILE * 0.7, -TILE * 0.68, hurt, bleedRate(e) > 0));
    }
    if (e.carrying) {
      const c = new Sprite(this.tex.item(e.carrying.def));
      c.anchor.set(0.5);
      c.width = c.height = TILE * 0.45;
      c.position.set(TILE * 0.3, -TILE * 0.05);
      rig.addChild(c);
    }
    const label = new BitmapText({ text: e.name.split(' ')[0] + (e.prisoner ? ' (prisoner)' : '') + (e.downed ? ' (down)' : e.asleep ? ' z' : ''), style: LABEL_TEXT });
    label.scale.set(this.pawnLabelScale());
    label.anchor.set(0.5, 0);
    label.position.set(0, TILE * 0.42);
    label.visible = this.lod !== 0;
    v.label = label;
    root.addChild(label);
  }

  /**
   * World scale for a label drawn at `base` that keeps it between min and max pixels tall on screen,
   * so names and counts neither shrink to specks nor balloon when zoomed in.
   */
  private labelScale(base: number, min: number, max: number): number {
    const s = this.world.scale.x;
    return Math.max(min, Math.min(max, LABEL_STYLE.fontSize * base * s)) / (LABEL_STYLE.fontSize * s);
  }

  private pawnLabelScale(): number {
    return this.labelScale(0.45, 8.5, 13);
  }

  private countLabelScale(): number {
    return this.labelScale(0.5, 8, 11);
  }

  /**
   * Labels by zoom: stack counts only up close, names down to a middling zoom, neither when zoomed
   * far out (they'd be an unreadable smear, and thousands of glyphs to draw).
   */
  private updateLod(): void {
    const s = this.world.scale.x;
    const lod = s < 0.42 ? 0 : s < 0.7 ? 1 : 2;
    const resize = Math.abs(s - this.labelZoom) > 0.02;
    if (lod === this.lod && !resize) return;
    const relod = lod !== this.lod;
    this.lod = lod;
    if (resize) this.labelZoom = s;
    const names = this.pawnLabelScale();
    const counts = this.countLabelScale();
    for (const v of this.views.values()) {
      if (!v.label) continue;
      const pawn = v.kind === 'pawn';
      if (relod) v.label.visible = lod >= (pawn ? 1 : 2);
      if (resize) v.label.scale.set(pawn ? names : counts);
    }
  }

  // ---------------------------------------------------------------- UI overlay

  private drawUi(): void {
    const g = this.ui;
    g.clear();
    this.drawCover(performance.now());
    const m = store.mirror;
    this.drawSettlements();
    const steering = this.controlled();
    if (steering) this.drawWatchers(g, steering);
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

  /** NPC settlements: a name over each, and a ring around their land coloured by how they feel about you. */
  private drawSettlements(): void {
    const m = store.mirror;
    const me = store.me?.faction ?? 0;
    const sw = 1.5 / this.world.scale.x;
    // The rings are big circles: re-tessellating them every frame cost ~0.5 ms, so they live in their
    // own Graphics, redrawn only when the zoom or a town's state or mood changes.
    let key = sw.toFixed(4);
    for (const f of m.factions.values()) if (f.settlement) key += `|${f.id}:${f.settlement.state}:${f.settlement.radius}:${dispositionOf(f.settlement, me)}`;
    const redraw = key !== this.settlementKey;
    const g = this.settlementGfx;
    if (redraw) {
      this.settlementKey = key;
      g.clear();
    }
    // Names stay a steady 15 to 20px on screen whatever the zoom.
    const z = this.world.scale.x;
    const scale = Math.max(15, Math.min(20, LABEL_STYLE.fontSize * 0.8 * z)) / (LABEL_STYLE.fontSize * z);
    const seen = new Set<number>();
    for (const f of m.factions.values()) {
      const s = f.settlement;
      if (!s) continue;
      seen.add(f.id);
      let label = this.settlementLabels.get(f.id);
      if (!label) {
        label = new BitmapText({ text: '', style: LABEL_TEXT });
        label.anchor.set(0.5, 1);
        this.layers.ui.addChild(label);
        this.settlementLabels.set(f.id, label);
      }
      // While settling you have no faction yet: show how the town takes to newcomers.
      const d = dispositionOf(s, me);
      const color = s.state === 'fallen' ? 0x8796a6 : DISPOSITION_COLOR[d];
      const text = s.state === 'fallen' ? `${f.name} (ruins)` : s.state === 'leaving' ? `${f.name} (abandoned)` : f.name;
      if (label.text !== text) label.text = text;
      label.tint = color;
      label.scale.set(scale);
      label.position.set((f.home.x + 0.5) * TILE, (f.home.y - 4.3) * TILE);
      if (redraw && s.state === 'home') {
        // A dark under-stroke keeps the coloured ring visible over pale sand, snow and ice.
        const cx = (f.home.x + 0.5) * TILE;
        const cy = (f.home.y + 0.5) * TILE;
        g.circle(cx, cy, s.radius * TILE).stroke({ width: sw * 2.6, color: 0x000000, alpha: 0.22 });
        g.circle(cx, cy, s.radius * TILE).stroke({ width: sw, color, alpha: 0.7 });
        if (d === 'hostile') {
          // The ring is their land; their guards come out further, and their walls shoot further still.
          g.circle(cx, cy, (s.radius + GUARD_REACH) * TILE).stroke({ width: sw, color, alpha: 0.35 });
          g.circle(cx, cy, (s.radius + SETTLEMENT_WATCH) * TILE).stroke({ width: sw * 0.8, color, alpha: 0.18 });
        }
      }
    }
    for (const [id, label] of this.settlementLabels) {
      if (seen.has(id)) continue;
      label.destroy();
      this.settlementLabels.delete(id);
    }
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

  /**
   * Where a ranged shot ends: on the target if it hit; on the near face of the cover that stopped
   * it; or wide of the target and on past it. Follows the drawn pawns while they're around.
   */
  private shotEnd(s: ShotFx): { x: number; y: number } {
    const a = this.views.get(s.shooter)?.root;
    const b = this.views.get(s.target)?.root;
    const ax = a ? a.x : (s.sx + 0.5) * TILE;
    const ay = a ? a.y - TILE * 0.15 : (s.sy + 0.5) * TILE;
    const bx = b ? b.x : (s.tx + 0.5) * TILE;
    const by = b ? b.y - TILE * 0.15 : (s.ty + 0.5) * TILE;
    if (s.hit) return { x: bx, y: by };
    if (s.stop >= 0) {
      const w = store.mirror.w;
      const cx = ((s.stop % w) + 0.5) * TILE;
      const cy = (((s.stop / w) | 0) + 0.5) * TILE;
      const len = Math.hypot(ax - cx, ay - cy) || 1;
      return { x: cx + ((ax - cx) / len) * TILE * 0.3, y: cy + ((ay - cy) / len) * TILE * 0.3 - TILE * 0.1 };
    }
    return { x: bx + s.wideX + (bx - ax) * 0.25, y: by + s.wideY + (by - ay) * 0.25 };
  }

  private coverHit: CoverHit = { cover: 0, cell: -1 };
  private coverThreats: Pawn[] = [];
  /** Cover worked out a few times a second: who (a pawn, or -1 for the cell under the cursor) against whom. */
  private coverMarks: { from: number; threat: number; cover: number; cell: number }[] = [];
  private coverAt = 0;
  private coverHover: number | null = -1;
  private coverSquad: number[] | null = null;
  private marks = new Marks(TILE * 0.6, TILE);

  /**
   * Who is in cover, and from what. For your drafted or steered colonists with armed enemies in
   * sight: an arc on the colonist toward each of the nearest few that can shoot them, green or
   * yellow or amber by how much cover they have from that side (red when exposed), and an outline
   * on the cell giving the cover. With drafted colonists selected, the cell under the cursor gets
   * the same preview, for picking a spot to move them to. The cover itself is worked out a few
   * times a second; each frame only places pooled sprites at the drawn positions.
   */
  private drawCover(now: number): void {
    const hc = store.hoverCell;
    if (now - this.coverAt > 200 || hc !== this.coverHover || store.squad !== this.coverSquad) {
      this.coverAt = now;
      this.coverHover = hc;
      this.coverSquad = store.squad;
      this.findCover();
    }
    const mk = this.marks;
    mk.begin();
    const m = store.mirror;
    for (const k of this.coverMarks) {
      const fv = k.from >= 0 ? this.views.get(k.from)?.root : undefined;
      if (k.from >= 0 && !fv) continue;
      const px = fv ? fv.x : ((hc! % m.w) + 0.5) * TILE;
      const py = fv ? fv.y : (((hc! / m.w) | 0) + 0.5) * TILE;
      const t = m.get<Pawn>(k.threat);
      const tv = this.views.get(k.threat)?.root;
      if (!t) continue;
      const color = coverColor(k.cover);
      const alpha = k.from >= 0 ? 1 : 0.75;
      mk.arc(px, py, Math.atan2((tv ? tv.y : (t.y + 0.5) * TILE) - py, (tv ? tv.x : (t.x + 0.5) * TILE) - px), color, alpha);
      if (k.cell >= 0) mk.box((k.cell % m.w) * TILE, ((k.cell / m.w) | 0) * TILE, color, alpha);
    }
    if (hc !== null && this.coverMarks.some((k) => k.from < 0)) mk.box((hc % m.w) * TILE, ((hc / m.w) | 0) * TILE, 0xffffff, 0.5);
    mk.end();
  }

  private findCover(): void {
    this.coverMarks.length = 0;
    const m = store.mirror;
    const me = store.me?.faction;
    if (!me) return;
    const steering = this.controlled();
    let any = !!steering;
    for (const id of this.pawnIds) {
      if (any) break;
      const e = m.entities.get(id);
      any = !!e && e.kind === 'pawn' && e.faction === me && !!e.drafted && !e.downed;
    }
    if (!any) return;
    const threats = this.coverThreats;
    threats.length = 0;
    const factions = { factions: m.factions } as unknown as World;
    for (const id of this.pawnIds) {
      const e = m.entities.get(id);
      if (!e || e.kind !== 'pawn' || e.faction === me || e.downed || e.prisoner || e.asleep) continue;
      if (!hostile(factions, me, e.faction) || weaponFor(e).melee || !fog.shows(e)) continue;
      threats.push(e);
    }
    if (!threats.length) return;
    for (const id of this.pawnIds) {
      const e = m.entities.get(id);
      if (!e || e.kind !== 'pawn' || e.faction !== me || e.downed || e.species || !(e.drafted || e === steering)) continue;
      this.coverFor(e.id, e.x, e.y);
    }
    // Preview under the cursor while drafted colonists are selected.
    const hc = store.hoverCell;
    if (hc === null || store.tool.kind !== 'select' || m.rock[hc] || m.entities.get(m.buildingAt[hc])?.kind === 'building') return;
    const squad = store.squad.some((id) => {
      const p = m.get<Pawn>(id);
      return !!p && p.faction === me && !!p.drafted;
    });
    if (squad) this.coverFor(-1, hc % m.w, (hc / m.w) | 0);
  }

  /** Cover at one spot against the nearest threats that have it in range and in sight. */
  private coverFor(from: number, x: number, y: number): void {
    const m = store.mirror;
    const near: Pawn[] = [];
    const nd: number[] = [];
    for (const t of this.coverThreats) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d > weaponFor(t).range + 1 || d < 1.5) continue;
      if (near.length === COVER_THREATS && d >= nd[COVER_THREATS - 1]) continue;
      if (!fog.lineClear(t.x, t.y, x, y)) continue;
      let i = near.length === COVER_THREATS ? COVER_THREATS - 1 : near.length;
      while (i > 0 && nd[i - 1] > d) {
        near[i] = near[i - 1];
        nd[i] = nd[i - 1];
        i--;
      }
      near[i] = t;
      nd[i] = d;
    }
    for (const t of near) {
      const hit = coverFrom(m, t.y * m.w + t.x, y * m.w + x, this.coverHit);
      this.coverMarks.push({ from, threat: t.id, cover: hit.cover, cell: hit.cell });
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
      const shot: ShotFx = { shooter: q[k], target: q[k + 1], sx: q[k + 2], sy: q[k + 3], tx: q[k + 4], ty: q[k + 5], hit: q[k + 6] === 1, weapon: WEAPON_KEYS[q[k + 7]] ?? '', born: now, stop: -1, wideX: 0, wideY: 0 };
      const ranged = !weaponOf(shot.weapon).melee;
      if (!shot.hit && ranged) {
        // A miss at someone in cover reads as the cover taking the shot; otherwise it flies wide and past.
        const hitCover = coverFrom(m, shot.sy * m.w + shot.sx, shot.ty * m.w + shot.tx, this.coverHit);
        if (hitCover.cover > 0 && hash2(shot.shooter, Math.floor(now), 13) < 0.8) shot.stop = hitCover.cell;
        shot.wideX = (hash2(shot.shooter, Math.floor(now), 5) - 0.5) * TILE * 1.6;
        shot.wideY = (hash2(shot.target, Math.floor(now), 9) - 0.5) * TILE * 1.6;
      }
      this.shots.push(shot);
      if (!stale) {
        const sv = this.views.get(shot.shooter)?.root;
        const wdef = weaponOf(shot.weapon);
        sound.play(wdef.melee ? 'melee' : shot.weapon === 'bow' ? 'bow' : 'rifle', sv?.x ?? (shot.sx + 0.5) * TILE, sv?.y ?? (shot.sy + 0.5) * TILE);
      }
      if (!shot.hit && ranged && !stale) {
        this.tweens.add(SHOT_FLY_MS, () => {}, () => {
          const end = this.shotEnd(shot);
          if (shot.stop >= 0) {
            // Chips off the cover and a spark.
            this.particles.burst(end.x, end.y, { count: 5, color: [0xd8d0c0, 0x8a8580, 0xa89880], speed: 70, size: 1.4, life: 380, gravity: 140, chips: true });
            this.particles.burst(end.x, end.y, { count: 3, color: [0xffe8a0, 0xffc060], speed: 90, size: 0.9, life: 160, drag: 4 });
          } else {
            // A puff of dust where it lands.
            this.particles.burst(end.x, end.y, { count: 3, color: 0xb8b0a0, speed: 18, size: 2.4, grow: 5, life: 420, lift: 8, alpha: 0.45 });
          }
        });
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
    // Drop finished shots in place (oldest first), keeping at most 300.
    let drop = Math.max(0, this.shots.length - 300);
    while (drop < this.shots.length && now - this.shots[drop].born >= SHOT_FLY_MS + SHOT_FADE_MS) drop++;
    if (drop) this.shots.splice(0, drop);
    const g = this.shotGfx;
    g.clear();
    for (const s of this.shots) {
      const wd = weaponOf(s.weapon);
      // Follow the drawn (interpolated) pawns while they're still around.
      const a = this.views.get(s.shooter)?.root;
      const b = this.views.get(s.target)?.root;
      const ax = a ? a.x : (s.sx + 0.5) * TILE;
      const ay = a ? a.y - TILE * 0.15 : (s.sy + 0.5) * TILE;
      const end = wd.melee ? { x: b ? b.x : (s.tx + 0.5) * TILE, y: b ? b.y - TILE * 0.15 : (s.ty + 0.5) * TILE } : this.shotEnd(s);
      const bx = end.x;
      const by = end.y;
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
      if (age < MUZZLE_MS && s.weapon !== 'bow') {
        // Muzzle flash just in front of the shooter.
        const k = 1 - age / MUZZLE_MS;
        const len = Math.hypot(bx - ax, by - ay) || 1;
        g.circle(ax + ((bx - ax) / len) * 9, ay + ((by - ay) / len) * 9, 1.5 + 3 * k).fill({ color: 0xfff0c0, alpha: 0.9 * k });
      }
      g.moveTo(ax, ay).lineTo(hx, hy).stroke({ width: s.weapon === 'rifle' ? 1.5 : 1, color: wd.color, alpha: 0.55 * fade });
      if (t < 1) g.circle(hx, hy, s.weapon === 'rifle' ? 2.2 : 1.8).fill({ color: wd.color, alpha: 1 });
      else if (s.hit) g.circle(bx, by, 5 * fade + 1).fill({ color: 0xff3020, alpha: 0.7 * fade });
      else if (s.stop >= 0) g.circle(bx, by, 3 * fade + 1).fill({ color: 0xffe0a0, alpha: 0.6 * fade });
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

  /** Shade over building interiors none of your people can see, FOG_RES texels a cell. */
  private fogMap: MapBitmap | null = null;
  /** Per cell as last drawn: 0 not indoors, 1 indoors and seen, 2 indoors and hidden. */
  private fogState = new Uint8Array(0);

  /**
   * Darken building interiors none of your people can see into, with soft edges: each texel
   * averages the hidden state of the indoor cells around its corner, and linear filtering blends
   * the rest. Only the area around cells whose state changed is repainted and uploaded.
   */
  private drawFog(): void {
    const m = store.mirror;
    const n = m.w * m.h;
    if (!this.fogMap || this.fogMap.width !== m.w * FOG_RES || this.fogMap.height !== m.h * FOG_RES) {
      this.fogMap?.destroy();
      this.fogMap = new MapBitmap(m.w * FOG_RES, m.h * FOG_RES, TILE / FOG_RES, { linear: true });
      this.layers.fog.addChild(this.fogMap.sprite);
      this.fogState = new Uint8Array(n);
    }
    const st = this.fogState;
    let x0 = m.w;
    let y0 = m.h;
    let x1 = -1;
    let y1 = -1;
    for (let c = 0; c < n; c++) {
      const v = m.roomAt[c] === 0 ? 0 : fog.visible[c] ? 1 : 2;
      if (v === st[c]) continue;
      st[c] = v;
      const x = c % m.w;
      const y = (c / m.w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return;
    // Texels blend with the neighbouring cells, so repaint one cell beyond the change.
    x0 = Math.max(0, x0 - 1);
    y0 = Math.max(0, y0 - 1);
    x1 = Math.min(m.w - 1, x1 + 1);
    y1 = Math.min(m.h - 1, y1 + 1);
    paintFog(this.fogMap.data, st, m.w, m.h, x0, y0, x1, y1);
    this.fogMap.update(y0 * FOG_RES, (y1 + 1) * FOG_RES);
  }

  /** The colonist you're steering, if any. */
  controlled(): Pawn | undefined {
    // Called a couple of times a frame: remember who it was (the change loop in frame() picks up a
    // newly possessed pawn) instead of scanning every entity each time.
    const e = store.mirror.entities.get(this.possessedId);
    if (e && e.kind === 'pawn' && e.possessed && e.faction === store.me?.faction) return e;
    this.possessedId = 0;
    return undefined;
  }

  /** Keep the camera on the colonist you're steering. */
  follow(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    const s = this.world.scale.x;
    this.world.x = this.app.screen.width / 2 - v.root.x * s;
    this.world.y = this.app.screen.height / 2 - v.root.y * s;
  }

  /**
   * While steering: how far each person nearby can see you (red if they can right now) and, for
   * sleepers, how close a clatter would have to be to wake them.
   */
  private drawWatchers(g: Graphics, me: Pawn): void {
    const m = store.mirror;
    const sw = 1.5 / this.world.scale.x;
    const cell = me.y * m.w + me.x;
    const sight = fog.sightAt(cell) * (me.sneaking ? 0.4 + 0.6 * stealthMult(me) : 1);
    const hearing = NOISE.pickup * (me.sneaking ? 0.6 : 1) * (1 - Math.min(0.6, (me.skills.stealth?.level ?? 0) * 0.03));
    for (const o of m.entities.values()) {
      if (o.kind !== 'pawn' || o.faction === me.faction || o.species || o.downed || o.prisoner) continue;
      if (Math.abs(o.x - me.x) > 30 || Math.abs(o.y - me.y) > 30) continue;
      if (fog.hidden(o.y * m.w + o.x)) continue;
      const v = this.views.get(o.id);
      const x = v ? v.root.x : (o.x + 0.5) * TILE;
      const y = v ? v.root.y : (o.y + 0.5) * TILE;
      if (o.asleep) {
        g.circle(x, y, hearing * TILE).stroke({ width: sw, color: 0x8ac8ff, alpha: 0.45 });
        continue;
      }
      const seen = fog.sees(o, me);
      g.circle(x, y, sight * TILE)
        .fill({ color: seen ? 0xff4030 : 0xf0b43c, alpha: seen ? 0.1 : 0.04 })
        .stroke({ width: sw, color: seen ? 0xff4030 : 0xf0b43c, alpha: 0.6 });
    }
  }

  private drawFrost(tick: number): void {
    const m = store.mirror;
    const r = frostRadius(tick, m.frost);
    if (Math.abs(r - this.frostDrawn) > 0.001) {
      this.frostDrawn = r;
      if (!this.frostMap || this.frostMap.width !== m.w || this.frostMap.height !== m.h) {
        this.frostMap?.destroy();
        this.frostMap = new MapBitmap(m.w, m.h, TILE, { linear: true });
        this.layers.frost.addChildAt(this.frostMap.sprite, 0);
      }
      const d = this.frostMap.data;
      d.fill(0);
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const f = frostLevel(x, y, m.w, m.h, r);
          if (!f) continue;
          const o = (y * m.w + x) * 4;
          // A little per-cell sparkle so it reads as snow, not paint.
          const k = 0.92 + hash2(x, y, 17) * 0.08;
          const a = (175 * f) / 255;
          d[o] = 232 * k * a;
          d[o + 1] = 242 * k * a;
          d[o + 2] = 255 * a;
          d[o + 3] = 255 * a;
        }
      }
      this.frostMap.update();
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

  /** Darkness at this tick: 0 at midday, 1 at deep night (smooth through dusk and dawn), or held dark by an eclipse. */
  private darkness(tick: number, active: Set<string>): number {
    const hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    const dark = hour < 5 || hour > 21 ? 1 : hour < 7 ? (7 - hour) / 2 : hour > 19 ? (hour - 19) / 2 : 0;
    const forcedDark = active.has('eclipse') || active.has('long_night') || active.has('ash_fall');
    return Math.max(forcedDark ? 0.8 : 0, dark);
  }

  /**
   * Night: a blue shade over the ground and buildings (pawns, labels and markers stay above it, so
   * people stay readable), with soft pools of light around fires, heaters and your colonists.
   */
  private drawNight(tick: number): void {
    const m = store.mirror;
    const active = new Set<string>();
    for (const c of m.conditions) active.add(c.key);
    const dark = this.darkness(tick, active);
    const shade = this.nightSprite;
    if (dark > 0.01) {
      // The light map follows the fog cadence (a few times a second), not every frame.
      if (this.lightVersion !== fog.version || !shade) this.drawLights();
      this.nightSprite!.visible = true;
      this.nightSprite!.alpha = dark * NIGHT_ALPHA;
    } else if (shade) shade.visible = false;
    // People and markers take a slight moonlit cast without losing contrast.
    const k = 1 - 0.22 * dark;
    const tint = (Math.round(255 * k) << 16) | (Math.round(255 * (k + 0.04 * dark)) << 8) | 255;
    if (this.layers.pawns.tint !== tint) this.layers.pawns.tint = tint;

    // Weather tints, over the whole screen.
    const g = this.night;
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    g.clear();
    const tintAll = (color: number, alpha: number) => alpha > 0.01 && g.rect(0, 0, W, H).fill({ color, alpha });
    if (active.has('fog')) tintAll(0xc8d0d8, 0.28);
    if (active.has('blizzard')) tintAll(0xe8f0ff, 0.25);
    if (active.has('ash_fall')) tintAll(0x3a3634, 0.3);
    if (active.has('spring_rains') || active.has('thunderstorm')) tintAll(0x203048, 0.15);
    if (active.has('blood_moon')) tintAll(0x900a0a, 0.08 + 0.2 * dark);
    if (active.has('aurora')) tintAll(0x20c080, 0.03 + 0.12 * dark);
    if (active.has('heat_wave') || active.has('drought')) tintAll(0xffa040, 0.07);
    if (active.has('false_spring') || active.has('warm_spell')) tintAll(0xfff0a0, 0.06);
    if (active.has('cold_wind') || active.has('cold_snap') || active.has('early_frost')) tintAll(0xa8d8ff, 0.1);
  }

  private nightMap: MapBitmap | null = null;
  private nightSprite: Sprite | null = null;
  private lightLevel = new Float32Array(0);
  private lightVersion = -1;

  /** Bake the night shade at one pixel per cell: opaque in the dark, clear where something gives light. */
  private drawLights(): void {
    const m = store.mirror;
    this.lightVersion = fog.version;
    const n = m.w * m.h;
    if (!this.nightMap || this.nightMap.width !== m.w || this.nightMap.height !== m.h) {
      this.nightMap?.destroy();
      // Linear filtering turns the per-cell map into soft pools.
      this.nightMap = new MapBitmap(m.w, m.h, TILE, { linear: true });
      this.nightSprite = this.nightMap.sprite;
      this.layers.night.addChild(this.nightSprite);
    }
    if (this.lightLevel.length !== n) this.lightLevel = new Float32Array(n);
    const light = this.lightLevel;
    light.fill(0);
    const stamp = (x0: number, y0: number, r: number, strength: number) => {
      const ri = Math.ceil(r);
      for (let y = Math.max(0, y0 - ri); y <= Math.min(m.h - 1, y0 + ri); y++) {
        for (let x = Math.max(0, x0 - ri); x <= Math.min(m.w - 1, x0 + ri); x++) {
          const d2 = ((x - x0) ** 2 + (y - y0) ** 2) / (r * r);
          if (d2 >= 1) continue;
          const l = strength * (1 - d2);
          const i = y * m.w + x;
          if (l > light[i]) light[i] = l;
        }
      }
    };
    const me = store.me?.faction;
    for (const e of m.entities.values()) {
      if (e.kind === 'building') {
        const d = BUILDINGS[e.def];
        if (d?.radiant) stamp(e.x, e.y, d.radiant[1] + 4, 1);
        else if (d?.heat && d.heat > 0) stamp(e.x, e.y, 4.5, 0.85);
      } else if (e.kind === 'pawn' && e.faction === me && !e.species && !e.downed) {
        // Your people carry a little light (and you can always find them).
        const p = this.views.get(e.id)?.root;
        stamp(p ? Math.round(p.x / TILE - 0.5) : e.x, p ? Math.round(p.y / TILE - 0.5) : e.y, 3.5, 0.6);
      }
    }
    for (const f of m.fireCells) stamp(f % m.w, (f / m.w) | 0, 4 + m.fire[f], 1);
    const d = this.nightMap.data;
    const r = (NIGHT_COLOR >> 16) & 255;
    const g = (NIGHT_COLOR >> 8) & 255;
    const b = NIGHT_COLOR & 255;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = 1 - light[i];
      d[o] = r * a;
      d[o + 1] = g * a;
      d[o + 2] = b * a;
      d[o + 3] = 255 * a;
    }
    this.nightMap.update();
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
