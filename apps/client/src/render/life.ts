import { Container, Sprite, Texture } from 'pixi.js';
import { PLANTS } from '@fe/defs';
import { calendar, frostLevel, frostRadius } from '@fe/sim';
import type { Mirror } from '@fe/protocol';
import type { Sun } from './light';

/**
 * Ambient life, purely decorative and kept sparse: a small flock of birds crossing now and then by
 * day (their shadows sliding over the ground), fireflies on summer nights, and leaves falling from
 * trees in autumn. A few dozen sprites at most, only around the camera, nothing when zoomed far out.
 */

const TILE = 32;

export interface LifeInput {
  tick: number;
  mirror: Mirror;
  sun: Sun;
  dark: number;
  precip: string;
  /** Visible world rectangle in world px. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Bird {
  body: Sprite;
  shadow: Sprite;
  phase: number;
  dx: number;
  dy: number;
}

interface Flock {
  birds: Bird[];
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Mote {
  s: Sprite;
  vx: number;
  vy: number;
  age: number;
  life: number;
  phase: number;
}

let textures: { bird: Texture; dot: Texture; leaf: Texture } | null = null;

function tex(): { bird: Texture; dot: Texture; leaf: Texture } {
  if (textures) return textures;
  const mk = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d')!);
    const t = Texture.from(c);
    t.source.scaleMode = 'linear';
    return t;
  };
  textures = {
    // A gull-wing "v", white so it can be tinted.
    bird: mk(24, 12, (g) => {
      g.strokeStyle = '#fff';
      g.lineWidth = 2.4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(2, 4);
      g.quadraticCurveTo(7, 2, 12, 8);
      g.quadraticCurveTo(17, 2, 22, 4);
      g.stroke();
    }),
    dot: mk(16, 16, (g) => {
      const r = g.createRadialGradient(8, 8, 0, 8, 8, 8);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.35, 'rgba(255,255,255,0.7)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 16, 16);
    }),
    leaf: mk(10, 6, (g) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.ellipse(5, 3, 4.5, 2.2, 0, 0, Math.PI * 2);
      g.fill();
    }),
  };
  return textures;
}

export class Life {
  readonly view = new Container();
  private shadows = new Container();
  private air = new Container();
  private flock: Flock | null = null;
  private nextFlock = performance.now() + 8000 + Math.random() * 12000;
  private flies: Mote[] = [];
  private leaves: Mote[] = [];
  private nextLeaf = 0;

  constructor() {
    this.view.addChild(this.shadows, this.air);
  }

  update(dtMs: number, now: number, o: LifeInput): void {
    const m = o.mirror;
    if (!m.w) return;
    const dt = Math.min(0.05, dtMs / 1000);
    const viewW = o.x1 - o.x0;
    // Zoomed far out: too small to see, not worth the sprites.
    const near = viewW < 110 * TILE;
    const cal = calendar(o.tick);
    // Out on the frozen band nothing flies or glows.
    const cx = Math.floor((o.x0 + o.x1) / 2 / TILE);
    const cy = Math.floor((o.y0 + o.y1) / 2 / TILE);
    const frozen = frostLevel(cx, cy, m.w, m.h, frostRadius(o.tick, m.frost)) > 0.4;
    const rough = o.precip === 'storm' || o.precip === 'blizzard' || o.precip === 'rain';

    this.updateFlock(dt, now, o, near && !frozen && !rough && o.dark < 0.35);
    const fliesWanted = near && !frozen && !rough && o.dark > 0.45 && (cal.season === 'Summer' || cal.season === 'Spring') ? (cal.season === 'Summer' ? 22 : 8) : 0;
    this.updateFlies(dt, o, fliesWanted);
    this.updateLeaves(dt, now, o, near && !frozen && cal.season === 'Fall' && o.dark < 0.6);
  }

  private updateFlock(dt: number, now: number, o: LifeInput, allowed: boolean): void {
    const f = this.flock;
    if (!f) {
      if (!allowed || now < this.nextFlock) return;
      this.nextFlock = now + 25000 + Math.random() * 35000;
      // Enter from a side of the view, heading across it with a little drift.
      const fromLeft = Math.random() < 0.5;
      const speed = 70 + Math.random() * 40;
      const angle = (Math.random() - 0.5) * 0.7;
      const vx = Math.cos(angle) * speed * (fromLeft ? 1 : -1);
      const vy = Math.sin(angle) * speed;
      const x = fromLeft ? o.x0 - 60 : o.x1 + 60;
      const y = o.y0 + (o.y1 - o.y0) * (0.2 + Math.random() * 0.6);
      const n = 3 + Math.floor(Math.random() * 5);
      const birds: Bird[] = [];
      const t = tex();
      for (let k = 0; k < n; k++) {
        // A loose V behind the leader.
        const side = k === 0 ? 0 : k % 2 ? 1 : -1;
        const rank = Math.ceil(k / 2);
        const back = -rank * 16;
        const across = side * rank * 13 + (Math.random() - 0.5) * 6;
        const ux = vx / speed;
        const uy = vy / speed;
        const body = new Sprite(t.bird);
        body.anchor.set(0.5);
        body.tint = 0x2a2a30;
        body.scale.set(0.62 + Math.random() * 0.12);
        const shadow = new Sprite(t.bird);
        shadow.anchor.set(0.5);
        shadow.tint = 0x000000;
        shadow.alpha = 0.16;
        shadow.scale.set(body.scale.x * 1.05);
        this.air.addChild(body);
        this.shadows.addChild(shadow);
        birds.push({ body, shadow, phase: Math.random() * 6.28, dx: ux * back - uy * across, dy: uy * back + ux * across });
      }
      this.flock = { birds, x, y, vx, vy };
      return;
    }
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    // Birds fly high: their shadows land well off along the sun, and fade with it.
    const sx = o.sun.x * 3.5 * TILE;
    const sy = o.sun.y * 3.5 * TILE + 40;
    const shade = Math.min(0.18, o.sun.strength * 0.5);
    for (const b of f.birds) {
      b.phase += dt * 9;
      const flap = 0.35 + 0.65 * Math.abs(Math.sin(b.phase));
      const x = f.x + b.dx;
      const y = f.y + b.dy + Math.sin(b.phase * 0.3) * 2;
      b.body.position.set(x, y);
      b.body.scale.y = b.body.scale.x * flap;
      b.body.rotation = Math.atan2(f.vy, Math.abs(f.vx)) * Math.sign(f.vx) * 0.5;
      b.shadow.position.set(x + sx, y + sy);
      b.shadow.scale.y = b.shadow.scale.x * flap;
      b.shadow.rotation = b.body.rotation;
      b.shadow.alpha = shade;
    }
    const margin = 200;
    if (f.x < o.x0 - margin * 2 || f.x > o.x1 + margin * 2 || f.y < o.y0 - margin * 2 || f.y > o.y1 + margin * 2) {
      for (const b of f.birds) {
        b.body.destroy();
        b.shadow.destroy();
      }
      this.flock = null;
    }
  }

  private updateFlies(dt: number, o: LifeInput, wanted: number): void {
    const m = o.mirror;
    const t = tex();
    while (this.flies.length < wanted) {
      const x = o.x0 + Math.random() * (o.x1 - o.x0);
      const y = o.y0 + Math.random() * (o.y1 - o.y0);
      const c = Math.floor(y / TILE) * m.w + Math.floor(x / TILE);
      const s = new Sprite(t.dot);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = 0xd8ff6a;
      s.scale.set(0.5);
      s.position.set(x, y);
      // Not over rock or water: start them somewhere plausible, else let them fade out quickly.
      const bad = c < 0 || c >= m.rock.length || m.rock[c] > 0;
      this.air.addChild(s);
      this.flies.push({ s, vx: 0, vy: 0, age: 0, life: bad ? 0 : 6 + Math.random() * 8, phase: Math.random() * 6.28 });
    }
    let w = 0;
    for (let i = 0; i < this.flies.length; i++) {
      const f = this.flies[i];
      f.age += dt;
      const out = f.s.x < o.x0 - 40 || f.s.x > o.x1 + 40 || f.s.y < o.y0 - 40 || f.s.y > o.y1 + 40;
      if (f.age >= f.life || out || w >= wanted) {
        f.s.destroy();
        continue;
      }
      // Lazy wandering, and a slow glow on and off.
      f.vx += (Math.random() - 0.5) * 40 * dt;
      f.vy += (Math.random() - 0.5) * 40 * dt;
      f.vx *= 0.98;
      f.vy *= 0.98;
      f.s.x += f.vx * dt;
      f.s.y += f.vy * dt;
      f.phase += dt * 2.2;
      const fade = Math.min(1, f.age / 1.2, (f.life - f.age) / 1.2);
      f.s.alpha = Math.max(0, Math.sin(f.phase)) ** 2 * 0.9 * fade;
      this.flies[w++] = f;
    }
    this.flies.length = w;
  }

  private updateLeaves(dt: number, now: number, o: LifeInput, allowed: boolean): void {
    const m = o.mirror;
    if (allowed && now >= this.nextLeaf && this.leaves.length < 14) {
      this.nextLeaf = now + 350 + Math.random() * 500;
      // Try a few random visible cells for a grown tree to shed from.
      for (let k = 0; k < 8; k++) {
        const x = Math.floor((o.x0 + Math.random() * (o.x1 - o.x0)) / TILE);
        const y = Math.floor((o.y0 + Math.random() * (o.y1 - o.y0)) / TILE);
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
        const e = m.entities.get(m.plantAt[y * m.w + x]);
        if (!e || e.kind !== 'plant' || !PLANTS[e.def]?.tree || e.def === 'pine' || e.growth < 0.6) continue;
        const s = new Sprite(tex().leaf);
        s.anchor.set(0.5);
        s.tint = [0xc8702a, 0xd89a30, 0xa8482a, 0xb88a3a][Math.floor(Math.random() * 4)];
        s.position.set((x + 0.5) * TILE + (Math.random() - 0.5) * 30, (y + 0.5) * TILE - 6 + (Math.random() - 0.5) * 20);
        this.air.addChild(s);
        this.leaves.push({ s, vx: 10 + Math.random() * 12, vy: 10 + Math.random() * 8, age: 0, life: 2.2 + Math.random() * 1.5, phase: Math.random() * 6.28 });
        break;
      }
    }
    let w = 0;
    for (const l of this.leaves) {
      l.age += dt;
      if (l.age >= l.life) {
        l.s.destroy();
        continue;
      }
      l.phase += dt * 3.5;
      l.s.x += (l.vx + Math.sin(l.phase) * 18) * dt;
      l.s.y += l.vy * dt;
      l.s.rotation = Math.sin(l.phase) * 0.9;
      l.s.scale.x = Math.cos(l.phase * 0.8);
      l.s.alpha = Math.min(1, l.age / 0.3, (l.life - l.age) / 0.6);
      this.leaves[w++] = l;
    }
    this.leaves.length = w;
  }
}
