import { Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import type { Footing } from './motion';

/**
 * What feet leave behind: prints in snow, sand and mud that slowly fill in, and rings spreading on
 * shallow water. A few hundred sprites from one small atlas, drawn under the pawns and over the frost.
 */

/** Most marks kept: past this the oldest go first. */
const MAX_MARKS = 420;
/** How long a mark lasts, and the tint and strength it starts at. */
const LOOK: Record<Exclude<Footing, null>, { ms: number; color: number; alpha: number }> = {
  snow: { ms: 32000, color: 0x5c7890, alpha: 0.4 },
  sand: { ms: 15000, color: 0x6e5c3c, alpha: 0.32 },
  mud: { ms: 18000, color: 0x241c12, alpha: 0.36 },
  dirt: { ms: 12000, color: 0x2a2014, alpha: 0.22 },
  water: { ms: 950, color: 0xdcecf4, alpha: 0.55 },
};

/** Atlas texels: a print is 20 long, 10 wide; a ring spans 32. */
const PRINT_LEN = 20;
const RING_SPAN = 32;

let atlas: { print: Texture; ring: Texture } | null = null;

function getAtlas(): { print: Texture; ring: Texture } {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = 56;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  // A boot sole pointing along +x: the tread, then the heel.
  g.beginPath();
  g.ellipse(13, 5, 7, 4.6, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(3.5, 5, 3.5, 3.4, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(40, 16, 13, 0, Math.PI * 2);
  g.stroke();
  const source = Texture.from(c).source;
  source.scaleMode = 'linear';
  const at = (x: number, y: number, w: number, h: number) => new Texture({ source, frame: new Rectangle(x, y, w, h) });
  atlas = { print: at(0, 0, PRINT_LEN, 10), ring: at(24, 0, RING_SPAN, RING_SPAN) };
  return atlas;
}

class Mark extends Particle {
  age = 0;
  life = 1;
  rgb = 0xffffff;
  alpha0 = 1;
  /** Rings spread as they age; prints stay put. */
  spread = 0;
}

/** 0xRRGGBB to the 0xBBGGRR a particle's packed colour wants. */
const bgr = (c: number) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);

export class Tracks {
  readonly view: ParticleContainer;
  private marks: Mark[];
  private pool: Mark[] = [];
  /** The oldest mark: the list is a ring once it's full. */
  private next = 0;

  constructor() {
    this.view = new ParticleContainer({ texture: getAtlas().print, dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true } });
    this.marks = this.view.particleChildren as Mark[];
  }

  private add(): Mark {
    const list = this.marks;
    if (list.length >= MAX_MARKS) {
      const m = list[this.next];
      this.next = (this.next + 1) % MAX_MARKS;
      return m;
    }
    const m = this.pool.pop() ?? new Mark(getAtlas().print);
    list.push(m);
    this.view.update();
    return m;
  }

  /** A foot coming down at (x, y), heading along `angle`. `size` 1 is a boot. */
  print(x: number, y: number, angle: number, footing: Exclude<Footing, 'water' | null>, size = 1): void {
    const look = LOOK[footing];
    const m = this.add();
    m.texture = getAtlas().print;
    m.anchorX = m.anchorY = 0.5;
    m.x = x;
    m.y = y;
    m.rotation = angle;
    m.scaleX = 0.42 * size;
    m.scaleY = 0.42 * size;
    m.age = 0;
    m.life = look.ms;
    m.rgb = bgr(look.color);
    m.alpha0 = look.alpha;
    m.spread = 0;
  }

  /** A ring spreading from a foot in shallow water. */
  ripple(x: number, y: number, size = 1): void {
    const look = LOOK.water;
    const m = this.add();
    m.texture = getAtlas().ring;
    m.anchorX = m.anchorY = 0.5;
    m.x = x;
    m.y = y;
    m.rotation = 0;
    m.age = 0;
    m.life = look.ms;
    m.rgb = bgr(look.color);
    m.alpha0 = look.alpha;
    m.spread = (26 * size) / RING_SPAN;
    m.scaleX = m.scaleY = 0.2;
  }

  update(dtMs: number): void {
    const list = this.marks;
    let gone = false;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      m.age += dtMs;
      if (m.age >= m.life) {
        // Marks die oldest-first, but a ripple is short-lived among long prints: swap it out.
        const last = list.pop()!;
        if (m !== last) list[i--] = last;
        this.pool.push(m);
        gone = true;
        continue;
      }
      const k = m.age / m.life;
      if (m.spread) {
        // Quick at first, slowing as it spreads, and squashed: it lies flat on the water.
        const s = m.spread * (0.2 + 0.8 * (1 - (1 - k) * (1 - k)));
        m.scaleX = s;
        m.scaleY = s * 0.6;
      }
      const a = m.alpha0 * (k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5);
      m.color = m.rgb + (((a * 255) | 0) << 24);
    }
    if (gone) {
      this.next = 0;
      this.view.update();
    }
  }

  get count(): number {
    return this.marks.length;
  }
}
