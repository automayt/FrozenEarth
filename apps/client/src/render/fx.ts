import { Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Purely visual effects: particles, tweens and weather. Nothing here touches game state,
 * so it can use wall-clock time and Math.random freely.
 */

export const ease = {
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inQuad: (t: number) => t * t,
  outBack: (t: number) => {
    const c = 1.9;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
};

const enum Shape {
  Dot,
  Chip,
  Zed,
}

/**
 * One small atlas of white shapes every particle and weather drop is drawn from, tinted per
 * particle: a soft dot, a chip (a 2:1 diamond), a sleeper's "z" and a rain streak. Sprites from a
 * shared texture cost the same however many there are, where the old Graphics re-tessellated
 * every circle and stroked "z" each frame.
 */
interface Atlas {
  dot: Texture;
  chip: Texture;
  zed: Texture;
  streak: Texture;
}

let atlas: Atlas | null = null;

function getAtlas(): Atlas {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  // Dot: radius 7 in a 16 x 16 cell.
  g.beginPath();
  g.arc(8, 8, 7, 0, Math.PI * 2);
  g.fill();
  // Chip: diamond 16 wide, 8 tall.
  g.beginPath();
  g.moveTo(18, 8);
  g.lineTo(26, 4);
  g.lineTo(34, 8);
  g.lineTo(26, 12);
  g.closePath();
  g.fill();
  // "z": spans 10 px, stroke 2.5.
  g.lineWidth = 2.5;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(39, 3);
  g.lineTo(49, 3);
  g.lineTo(39, 13);
  g.lineTo(49, 13);
  g.stroke();
  // Streak: 2 x 16.
  g.fillRect(55, 0, 2, 16);
  const source = Texture.from(c).source;
  source.scaleMode = 'linear';
  const at = (x: number, y: number, w: number, h: number) => new Texture({ source, frame: new Rectangle(x, y, w, h) });
  atlas = { dot: at(0, 0, 16, 16), chip: at(18, 4, 16, 8), zed: at(36, 0, 16, 16), streak: at(55, 0, 2, 16) };
  return atlas;
}

/** Atlas texels per world unit of each shape's size, so scale = size / these. */
const DOT_R = 7;
const CHIP_HALF = 8;
const ZED_HALF = 5;

/** 0xRRGGBB to the 0xBBGGRR a particle's packed colour wants. */
function bgr(c: number): number {
  return ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
}

class Spark extends Particle {
  vx = 0;
  vy = 0;
  /** Age and lifetime in ms. */
  age = 0;
  life = 1;
  size = 1;
  grow = 0;
  bgr = 0xffffff;
  alpha0 = 1;
  gravity = 0;
  drag = 0;
  spin = 0;
  angle = 0;
  shape: Shape = Shape.Dot;
}

export interface BurstOptions {
  count: number;
  color: number | number[];
  /** Pixels per second. */
  speed: number;
  size: number;
  life: number;
  gravity?: number;
  drag?: number;
  /** Extra upward push, pixels per second. */
  lift?: number;
  /** Size change per second (smoke grows). */
  grow?: number;
  alpha?: number;
  /** Radians the burst is centred on, and how wide it spreads. Full circle by default. */
  angle?: number;
  spread?: number;
  chips?: boolean;
}

/** A pooled particle system: tinted sprites from one atlas in a ParticleContainer. */
export class Particles {
  readonly view: ParticleContainer;
  private live: Spark[];
  private pool: Spark[] = [];
  private static MAX = 1600;

  constructor() {
    const a = getAtlas();
    this.view = new ParticleContainer({ texture: a.dot, dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true } });
    this.live = this.view.particleChildren as Spark[];
  }

  private spawn(shape: Shape, x: number, y: number): Spark | null {
    if (this.live.length >= Particles.MAX) return null;
    const a = getAtlas();
    const p = this.pool.pop() ?? new Spark(a.dot);
    p.texture = shape === Shape.Chip ? a.chip : shape === Shape.Zed ? a.zed : a.dot;
    p.anchorX = p.anchorY = 0.5;
    p.shape = shape;
    p.x = x;
    p.y = y;
    p.age = 0;
    p.rotation = 0;
    this.live.push(p);
    this.view.update();
    return p;
  }

  burst(x: number, y: number, o: BurstOptions): void {
    const colors = Array.isArray(o.color) ? o.color : [o.color];
    for (let k = 0; k < o.count; k++) {
      const p = this.spawn(o.chips ? Shape.Chip : Shape.Dot, x + (Math.random() - 0.5) * 4, y + (Math.random() - 0.5) * 4);
      if (!p) return;
      const a = (o.angle ?? 0) + (Math.random() - 0.5) * (o.spread ?? Math.PI * 2);
      const v = o.speed * (0.4 + Math.random() * 0.8);
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v - (o.lift ?? 0);
      p.life = o.life * (0.7 + Math.random() * 0.6);
      p.size = o.size * (0.6 + Math.random() * 0.8);
      p.grow = o.grow ?? 0;
      p.bgr = bgr(colors[(Math.random() * colors.length) | 0]);
      p.alpha0 = o.alpha ?? 1;
      p.gravity = o.gravity ?? 0;
      p.drag = o.drag ?? 2;
      p.spin = o.chips ? (Math.random() - 0.5) * 14 : 0;
      p.angle = Math.random() * Math.PI;
      this.style(p, 0);
    }
  }

  /** A floating "z" above a sleeper. */
  zed(x: number, y: number): void {
    const p = this.spawn(Shape.Zed, x, y);
    if (!p) return;
    p.vx = 6 + Math.random() * 4;
    p.vy = -14;
    p.life = 1600;
    p.size = 4;
    p.grow = 2;
    p.bgr = bgr(0xe8f0ff);
    p.alpha0 = 0.9;
    p.gravity = 0;
    p.drag = 0;
    p.spin = 0;
    p.angle = 0;
    this.style(p, 0);
  }

  /** Scale, rotation and packed colour from the particle's state. */
  private style(p: Spark, a: number): void {
    const s = p.shape === Shape.Chip ? p.size / CHIP_HALF : p.shape === Shape.Zed ? p.size / ZED_HALF : Math.max(0.3, p.size) / DOT_R;
    p.scaleX = p.scaleY = s;
    p.rotation = p.shape === Shape.Chip ? p.angle : 0;
    p.color = p.bgr + (((Math.max(0, Math.min(1, a)) * 255) | 0) << 24);
  }

  update(dtMs: number): void {
    const dt = Math.min(0.05, dtMs / 1000);
    const live = this.live;
    let w = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      p.age += dtMs;
      if (p.age >= p.life) {
        this.pool.push(p);
        continue;
      }
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.grow * dt;
      p.angle += p.spin * dt;
      const k = p.age / p.life;
      this.style(p, p.alpha0 * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85));
      live[w++] = p;
    }
    if (w !== live.length) {
      live.length = w;
      this.view.update();
    }
  }

  get count(): number {
    return this.live.length;
  }
}

interface Tween {
  t0: number;
  dur: number;
  step: (k: number) => void;
  done?: () => void;
  owner?: { destroyed: boolean };
}

/** Time-based tweens. step(k) gets progress 0..1; done runs once at the end. */
export class Tweens {
  private list: Tween[] = [];

  /**
   * Animate over `dur` ms. With an `owner`, the tween is dropped (without calling `done`) once the
   * owner is destroyed: a view replaced mid pop-in must not be touched after it's gone.
   */
  add(dur: number, step: (k: number) => void, done?: () => void, owner?: { destroyed: boolean }): void {
    this.list.push({ t0: performance.now(), dur, step, done, owner });
    step(0);
  }

  update(now: number): void {
    if (!this.list.length) return;
    const keep: Tween[] = [];
    for (const t of this.list) {
      if (t.owner?.destroyed) continue;
      const k = Math.min(1, (now - t.t0) / t.dur);
      t.step(k);
      if (k < 1) keep.push(t);
      else t.done?.();
    }
    this.list = keep;
  }
}

export type Precip = 'none' | 'rain' | 'storm' | 'snow' | 'blizzard' | 'ash';

class Drop extends Particle {
  z = 1;
  phase = 0;
}

/** Screen-space rain, snow and ash, as sprites. Drops wrap around the screen; density follows the weather. */
export class Weather {
  readonly view: ParticleContainer;
  private drops: Drop[];
  private kind: Precip = 'none';

  constructor() {
    this.view = new ParticleContainer({ texture: getAtlas().dot, dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true } });
    this.drops = this.view.particleChildren as Drop[];
  }

  update(dtMs: number, kind: Precip, w: number, h: number, wind: number): void {
    const want = { none: 0, rain: 260, storm: 520, snow: 160, blizzard: 650, ash: 220 }[kind];
    const drops = this.drops;
    const wet = kind === 'rain' || kind === 'storm';
    const a = getAtlas();
    if (drops.length !== want || kind !== this.kind) {
      while (drops.length < want) {
        const d = new Drop(a.dot);
        d.x = Math.random() * w;
        d.y = Math.random() * h;
        d.z = 0.4 + Math.random() * 0.6;
        d.phase = Math.random() * 6.28;
        drops.push(d);
      }
      if (drops.length > want) drops.length = want;
      // Look (texture, colour, size) only changes with the kind of weather.
      const color = wet ? 0xa8c8e8 : kind === 'ash' ? 0x5a5450 : 0xf4f8ff;
      const alpha = kind === 'storm' ? 0.45 : wet ? 0.35 : kind === 'ash' ? 0.6 : 0.8;
      const packed = bgr(color) + (((alpha * 255) | 0) << 24);
      for (const d of drops) {
        d.texture = wet ? a.streak : a.dot;
        d.color = packed;
        if (wet) {
          d.anchorX = 0.5;
          d.anchorY = 1;
          // 1 px wide, 10 px long at full depth.
          d.scaleX = 0.5;
          d.scaleY = (10 * d.z) / 16;
        } else {
          d.anchorX = d.anchorY = 0.5;
          d.scaleX = d.scaleY = ((kind === 'ash' ? 1.4 : 1.8) * d.z) / DOT_R;
          d.rotation = 0;
        }
      }
      this.kind = kind;
      this.view.update();
    }
    if (!want) return;
    const dt = Math.min(0.05, dtMs / 1000);
    const t = performance.now() / 1000;
    const fall = wet ? 900 : kind === 'blizzard' ? 260 : kind === 'ash' ? 40 : 70;
    const drift = wind * (wet ? 140 : kind === 'blizzard' ? 320 : 60);
    // Rain streaks lean with the wind (the old line ran back by drift * 0.012 per unit of depth).
    const lean = wet ? Math.atan2(-drift * 0.012, 10) : 0;
    for (const d of drops) {
      d.y += fall * d.z * dt;
      d.x += (drift + (wet ? 0 : Math.sin(t * 1.3 + d.phase) * 18)) * d.z * dt;
      if (d.y > h + 10) {
        d.y = -10;
        d.x = Math.random() * w;
      }
      if (d.x > w + 10) d.x = -10;
      else if (d.x < -10) d.x = w + 10;
      if (wet) d.rotation = lean;
    }
  }
}
