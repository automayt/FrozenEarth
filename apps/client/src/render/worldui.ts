import { Container, Sprite, type Texture } from 'pixi.js';
import { PLANTS, RECIPES, ROCKS, skillSpeed, type SkillKey } from '@fe/defs';
import type { Mirror } from '@fe/protocol';
import { bleedRate, constructCost, constructWork, DESIG, woundTotal, type Construct, type Job, type Pawn } from '@fe/sim';
import { cameraSettings } from './cameraSettings';
import { ease } from './fx';
import { ATLAS_RES, RETICLE_PX, RING_PX, RING_STEPS, TAG_PX, worldAtlas, type WorldAtlas } from './worldAtlas';

/**
 * Information on the map itself rather than in a panel: health bars, what a colonist is doing, how
 * far along the work is, what's selected and what's being shot at. All of it is pooled sprites from
 * one atlas (render/worldAtlas.ts) in their own render group, so a frame only moves and tints them;
 * nothing is tessellated, off-screen pawns cost a bounds check, and what a pawn "remembers" (when
 * it was last hurt, how far its work has got) changes only when the server says something changed.
 * Marks are sized in screen pixels, so they read the same at every zoom.
 */

const TILE = 32;

// ---------------------------------------------------------------- tuning knobs

/** How long a health bar stays after the last blow, and how long it takes to fade. */
export const BAR_HOLD_MS = 3200;
export const BAR_FADE_MS = 900;
/** Wounds below this don't count as hurt. */
const HURT_MIN = 0.02;
/** How fast the pale trail on a health bar catches up. */
const GHOST_EASE_MS = 420;
/** Job tags show on everyone from this zoom in. */
export const TAG_ZOOM = 1.3;
/** Below this zoom tags show only on the pawn under the cursor or the main selection. */
export const TAG_FAR = 0.42;
/** Designation markers show from this zoom in; further out, the painted corners carry it. */
export const DESIG_ZOOM = 0.42;
const DESIG_MAX = 260;
const DESIG_SCAN_MS = 250;
/** Rings on idle blueprints go at this zoom out; rings with someone working stay. */
export const RING_ZOOM = 0.3;
/** How long a new bracket takes to close in, and a new reticle to lock on. */
export const SETTLE_MS = 190;
export const LOCK_MS = 240;
/** One turn of a locked reticle. */
const RETICLE_TURN_MS = 9000;

const TALLOW = 0xeadfc8;
const BRASS = 0xc9a45c;
const EMBER = 0xff9a3c;
const RIME = 0xc3e4f3;
const HOSTILE = 0xff6a4a;
const SOOT = 0x11151d;
const HP_GOOD = 0x8fcf6a;
const HP_MID = 0xe8b83c;
const HP_LOW = 0xe85a3c;
const HP_BLEED = 0xff4848;
const HP_TRAIL = 0xfff0d8;

/** Screen size of a mark: its natural size at this zoom, held between min and max pixels. */
export const screenSize = (world: number, scale: number, min: number, max: number) => Math.max(min, Math.min(max, world * scale));

/** Share of the way from 0..1 a health bar's alpha is, given how long since the last blow. */
export function barAlpha(age: number): number {
  if (age <= BAR_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - BAR_HOLD_MS) / BAR_FADE_MS);
}

/** Colour of what's left of someone's health. */
export function barColor(left: number, bleeding: boolean): number {
  return bleeding ? HP_BLEED : left > 0.6 ? HP_GOOD : left > 0.3 ? HP_MID : HP_LOW;
}

/**
 * How far along a job is. The server only sends a job when its pawn changes, not every tick of
 * work, so between updates the ring runs on from the last figure at the rate the pawn works.
 */
export function workShare(base: number, sinceTicks: number, rate: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(0.99, (base + sinceTicks * rate) / total)) : 0;
}

/** The ring frame for a share done. */
export const ringStep = (share: number) => Math.max(0, Math.min(RING_STEPS, Math.round(share * RING_STEPS)));

/** The tag for a job. Idling and wandering have none. */
export function jobTag(j: Job | null): string | null {
  switch (j?.type) {
    case 'build':
    case 'repair':
    case 'bash':
      return 'build';
    case 'mine':
      return 'mine';
    case 'cut':
      return j.harvest ? 'plant' : 'chop';
    case 'sow':
      return 'plant';
    case 'haul':
    case 'deliver':
      return 'haul';
    case 'eat':
    case 'feed':
      return 'eat';
    case 'sleep':
      return 'sleep';
    case 'attack':
    case 'equip':
      return 'fight';
    case 'tend':
    case 'rescue':
      return 'tend';
    case 'bill':
      return 'craft';
    case 'extinguish':
    case 'ignite':
      return 'fire';
    case 'tame':
      return 'tame';
    case 'shelter':
    case 'flee':
    case 'hold':
      return 'flee';
    case 'trek':
      return 'trek';
    case 'goto':
    case 'warm':
      return 'walk';
    default:
      return null;
  }
}

/** Skill a working pawn gets faster with. */
const WORK_SKILL: Partial<Record<Job['type'], SkillKey>> = { mine: 'mining', cut: 'plants' };

/** Ticks one try at taming takes (taming.ts); there's no figure to show, so the ring counts tries. */
const TAME_TRY_TICKS = 400;

interface Memo {
  hurt: number;
  bleeding: boolean;
  /** Last time it was hurt or in a fight. */
  touched: number;
  /** The pale trail: where the bar was. */
  ghost: number;
  /** The job the ring is running for, and the last figure the server gave for it. */
  work: number;
  sent: number;
  base: number;
  baseTick: number;
  rate: number;
}

interface Site {
  x: number;
  y: number;
  /** Share done, of materials if not ready, of building once they're all there. */
  share: number;
  shown: number;
  ready: boolean;
}

/** Sprites of one kind, hidden when a frame doesn't use them. */
class Pool {
  readonly view = new Container();
  private all: Sprite[] = [];
  private n = 0;
  private lit = 0;

  constructor(
    private readonly tex: Texture,
    private readonly ax = 0.5,
    private readonly ay = 0.5,
  ) {}

  begin(): void {
    this.n = 0;
  }

  next(): Sprite {
    let s = this.all[this.n];
    if (!s) {
      s = new Sprite(this.tex);
      s.anchor.set(this.ax, this.ay);
      this.all.push(s);
      this.view.addChild(s);
    }
    this.n++;
    if (this.n > this.lit) s.visible = true;
    return s;
  }

  end(): void {
    for (let i = this.n; i < this.lit; i++) this.all[i].visible = false;
    this.lit = this.n;
  }
}

export class WorldUi {
  readonly view = new Container();
  private a: WorldAtlas | null = null;
  private pools: Pool[] = [];
  private back!: Pool;
  private trail!: Pool;
  private fill!: Pool;
  private tags!: Pool;
  private rings!: Pool;
  private corners!: Pool;
  private reticles!: Pool;
  private desigs!: Pool;
  private memo = new Map<number, Memo>();
  private sites = new Map<number, Site>();
  /** Constructs being worked on this frame: their rings stay whatever the zoom. */
  private busySites = new Set<number>();
  /** When each bracket and reticle first showed. */
  private born = new Map<number, number>();
  private live = new Set<number>();
  private ringDone = new Set<number>();
  private squad = new Set<number>();
  private squadFrom: number[] | null = null;
  private desigCells: { x: number; y: number; cell: number; tag: string; tint: number }[] = [];
  private desigAt = 0;
  private desigKey = '';
  private desigDirty = true;
  // Frame state.
  private now = 0;
  private dt = 16;
  private tick = 0;
  private me = 0;
  private s = 1;
  private calm = false;
  private m!: Mirror;
  private x0 = 0;
  private y0 = 0;
  private x1 = 0;
  private y1 = 0;
  private hoverX = -1e9;
  private hoverY = -1e9;

  constructor() {
    this.view.isRenderGroup = true;
  }

  /** Atlas and pools, made on first use so nothing touches the canvas before the app exists. */
  private setup(): void {
    const a = (this.a = worldAtlas());
    const pool = (t: Texture, ax = 0.5, ay = 0.5) => {
      const p = new Pool(t, ax, ay);
      this.pools.push(p);
      this.view.addChild(p.view);
      return p;
    };
    this.desigs = pool(a.bare.mine);
    this.rings = pool(a.ring[0]);
    this.back = pool(a.px, 0, 0);
    this.trail = pool(a.px, 0, 0);
    this.fill = pool(a.px, 0, 0);
    this.tags = pool(a.tag.walk);
    this.corners = pool(a.corner, 0, 0);
    this.reticles = pool(a.reticle);
  }

  /** Take in what changed this frame: wounds on pawns, progress on constructs. */
  note(m: Mirror, changed: Set<number>, removed: Set<number>, now: number): void {
    for (const id of removed) {
      this.memo.delete(id);
      this.sites.delete(id);
      this.born.delete(id);
    }
    for (const id of changed) {
      const e = m.entities.get(id);
      if (!e) continue;
      if (e.kind === 'pawn') {
        const hurt = woundTotal(e);
        const memo = this.memo.get(id);
        if (!memo) {
          this.memo.set(id, { hurt, bleeding: bleedRate(e) > 0, touched: -Infinity, ghost: 1 - hurt, work: -1, sent: 0, base: 0, baseTick: 0, rate: 1 });
          continue;
        }
        if (hurt > memo.hurt + 0.001) memo.touched = now;
        memo.hurt = hurt;
        memo.bleeding = bleedRate(e) > 0;
      } else if (e.kind === 'construct') this.noteSite(e);
    }
    if (m.changedCells.size) this.desigDirty = true;
  }

  private noteSite(e: Construct): void {
    const need = Object.values(constructCost(e)).reduce((a, b) => a + b, 0);
    const got = Object.values(e.delivered).reduce((a, b) => a + b, 0);
    const ready = got >= need;
    const share = ready ? e.progress / constructWork(e) : need ? got / need : 0;
    if (share <= 0) {
      this.sites.delete(e.id);
      return;
    }
    const old = this.sites.get(e.id);
    if (old) {
      // Going from fetching materials to building starts the ring over.
      if (old.ready !== ready) old.shown = 0;
      old.share = share;
      old.ready = ready;
    } else this.sites.set(e.id, { x: (e.x + 0.5) * TILE, y: (e.y + 0.5) * TILE, share, shown: share, ready });
  }

  /** A blow landed, or was struck: both sides are in a fight. */
  struck(id: number, now: number): void {
    const memo = this.memo.get(id);
    if (memo) memo.touched = now;
  }

  begin(m: Mirror, me: number, now: number, dt: number, tick: number, scale: number, view: { x0: number; y0: number; x1: number; y1: number }, hover: number | null, squad: number[]): void {
    if (!this.a) this.setup();
    for (const p of this.pools) p.begin();
    this.m = m;
    this.me = me;
    this.now = now;
    this.dt = dt;
    this.tick = tick;
    this.s = scale;
    this.calm = cameraSettings.REDUCED_MOTION;
    // A little past the view, so tall marks don't pop at the edge.
    this.x0 = view.x0 * TILE - TILE;
    this.y0 = view.y0 * TILE - TILE;
    this.x1 = view.x1 * TILE + TILE;
    this.y1 = view.y1 * TILE + TILE * 2;
    this.hoverX = hover === null ? -1e9 : ((hover % m.w) + 0.5) * TILE;
    this.hoverY = hover === null ? -1e9 : (((hover / m.w) | 0) + 0.5) * TILE;
    if (squad !== this.squadFrom) {
      this.squadFrom = squad;
      this.squad.clear();
      for (const id of squad) this.squad.add(id);
    }
    this.busySites.clear();
    this.ringDone.clear();
    this.live.clear();
  }

  /** One pawn, where it's drawn. `work` is the cell it's standing and working at, if any. */
  pawn(e: Pawn, x: number, y: number, visible: boolean, selected: boolean, work: number | null): void {
    if (!visible || x < this.x0 || x > this.x1 || y < this.y0 || y > this.y1) return;
    const memo = this.memo.get(e.id);
    if (!memo) return;
    const hovered = Math.abs(x - this.hoverX) < TILE * 0.8 && Math.abs(y - this.hoverY) < TILE * 0.8;
    const noticed = hovered || selected || this.squad.has(e.id);
    const hurt = memo.hurt > HURT_MIN || !!e.downed;
    if (e.job?.type === 'attack') memo.touched = this.now;
    const alpha = (hurt && (noticed || e.downed || memo.bleeding)) || (e.job?.type === 'attack' && !e.species) ? 1 : barAlpha(this.now - memo.touched);
    if (alpha > 0) this.bar(memo, x, y, alpha);
    else memo.ghost = 1 - memo.hurt;
    const mine = e.faction === this.me;
    // Zoomed far out a tag is as wide as three pawns: only the one you're pointing at gets one.
    if (!e.species && (this.s >= TAG_FAR ? noticed || (mine && this.s >= TAG_ZOOM) : hovered || selected)) {
      const tag = jobTag(e.job);
      if (tag) this.tag(tag, x, y);
    }
    if (mine) this.workRing(e, memo, work);
  }

  private bar(memo: Memo, x: number, y: number, alpha: number): void {
    const s = this.s;
    const left = Math.max(0, 1 - memo.hurt);
    // Trails the health down, and jumps back up with it.
    memo.ghost = left >= memo.ghost ? left : left + (memo.ghost - left) * Math.exp(-this.dt / GHOST_EASE_MS);
    const w = screenSize(TILE * 0.8, s, 20, 34);
    const h = s >= 1 ? 4 : 3;
    const bx = x - w / 2 / s;
    const by = y - Math.max(TILE * 0.72, 16 / s);
    const paint = (sp: Sprite, px: number, py: number, pw: number, ph: number, tint: number, a: number) => {
      sp.position.set(px, py);
      // The block is 4 px, at ATLAS_RES.
      sp.scale.set(pw / (4 * ATLAS_RES) / s, ph / (4 * ATLAS_RES) / s);
      sp.tint = tint;
      sp.alpha = a;
    };
    paint(this.back.next(), bx - 1 / s, by - 1 / s, w + 2, h + 2, SOOT, alpha * 0.9);
    if (memo.ghost > left + 0.005) paint(this.trail.next(), bx, by, w * memo.ghost, h, HP_TRAIL, alpha * 0.9);
    if (left > 0) paint(this.fill.next(), bx, by, w * left, h, barColor(left, memo.bleeding), alpha);
  }

  private tag(key: string, x: number, y: number): void {
    const s = this.s;
    const t = this.tags.next();
    const tex = this.a!.tag[key];
    if (t.texture !== tex) t.texture = tex;
    // Sharpest near its drawn size; a touch larger close up.
    const px = screenSize(TILE * 0.56, s, TAG_PX * 0.86, TAG_PX * 1.15);
    t.scale.set(px / TAG_PX / ATLAS_RES / s);
    // Beside where the health bar goes, so the two never overlap.
    const barW = screenSize(TILE * 0.8, s, 20, 34);
    t.position.set(x + Math.max(TILE * 0.5, (barW / 2 + 12) / s), y - Math.max(TILE * 0.66, 14 / s));
  }

  /** The ring on what a colonist is working at. */
  private workRing(e: Pawn, memo: Memo, work: number | null): void {
    const j = e.job;
    if (!j) return;
    const m = this.m;
    if (j.type === 'tame' && !e.path) {
      const a = m.entities.get(j.target);
      if (!a || Math.max(Math.abs(a.x - e.x), Math.abs(a.y - e.y)) > 1) return;
      const code = j.target * 8 + 7;
      if (memo.work !== code) {
        memo.work = code;
        memo.baseTick = this.tick;
      }
      const k = ((this.tick - memo.baseTick) % TAME_TRY_TICKS) / TAME_TRY_TICKS;
      this.ring(-1 - a.id, (a.x + 0.5) * TILE, (a.y + 0.5) * TILE, k, EMBER);
      return;
    }
    if (work === null) return;
    let total = 0;
    let progress = 0;
    let skill: SkillKey | undefined = WORK_SKILL[j.type];
    switch (j.type) {
      case 'build':
        this.busySites.add(j.target);
        return;
      case 'mine':
        total = ROCKS[m.rock[j.cell]]?.mineWork ?? 0;
        progress = j.progress;
        break;
      case 'cut': {
        const p = m.entities.get(j.target);
        total = p?.kind === 'plant' ? (PLANTS[p.def]?.work ?? 0) : 0;
        progress = j.progress;
        break;
      }
      case 'bill': {
        const b = m.entities.get(j.bench);
        const bill = b?.kind === 'building' ? b.bills?.find((x) => x.id === j.bill) : undefined;
        const r = bill ? RECIPES[bill.recipe] : undefined;
        total = r?.work ?? 0;
        progress = j.progress;
        skill = r?.workType === 'cook' ? 'cooking' : 'crafting';
        break;
      }
      default:
        return;
    }
    if (!total) return;
    const code = work * 8 + (j.type === 'mine' ? 1 : j.type === 'cut' ? 2 : 3);
    if (memo.work !== code || memo.sent !== progress) {
      memo.work = code;
      memo.sent = progress;
      memo.base = progress;
      memo.baseTick = this.tick;
      memo.rate = (skill ? skillSpeed(e.skills[skill]?.level ?? 0) : 1) * (e.needs.mood < 0.2 ? 0.8 : 1) * (e.needs.rest < 0.1 ? 0.8 : 1);
    }
    this.ring(work, ((work % m.w) + 0.5) * TILE, (Math.floor(work / m.w) + 0.5) * TILE, workShare(memo.base, this.tick - memo.baseTick, memo.rate, total), BRASS);
  }

  /** A ring around a spot on the map. `key` keeps two workers on one thing to one ring. */
  private ring(key: number, x: number, y: number, share: number, tint: number): void {
    if (this.ringDone.has(key)) return;
    this.ringDone.add(key);
    const r = this.rings.next();
    const tex = this.a!.ring[ringStep(share)];
    if (r.texture !== tex) r.texture = tex;
    const px = screenSize(TILE * 0.9, this.s, 20, 34);
    r.scale.set(px / RING_PX / ATLAS_RES / this.s);
    r.position.set(x, y);
    r.tint = tint;
    r.alpha = 0.95;
  }

  /** Corner brackets around a point, closing in with a small overshoot when new. `half` is in world units. */
  bracket(key: number, x: number, y: number, half: number, tint: number, alpha: number): void {
    const s = this.s;
    this.live.add(key);
    let born = this.born.get(key);
    if (born === undefined) {
      born = this.now;
      this.born.set(key, born);
    }
    const k = (this.now - born) / SETTLE_MS;
    const open = k >= 1 || this.calm ? 0 : 1 - ease.outBack(k);
    // Far out, neighbours are only a few pixels apart: the brackets draw in rather than overlap.
    const fine = Math.max(0.6, Math.min(1, 0.5 + s * 0.8));
    const r = (Math.max(half * s, 15 * fine) * (1 + open * 0.55)) / s;
    const size = fine / ATLAS_RES / s;
    const a = alpha * (k >= 1 || this.calm ? 1 : Math.min(1, 0.4 + k));
    for (let q = 0; q < 4; q++) {
      const c = this.corners.next();
      const sx = q === 1 || q === 2 ? -1 : 1;
      const sy = q >= 2 ? -1 : 1;
      c.position.set(x - sx * r, y - sy * r);
      c.scale.set(sx * size, sy * size);
      c.tint = tint;
      c.alpha = a;
    }
  }

  /** A target reticle: spins in and locks on when new, then turns slowly. */
  reticle(key: number, x: number, y: number): void {
    const s = this.s;
    this.live.add(key);
    let born = this.born.get(key);
    if (born === undefined) {
      born = this.now;
      this.born.set(key, born);
    }
    const k = Math.min(1, (this.now - born) / LOCK_MS);
    const r = this.reticles.next();
    const px = screenSize(TILE * 1.25, s, 30, 50);
    const lock = this.calm ? 1 : ease.outQuad(k);
    r.scale.set((px / RETICLE_PX / ATLAS_RES / s) * (1 + (1 - lock) * 0.9));
    r.rotation = this.calm ? 0 : ((this.now - born) / RETICLE_TURN_MS) * Math.PI * 2 - (1 - lock) * 1.4;
    r.position.set(x, y);
    r.tint = HOSTILE;
    r.alpha = Math.min(1, 0.3 + k);
  }

  /** Designations in view get a small marker of what's wanted there, breathing in a slow wave across the job. */
  private drawDesigs(me: number): void {
    const m = this.m;
    const s = this.s;
    if (s < DESIG_ZOOM) return;
    const a = this.a!;
    const key = `${Math.floor(this.x0 / TILE)},${Math.floor(this.y0 / TILE)},${Math.ceil(this.x1 / TILE)},${Math.ceil(this.y1 / TILE)}`;
    if (key !== this.desigKey || (this.desigDirty && this.now - this.desigAt > DESIG_SCAN_MS)) {
      this.desigKey = key;
      this.desigDirty = false;
      this.desigAt = this.now;
      const list = this.desigCells;
      list.length = 0;
      const y1 = Math.min(m.h - 1, Math.ceil(this.y1 / TILE));
      const x1 = Math.min(m.w - 1, Math.ceil(this.x1 / TILE));
      for (let y = Math.max(0, Math.floor(this.y0 / TILE)); y <= y1 && list.length < DESIG_MAX; y++) {
        for (let x = Math.max(0, Math.floor(this.x0 / TILE)); x <= x1 && list.length < DESIG_MAX; x++) {
          const c = y * m.w + x;
          const d = m.desig[c];
          if (!d || (d === DESIG.steal && m.desigFaction[c] !== me)) continue;
          list.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, cell: x + y, tag: d === DESIG.mine ? 'mine' : d === DESIG.cut ? 'chop' : d === DESIG.steal ? 'steal' : 'plant', tint: d === DESIG.mine ? 0xf0b43c : d === DESIG.cut ? 0xf07050 : d === DESIG.steal ? 0xd8a0ff : 0x9ae070 });
        }
      }
    }
    const t = this.now / 1000;
    const size = screenSize(TILE * 0.5, s, 11, 20) / 16 / ATLAS_RES / s;
    for (const d of this.desigCells) {
      const sp = this.desigs.next();
      const tex = a.bare[d.tag];
      if (sp.texture !== tex) sp.texture = tex;
      const wave = this.calm ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.4 - d.cell * 0.55);
      sp.position.set(d.x, d.y);
      sp.scale.set(size * (0.92 + 0.12 * wave));
      sp.tint = d.tint;
      sp.alpha = 0.5 + 0.42 * wave;
    }
  }

  end(): void {
    // Rings on building sites in view.
    const s = this.s;
    for (const [id, site] of this.sites) {
      const busy = this.busySites.has(id);
      // Smooth the steps between the tenths the server reports.
      site.shown += (site.share - site.shown) * (1 - Math.exp(-this.dt / 240));
      if (!busy && s < RING_ZOOM) continue;
      if (site.x < this.x0 || site.x > this.x1 || site.y < this.y0 || site.y > this.y1) continue;
      this.ring(-id, site.x, site.y, site.shown, site.ready ? BRASS : RIME);
    }
    this.drawDesigs(this.me);
    for (const p of this.pools) p.end();
    for (const k of this.born.keys()) if (!this.live.has(k)) this.born.delete(k);
  }
}

export const MARK_TINT = { own: TALLOW, foe: HOSTILE, other: RIME, ember: EMBER };
