import { Graphics } from 'pixi.js';

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

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Age and lifetime in ms. */
  age: number;
  life: number;
  size: number;
  grow: number;
  color: number;
  alpha: number;
  gravity: number;
  drag: number;
  spin: number;
  angle: number;
  shape: Shape;
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

/** A pooled particle system drawn into one Graphics. */
export class Particles {
  readonly g = new Graphics();
  private ps: Particle[] = [];
  private static MAX = 1600;

  burst(x: number, y: number, o: BurstOptions): void {
    for (let k = 0; k < o.count && this.ps.length < Particles.MAX; k++) {
      const a = (o.angle ?? 0) + (Math.random() - 0.5) * (o.spread ?? Math.PI * 2);
      const v = o.speed * (0.4 + Math.random() * 0.8);
      const colors = Array.isArray(o.color) ? o.color : [o.color];
      this.ps.push({
        x: x + (Math.random() - 0.5) * 4,
        y: y + (Math.random() - 0.5) * 4,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - (o.lift ?? 0),
        age: 0,
        life: o.life * (0.7 + Math.random() * 0.6),
        size: o.size * (0.6 + Math.random() * 0.8),
        grow: o.grow ?? 0,
        color: colors[(Math.random() * colors.length) | 0],
        alpha: o.alpha ?? 1,
        gravity: o.gravity ?? 0,
        drag: o.drag ?? 2,
        spin: o.chips ? (Math.random() - 0.5) * 14 : 0,
        angle: Math.random() * Math.PI,
        shape: o.chips ? Shape.Chip : Shape.Dot,
      });
    }
  }

  /** A floating "z" above a sleeper. */
  zed(x: number, y: number): void {
    if (this.ps.length >= Particles.MAX) return;
    this.ps.push({ x, y, vx: 6 + Math.random() * 4, vy: -14, age: 0, life: 1600, size: 4, grow: 2, color: 0xe8f0ff, alpha: 0.9, gravity: 0, drag: 0, spin: 0, angle: 0, shape: Shape.Zed });
  }

  update(dtMs: number): void {
    const dt = Math.min(0.05, dtMs / 1000);
    const g = this.g;
    g.clear();
    const keep: Particle[] = [];
    for (const p of this.ps) {
      p.age += dtMs;
      if (p.age >= p.life) continue;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.grow * dt;
      p.angle += p.spin * dt;
      const k = p.age / p.life;
      const a = p.alpha * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
      if (p.shape === Shape.Chip) {
        const c = Math.cos(p.angle) * p.size;
        const s = Math.sin(p.angle) * p.size;
        g.poly([p.x - c, p.y - s, p.x + s * 0.5, p.y - c * 0.5, p.x + c, p.y + s, p.x - s * 0.5, p.y + c * 0.5]).fill({ color: p.color, alpha: a });
      } else if (p.shape === Shape.Zed) {
        const s = p.size;
        g.moveTo(p.x - s, p.y - s)
          .lineTo(p.x + s, p.y - s)
          .lineTo(p.x - s, p.y + s)
          .lineTo(p.x + s, p.y + s)
          .stroke({ width: 1.5, color: p.color, alpha: a });
      } else {
        g.circle(p.x, p.y, Math.max(0.3, p.size)).fill({ color: p.color, alpha: a });
      }
      keep.push(p);
    }
    this.ps = keep;
  }

  get count(): number {
    return this.ps.length;
  }
}

interface Tween {
  t0: number;
  dur: number;
  step: (k: number) => void;
  done?: () => void;
}

/** Time-based tweens. step(k) gets progress 0..1; done runs once at the end. */
export class Tweens {
  private list: Tween[] = [];

  add(dur: number, step: (k: number) => void, done?: () => void): void {
    this.list.push({ t0: performance.now(), dur, step, done });
    step(0);
  }

  update(now: number): void {
    if (!this.list.length) return;
    const keep: Tween[] = [];
    for (const t of this.list) {
      const k = Math.min(1, (now - t.t0) / t.dur);
      t.step(k);
      if (k < 1) keep.push(t);
      else t.done?.();
    }
    this.list = keep;
  }
}

export type Precip = 'none' | 'rain' | 'storm' | 'snow' | 'blizzard' | 'ash';

interface Drop {
  x: number;
  y: number;
  z: number;
  phase: number;
}

/** Screen-space rain, snow and ash. Drops wrap around the screen; density follows the weather. */
export class Weather {
  readonly g = new Graphics();
  private drops: Drop[] = [];

  update(dtMs: number, kind: Precip, w: number, h: number, wind: number): void {
    const g = this.g;
    g.clear();
    const want = { none: 0, rain: 260, storm: 520, snow: 160, blizzard: 650, ash: 220 }[kind];
    while (this.drops.length < want) this.drops.push({ x: Math.random() * w, y: Math.random() * h, z: 0.4 + Math.random() * 0.6, phase: Math.random() * 6.28 });
    if (this.drops.length > want) this.drops.length = want;
    if (!want) return;
    const dt = Math.min(0.05, dtMs / 1000);
    const t = performance.now() / 1000;
    const wet = kind === 'rain' || kind === 'storm';
    const fall = wet ? 900 : kind === 'blizzard' ? 260 : kind === 'ash' ? 40 : 70;
    const drift = wind * (wet ? 140 : kind === 'blizzard' ? 320 : 60);
    for (const d of this.drops) {
      d.y += fall * d.z * dt;
      d.x += (drift + (wet ? 0 : Math.sin(t * 1.3 + d.phase) * 18)) * d.z * dt;
      if (d.y > h + 10) {
        d.y = -10;
        d.x = Math.random() * w;
      }
      if (d.x > w + 10) d.x = -10;
      else if (d.x < -10) d.x = w + 10;
      if (wet) {
        const len = 10 * d.z;
        g.moveTo(d.x, d.y).lineTo(d.x - drift * 0.012 * d.z, d.y - len);
      } else {
        g.circle(d.x, d.y, (kind === 'ash' ? 1.4 : 1.8) * d.z);
      }
    }
    if (wet) g.stroke({ width: 1, color: 0xa8c8e8, alpha: kind === 'storm' ? 0.45 : 0.35 });
    else g.fill({ color: kind === 'ash' ? 0x5a5450 : 0xf4f8ff, alpha: kind === 'ash' ? 0.6 : 0.8 });
  }
}
