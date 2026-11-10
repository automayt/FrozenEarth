import { Application, BitmapText, Container, Graphics, GraphicsContext, Sprite, TextStyle } from 'pixi.js';
import { ANIMALS, BUILDINGS, ITEMS, LANDMARKS, maxHp, PLANTS, ROCKS, TERRAINS, WEAPON_KEYS, weaponOf, type LandmarkKind, type TerrainDef } from '@fe/defs';
import { PawnGlide, pawnPosition } from '@fe/protocol';
import { DESIG, FROST_BAND, MIN_COLONY_GAP, pactOf, SHOT_FIELDS, calendar, dispositionOf, GUARD_REACH, hostile, NOISE, SETTLEMENT_WATCH, stealthMult, frostLevel, frostRadius, hash2, outdoorTempAt, weaponFor, type Construct, type Entity, type Pawn, type World, constructCost, constructWork, type Building } from '@fe/sim';
import { ease, Particles, Tweens, Weather, type Precip } from './fx';
import { sound } from '../audio';
import { fog } from './fog';
import { store } from '../store';
import { settings, WEATHER_DENSITY } from '../settings';
import { TextureBank } from './textures';
import { ChunkedBitmap, MapBitmap } from './bitmap';
import { Ground } from './ground';
import { FOG_RES, paintFog, paintOverlayCell, PX } from './paint';
import { coverColor, coverFrom, type CoverHit } from './cover';
import { Marks } from './marks';
import { RockLayer, rockDust } from './rock';
import { Input } from './input';
import { Lighting } from './light';
import { Shadows } from './shadows';
import { Life } from './life';
import { Juice } from './juice';
import { cameraRequests, DragTracker, edgeResist, edgeSpring, flightPose, followStep, keepOnMap, mayTakeCamera, MOMENT_HOLD_MS, MOMENT_SKIP_MS, PanBody, panRange, panSpeedFor, planFlight, Shake, shakeFalloff, type Flight } from './camera';
import { cameraSettings } from './cameraSettings';
import { MARK_TINT, WorldUi } from './worldui';
import { BREATH_BELOW, breathGap, pileLevel, FELL_MS, fellAngle, fellPose, footingOf, gentleSwing, GENTLE_STRIKE, GENTLE_SWING_MS, grazeDip, heavySwing, HEAVY_STRIKE, HEAVY_SWING_MS, passed, REBOUND_MS, RISE_STEPS, riseStep, SETTLE_MS, siteStage } from './motion';
import { Tracks } from './tracks';

/** World units per cell. */
export const TILE = 32;
/** Cells per culling chunk. */
const CHUNK = 16;
/** Camera scale limits. */
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
/** Zoom easing time constant: about 95% of the way there in three of these. */
const ZOOM_EASE_MS = 70;
/** Bitmap text is generated at 2x and drawn at half scale so it stays sharp when zoomed. */
/** How a settlement feels about you, as a colour. */
export const DISPOSITION_COLOR = { friendly: 0x7ad07a, wary: 0xf0b43c, hostile: 0xf07a5a } as const;

const LABEL_STYLE = { fontFamily: 'Signika', fontSize: 22, fill: 0xffffff, stroke: { color: 0x000000, width: 5 } };
/**
 * One shared TextStyle for every label. A stroked style keys its bitmap font by TextStyle instance,
 * so handing BitmapText a plain style object built a whole new glyph atlas per label (~15 ms each,
 * and never freed); sharing the instance means one atlas for all of them.
 */
const LABEL_TEXT = new TextStyle(LABEL_STYLE);
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
  /** For a miss: the cover cell that stopped it (-1 if it just flew wide), and how far wide it flew. */
  stop: number;
  wideX: number;
  wideY: number;
}

/** Projectile flight time and how long the tracer lingers after, in ms. */
const SHOT_FLY_MS = 140;
const SHOT_FADE_MS = 260;
const MUZZLE_MS = 70;
/** Weapon damage from which a hit shakes the screen. */
const HEAVY_HIT = 0.17;
/** Nearest threats each colonist's cover is shown against. */
const COVER_THREATS = 3;
/** How long a stump stays, and the most kept at once. */
const STUMP_MS = 90000;
const MAX_STUMPS = 60;
/** World length of the trunk shape, stretched to the fall. */
const TRUNK_LEN = 32;
/** Where the goods for a building site pile up, in the order they arrive. */
const PILE_AT: [number, number][] = [[9, 9], [-9, 10], [9, -7]];

interface EntityView {
  root: Container;
  key: string;
  kind: Entity['kind'];
  def: string;
  /** Set for walls, so neighbours can re-join when this one goes away. */
  wallCell?: number;
  /** A building that has taken damage: if it goes, it was knocked down rather than taken apart. */
  battered?: boolean;
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
  /** The cell a pawn is standing and working at this frame. */
  workCell?: number | null;
  /** How far through a swing a working pawn was last frame (0..1), to catch the moment the tool lands. */
  swing?: number;
  /** Which foot comes down next. */
  foot?: boolean;
  nextBreath?: number;
  nextGlance?: number;
  /** A shove on the rig: a lunge, a recoil, a blow taken. */
  kick?: { x: number; y: number; at: number; ms: number };
  /** An item stack's fill level (render/motion.ts pileLevel), to notice it crossing into another. */
  pile?: number;
  /** Lying down, asleep or hurt. The view is rebuilt when this changes, so the fall is played then. */
  lying?: boolean;
  /** A building site: what's up so far, the plank that climbs with it, and how far up it's drawn and heading. */
  rise?: Sprite;
  plank?: Container;
  riseShown?: number;
  riseGoal?: number;
  /** A door's leaf and its resting scale, how far open it is (0..1), and until when something holds it. */
  leaf?: Sprite;
  leafScale?: number;
  open?: number;
  openUntil?: number;
}

/** What a working pawn is working on, and what that throws up. */
type WorkFx = 'stone' | 'wood' | 'leaf' | 'build' | 'soil' | 'craft' | 'steam' | 'tend';

export class GameRenderer {
  app = new Application();
  world = new Container();
  /** Ground art and the zone/designation overlay, PX pixels a cell, in chunk textures. */
  private terrainMap: ChunkedBitmap | null = null;
  /** Shader-drawn ground under terrainMap (which then only holds rock), or null on renderers it can't run on. */
  private ground: Ground | null = null;
  private overlayMap: ChunkedBitmap | null = null;
  /** What each overlay cell was last painted as (see overlayCell()), to skip unchanged cells. */
  private overlayKeys = new Int32Array(0);
  /** Faction the overlay was drawn for: your zones are drawn stronger, and only your theft plans show. */
  private overlayFor = -1;
  /** Mountains: their own static layer over the ground (see rock.ts). */
  private rockLayer: RockLayer | null = null;
  private layers = {
    terrain: new Container(),
    rock: new Container(),
    overlay: new Container(),
    /** Sun shadows (render/shadows.ts): above the ground, below everything that casts one. */
    shadows: new Container(),
    floorThings: new Container(),
    items: new Container(),
    buildings: new Container(),
    plants: new Container(),
    /** Shade over building interiors none of your people can see into. */
    fog: new Container(),
    /** Frost over the frozen zone: whitens ground, buildings and trees alike. */
    frost: new Container(),
    /** Footprints and ripples: over the frost they're pressed into, under the night. */
    tracks: new Container(),
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
  private tracks = new Tracks();
  /** Barks over colonists and gains floating up from felled trees and mined rock. */
  private juice = new Juice();
  private tweens = new Tweens();
  private weather = new Weather();
  /** True once the first snapshot has been drawn; only later arrivals and departures animate. */
  private built = false;
  /** Rock layer as last drawn, to spot freshly mined cells. */
  private prevRock = new Uint8Array(0);
  /** A camera move under way (render/camera.ts). */
  private flight: Flight | null = null;
  /** Pan velocity, kept between frames for the wind-up and the coast. */
  private pan = new PanBody();
  private dragPanned = new DragTracker();
  /** The pawn the camera is following (F), or 0. */
  private followId = 0;
  /** A big-moment look: out to the spot, hold, and back to where the player was. */
  private moment: { phase: 'out' | 'hold' | 'back'; x: number; y: number; scale: number; until: number } | null = null;
  private lastMoment = -Infinity;
  /** When the player last pressed something; big moments wait for a quiet spell. */
  lastInput = 0;
  private quake = new Shake();
  /** The shake offset added to the world this frame, taken off again at the start of the next. */
  private shaken = { x: 0, y: 0 };
  /** The small line over the map while the camera is doing something of its own. */
  private hint: HTMLDivElement | null = null;
  /** Where the zoom is heading, and the screen point it closes in on. */
  private zoomGoal: { s: number; sx: number; sy: number } | null = null;
  private lastFrame = performance.now();
  /** Frost over the frozen zone, one pixel a cell. */
  private frostMap: MapBitmap | null = null;
  /** Radius the frost overlay was last drawn at. */
  private frostDrawn = -1;
  private frostRing = new Graphics();
  ui = new Graphics();
  private settlementLabels = new Map<number, BitmapText>();
  /** Names over other players' colonies. */
  private colonyLabels = new Map<number, BitmapText>();
  private settlementGfx = new Graphics();
  private settlementKey = '';
  private night = new Graphics();
  /** Time of day: night shade, firelight, colour grade (render/light.ts). */
  lighting!: Lighting;
  shadows!: Shadows;
  private life = new Life();
  private precip = 'none';
  private views = new Map<number, EntityView>();
  /** Health bars, job tags, progress rings, selection brackets, reticles (render/worldui.ts). */
  private worldUi = new WorldUi();
  /** Hot springs on view (they steam), what your colony knew of landmarks last frame, and the next puff. */
  private springs = new Set<number>();
  private landmarkSig = '';
  private nextSteam = 0;
  /** Lit campfires on view, and the next wisp of smoke. */
  private hearths = new Set<number>();
  private nextHearth = 0;
  /** Doors, and building sites whose building has started going up. */
  private doors = new Map<number, EntityView>();
  private sites = new Map<number, EntityView>();
  /** Cells whose site just finished, so what replaces it settles in rather than pops. */
  private raised = new Set<number>();
  /** Where the last axe blow on each tree came from, by the tree's cell: it falls the other way. */
  private cutters = new Map<number, { x: number; y: number }>();
  /** Oldest first. */
  private stumps: { root: Container; until: number }[] = [];
  /** Outdoor temperature and the frost line, this frame. */
  private airTemp = 20;
  private frostNow = 2;
  /** Shared geometry for the small shapes on entity views (see shape()). */
  private shapes = new Map<string, GraphicsContext>();
  private pawnIds = new Set<number>();
  private pawnGlide = new PawnGlide();
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
    this.hint = document.createElement('div');
    this.hint.className = 'cam-hint';
    this.hint.hidden = true;
    el.appendChild(this.hint);
    this.tex = new TextureBank(this.app.renderer);
    await this.tex.loadArt();
    this.ground = Ground.create(this.app.renderer, this.tex, TILE);
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
    this.layers.tracks.addChild(this.tracks.view);
    this.layers.frost.addChild(this.frostRing);
    this.lighting = new Lighting(this.layers, this.layers.night, this.night);
    this.shadows = new Shadows(this.app.renderer, this.tex);
    this.layers.shadows.addChild(this.shadows.view);
    this.layers.fx.addChild(this.life.view);
    this.layers.ui.addChild(this.worldUi.view, this.juice.view);
    this.input = new Input(this, this.app.canvas);
    this.app.ticker.add(() => this.frame());
  }

  destroy(): void {
    this.destroyed = true;
    this.input?.destroy();
    this.ground?.destroy();
    this.hint?.remove();
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

  /** Fly to a cell: a quick glide when it's close, a short eased flight that lifts mid-way when it's far. */
  glideTo(x: number, y: number): void {
    this.followId = 0;
    this.moment = null;
    this.fly(x, y);
  }

  private fly(x: number, y: number, scale = this.world.scale.x): void {
    this.pan.stop();
    this.zoomGoal = null;
    if (cameraSettings.REDUCED_MOTION) {
      this.flight = null;
      this.world.scale.set(scale);
      this.centerOn(x, y);
      return;
    }
    const c = this.viewCenter();
    const s = this.world.scale.x;
    this.flight = planFlight(c.x, c.y, x, y, s, TILE * s, Math.min(this.app.screen.width, this.app.screen.height), performance.now(), scale, MIN_ZOOM);
  }

  /**
   * The player reached for the camera: whatever it was doing on its own stops. During a big moment
   * it first flies back to where they were, and they get it then (false until it has).
   */
  private takeCamera(): boolean {
    if (this.moment) {
      this.skipMoment();
      return false;
    }
    this.followId = 0;
    this.flight = null;
    return true;
  }

  /** As takeCamera, but zooming keeps the follow going. */
  private takeZoom(): boolean {
    if (this.moment) {
      this.skipMoment();
      return false;
    }
    this.flight = null;
    return true;
  }

  /** Follow a pawn until a manual pan, or stop if it's the one already followed. */
  toggleFollow(id: number): boolean {
    if (this.followId === id) {
      this.followId = 0;
      return false;
    }
    const e = store.mirror.get<Pawn>(id);
    if (!e) return false;
    this.followId = id;
    this.moment = null;
    this.pan.stop();
    if (!this.onView(e.x, e.y, 0.8)) this.fly(e.x, e.y);
    return true;
  }

  stopFollow(): void {
    this.followId = 0;
  }

  get following(): number {
    return this.followId;
  }

  /** Whether a cell is on screen, within the middle `share` of it. */
  private onView(x: number, y: number, share: number): boolean {
    const c = this.viewCenter();
    const s = this.world.scale.x * TILE;
    return Math.abs(x - c.x) * s < (this.app.screen.width * share) / 2 && Math.abs(y - c.y) * s < (this.app.screen.height * share) / 2;
  }

  /** Move the view by a dragged amount, with some give past the edge of the map. */
  dragPan(dx: number, dy: number): void {
    if (!this.takeCamera()) return;
    this.pan.stop();
    const { x, y } = this.panRanges();
    this.world.x += dx * edgeResist(this.world.x, x.lo, x.hi, dx);
    this.world.y += dy * edgeResist(this.world.y, y.lo, y.hi, dy);
    this.dragPanned.add(dx, dy, performance.now());
  }

  dragPanStart(): void {
    this.dragPanned.reset(performance.now());
  }

  /** The drag let go: the view carries on a little at the speed it was going. */
  dragPanEnd(): void {
    const v = this.dragPanned.release(performance.now());
    if (!cameraSettings.REDUCED_MOTION) this.pan.throwAt(v.vx, v.vy);
  }

  /** Held pan keys or the screen edge, -1..1 on each axis (0 lets it coast), for dt ms. */
  panInput(dirX: number, dirY: number, dt: number): void {
    const manual = dirX !== 0 || dirY !== 0;
    if (manual ? !this.takeCamera() : !this.pan.moving) return;
    const speed = panSpeedFor(this.world.scale.x, MAX_ZOOM, MIN_ZOOM);
    const { x, y } = this.panRanges();
    const gx = -dirX * speed * edgeResist(this.world.x, x.lo, x.hi, -dirX);
    const gy = -dirY * speed * edgeResist(this.world.y, y.lo, y.hi, -dirY);
    if (cameraSettings.REDUCED_MOTION) {
      this.pan.stop();
      this.world.x += (gx * dt) / 1000;
      this.world.y += (gy * dt) / 1000;
      return;
    }
    const d = this.pan.step(gx, gy, dt);
    this.world.x += d.dx * edgeResist(this.world.x, x.lo, x.hi, d.dx);
    this.world.y += d.dy * edgeResist(this.world.y, y.lo, y.hi, d.dy);
  }

  private panRanges(): { x: { lo: number; hi: number }; y: { lo: number; hi: number } } {
    const s = this.world.scale.x;
    return { x: panRange(this.app.screen.width, this.mapW * TILE, s), y: panRange(this.app.screen.height, this.mapH * TILE, s) };
  }

  /** Zoom by a factor about a screen point. The camera eases there over a few frames; more wheel turns stack. */
  zoomAt(sx: number, sy: number, factor: number): void {
    if (!this.takeZoom()) return;
    const from = this.zoomGoal?.s ?? this.world.scale.x;
    // Following, the colonist stays in the middle of the screen whatever the cursor is over.
    const held = this.followId !== 0;
    this.zoomGoal = { s: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, from * factor)), sx: held ? this.app.screen.width / 2 : sx, sy: held ? this.app.screen.height / 2 : sy };
  }

  /** Set the scale, keeping the world point under (sx, sy) where it is. */
  private scaleAbout(sx: number, sy: number, s: number): void {
    const old = this.world.scale.x;
    this.world.x = sx - ((sx - this.world.x) * s) / old;
    this.world.y = sy - ((sy - this.world.y) * s) / old;
    this.world.scale.set(s);
  }

  /** One frame of easing toward the zoom goal: a fixed share of the remaining distance (in log scale), whatever the frame rate. */
  private easeZoom(dt: number): void {
    const g = this.zoomGoal;
    if (!g) return;
    const old = this.world.scale.x;
    let s = old * Math.pow(g.s / old, 1 - Math.exp(-dt / ZOOM_EASE_MS));
    if (Math.abs(Math.log(g.s / s)) < 0.002) {
      s = g.s;
      this.zoomGoal = null;
    }
    this.scaleAbout(g.sx, g.sy, s);
  }

  // ---------------------------------------------------------------- per frame

  /** Everything that moves the view this frame, in order: requests, flight, zoom, input, follow, edges, shake. */
  private stepCamera(now: number, dt: number): void {
    this.world.x -= this.shaken.x;
    this.world.y -= this.shaken.y;
    this.shaken.x = this.shaken.y = 0;
    if (store.focus) {
      if (this.built) this.glideTo(store.focus.x, store.focus.y);
      else this.centerOn(store.focus.x, store.focus.y);
      store.focus = null;
    }
    this.askMoment(now);
    if (this.flight) {
      const p = flightPose(this.flight, now);
      this.world.scale.set(p.scale);
      this.centerOn(p.x, p.y);
      if (p.done) this.flight = null;
    }
    this.stepMoment(now);
    this.easeZoom(dt);
    this.input.update(dt);
    const followed = this.followId ? this.views.get(this.followId) : undefined;
    if (this.followId && (!followed || !followed.root.visible)) this.followId = 0;
    if (followed && !this.flight) {
      const s = this.world.scale.x;
      this.world.x = followStep(this.world.x, this.app.screen.width / 2 - followed.root.x * s, dt);
      this.world.y = followStep(this.world.y, this.app.screen.height / 2 - followed.root.y * s, dt);
    }
    // Past the edge of the map, the view eases back, unless a hand is still pulling it out there.
    if (!this.flight && !this.followId && !this.input.panning && !this.possessedId) {
      const { x, y } = this.panRanges();
      this.world.x = edgeSpring(this.world.x, x.lo, x.hi, dt);
      this.world.y = edgeSpring(this.world.y, y.lo, y.hi, dt);
    }
    this.setHint(this.moment && this.moment.phase !== 'back' ? 'Click to skip' : followed ? `Following ${followed.label?.text ?? 'them'}. F or a pan stops it.` : null);
    this.quake.step(dt);
    if (this.quake.trauma > 0 && !cameraSettings.REDUCED_MOTION) {
      const o = this.quake.offset(now, cameraSettings.SCREEN_SHAKE);
      this.shaken.x = o.x;
      this.shaken.y = o.y;
      this.world.x += o.x;
      this.world.y += o.y;
    }
  }

  /** Something big happened somewhere: go and look, if the player isn't using the camera themselves. */
  private askMoment(now: number): void {
    const q = cameraRequests.moment;
    if (!q) return;
    cameraRequests.moment = null;
    if (!cameraSettings.BIG_MOMENTS || cameraSettings.REDUCED_MOTION || this.onView(q.x, q.y, 0.7)) return;
    const free = mayTakeCamera({
      tool: store.tool.kind !== 'select',
      busyPointer: this.input.busy,
      overlay: !!store.menu || store.panel !== 'none' || store.help,
      steering: !!this.controlled(),
      following: this.followId !== 0,
      cameraBusy: !!this.flight || !!this.moment || this.pan.moving || !!this.zoomGoal,
      sinceInput: now - this.lastInput,
      sinceMoment: now - this.lastMoment,
    });
    if (!free) return;
    this.lastMoment = now;
    const c = this.viewCenter();
    const s = this.world.scale.x * TILE;
    this.moment = { phase: 'out', x: c.x, y: c.y, scale: this.world.scale.x, until: 0 };
    // Raiders arrive at the very edge: stop short, so the look is at them and not at the void.
    this.fly(keepOnMap(q.x, this.app.screen.width / s, this.mapW), keepOnMap(q.y, this.app.screen.height / s, this.mapH));
  }

  private stepMoment(now: number): void {
    const b = this.moment;
    if (!b || this.flight) return;
    if (b.phase === 'out') {
      b.phase = 'hold';
      b.until = now + MOMENT_HOLD_MS;
    } else if (b.phase === 'hold' && now >= b.until) {
      b.phase = 'back';
      this.fly(b.x, b.y, b.scale);
    } else if (b.phase === 'back') this.moment = null;
  }

  /** A click or key during a big moment: back to where the player was, quickly. */
  skipMoment(): void {
    const b = this.moment;
    if (!b || b.phase === 'back') return;
    b.phase = 'back';
    this.fly(b.x, b.y, b.scale);
    if (this.flight) this.flight.ms = MOMENT_SKIP_MS;
  }

  /** True while the camera is off on a big moment, so the click that skips it does nothing else. */
  get inMoment(): boolean {
    return !!this.moment && this.moment.phase !== 'back';
  }

  private setHint(text: string | null): void {
    const h = this.hint;
    if (!h) return;
    h.hidden = text === null;
    if (text !== null && h.textContent !== text) h.textContent = text;
  }

  /** Shake the screen for something heavy at a world point: less the further it is from the view. */
  shakeAt(x: number, y: number, power: number): void {
    if (cameraSettings.REDUCED_MOTION || cameraSettings.SCREEN_SHAKE <= 0) return;
    const s = this.world.scale.x;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const dist = Math.hypot(x * s + this.world.x - w / 2, y * s + this.world.y - h / 2);
    // A blow seen from high up is a smaller thing.
    this.quake.add(power * shakeFalloff(dist, Math.hypot(w, h) / 2) * Math.min(1, 0.45 + s * 0.55));
  }

  private frame(): void {
    const m = store.mirror;
    if (!m.w) return;
    if (m.w !== this.mapW || m.h !== this.mapH) this.setupMap();
    const now = performance.now();
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.stepCamera(now, dt);
    this.ground?.tick(now);

    if (m.allCellsChanged) {
      this.drawAllTerrain();
      this.rockLayer?.drawAll(m);
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
          this.particles.burst(x, y, { count: 14, color: rockDust(this.prevRock[c]), speed: 70, size: 2.2, life: 700, gravity: 60, drag: 3, chips: true });
          this.particles.burst(x, y, { count: 8, color: 0xb0aaa0, speed: 25, size: 4, grow: 6, life: 900, lift: 10, alpha: 0.5 });
          sound.play('rock', x, y);
          this.juice.rockMined(c, now);
        }
      }
    }
    for (const c of m.changedCells) this.prevRock[c] = m.rock[c];
    this.shadows.note(m, m.changedEnts, m.removedEnts, m.changedCells.size > 0);
    sound.note(m, m.changedEnts, m.removedEnts);
    this.worldUi.note(m, m.changedEnts, m.removedEnts, now);
    this.juice.frame(m, store.me?.faction ?? 0, m.changedEnts, m.removedEnts, now, (id) => {
      const v = this.views.get(id);
      return v && v.root.visible ? { x: v.root.x, y: v.root.y } : null;
    });
    if (m.changedCells.size) {
      this.drawTerrainCells(m.changedCells);
      this.rockLayer?.update(m, m.changedCells);
    }
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
    // Learning of a landmark (or visiting one) changes how it's drawn, though the landmark itself didn't change.
    const known = mine ? m.factions.get(mine) : undefined;
    const sig = `${mine}:${known?.seen?.length ?? 0}:${known?.visited?.length ?? 0}`;
    if (sig !== this.landmarkSig) {
      this.landmarkSig = sig;
      for (const e of m.entities.values()) if (e.kind === 'building' && BUILDINGS[e.def]?.landmark) m.changedEnts.add(e.id);
    }
    for (const id of m.changedEnts) {
      const e = m.entities.get(id);
      if (!e) continue;
      this.updateView(e);
      if (e.kind === 'pawn' && e.possessed && e.faction === mine) this.possessedId = e.id;
      if (e.kind === 'pawn' && this.built) {
        // Someone going down is the heaviest blow of a fight.
        if (e.downed && !this.felled.has(e.id)) {
          this.felled.add(e.id);
          this.shakeAt((e.x + 0.5) * TILE, (e.y + 0.5) * TILE, e.species ? 0.3 : 0.5);
        } else if (!e.downed) this.felled.delete(e.id);
      }
    }
    m.changedEnts.clear();

    if (!this.built && m.entities.size) this.built = true;

    const tick = store.estTick();
    this.airTemp = outdoorTempAt(tick, m.coldOffset, m.conditions);
    this.frostNow = frostRadius(tick, m.frost);
    if (fog.update(now)) this.drawFog();
    const me = store.me?.faction;
    {
      const a = this.screenToWorld(0, 0);
      const b = this.screenToWorld(this.app.screen.width, this.app.screen.height);
      store.view = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      sound.setListener(((a.x + b.x) / 2) * TILE, ((a.y + b.y) / 2) * TILE, (b.x - a.x) * TILE);
      this.worldUi.begin(m, me ?? 0, now, dt, tick, this.world.scale.x, store.view, store.hoverCell, store.squad);
    }
    for (const id of this.pawnIds) {
      const e = m.entities.get(id);
      const v = this.views.get(id);
      if (!e || e.kind !== 'pawn' || !v) continue;
      // Small late corrections glide instead of popping (see PawnGlide).
      const pos = this.pawnGlide.at(id, pawnPosition(e, tick, m.w), now);
      v.root.position.set((pos.x + 0.5) * TILE, (pos.y + 0.5) * TILE);
      // Lower on screen draws in front. Only re-sorts the pawn layer, and only when the order can change.
      v.root.zIndex = Math.round(v.root.y);
      // Others indoors, out of your people's sight, aren't shown.
      v.root.visible = e.faction === me || !fog.hidden(Math.round(pos.y) * m.w + Math.round(pos.x));
      this.animatePawn(e, v, now);
      this.worldUi.pawn(e, v.root.x, v.root.y, v.root.visible, id === store.selected, v.workCell ?? null);
      if (this.doors.size && v.root.visible) {
        this.holdDoor(Math.round(pos.y) * m.w + Math.round(pos.x), now);
        if (e.path) {
          this.holdDoor(e.path.cells[e.path.idx], now);
          this.holdDoor(e.path.cells[e.path.idx + 1], now);
        }
      }
    }
    if (now >= this.nextSteam && this.springs.size) {
      // Warm water breathing out into the cold.
      this.nextSteam = now + 380;
      for (const id of this.springs) {
        const v = this.views.get(id);
        if (!v || !v.root.parent?.visible) continue;
        this.particles.burst(v.root.x + (Math.random() - 0.5) * TILE, v.root.y + (Math.random() - 0.5) * TILE * 0.6, { count: 1, color: 0xeef6f8, speed: 4, size: 5, grow: 12, life: 2200, lift: 16, alpha: 0.32 });
      }
    }
    if (settings.details && now >= this.nextHearth && this.hearths.size) {
      this.nextHearth = now + 340;
      this.hearthSmoke();
    }
    this.swingDoors(now, dt);
    this.raiseSites(dt);
    this.clearStumps(now);
    this.tracks.view.visible = settings.details;
    this.tracks.update(dt);
    this.cullChunks();
    this.drawFrost(tick);
    // Too small to see when zoomed out, and it touches every visible plant.
    if (this.world.scale.x >= 0.35 && settings.plantSway && !settings.reducedMotion) this.swayPlants(now);
    this.updateLod();
    this.drawFire(dt);
    this.drawShots();
    this.particles.update(dt);
    this.tweens.update(now);
    this.drawUi();
    this.worldUi.end();
    this.drawWeather(tick, dt);
    this.drawLight(tick, now, dt);
  }

  // ---------------------------------------------------------------- animation

  /** Bob while walking, face the direction of travel, swing at work, breathe in sleep, flash when hit. */
  private animatePawn(e: Pawn, v: EntityView, now: number): void {
    const rig = v.rig;
    if (!rig) return;
    v.workCell = null;
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
    let kx = 0;
    let ky = 0;
    let busy = false;
    const swung = v.swing;
    v.swing = undefined;
    if (e.asleep || e.downed) {
      // Slow breathing; a "z" now and then for sleepers.
      const b = Math.sin(now / 700 + e.id) * 0.04;
      sx = 1 + b;
      sy = 1 - b;
      // No "z" over a sleeper you can't see: it would give away who's in a dark room.
      if (e.asleep && !e.downed && v.root.visible && now >= (v.nextZ ?? 0)) {
        this.particles.zed(x + 5, y - 3);
        v.nextZ = now + 1300 + Math.random() * 500;
      }
    } else if (moved > 0.02) {
      // About one step per cell (half a cycle): faster and the walk frames flicker past.
      const stride = v.phase ?? 0;
      v.phase = (stride + (moved / TILE) * Math.PI * 1.2) % (Math.PI * 2);
      bob = -Math.abs(Math.sin(v.phase)) * (e.species === 'hare' ? 7 : 3.2);
      lean = Math.sin(v.phase) * 0.06;
      this.setWalkFrame(v, v.phase);
      if (Math.floor(stride / Math.PI) !== Math.floor(v.phase / Math.PI)) this.footfall(e, v, dx, dy);
      busy = true;
    } else {
      this.setWalkFrame(v, -1);
      const work = this.workTarget(e);
      if (work) {
        v.workCell = work.cell;
        // Face the work and swing at it.
        const tx = (work.cell % store.mirror.w) + 0.5;
        const ty = Math.floor(work.cell / store.mirror.w) + 0.5;
        if (Math.abs(tx * TILE - x) > 2) v.facing = tx * TILE > x ? 1 : -1;
        const gentle = work.fx === 'soil' || work.fx === 'tend' || work.fx === 'craft';
        const p = ((now + e.id * 137) / (gentle ? GENTLE_SWING_MS : HEAVY_SWING_MS)) % 1;
        const swing = gentle ? gentleSwing(p) : heavySwing(p);
        const down = Math.max(0, swing);
        lean = swing * (work.fx === 'tend' || work.fx === 'craft' ? 0.08 : 0.22);
        bob = -down * 1.5;
        if (!gentle) {
          // The whole body goes into a heavy blow.
          const wx = tx * TILE - x;
          const wy = ty * TILE - y;
          const d = Math.hypot(wx, wy) || 1;
          kx = (wx / d) * down * 2.5;
          ky = (wy / d) * down * 2.5;
          sx = 1 + down * 0.05;
          sy = 1 - down * 0.05;
        }
        // Chips fly, and the sound comes, as the tool lands.
        if (swung !== undefined && passed(swung, p, gentle ? GENTLE_STRIKE : HEAVY_STRIKE)) this.strike(work, tx * TILE, ty * TILE, x, y);
        v.swing = p;
        busy = true;
      } else if (v.animal) {
        const dip = grazeDip(now / 1000, e.id);
        lean = dip * 0.16;
        bob = dip * 1.2;
      } else {
        // Idle: a slight sway, and now and then a look the other way.
        lean = Math.sin(now / 900 + e.id) * 0.02;
        if (!e.drafted && now >= (v.nextGlance ?? 0)) {
          if (v.nextGlance !== undefined && Math.random() < 0.5) v.facing = -(v.facing ?? 1);
          v.nextGlance = now + 3000 + Math.random() * 6000;
        }
      }
    }
    const kick = v.kick;
    if (kick) {
      const k = (now - kick.at) / kick.ms;
      if (k >= 1) v.kick = undefined;
      else if (k > 0) {
        kx += kick.x * Math.sin(k * Math.PI);
        ky += kick.y * Math.sin(k * Math.PI);
      }
    }
    const facing = v.facing ?? 1;
    rig.position.set(kx, bob + ky);
    rig.rotation = lean * facing;
    rig.scale.set(facing * sx, sy);
    if (v.body) v.body.tint = (v.flashUntil ?? 0) > now ? 0xff7060 : (v.baseTint ?? 0xffffff);
    if (now >= (v.nextBreath ?? 0)) {
      v.nextBreath = now + breathGap(busy, !!e.asleep, Math.random());
      this.breathe(e, v, x, y);
    }
  }

  /** Air you can see, on a cold day. */
  private breathe(e: Pawn, v: EntityView, x: number, y: number): void {
    if (!settings.details || !v.root.visible || this.world.scale.x < 0.55 || !this.onView(x / TILE - 0.5, y / TILE - 0.5, 1.1) || !this.coldAt(x, y)) return;
    const facing = v.facing ?? 1;
    const size = e.species ? (ANIMALS[e.species]?.size ?? 1) : 1;
    const out = v.lying ? 0.34 : e.species ? 0.42 * size : 0.3;
    const up = v.lying ? 0.02 : e.species ? 0.18 * size : 0.24;
    this.particles.burst(x + facing * TILE * out, y - TILE * up, { count: 2, color: 0xeaf2fa, speed: 13, size: 1.3 * Math.sqrt(size), grow: 5, life: 1050, lift: 4, drag: 1.2, alpha: 0.2, angle: facing > 0 ? 0 : Math.PI, spread: 0.7 });
  }

  private coldAt(x: number, y: number): boolean {
    const m = store.mirror;
    const cx = Math.floor(x / TILE);
    const cy = Math.floor(y / TILE);
    const room = m.rooms.get(m.roomAt[cy * m.w + cx]);
    if (room) return room.temp < BREATH_BELOW;
    return this.airTemp < BREATH_BELOW || frostLevel(cx, cy, m.w, m.h, this.frostNow) > 0.3;
  }

  /** A foot comes down: a print if the ground takes one, a ring on shallow water. */
  private footfall(e: Pawn, v: EntityView, dx: number, dy: number): void {
    const m = store.mirror;
    const x = v.root.x;
    const y = v.root.y + TILE * 0.3;
    if (!settings.details || !v.root.visible || this.world.scale.x < 0.35 || !this.onView(x / TILE - 0.5, y / TILE - 0.5, 1.1)) return;
    const cx = Math.floor(x / TILE);
    const cy = Math.floor(v.root.y / TILE);
    if (!m.inBounds(cx, cy)) return;
    const c = cy * m.w + cx;
    const wet = this.precip === 'rain' || this.precip === 'storm';
    const footing = footingOf(TERRAINS[m.terrain[c]].key, frostLevel(cx, cy, m.w, m.h, this.frostNow), m.roomAt[c] !== 0, wet);
    if (!footing) return;
    const size = e.species ? Math.max(0.55, Math.min(1.1, (ANIMALS[e.species]?.size ?? 1) * 0.8)) : 1;
    if (footing === 'water') {
      this.tracks.ripple(x, y, size);
      this.particles.burst(x, y, { count: 3, color: 0xdcecf4, speed: 22, size: 1, life: 300, gravity: 110, lift: 12, alpha: 0.7 });
      return;
    }
    const angle = Math.atan2(dy, dx);
    v.foot = !v.foot;
    const side = (v.foot ? 3.2 : -3.2) * size;
    this.tracks.print(x - Math.sin(angle) * side, y + Math.cos(angle) * side, angle, footing, size);
    if (footing === 'snow') this.particles.burst(x, y, { count: 2, color: 0xf2f7ff, speed: 16, size: 1.2, life: 320, gravity: 70, alpha: 0.7 });
  }

  /** The tool lands: chips, the sound, and whatever it hit gives a little. */
  private strike(work: { cell: number; fx: WorkFx; id?: number }, tx: number, ty: number, x: number, y: number): void {
    this.workParticles(work.fx, tx, ty);
    if (work.fx === 'wood') {
      this.cutters.set(work.cell, { x, y });
      if (this.cutters.size > 64) this.cutters.delete(this.cutters.keys().next().value!);
    }
    const t = work.id ? this.views.get(work.id) : undefined;
    if (!t || settings.reducedMotion || !t.root.parent?.visible) return;
    if (work.fx === 'build') {
      this.tweens.add(150, (k) => t.root.scale.set(1 + 0.05 * (1 - k)), undefined, t.root);
      return;
    }
    const s = t.root.children[0];
    if (!s || (work.fx !== 'wood' && work.fx !== 'leaf')) return;
    const d = Math.hypot(tx - x, ty - y) || 1;
    const ux = (tx - x) / d;
    const uy = (ty - y) / d;
    const power = work.fx === 'wood' ? 2.6 : 1.5;
    this.tweens.add(220, (k) => {
      const a = power * (1 - k) * Math.sin(k * Math.PI * 5);
      s.position.set(ux * a, uy * a);
    }, undefined, s);
  }

  /** Someone at this cell or stepping into it: if it's a door, it stands open a moment. */
  private holdDoor(cell: number | undefined, now: number): void {
    if (cell === undefined) return;
    const v = this.doors.get(store.mirror.buildingAt[cell]);
    if (v) v.openUntil = now + 300;
  }

  /** Doors swing on their hinge at the left: open fast, close a little slower. */
  private swingDoors(now: number, dt: number): void {
    for (const v of this.doors.values()) {
      const goal = (v.openUntil ?? 0) > now ? 1 : 0;
      const was = v.open ?? 0;
      if (was === goal) continue;
      let o = was + (goal - was) * (1 - Math.exp(-dt / (goal ? 55 : 120)));
      if (Math.abs(goal - o) < 0.01) o = goal;
      v.open = o;
      const f = 1 - 0.8 * o;
      v.leaf!.scale.x = v.leafScale! * f;
      v.leaf!.x = (-TILE / 2) * (1 - f);
    }
  }

  /** Buildings climb toward what the builders have done, however far apart the updates come. */
  private raiseSites(dt: number): void {
    for (const v of this.sites.values()) {
      const goal = v.riseGoal!;
      const was = v.riseShown!;
      if (was === goal) continue;
      let s = was + (goal - was) * (1 - Math.exp(-dt / 140));
      if (Math.abs(goal - s) < 0.002) s = goal;
      v.riseShown = s;
      this.setRise(v, s);
    }
  }

  private setRise(v: EntityView, share: number): void {
    const step = riseStep(share);
    const rise = v.rise!;
    rise.visible = share > 0.005;
    rise.texture = this.tex.riseFrame(v.def, step, RISE_STEPS);
    rise.width = TILE;
    rise.height = (TILE * step) / RISE_STEPS;
    if (v.plank) v.plank.y = TILE / 2 - rise.height;
  }

  private hearthSmoke(): void {
    for (const id of this.hearths) {
      const v = this.views.get(id);
      if (!v || !v.root.parent?.visible) continue;
      const { x, y } = v.root;
      this.particles.burst(x + (Math.random() - 0.5) * 6, y - 8, { count: 1, color: [0x8a8680, 0xa8a49c], speed: 5, size: 2.6, grow: 8, life: 2600, lift: 20, alpha: 0.2, drag: 0.3 });
      if (Math.random() < 0.25) this.particles.burst(x, y - 4, { count: 1, color: [0xffb040, 0xff7020], speed: 14, size: 1, life: 900, lift: 36, drag: 1 });
    }
  }

  /** The way a hit looks on the bodies involved: the striker goes in or kicks back, the struck gives. */
  private shove(s: ShotFx, now: number): void {
    const a = this.views.get(s.shooter);
    const b = this.views.get(s.target);
    if (!a || !b || a === b || settings.reducedMotion) return;
    const dx = b.root.x - a.root.x;
    const dy = b.root.y - a.root.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const melee = weaponOf(s.weapon).melee;
    a.kick = melee ? { x: ux * 8, y: uy * 8, at: now, ms: 190 } : { x: -ux * 2.6, y: -uy * 2.6, at: now, ms: 130 };
    if (s.hit) b.kick = { x: ux * 4, y: uy * 4, at: now + (melee ? 60 : SHOT_FLY_MS), ms: 170 };
  }

  /** A body going down, or getting up. Its view was just rebuilt lying (or standing), so this plays the way there. */
  private topple(v: EntityView, hurt: boolean): void {
    const body = v.body!;
    if (!v.lying) {
      this.tweens.add(300, (k) => (body.rotation = (Math.PI / 2) * (1 - ease.outQuad(k))), undefined, body);
      return;
    }
    const rest = body.rotation;
    this.tweens.add(
      hurt ? 240 : 360,
      (k) => (body.rotation = rest * (hurt ? ease.inQuad(k) : ease.outQuad(k))),
      () => {
        if (hurt) this.particles.burst(v.root.x, v.root.y + TILE * 0.25, { count: 5, color: 0xb8b0a0, speed: 24, size: 2.4, grow: 5, life: 460, lift: 6, alpha: 0.4 });
      },
      body,
    );
  }

  /** A pawn's view is rebuilt whenever it picks something up or lies down: it mustn't lose its stride or its bearings. */
  private carryOver(old: EntityView, v: EntityView): void {
    v.facing = old.facing;
    v.phase = old.phase;
    v.lastX = old.lastX;
    v.lastY = old.lastY;
    v.swing = old.swing;
    v.foot = old.foot;
    v.kick = old.kick;
    v.flashUntil = old.flashUntil;
    v.nextBreath = old.nextBreath;
    v.nextGlance = old.nextGlance;
    v.nextZ = old.nextZ;
  }

  /** Swap the body texture for walk-cycle frames, if the art exists. phase < 0 = standing. */
  private setWalkFrame(v: EntityView, phase: number): void {
    if (!v.body || v.animal) return;
    const frames = this.tex.walkFrames();
    if (!frames.length) return;
    v.body.texture = phase < 0 ? this.tex.pawn() : frames[Math.floor((phase / (Math.PI * 2)) * frames.length * 2) % frames.length];
  }

  /** The cell a pawn is working on right now, if it's standing next to it. */
  private workTarget(e: Pawn): { cell: number; fx: WorkFx; id?: number } | null {
    const j = e.job;
    if (!j || e.path) return null;
    const m = store.mirror;
    const cellOf = (id: number) => {
      const t = m.entities.get(id);
      return t ? t.y * m.w + t.x : -1;
    };
    let cell = -1;
    let fx: WorkFx = 'build';
    let id: number | undefined;
    switch (j.type) {
      case 'mine':
        cell = j.cell;
        fx = 'stone';
        break;
      case 'cut': {
        cell = cellOf(j.target);
        id = j.target;
        const t = m.entities.get(j.target);
        fx = t && t.kind === 'plant' && PLANTS[t.def]?.tree ? 'wood' : 'leaf';
        break;
      }
      case 'build':
        cell = cellOf(j.target);
        id = j.target;
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
    return Math.max(Math.abs(px - e.x), Math.abs(py - e.y)) <= 1 ? { cell, fx, id } : null;
  }

  private workParticles(fx: WorkFx, x: number, y: number): void {
    const p = this.particles;
    sound.play(fx, x, y);
    if (!this.onView(x / TILE - 0.5, y / TILE - 0.5, 1.2)) return;
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
    this.ground?.setup(m.w, m.h, this.layers.terrain);
    this.rockLayer?.destroy();
    this.rockLayer = new RockLayer(m.w, m.h, TILE);
    this.layers.rock.addChild(this.rockLayer.root);
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
    this.ground?.update(store.mirror.terrain, null);
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
    this.ground?.update(m.terrain, cells);
  }

  /** Write one cell's PX x PX pixels into an RGBA buffer of the given stride, at (ox, oy). */
  private paintCell(data: Uint8ClampedArray, stride: number, c: number, ox: number, oy: number): void {
    const m = store.mirror;
    const x = c % m.w;
    const y = (c / m.w) | 0;
    const rock = m.rock[c];
    if (this.ground && (!rock || this.rockLayer)) {
      // The ground shader draws open ground and the rock layer draws rock; this bitmap is only the fallback.
      for (let py = 0; py < PX; py++) data.fill(0, ((oy + py) * stride + ox) * 4, ((oy + py) * stride + ox + PX) * 4);
      return;
    }
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
          // (Scaled to the image, so larger ground textures keep the same feature size.)
          const step = (rock ? TEX_STEP * 2 : TEX_STEP) * Math.max(1, Math.round(tex.w / 128));
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
    this.springs.delete(id);
    this.hearths.delete(id);
    this.doors.delete(id);
    this.sites.delete(id);
    this.pawnGlide.forget(id);
    if (leaving) this.felled.delete(id);
    const root = v.root;
    if (leaving && v.riseGoal !== undefined) this.raised.add(Math.floor(root.y / TILE) * this.mapW + Math.floor(root.x / TILE));
    if (!leaving || !this.built || !root.visible || !root.parent?.visible) {
      root.destroy({ children: true });
      return;
    }
    if (v.kind === 'building' && v.battered) this.shakeAt(root.x, root.y, 0.55);
    const kill = () => root.destroy({ children: true });
    if (v.kind === 'plant' && PLANTS[v.def]?.tree) {
      this.fellTree(v, root, kill);
    } else if (v.kind === 'construct') {
      // The last of the scaffolding comes away as the building takes over.
      if ((v.riseGoal ?? 0) > 0.5) {
        this.particles.burst(root.x, root.y + 8, { count: 7, color: 0xb8ac98, speed: 34, size: 3, grow: 7, life: 620, lift: 6, alpha: 0.4 });
        if (v.plank) this.particles.burst(root.x, root.y, { count: 8, color: [0x8a6a42, 0xb08a58], speed: 62, size: 2, life: 560, gravity: 150, chips: true });
      }
      kill();
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

  /**
   * Timber: seen from above, the crown swings out from the stump along the line of the fall and the
   * trunk is laid bare behind it. It lands with a crash of leaves and snow or dust, rebounds, and
   * fades, leaving the stump and whatever wood it gave.
   */
  private fellTree(v: EntityView, root: Container, kill: () => void): void {
    const m = store.mirror;
    const crown = root.children[0] as Sprite | undefined;
    const cx = Math.floor(root.x / TILE);
    const cy = Math.floor(root.y / TILE);
    const cell = cy * m.w + cx;
    const by = this.cutters.get(cell);
    this.cutters.delete(cell);
    sound.play('fall', root.x, root.y);
    if (!crown) return kill();
    root.label = 'fallen';
    const size = crown.width;
    const length = size * 1.45;
    let angle = fellAngle(root.x, root.y, by, Math.random());
    // Never off the edge of the world.
    if (!m.inBounds(Math.floor((root.x + Math.cos(angle) * length) / TILE), Math.floor((root.y + Math.sin(angle) * length) / TILE))) angle += Math.PI;
    const leaves = v.def === 'pine' ? [0x2f5a3a, 0x3f6a4a, 0x254a30] : [0x4a8030, 0x6aa040, 0x2f5a2a];
    this.leaveStump(cx, cy, size);
    this.particles.burst(root.x, root.y, { count: 8, color: leaves, speed: 45, size: 2, life: 800, gravity: 40, chips: true });
    // In the frame of the fall, so "along" is x. The crown turns back to keep its art as it was.
    const along = new Container();
    along.rotation = angle;
    const trunk = this.shape('trunk', (g) => {
      g.poly([0, -4, TRUNK_LEN, -2.4, TRUNK_LEN, 2.4, 0, 4]).fill(0x5a4030);
      g.poly([0, -3.4, TRUNK_LEN, -2, TRUNK_LEN, -0.8, 0, -1]).fill({ color: 0x7a5a40, alpha: 0.8 });
    });
    trunk.scale.set(0, size / (TILE * 1.5));
    const box = new Container();
    crown.position.set(0, 0);
    crown.rotation = -angle;
    box.addChild(crown);
    along.addChild(trunk, box);
    root.addChild(along);
    const total = FELL_MS + REBOUND_MS + SETTLE_MS;
    let landed = false;
    this.tweens.add(
      total,
      (k) => {
        const ms = k * total;
        const p = fellPose(ms);
        box.x = length * p.reach;
        box.scale.set(p.squash, 1 + (1 - p.squash) * 0.2);
        trunk.scale.x = (length * p.reach) / TRUNK_LEN;
        root.alpha = p.alpha;
        if (!landed && ms >= FELL_MS) {
          landed = true;
          this.treeLands(root.x, root.y, angle, length, leaves, size >= TILE * 1.1);
        }
      },
      kill,
    );
  }

  private treeLands(x: number, y: number, angle: number, length: number, leaves: number[], big: boolean): void {
    const m = store.mirror;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const tipX = x + ux * length;
    const tipY = y + uy * length;
    const snow = frostLevel(Math.floor(tipX / TILE), Math.floor(tipY / TILE), m.w, m.h, this.frostNow) >= 0.25;
    for (const t of [0.4, 0.7, 1]) {
      this.particles.burst(x + ux * length * t, y + uy * length * t, { count: 5, color: snow ? [0xf4f8ff, 0xdfeaf4] : [0xb8ac98, 0x9a8e7c], speed: 46, size: 3.2, grow: 7, life: 800, lift: 6, alpha: snow ? 0.7 : 0.4, drag: 2.5 });
    }
    this.particles.burst(tipX, tipY, { count: 14, color: leaves, speed: 85, size: 2.2, life: 1000, gravity: 70, chips: true });
    if (!big) return;
    this.shakeAt(tipX, tipY, 0.14);
    if (settings.wildlife && this.lighting.dark < 0.35 && !snow && Math.random() < 0.4) this.life.startle(tipX, tipY);
  }

  private leaveStump(cx: number, cy: number, size: number): void {
    const root = new Container();
    root.label = 'stump';
    root.position.set((cx + 0.5) * TILE, (cy + 0.5) * TILE);
    root.scale.set(0.6 + 0.6 * (size / (TILE * 1.5)));
    root.addChild(
      this.shape('stump', (g) => {
        g.ellipse(0, 2.6, 8, 6.4).fill(0x4a3424);
        g.ellipse(0, 0, 7.6, 6).fill(0xb08a58).stroke({ width: 1.2, color: 0x5a3f28 });
        g.ellipse(0, 0, 4.6, 3.6).stroke({ width: 0.8, color: 0x8a6a42, alpha: 0.8 });
        g.circle(0, 0, 1.4).fill(0x8a6a42);
      }),
    );
    this.place('floorThings', root, cx, cy);
    this.stumps.push({ root, until: performance.now() + STUMP_MS });
    if (this.stumps.length > MAX_STUMPS) this.stumps.shift()!.root.destroy({ children: true });
  }

  private clearStumps(now: number): void {
    while (this.stumps.length && this.stumps[0].until <= now) {
      const { root } = this.stumps.shift()!;
      this.tweens.add(1200, (k) => (root.alpha = 1 - k), () => root.destroy({ children: true }));
    }
  }

  /** A stack changed how full it looks: a bump as goods land on it, a sag and a few crumbs as they're taken. */
  private restack(v: EntityView, grew: boolean): void {
    const root = v.root;
    if (!this.built || !root.parent?.visible) return;
    this.tweens.add(
      grew ? 220 : 260,
      (k) => {
        const q = Math.sin(k * Math.PI) * (1 - k) * (grew ? 0.16 : 0.12);
        root.scale.set(1 + q * (grew ? 0.5 : 1), 1 + (grew ? q : -q));
      },
      () => root.scale.set(1),
      root,
    );
    if (!grew) this.particles.burst(root.x, root.y + 6, { count: 4, color: [ITEMS[v.def]?.color ?? 0x999999, 0xb8ac98], speed: 38, size: 1.5, life: 380, gravity: 120, chips: true });
  }

  /** A finished building takes its weight: down and back, rather than the pop of something appearing. */
  private settle(root: Container): void {
    this.tweens.add(
      300,
      (k) => {
        const q = Math.sin(k * Math.PI) * (1 - k) * 0.22;
        root.scale.set(1 + q * 0.6, 1 - q);
      },
      () => root.scale.set(1),
      root,
    );
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
        // Landmarks: drawn once your people know of them, dimmed once searched.
        if (BUILDINGS[e.def]?.landmark) return `l:${e.def}:${knowsLandmark(e.id) ? 1 : 0}:${e.found ?? 0}:${visitedLandmark(e.id) ? 1 : 0}`;
        // Damage in eighths, so a wall being smashed redraws a few times rather than every blow.
        const dmg = Math.ceil((1 - e.hp / maxHp(e.def)) * 8);
        return isWall(e) ? `b:${e.def}:${e.faction}:${this.wallMask(e.x, e.y)}:${dmg}` : `b:${e.def}:${e.faction}:${dmg}`;
      }
      case 'construct': {
        const total = Object.values(constructCost(e)).reduce((a, b) => a + b, 0);
        const got = Object.values(e.delivered).reduce((a, b) => a + b, 0);
        const { ready, pile } = siteStage(total, got, e.progress, constructWork(e));
        return `c:${e.def}:${ready}:${pile}:${e.kit ? 'k' : ''}`;
      }
      case 'pawn':
        return `w:${e.faction}:${e.name}:${e.tamed ?? 0}:${e.taming ?? 0}:${e.hunted ?? 0}:${e.asleep ? 1 : 0}:${e.carrying ? `${e.carrying.def}${pileLevel(e.carrying.count, ITEMS[e.carrying.def]?.stackLimit ?? 1)}` : ''}:${e.weapon}:${e.drafted ? 1 : 0}:${e.downed ? 1 : 0}:${e.prisoner}`;
    }
  }

  private updateView(e: Entity): void {
    const key = this.viewKey(e);
    const old = this.views.get(e.id);
    if (old && e.kind === 'construct' && old.riseGoal !== undefined) old.riseGoal = Math.min(1, e.progress / constructWork(e));
    if (old && old.key === key) return;
    if (old && e.kind === 'item' && old.kind === 'item' && old.def === e.def && old.root.x === (e.x + 0.5) * TILE && old.root.y === (e.y + 0.5) * TILE) {
      // A stack growing or shrinking as haulers come and go: update it in place rather than rebuild.
      const s = old.root.children[0] as Sprite;
      s.tint = e.rot >= 0.5 ? 0xa0b070 : 0xffffff;
      this.setCountLabel(old, e.count);
      old.key = key;
      const pile = this.tex.pile(e.def, e.count);
      if (pile.level !== old.pile) {
        const grew = pile.level > (old.pile ?? 0);
        old.pile = pile.level;
        s.texture = pile.texture;
        s.width = s.height = TILE * 0.9 * pile.scale;
        this.restack(old, grew);
      }
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
        const pile = this.tex.pile(e.def, e.count);
        const s = new Sprite(pile.texture);
        s.anchor.set(0.5);
        s.width = s.height = TILE * 0.9 * pile.scale;
        v.pile = pile.level;
        if (e.rot >= 0.5) s.tint = 0xa0b070;
        root.addChild(s);
        this.setCountLabel(v, e.count);
        this.place('items', root, e.x, e.y);
        break;
      }
      case 'building': {
        const d = BUILDINGS[e.def];
        if (d?.landmark) {
          this.drawLandmark(root, e);
          this.place('buildings', root, e.x, e.y);
          break;
        }
        const wall = isWall(e);
        if (wall) v.wallCell = e.y * store.mirror.w + e.x;
        const s = new Sprite(wall ? this.tex.wall(e.def, this.wallMask(e.x, e.y)) : this.tex.building(e.def));
        s.anchor.set(0.5);
        s.width = s.height = TILE;
        root.addChild(s);
        const health = e.hp / maxHp(e.def);
        if (health < 1 && e.faction === 0) {
          // Old ruined walls out in the wilds: weathered, not under attack.
          s.tint = 0xb8b0a4;
        } else if (health < 1) {
          // Battered: darker, with a strip showing what's left.
          v.battered = true;
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
          v.leaf = s;
          v.leafScale = s.scale.x;
          this.doors.set(e.id, v);
        }
        if (e.def === 'campfire') this.hearths.add(e.id);
        this.place(d.floorTerrain ? 'floorThings' : 'buildings', root, e.x, e.y);
        break;
      }
      case 'construct':
        this.drawConstruct(root, e, v);
        this.place('buildings', root, e.x, e.y);
        break;
      case 'pawn':
        this.drawPawn(root, e, v);
        this.layers.pawns.addChild(root);
        this.pawnIds.add(e.id);
        break;
    }
    this.views.set(e.id, v);
    if (old && e.kind === 'pawn') {
      this.carryOver(old, v);
      if (this.built && v.body && !!v.lying !== !!old.lying) this.topple(v, !!e.downed);
    }
    if (!old && this.built) {
      if (e.kind === 'pawn') this.tweens.add(400, (k) => (root.alpha = k), undefined, root);
      else if (e.kind === 'building' && this.raised.delete(e.y * store.mirror.w + e.x)) this.settle(root);
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

  /** The journey: the route being planned (home, waypoints, destination), or the caravan's route ahead and its goal. */
  private drawJourney(g: Graphics): void {
    const m = store.mirror;
    const me = store.me?.faction ?? 0;
    const f = m.factions.get(me);
    if (!f) return;
    const sw = 1 / this.world.scale.x;
    const px = (x: number, y: number): [number, number] => [(x + 0.5) * TILE, (y + 0.5) * TILE];
    const flag = (x: number, y: number, color: number) => {
      const [fx, fy] = px(x, y);
      g.moveTo(fx, fy).lineTo(fx, fy - TILE * 1.2).stroke({ width: 2.5 * sw, color: 0x2a2018, alpha: 0.9 });
      g.poly([fx, fy - TILE * 1.2, fx + TILE * 0.7, fy - TILE * 0.95, fx, fy - TILE * 0.7]).fill({ color, alpha: 0.95 });
    };
    const c = f.caravan;
    if (c) {
      const from = Math.max(0, c.leg - 1);
      const pts = (c.at !== undefined ? [c.at] : []).concat(c.route.slice(from));
      if (pts.length > 1) {
        const [x0, y0] = px(pts[0] % m.w, Math.floor(pts[0] / m.w));
        g.moveTo(x0, y0);
        for (const cell of pts.slice(1)) g.lineTo(...px(cell % m.w, Math.floor(cell / m.w)));
        g.stroke({ width: 3 * sw, color: 0xf0d080, alpha: 0.55 });
      }
      flag(c.dest % m.w, Math.floor(c.dest / m.w), 0xf0c050);
      return;
    }
    const j = store.journey;
    if (store.tool.kind !== 'moveHome' || !j?.dest) return;
    const pts = [f.home, ...j.via, j.dest];
    g.moveTo(...px(pts[0].x, pts[0].y));
    for (const p of pts.slice(1)) g.lineTo(...px(p.x, p.y));
    g.stroke({ width: 3 * sw, color: 0xf0d080, alpha: 0.7 });
    for (const v of j.via) g.circle(...px(v.x, v.y), TILE * 0.35).fill({ color: 0xf0d080, alpha: 0.8 });
    flag(j.dest.x, j.dest.y, 0xf0c050);
  }

  /**
   * A building site, in stages: the blueprint with its goods piling up beside it, then the building
   * itself rising from the ground as the work goes on (walls and doors inside a scaffold).
   */
  private drawConstruct(root: Container, e: Construct, v: EntityView): void {
    const cost = constructCost(e);
    const total = Object.values(cost).reduce((a, b) => a + b, 0);
    const got = Object.values(e.delivered).reduce((a, b) => a + b, 0);
    const { ready, pile, rise } = siteStage(total, got, e.progress, constructWork(e));
    const ghost = new Sprite(this.tex.building(e.def));
    ghost.anchor.set(0.5);
    ghost.width = ghost.height = TILE;
    ghost.alpha = ready ? 0.24 : 0.3;
    ghost.tint = ready ? 0xd8c8a0 : 0x8ac8ff;
    const frame = this.shape(`cframe:${ready}`, (g) =>
      g
        .rect(-TILE / 2 + 1, -TILE / 2 + 1, TILE - 2, TILE - 2)
        .fill({ color: ready ? 0x8a7050 : 0x3a7ac0, alpha: ready ? 0.25 : 0.2 })
        .stroke({ width: 1.5, color: ready ? 0xc8a878 : 0x8ac8ff, alpha: 0.9 }),
    );
    root.addChild(frame, ghost);
    const goods = Object.keys(cost).find((k) => e.delivered[k]);
    for (let k = 0; goods && k < pile; k++) {
      const s = new Sprite(this.tex.item(goods));
      s.anchor.set(0.5);
      s.width = s.height = TILE * 0.5;
      s.position.set(...PILE_AT[k]);
      root.addChild(s);
    }
    if (!ready) return;
    const up = new Sprite(this.tex.riseFrame(e.def, riseStep(rise), RISE_STEPS));
    up.anchor.set(0.5, 1);
    up.y = TILE / 2;
    root.addChild(up);
    v.rise = up;
    v.riseShown = v.riseGoal = rise;
    if (BUILDINGS[e.def]?.wall) {
      root.addChild(
        this.shape('scaffold', (g) => {
          g.moveTo(-TILE / 2 + 3, -TILE / 2 + 1).lineTo(TILE / 2 - 3, TILE / 2 - 1).moveTo(TILE / 2 - 3, -TILE / 2 + 1).lineTo(-TILE / 2 + 3, TILE / 2 - 1).stroke({ width: 1, color: 0x6a5032, alpha: 0.55 });
          g.moveTo(-TILE / 2 + 3, -TILE / 2 + 1).lineTo(-TILE / 2 + 3, TILE / 2 - 1).moveTo(TILE / 2 - 3, -TILE / 2 + 1).lineTo(TILE / 2 - 3, TILE / 2 - 1).stroke({ width: 2, color: 0x8a6a42 });
        }),
      );
      v.plank = this.shape('plank', (g) => g.rect(-TILE / 2 + 1, -1.5, TILE - 2, 3).fill(0xb08a58).stroke({ width: 0.8, color: 0x5a3f28 }));
      root.addChild(v.plank);
    }
    this.sites.set(e.id, v);
    this.setRise(v, rise);
  }

  /**
   * A landmark: hidden until your people have seen it (or heard of it), then drawn larger than a
   * cell, with an ember mark over it until someone of yours has been there; dimmed once emptied,
   * frosted over if the ice took it.
   */
  private drawLandmark(root: Container, e: Building): void {
    if (!knowsLandmark(e.id)) return;
    const scale = LANDMARK_SCALE[e.def] ?? 1.2;
    const s = new Sprite(this.tex.building(e.def));
    s.anchor.set(0.5, e.def === 'monolith' ? 0.8 : 0.5);
    s.width = s.height = TILE * scale;
    if (e.found && e.found < 0) s.tint = 0xc8dcf0;
    else if (e.found) s.tint = 0x9a948c;
    root.addChild(s);
    if (!visitedLandmark(e.id) && !(e.found && !LANDMARKS[e.def as LandmarkKind]?.lasting)) {
      const y = -TILE * scale * 0.55 - 6;
      root.addChild(
        this.shape(`lm-mark:${y}`, (g) =>
          g
            .poly([0, y - 6, 5, y, 0, y + 6, -5, y])
            .fill({ color: 0xff9a3c, alpha: 0.95 })
            .stroke({ width: 1.5, color: 0x3a2410 }),
        ),
      );
    }
    if (e.def === 'hot_spring') this.springs.add(e.id);
  }

  /** A wild animal: its sprite on a shadow, a crosshair when your hunters are after it. */
  private drawAnimal(root: Container, e: Pawn, v: EntityView): void {
    const def = ANIMALS[e.species!];
    const size = TILE * 1.15 * (def?.size ?? 1);
    root.addChild(this.shape(`shadow:${size}`, (g) => g.ellipse(0, TILE * 0.3, size * 0.38, size * 0.12).fill({ color: 0x000000, alpha: 0.3 })));
    // One of a colony's animals wears its colours: a ring at its feet, like a colonist's.
    if (e.tamed) {
      const color = store.mirror.factions.get(e.tamed)?.color ?? 0xffffff;
      root.addChild(this.shape(`tame-ring:${size}:${color}`, (g) => g.ellipse(0, TILE * 0.3, size * 0.36, size * 0.13).stroke({ width: 2, color, alpha: 0.9 })));
    }
    const body = new Sprite(this.tex.animal(e.species!));
    // The ComfyUI sprites stand on the bottom of their frame; the fallback shapes a little higher.
    body.anchor.set(0.5, this.tex.hasArt(`animal_${e.species}`) ? 0.95 : 0.85);
    body.width = body.height = size;
    body.position.y = TILE * 0.32;
    if (e.downed) {
      body.rotation = Math.PI / 2;
      body.tint = 0xd07070;
      v.lying = true;
    }
    const rig = new Container();
    rig.addChild(body);
    root.addChild(rig);
    v.rig = rig;
    v.body = body;
    v.baseTint = body.tint;
    v.animal = true;
    if (e.taming && e.taming === store.me?.faction) {
      // Marked for taming: a small heart, in ember.
      const y = -size * 0.75 - 8;
      root.addChild(
        this.shape(`tame:${y}`, (g) =>
          g
            .circle(-2.6, y - 1.5, 3)
            .circle(2.6, y - 1.5, 3)
            .poly([-5.4, y - 0.5, 5.4, y - 0.5, 0, y + 5.5])
            .fill(0xff9a3c),
        ),
      );
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
      v.lying = true;
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
    if (e.carrying) {
      const load = this.tex.pile(e.carrying.def, e.carrying.count);
      const c = new Sprite(load.texture);
      c.anchor.set(0.5);
      c.width = c.height = TILE * 0.5 * load.scale;
      c.position.set(TILE * 0.3, -TILE * 0.05);
      rig.addChild(c);
    }
    // A raider chief: a brass crown while they lead, and their whole name ("Corvin the Crow").
    const named = f?.raid?.chiefName === e.name || !!e.captive?.chief;
    if (f?.raid?.chief === e.id && !e.drafted) {
      root.addChild(
        this.shape('chief', (g) =>
          g
            .poly([-7, -TILE * 0.7, -7, -TILE * 0.9, -3.5, -TILE * 0.8, 0, -TILE * 0.94, 3.5, -TILE * 0.8, 7, -TILE * 0.9, 7, -TILE * 0.7])
            .fill(0xc9a45c)
            .stroke({ width: 1.2, color: 0x2a1d0c, alpha: 0.9 }),
        ),
      );
    }
    const label = new BitmapText({ text: (named ? e.name : e.name.split(' ')[0]) + (e.prisoner ? ' (prisoner)' : '') + (e.downed ? ' (down)' : e.asleep ? ' z' : ''), style: LABEL_TEXT });
    label.scale.set(this.pawnLabelScale());
    label.anchor.set(0.5, 0);
    label.position.set(0, TILE * 0.42);
    label.visible = this.lod !== 0;
    // Everyone else's people are named in their faction's colour (lightened to stay readable), so
    // yours and theirs tell apart at a glance in a crowd.
    if (e.faction !== store.me?.faction) label.tint = lighten(color, 0.45);
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
    this.drawColonyLabels();
    const steering = this.controlled();
    if (steering) this.drawWatchers(g, steering);
    if (store.me?.faction === 0) {
      this.drawSettleUi(g);
      return;
    }
    this.drawJourney(g);
    if (store.tool.kind === 'moveHome') {
      // Picking a new home: show where other colonies keep their distance, and the spot under the cursor.
      const hc = store.hoverCell;
      store.settlePick = hc === null ? null : { x: hc % m.w, y: Math.floor(hc / m.w) };
      this.drawSettleUi(g, store.me?.faction);
      return;
    }
    const sw = 1 / this.world.scale.x;
    const ui = this.worldUi;
    for (const id of store.squad) {
      if (id === store.selected) continue;
      const v = this.views.get(id);
      if (v) ui.bracket(id, v.root.x, v.root.y, TILE * 0.5, MARK_TINT.own, 0.72);
    }
    // Who your selected fighters are going after.
    for (const id of store.squad) {
      const p = m.get<Pawn>(id);
      const v = this.views.get(id);
      if (!p || !v || p.job?.type !== 'attack') continue;
      const tv = this.views.get(p.job.target);
      if (!tv || !tv.root.visible) continue;
      g.moveTo(v.root.x, v.root.y).lineTo(tv.root.x, tv.root.y).stroke({ width: 1.5 * sw, color: 0xff5040, alpha: 0.45 });
      ui.reticle(-1 - p.job.target, tv.root.x, tv.root.y);
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
      const foe = sel.kind === 'pawn' ? sel.faction !== store.me?.faction && !sel.species && hostile({ factions: m.factions } as unknown as World, store.me?.faction ?? 0, sel.faction) : false;
      ui.bracket(sel.id, x, y, TILE * (sel.kind === 'building' ? (LANDMARK_SCALE[sel.def] ?? 1) * 0.55 : 0.55), foe ? MARK_TINT.foe : sel.kind === 'pawn' && sel.faction === store.me?.faction ? MARK_TINT.own : MARK_TINT.other, 1);
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
      ui.bracket(-2_000_000_000 - c, ((c % m.w) + 0.5) * TILE, (((c / m.w) | 0) + 0.5) * TILE, TILE * 0.5, MARK_TINT.other, 0.8);
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

  /** Other players' colonies: their name over their home, in their colour, with how you stand. */
  private drawColonyLabels(): void {
    const m = store.mirror;
    const me = store.me?.faction ?? 0;
    const z = this.world.scale.x;
    const scale = Math.max(14, Math.min(19, LABEL_STYLE.fontSize * 0.75 * z)) / (LABEL_STYLE.fontSize * z);
    const seen = new Set<number>();
    for (const f of m.factions.values()) {
      if (!f.isPlayer || f.id === me) continue;
      seen.add(f.id);
      let label = this.colonyLabels.get(f.id);
      if (!label) {
        label = new BitmapText({ text: '', style: LABEL_TEXT });
        label.anchor.set(0.5, 1);
        this.layers.ui.addChild(label);
        this.colonyLabels.set(f.id, label);
      }
      const pact = me ? pactOf(m, me, f.id)?.kind : undefined;
      const owner = store.players.find((p) => p.faction === f.id);
      const text = `${f.name}${pact === 'ally' ? ' (ally)' : pact === 'war' ? ' (at war)' : pact === 'truce' ? ' (truce)' : ''}${owner && !owner.connected ? ' · offline' : ''}`;
      if (label.text !== text) label.text = text;
      label.tint = lighten(f.color, 0.3);
      label.scale.set(scale);
      label.position.set((f.home.x + 0.5) * TILE, (f.home.y - 3.2) * TILE);
    }
    for (const [id, label] of this.colonyLabels) {
      if (seen.has(id)) continue;
      label.destroy();
      this.colonyLabels.delete(id);
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

  /** Pawns already down, so each fall shakes the screen once. */
  private felled = new Set<number>();

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
      if (!stale) this.shove(shot, now);
      if (shot.hit && !stale) this.juice.hit(shot.shooter, shot.target, now);
      if (!stale) {
        this.worldUi.struck(shot.shooter, now);
        this.worldUi.struck(shot.target, now);
      }
      if (!stale) {
        const sv = this.views.get(shot.shooter)?.root;
        const wdef = weaponOf(shot.weapon);
        sound.play((m.entities.get(shot.shooter) as Pawn | undefined)?.species ? 'bite' : wdef.melee ? 'melee' : shot.weapon === 'bow' ? 'bow' : 'rifle', sv?.x ?? (shot.sx + 0.5) * TILE, sv?.y ?? (shot.sy + 0.5) * TILE);
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
          // A heavy blow lands on the camera too; ordinary shots don't, or a firefight never stops shaking.
          const heavy = weaponOf(shot.weapon).damage;
          if (heavy >= HEAVY_HIT) this.shakeAt(tv.root.x, tv.root.y, 0.3 + (heavy - HEAVY_HIT));
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
    const t = performance.now() / 120;
    if (settings.details) {
      for (const id of this.hearths) {
        const v = this.views.get(id);
        if (!v || !v.root.parent?.visible) continue;
        const { x, y } = v.root;
        g.circle(x, y + 1, 8 * (0.88 + 0.12 * Math.sin(t + id * 1.7))).fill({ color: 0xff7a20, alpha: 0.26 });
        // Three tongues of flame, licking up at their own pace.
        for (let k = 0; k < 3; k++) {
          const a = k * 2.1 + id;
          const lick = 0.7 + 0.3 * Math.sin(t * 1.6 + a);
          g.ellipse(x + Math.cos(a) * 3, y - 2 - 3 * lick, 2.3, 4.6 * lick).fill({ color: k ? 0xff9a30 : 0xffd060, alpha: 0.8 });
        }
      }
    }
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
    this.precip = kind;
    // Looking out over frozen ground: it's always snowing out there.
    const m = store.mirror;
    const c = this.screenToCell(this.app.screen.width / 2, this.app.screen.height / 2);
    const frozenView = m.w ? frostLevel(c.x, c.y, m.w, m.h, frostRadius(tick, m.frost)) : 0;
    if (kind === 'none' && frozenView > 0.5) {
      kind = 'snow';
      wind = 0.6;
    }
    sound.world(tick, kind, wind);
    this.weather.update(dt, kind, this.app.screen.width, this.app.screen.height, wind, WEATHER_DENSITY[settings.weather]);
  }

  /** Time of day: colour grade and night light, then sun shadows and ambient life that follow it. */
  private drawLight(tick: number, now: number, dt: number): void {
    const m = store.mirror;
    this.lighting.update(
      {
        tick,
        mirror: m,
        precip: this.precip,
        version: fog.version,
        faction: store.me?.faction,
        pawnCell: (id) => {
          const p = this.views.get(id)?.root;
          return p ? { x: Math.round(p.x / TILE - 0.5), y: Math.round(p.y / TILE - 0.5) } : null;
        },
      },
      this.app.screen.width,
      this.app.screen.height,
    );
    if (settings.shadows) this.shadows.update(m, this.lighting.sun, now, this.pawnIds, this.views);
    else this.shadows.view.visible = false;
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.app.screen.width, this.app.screen.height);
    this.life.view.visible = settings.wildlife;
    if (settings.wildlife) this.life.update(dt, now, { tick, mirror: m, sun: this.lighting.sun, dark: this.lighting.dark, precip: this.precip, x0: a.x * TILE, y0: a.y * TILE, x1: b.x * TILE, y1: b.y * TILE });
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

/** How big each landmark is drawn, in cells. */
const LANDMARK_SCALE: Record<string, number> = { abandoned_camp: 1.6, cairn: 1.2, old_ruin: 1.5, frozen_wreck: 2.6, hot_spring: 1.5, monolith: 1.9 };

/** Your colony has seen this landmark, or heard of it. Spectators see everything. */
function knowsLandmark(id: number): boolean {
  const me = store.me?.faction;
  if (!me) return true;
  return !!store.mirror.factions.get(me)?.seen?.includes(id);
}

function visitedLandmark(id: number): boolean {
  const me = store.me?.faction;
  return !!me && !!store.mirror.factions.get(me)?.visited?.includes(id);
}

function isWall(e: Entity | undefined): boolean {
  if (!e || e.kind !== 'building') return false;
  const d = BUILDINGS[e.def];
  return !!d?.wall && !d.door;
}

/** Mix a colour toward white by `t` (0..1). */
function lighten(c: number, t: number): number {
  const ch = (v: number) => Math.round(v + (255 - v) * t);
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}
