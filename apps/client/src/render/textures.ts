import { Assets, Graphics, Texture, type Renderer } from 'pixi.js';
import { BUILDINGS, ITEMS, PLANTS } from '@fe/defs';

/** Texture resolution in pixels for procedurally drawn sprites. */
const S = 64;

/** Generated art that doesn't fit the top-down view; the procedural version is used instead. */
const ART_SKIP = new Set(['building_door']);

function shade(color: number, f: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 255) * f));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 255) * f));
  const b = Math.max(0, Math.min(255, (color & 255) * f));
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

/**
 * Sprites by key ("plant_oak", "item_wood", "building_bed", "pawn"...).
 * Hand-made art from /sprites/manifest.json wins; anything missing is drawn procedurally.
 */
export class TextureBank {
  private cache = new Map<string, Texture>();
  private art = new Map<string, Texture>();
  private manifest: Record<string, string> = {};
  /** Raw RGBA pixels of tileable terrain textures, keyed like "terrain_soil". */
  pixels = new Map<string, { w: number; h: number; data: Uint8ClampedArray }>();

  constructor(private renderer: Renderer) {}

  async loadArt(): Promise<number> {
    try {
      const res = await fetch('/sprites/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return 0;
      const manifest = (await res.json()) as Record<string, string>;
      this.manifest = manifest;
      await Promise.all(
        Object.entries(manifest)
          .filter(([key]) => key.startsWith('terrain_') || key.startsWith('rock_'))
          .map(([key, file]) => this.loadPixels(key, file)),
      );
      await Promise.all(
        Object.entries(manifest)
          .filter(([key]) => !key.startsWith('terrain_') && !key.startsWith('rock_') && !ART_SKIP.has(key))
          .map(async ([key, file]) => {
          try {
            const tex = await Assets.load<Texture>(`/sprites/${file}`);
            tex.source.scaleMode = 'linear';
            this.art.set(key, tex);
          } catch {
            // Missing or broken file: keep the procedural fallback.
          }
        }),
      );
    } catch {
      // No manifest: procedural art only.
    }
    return this.art.size;
  }

  private async loadPixels(key: string, file: string): Promise<void> {
    try {
      const blob = await (await fetch(`/sprites/${file}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      this.pixels.set(key, { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data });
    } catch {
      // Fall back to flat colour for this terrain.
    }
  }

  hasArt(key: string): boolean {
    return this.art.has(key);
  }

  private walk: Texture[] | null = null;

  /** Colonist walk-cycle frames (pawn_walk_0, pawn_walk_1, ...), or none if the art isn't there. */
  walkFrames(): Texture[] {
    if (!this.walk) {
      this.walk = [];
      for (let k = 0; this.art.has(`pawn_walk_${k}`); k++) this.walk.push(this.art.get(`pawn_walk_${k}`)!);
    }
    return this.walk;
  }

  private draw(key: string, fn: (g: Graphics) => void): Texture {
    const art = this.art.get(key);
    if (art) return art;
    let t = this.cache.get(key);
    if (!t) {
      const g = new Graphics();
      // Transparent frame so every texture is exactly S x S.
      g.rect(0, 0, S, S).fill({ color: 0, alpha: 0.001 });
      fn(g);
      t = this.renderer.generateTexture({ target: g, resolution: 1 });
      g.destroy();
      this.cache.set(key, t);
    }
    return t;
  }

  plant(def: string): Texture {
    const d = PLANTS[def];
    const c = d?.color ?? 0x3a6a2a;
    return this.draw(`plant_${def}`, (g) => {
      if (d?.tree) {
        if (def === 'pine') {
          for (let k = 0; k < 3; k++) {
            const r = 30 - k * 8;
            g.star(32, 32, 8, r, r * 0.6).fill(shade(c, 0.85 + k * 0.15)).stroke({ width: 2, color: shade(c, 0.5) });
          }
        } else {
          g.circle(32, 32, 29).fill(shade(c, 0.9)).stroke({ width: 2, color: shade(c, 0.5) });
          g.circle(24, 26, 14).fill({ color: shade(c, 1.25), alpha: 0.8 });
          g.circle(40, 38, 11).fill({ color: shade(c, 1.1), alpha: 0.7 });
        }
      } else if (d?.sowable) {
        for (const [x, y] of [[22, 22], [42, 24], [30, 42]]) {
          g.ellipse(x, y, 9, 13).fill(shade(c, 1)).stroke({ width: 1.5, color: shade(c, 0.55) });
        }
      } else {
        g.circle(32, 32, 22).fill(shade(c, 1)).stroke({ width: 2, color: shade(c, 0.55) });
        g.circle(26, 27, 9).fill({ color: shade(c, 1.3), alpha: 0.7 });
        if (def === 'berry_bush') for (const [x, y] of [[24, 38], [38, 26], [40, 40], [30, 30]]) g.circle(x, y, 3.5).fill(0x8a1a5a);
      }
    });
  }

  item(def: string): Texture {
    const d = ITEMS[def];
    const c = d?.color ?? 0x999999;
    return this.draw(`item_${def}`, (g) => {
      if (d?.category === 'resource') {
        for (let k = 0; k < 3; k++) g.roundRect(12, 14 + k * 12, 40, 10, 3).fill(shade(c, 0.85 + k * 0.1)).stroke({ width: 1.5, color: shade(c, 0.5) });
      } else if (d?.category === 'apparel') {
        if (def === 'tuque' || def === 'sun_hat') {
          g.ellipse(32, 40, 22, 10).fill(shade(c, 0.85)).stroke({ width: 2, color: shade(c, 0.5) });
          g.ellipse(32, 30, 15, 14).fill(c).stroke({ width: 2, color: shade(c, 0.5) });
          if (def === 'tuque') g.circle(32, 15, 5).fill(0xf0f0f0);
        } else {
          // A folded garment: body, sleeves, collar.
          g.poly([16, 14, 26, 10, 38, 10, 48, 14, 58, 26, 50, 32, 46, 28, 46, 54, 18, 54, 18, 28, 14, 32, 6, 26]).fill(c).stroke({ width: 2, color: shade(c, 0.5) });
          g.rect(28, 10, 8, 6).fill(shade(c, 0.7));
          if (def === 'parka') g.rect(18, 12, 28, 6).fill(0xe8e0d0);
        }
      } else if (d?.category === 'meal') {
        g.circle(32, 34, 20).fill(0xe8e0d0).stroke({ width: 2, color: 0x6a5a48 });
        g.circle(32, 34, 14).fill(c);
      } else {
        for (const [x, y, r] of [[24, 36, 9], [38, 34, 9], [31, 24, 9], [30, 42, 7], [42, 44, 6]]) g.circle(x, y, r).fill(shade(c, 0.9 + (x % 3) * 0.08)).stroke({ width: 1.5, color: shade(c, 0.5) });
      }
    });
  }

  building(def: string): Texture {
    const d = BUILDINGS[def];
    const c = d?.color ?? 0x888888;
    return this.draw(`building_${def}`, (g) => {
      if (d?.wall && !d.door) {
        g.rect(0, 0, S, S).fill(shade(c, 0.9));
        g.rect(4, 4, S - 8, S - 8).fill(shade(c, 1.1));
        g.rect(0, S - 8, S, 8).fill({ color: shade(c, 0.6), alpha: 0.8 });
        return;
      }
      switch (def) {
        case 'door':
          g.rect(2, 22, 60, 20).fill(shade(c, 1)).stroke({ width: 2, color: shade(c, 0.5) });
          g.rect(2, 30, 60, 4).fill(shade(c, 0.6));
          return;
        case 'bed':
          g.roundRect(8, 4, 48, 56, 6).fill(0x6a4a30);
          g.roundRect(11, 7, 42, 50, 4).fill(c);
          g.roundRect(15, 9, 34, 12, 4).fill(0xeeeae0);
          return;
        case 'table':
          g.roundRect(4, 8, 56, 48, 4).fill(c).stroke({ width: 2, color: shade(c, 0.5) });
          g.rect(10, 14, 44, 2).fill({ color: shade(c, 1.2), alpha: 0.6 });
          return;
        case 'chair':
          g.roundRect(18, 20, 28, 28, 4).fill(c).stroke({ width: 2, color: shade(c, 0.5) });
          g.rect(18, 14, 28, 8).fill(shade(c, 0.8));
          return;
        case 'campfire':
          for (let k = 0; k < 10; k++) {
            const a = (k / 10) * Math.PI * 2;
            g.circle(32 + Math.cos(a) * 22, 32 + Math.sin(a) * 22, 6).fill(0x7a7470);
          }
          g.circle(32, 32, 14).fill(0xe0702a);
          g.circle(32, 32, 7).fill(0xffd060);
          return;
        case 'sun_shard':
          g.circle(32, 32, 30).fill({ color: 0xffd060, alpha: 0.25 });
          g.star(32, 32, 7, 26, 11).fill(0xffc040).stroke({ width: 2, color: 0xa06010 });
          g.circle(32, 32, 9).fill(0xfff4c0);
          return;
        case 'whispering_stone':
          g.ellipse(32, 54, 18, 6).fill({ color: 0x000000, alpha: 0.4 });
          g.poly([32, 2, 46, 14, 44, 56, 20, 56, 18, 14]).fill(0x1a1a24).stroke({ width: 2, color: 0x6a5aa0 });
          g.rect(29, 16, 6, 30).fill({ color: 0x8a7ad0, alpha: 0.35 });
          return;
        case 'crafting_spot':
          g.roundRect(6, 10, 52, 44, 4).fill({ color: c, alpha: 0.7 });
          g.rect(16, 20, 24, 4).fill(0x5a5a5a);
          g.rect(22, 34, 4, 14).fill(0x7a5a38);
          return;
        default:
          g.roundRect(4, 4, 56, 56, 5).fill(c).stroke({ width: 2, color: shade(c, 0.5) });
          g.roundRect(12, 12, 40, 40, 4).fill({ color: shade(c, 1.25), alpha: 0.5 });
          if (def === 'heater') g.circle(32, 32, 9).fill(0xffa040);
          if (def === 'cooler') for (let k = 0; k < 4; k++) g.rect(14, 16 + k * 9, 36, 3).fill(0xd0e8f8);
      }
    });
  }

  /** A wall piece that joins up with neighbours. mask bits: 1 up, 2 right, 4 down, 8 left. */
  wall(def: string, mask: number): Texture {
    const c = BUILDINGS[def]?.color ?? 0x888888;
    return this.draw(`wall_${def}_${mask}`, (g) => {
      const e = 7; // edge thickness where the wall ends
      const top = shade(c, 1.12);
      const side = shade(c, 0.62);
      const outline = shade(c, 0.4);
      // Wall top, extended to the tile edge wherever a neighbour continues it.
      const x0 = mask & 8 ? 0 : e;
      const x1 = mask & 2 ? S : S - e;
      const y0 = mask & 1 ? 0 : e;
      const y1 = mask & 4 ? S : S - e - 6;
      g.rect(0, 0, S, S).fill({ color: 0, alpha: 0.001 });
      // Front face (gives a little height) where the wall doesn't continue downward.
      if (!(mask & 4)) g.rect(x0, y1, x1 - x0, S - e - y1 + 6).fill(side);
      g.rect(x0, y0, x1 - x0, y1 - y0).fill(top);
      // Subtle plank/stone seams along the run direction.
      const horizontal = (mask & 10) !== 0 || (mask & 5) === 0;
      for (let k = 1; k < 4; k++) {
        if (horizontal) g.rect(x0, y0 + ((y1 - y0) * k) / 4, x1 - x0, 1).fill({ color: outline, alpha: 0.35 });
        else g.rect(x0 + ((x1 - x0) * k) / 4, y0, 1, y1 - y0).fill({ color: outline, alpha: 0.35 });
      }
      // Outline only on open sides.
      const w = 2;
      if (!(mask & 1)) g.rect(x0, y0, x1 - x0, w).fill(outline);
      if (!(mask & 8)) g.rect(x0, y0, w, (mask & 4 ? S : S - e) - y0).fill(outline);
      if (!(mask & 2)) g.rect(x1 - w, y0, w, (mask & 4 ? S : S - e) - y0).fill(outline);
      if (!(mask & 4)) g.rect(x0, S - e - w + 6, x1 - x0, w).fill(outline);
    });
  }

  /** Neutral colonist, tinted per faction by the sprite. */
  pawn(): Texture {
    return this.draw('pawn', (g) => {
      g.ellipse(32, 36, 20, 16).fill(0xf0f0f0).stroke({ width: 3, color: 0x202020 });
      g.circle(32, 24, 11).fill(0xe8c8a8).stroke({ width: 2.5, color: 0x202020 });
    });
  }
}
