import { Container, Matrix, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import { ANIMALS, BUILDINGS, PLANTS } from '@fe/defs';
import type { Entity } from '@fe/sim';
import type { Mirror } from '@fe/protocol';
import { MapBitmap } from './bitmap';
import type { Sun } from './light';
import type { TextureBank } from './textures';

/**
 * Sun shadows. Everything that stands still (trees, bushes, crops, furniture, walls, mountain
 * edges) is baked into one low-resolution shadow texture covering the whole map, rebaked only when
 * the sun has moved a little or something changed, so a frame costs one sprite however many trees
 * there are. Shadows are drawn with max blending, so where two overlap they don't stack darker.
 * Pawns and animals move, so each gets its own soft shadow sprite, re-aimed when the sun moves.
 * Items on the ground cast nothing.
 */

/** Shadow texture pixels per cell (shadows are soft, so a few is plenty). */
const RES = 4;
const TILE = 32;
/** Caster heights in cells. */
const ROCK_H = 1.5;
const WALL_H = 1.05;
/** Min ms between rebakes when only the sun moved, and when the scene changed. */
const SUN_BAKE_MS = 700;
const CHANGE_BAKE_MS = 200;
/** Sun movement (cells of shadow per cell of height) that triggers a rebake. */
const SUN_EPS = 0.012;

interface Caster {
  sprite: Sprite;
  /** Height in cells, footprint size in world px, opacity, and centre in world px. */
  h: number;
  size: number;
  alpha: number;
  x: number;
  y: number;
  /**
   * Round, blurry casters (plants) are simply rotated to face along the shadow and stretched:
   * three cheap property sets, where a full shear matrix costs a decompose per sprite.
   */
  round: boolean;
}

interface PawnShadow {
  sprite: Sprite;
  /** Frame it was last seen on. */
  seen: number;
  /** Offset of the blob's centre from the view's origin. */
  ox: number;
  oy: number;
  h: number;
  w: number;
  /** Foot offset below the view's origin. */
  foot: number;
}

/** What shadows need of a pawn's view. */
export interface PawnViewLike {
  root: Container;
}

/** Height (cells), opacity, and footprint scale of a building's shadow, or null if it casts none. */
function buildingShadow(def: string): { h: number; alpha: number } | null {
  const d = BUILDINGS[def];
  if (!d || d.floorTerrain || d.wall) return null;
  switch (def) {
    case 'bed':
      return { h: 0.3, alpha: 0.8 };
    case 'campfire':
    case 'crafting_spot':
      return { h: 0.15, alpha: 0.5 };
    case 'chair':
      return { h: 0.45, alpha: 0.75 };
    case 'table':
      return { h: 0.4, alpha: 0.8 };
    case 'sandbags':
      return { h: 0.45, alpha: 0.85 };
    case 'whispering_stone':
      return { h: 1.4, alpha: 0.9 };
    case 'sun_shard':
      return { h: 0.6, alpha: 0.4 };
    default:
      return { h: 0.6, alpha: 0.85 };
  }
}

/** Shadow of a plant: trees tall, bushes low, crops lower still, all scaled by growth. */
function plantShadow(def: string, growth: number): { h: number; alpha: number; size: number } | null {
  const d = PLANTS[def];
  if (!d) return null;
  const g = 0.3 + 0.7 * Math.min(1, growth);
  const size = (d.tree ? 1.5 : 1) * TILE * g;
  if (d.tree) return { h: 1.9 * g, alpha: 0.85, size: size * 0.9 };
  if (d.sowable) return { h: 0.4 * g, alpha: 0.55, size: size * 0.9 };
  return { h: 0.5 * g, alpha: 0.75, size: size * 0.9 };
}

/**
 * Local matrix that stretches a size x size sprite (texture tw x th) along the shadow direction
 * by `len` world px and shifts it half that way, so the blob runs from the caster's foot to where
 * its top's shadow lands.
 */
function shadowMatrix(out: Matrix, sun: Sun, h: number, size: number, cross: number, tw: number, th: number, cx: number, cy: number): Matrix {
  const vx = sun.x * h * TILE;
  const vy = sun.y * h * TILE;
  const len = Math.hypot(vx, vy);
  const ux = len > 1e-6 ? vx / len : 0;
  const uy = len > 1e-6 ? vy / len : 1;
  // Along u: (size + len) / size; across u: `cross`.
  const a = (size + len) / size;
  const b = cross;
  // R(theta) diag(a, b) R(-theta): symmetric stretch along u.
  const m00 = a * ux * ux + b * uy * uy;
  const m11 = a * uy * uy + b * ux * ux;
  const m01 = (a - b) * ux * uy;
  const sx = size / tw;
  const sy = size / th;
  out.a = m00 * sx;
  out.b = m01 * sx;
  out.c = m01 * sy;
  out.d = m11 * sy;
  out.tx = cx + vx / 2;
  out.ty = cy + vy / 2;
  return out;
}

export class Shadows {
  /** Goes in the world above the ground and below everything that casts. */
  readonly view = new Container();
  private rt: RenderTexture | null = null;
  private baked: Sprite | null = null;
  private readonly bake = new Container();
  private readonly casterLayer = new Container();
  private readonly cellLayer = new Container();
  private readonly casters = new Map<number, Caster>();
  /** Wall entities, so one going away repaints the wall mask. */
  private readonly wallIds = new Set<number>();
  private stamp = 0;
  private readonly pawns = new Map<number, PawnShadow>();
  private readonly pawnLayer = new Container();
  private rockMask: MapBitmap | null = null;
  private wallMask: MapBitmap | null = null;
  private eraseMask: MapBitmap | null = null;
  private rockCopies: Sprite[] = [];
  private wallCopies: Sprite[] = [];
  private eraser: Sprite | null = null;
  private soft = new Map<number, Texture>();
  private blob: Texture | null = null;
  private dirty = true;
  private masksDirty = true;
  private lastBake = -1e9;
  private bakedSun: Sun = { x: 0, y: 0, strength: 0 };
  private aimedSun: Sun = { x: 1e9, y: 0, strength: 0 };
  private readonly mat = new Matrix();
  private w = 0;
  private h = 0;
  /** Bakes so far and the last bake's cost in ms (for profiling). */
  bakes = 0;
  bakeMs = 0;

  constructor(
    private renderer: Renderer,
    private tex: TextureBank,
  ) {
    this.bake.addChild(this.casterLayer, this.cellLayer);
    this.bake.scale.set(RES / TILE);
    // Max blending: overlapping shadows take the darker, they don't add up.
    this.casterLayer.blendMode = 'max';
    this.cellLayer.blendMode = 'max';
    this.view.addChild(this.pawnLayer);
  }

  /** Note entities that changed or left, and whether any cells (rock) changed. */
  note(m: Mirror, changed: Iterable<number>, removed: Iterable<number>, cellsChanged: boolean): void {
    for (const id of removed) this.drop(id);
    for (const id of changed) {
      const e = m.entities.get(id);
      if (!e) this.drop(id);
      else this.upsert(e);
    }
    if (cellsChanged) this.masksDirty = true;
  }

  /** Walls changed somewhere (built, destroyed): the wall mask needs repainting. */
  wallsChanged(): void {
    this.masksDirty = true;
  }

  private drop(id: number): void {
    if (this.wallIds.delete(id)) this.masksDirty = true;
    const c = this.casters.get(id);
    if (c) {
      c.sprite.destroy();
      this.casters.delete(id);
      this.dirty = true;
    }
  }

  private upsert(e: Entity): void {
    let spec: { h: number; alpha: number; size: number } | null = null;
    let texture: Texture | null = null;
    if (e.kind === 'plant') {
      spec = plantShadow(e.def, e.growth);
      if (spec) texture = this.tex.plant(e.def);
    } else if (e.kind === 'building') {
      const b = buildingShadow(e.def);
      if (b) {
        spec = { ...b, size: TILE * 0.94 };
        texture = this.tex.building(e.def);
      } else if (BUILDINGS[e.def]?.wall && !this.wallIds.has(e.id)) {
        this.wallIds.add(e.id);
        this.masksDirty = true;
        return;
      }
    }
    if (!spec || !texture) {
      this.drop(e.id);
      return;
    }
    const soft = this.softOf(texture);
    let c = this.casters.get(e.id);
    if (!c) {
      const sprite = new Sprite(soft);
      sprite.anchor.set(0.5);
      sprite.tint = 0x000000;
      this.casterLayer.addChild(sprite);
      c = { sprite, h: 0, size: 0, alpha: 1, x: 0, y: 0, round: e.kind === 'plant' };
      this.casters.set(e.id, c);
    }
    const x = (e.x + 0.5) * TILE;
    const y = (e.y + 0.5) * TILE;
    if (c.sprite.texture === soft && c.h === spec.h && c.size === spec.size && c.x === x && c.y === y) return;
    c.sprite.texture = soft;
    c.h = spec.h;
    c.size = spec.size;
    c.alpha = spec.alpha;
    c.x = x;
    c.y = y;
    c.sprite.alpha = spec.alpha;
    this.aimCaster(c, this.bakedSun);
    this.dirty = true;
  }

  private aimCaster(c: Caster, sun: Sun): void {
    const t = c.sprite.texture;
    if (!c.round) {
      c.sprite.setFromMatrix(shadowMatrix(this.mat, sun, c.h, c.size, 0.9, t.width, t.height, c.x, c.y));
      return;
    }
    const vx = sun.x * c.h * TILE;
    const vy = sun.y * c.h * TILE;
    const s = c.sprite;
    s.position.set(c.x + vx / 2, c.y + vy / 2);
    s.rotation = Math.atan2(vy, vx);
    s.scale.set((c.size + Math.hypot(vx, vy)) / t.width, (c.size * 0.9) / t.height);
  }

  /**
   * A soft black silhouette of a texture, small and blurred: shadows don't need detail, and a
   * blurred copy gives soft edges without a filter pass. Cached per texture.
   */
  private softOf(t: Texture): Texture {
    const hit = this.soft.get(t.uid);
    if (hit) return hit;
    const N = 32;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d')!;
    let src: CanvasImageSource | null = null;
    const r = t.source.resource as unknown;
    if (typeof ImageBitmap !== 'undefined' && r instanceof ImageBitmap) src = r;
    else if (r instanceof HTMLImageElement || r instanceof HTMLCanvasElement) src = r;
    try {
      if (!src) src = this.renderer.extract.canvas(t) as HTMLCanvasElement;
      ctx.filter = 'blur(1.4px)';
      ctx.drawImage(src, 3, 3, N - 6, N - 6);
      ctx.filter = 'none';
    } catch {
      ctx.beginPath();
      ctx.arc(N / 2, N / 2, N / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, N, N);
    const out = Texture.from(c);
    out.source.scaleMode = 'linear';
    this.soft.set(t.uid, out);
    return out;
  }

  /** A soft round blob for pawn and animal shadows. */
  private blobTexture(): Texture {
    if (this.blob) return this.blob;
    const N = 32;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.85)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
    this.blob = Texture.from(c);
    this.blob.source.scaleMode = 'linear';
    return this.blob;
  }

  private setupMap(m: Mirror): void {
    this.w = m.w;
    this.h = m.h;
    this.rt?.destroy(true);
    this.baked?.destroy();
    this.rt = RenderTexture.create({ width: m.w * RES, height: m.h * RES, scaleMode: 'linear', antialias: false });
    this.baked = new Sprite(this.rt);
    this.baked.scale.set(TILE / RES);
    this.view.addChildAt(this.baked, 0);
    for (const mk of [this.rockMask, this.wallMask, this.eraseMask]) mk?.destroy();
    for (const s of [...this.rockCopies, ...this.wallCopies]) s.destroy();
    this.rockCopies = [];
    this.wallCopies = [];
    this.eraser?.destroy();
    this.rockMask = new MapBitmap(m.w, m.h, TILE);
    this.wallMask = new MapBitmap(m.w, m.h, TILE);
    this.eraseMask = new MapBitmap(m.w, m.h, TILE);
    this.eraser = new Sprite(this.eraseMask.texture);
    this.eraser.scale.set(TILE);
    this.eraser.blendMode = 'erase';
    this.bake.addChild(this.eraser);
    this.masksDirty = true;
    this.dirty = true;
  }

  /**
   * Masks of what stands up from the ground, one pixel a cell: mountain rock, walls (with doors),
   * and where no sun shadow may land (on rock and under rock roofs).
   */
  private paintMasks(m: Mirror): void {
    const n = m.w * m.h;
    const rock = this.rockMask!.data;
    const wall = this.wallMask!.data;
    const erase = this.eraseMask!.data;
    rock.fill(0);
    wall.fill(0);
    erase.fill(0);
    const roof = (m as Mirror & { roof?: Uint8Array }).roof;
    for (let i = 0; i < n; i++) {
      if (m.rock[i]) {
        rock[i * 4 + 3] = 255;
        erase[i * 4 + 3] = 255;
      } else if (roof && roof[i]) erase[i * 4 + 3] = 255;
      const b = m.buildingAt[i];
      if (b) {
        const e = m.entities.get(b);
        if (e && e.kind === 'building' && BUILDINGS[e.def]?.wall) wall[i * 4 + 3] = 255;
      }
    }
    this.rockMask!.update();
    this.wallMask!.update();
    this.eraseMask!.update();
    this.masksDirty = false;
    this.dirty = true;
  }

  /** Lay copies of a mask along the shadow, a quarter cell apart, so the mask sweeps out its shadow. */
  private sweep(copies: Sprite[], mask: MapBitmap, sun: Sun, h: number): void {
    const vx = sun.x * h;
    const vy = sun.y * h;
    const steps = Math.max(1, Math.min(24, Math.ceil(Math.hypot(vx, vy) * 4)));
    while (copies.length < steps) {
      const s = new Sprite(mask.texture);
      s.scale.set(TILE);
      s.tint = 0x000000;
      this.cellLayer.addChild(s);
      copies.push(s);
    }
    for (let k = 0; k < copies.length; k++) {
      const s = copies[k];
      s.visible = k < steps;
      s.texture = mask.texture;
      const f = (k + 1) / steps;
      s.position.set(vx * f * TILE, vy * f * TILE);
    }
  }

  /** Per frame: fade with the sun, rebake when it has moved or the scene changed, and follow pawns. */
  update(m: Mirror, sun: Sun, now: number, pawnIds: Iterable<number>, views: Map<number, PawnViewLike>): void {
    if (!m.w) return;
    if (m.w !== this.w || m.h !== this.h) this.setupMap(m);
    const visible = sun.strength > 0.004;
    this.view.visible = visible;
    this.view.alpha = sun.strength;
    if (!visible) return;
    const drift = Math.abs(sun.x - this.bakedSun.x) + Math.abs(sun.y - this.bakedSun.y);
    if (this.masksDirty) this.paintMasks(m);
    const since = now - this.lastBake;
    // A jump (joining, or time skipped) rebakes at once; the sun's slow drift at most every SUN_BAKE_MS.
    if (drift > 0.15 || (drift > SUN_EPS && since >= SUN_BAKE_MS) || (this.dirty && since >= CHANGE_BAKE_MS)) this.render(sun, now);
    this.followPawns(m, sun, pawnIds, views);
  }

  private render(sun: Sun, now: number): void {
    const t0 = performance.now();
    if (Math.abs(sun.x - this.bakedSun.x) + Math.abs(sun.y - this.bakedSun.y) > 1e-6) {
      for (const c of this.casters.values()) this.aimCaster(c, sun);
    }
    this.bakedSun = { ...sun };
    this.sweep(this.rockCopies, this.rockMask!, sun, ROCK_H);
    this.sweep(this.wallCopies, this.wallMask!, sun, WALL_H);
    this.renderer.render({ container: this.bake, target: this.rt!, clear: true, clearColor: [0, 0, 0, 0] });
    this.dirty = false;
    this.lastBake = now;
    this.bakes++;
    this.bakeMs = performance.now() - t0;
  }

  /** Pawn and animal shadows sit under trees and walls like the baked ones, following their views. */
  private followPawns(m: Mirror, sun: Sun, pawnIds: Iterable<number>, views: Map<number, PawnViewLike>): void {
    const reaim = Math.abs(sun.x - this.aimedSun.x) + Math.abs(sun.y - this.aimedSun.y) > 0.004;
    if (reaim) this.aimedSun = { ...sun };
    const stamp = ++this.stamp;
    for (const id of pawnIds) {
      const v = views.get(id);
      const e = m.entities.get(id);
      if (!v || !e || e.kind !== 'pawn') continue;
      const lying = e.asleep || e.downed;
      const size = e.species ? (ANIMALS[e.species]?.size ?? 1) : 1;
      const h = (e.species ? 0.55 : 0.95) * size * (lying ? 0.3 : 1);
      const w = (e.species ? 0.7 : 0.5) * size * TILE;
      let p = this.pawns.get(id);
      if (!p || p.h !== h || p.w !== w) {
        if (!p) {
          const sprite = new Sprite(this.blobTexture());
          sprite.anchor.set(0.5);
          this.pawnLayer.addChild(sprite);
          p = { sprite, h, w, foot: TILE * 0.3, seen: stamp, ox: 0, oy: 0 };
          this.pawns.set(id, p);
        }
        p.h = h;
        p.w = w;
        this.aimPawn(p, sun);
      } else if (reaim) this.aimPawn(p, sun);
      p.seen = stamp;
      const s = p.sprite;
      s.position.set(v.root.x + p.ox, v.root.y + p.oy);
      s.visible = v.root.visible && v.root.alpha > 0.05;
    }
    for (const [id, p] of this.pawns) {
      if (p.seen !== stamp) {
        p.sprite.destroy();
        this.pawns.delete(id);
      }
    }
  }

  private aimPawn(p: PawnShadow, sun: Sun): void {
    const t = p.sprite.texture;
    // A pawn is a tall narrow thing: its shadow is a stretched blob from the feet.
    shadowMatrix(this.mat, sun, p.h, p.w, 0.55, t.width, t.height, 0, p.foot);
    p.ox = this.mat.tx;
    p.oy = this.mat.ty;
    this.mat.tx = 0;
    this.mat.ty = 0;
    p.sprite.setFromMatrix(this.mat);
  }

  destroy(): void {
    this.rt?.destroy(true);
    for (const mk of [this.rockMask, this.wallMask, this.eraseMask]) mk?.destroy();
    for (const t of this.soft.values()) t.destroy(true);
    this.blob?.destroy(true);
    this.bake.destroy({ children: true });
    this.view.destroy({ children: true });
  }
}
