import { Rectangle, Texture } from 'pixi.js';

/**
 * Every in-world mark in one texture, drawn once on a canvas, so a screen full of bars, rings and
 * brackets is a single draw call of tinted sprites and nothing is ever re-tessellated.
 *
 * The look is cut iron: chamfered corners rather than round ones, a soot under-stroke on everything
 * so it reads over snow and sand alike, and white where a mark takes its tint. Frames are drawn at
 * ATLAS_RES times their nominal size and shown at about nominal size whatever the zoom.
 */

export const ATLAS_RES = 2;
/** Steps a progress ring is drawn in. */
export const RING_STEPS = 36;

const SOOT = '#11151d';
const TALLOW = '#eadfc8';
const BRASS = '#c9a45c';

/** What a pawn is up to, as a glyph on a 24 px grid (strokes), in the hand of the HUD's icons. */
export const GLYPHS: Record<string, string> = {
  build: 'M5 20 13.5 11.5M9.5 7.5 13 4l7 4-2.5 2.5-3.5-.5-2.5 2.5z',
  mine: 'M5 20 15.5 9.5M6 8c5-4 11-3 14 3',
  chop: 'M12 22V3M12 6C8 3.500 5 4 3.500 5.500c0 3 .8 5 1.700 6.500C7 11 10 10 12 10M12 6c4-2.500 7-2 8.500-.5 0 3-.8 5-1.700 6.500C17 11 14 10 12 10',
  plant: 'M12 21v-10M12 12c0-4 3-6.5 7.5-6.5C19.5 9.500 16.500 12 12 12zM12 16c0-3-2.500-5-6.500-5C5.500 14 8 16 12 16z',
  haul: 'M4 10h16v10H4zM4 10l3-5h10l3 5M12 5v5',
  eat: 'M3.500 11h17c0 5.500-3.500 9-8.500 9s-8.500-3.500-8.500-9zM9 7.500c0-2 2-2 2-4.500M14 7.500c0-2 2-2 2-4.500',
  sleep: 'M5 5h8l-8 9h8M15 12h5l-5 6.500h5',
  fight: 'M4.500 4.500 19 19M19.500 4.500 5 19M7.500 20l-3.500-3.500M16.500 20l3.500-3.500',
  tend: 'M12 4.500v15M4.500 12h15',
  craft: 'M3.500 8.500h11c.3 2.600 2.200 3.800 5.500 4v2h-5.500l1.200 4.500H8.300l1.200-4.500h-2C5 14.500 3.500 12.300 3.500 8.500z',
  fire: 'M12 3c.6 3.800 5 6 5 11a5 5 0 0 1-10 0c0-2.700 1.600-4 2-6 1.300 1 2 2.400 2 4 1.400-1.800 1.600-5.400 1-9z',
  tame: 'M12 20.500s-8.500-5-8.500-11.500A4.800 4.800 0 0 1 12 6a4.800 4.800 0 0 1 8.500 3c0 6.500-8.500 11.500-8.500 11.500z',
  flee: 'M12 3 19 6v5.500c0 4.700-3.200 7.900-7 9.500-3.800-1.600-7-4.800-7-9.500V6z',
  trek: 'M7 21.500V3.500l12 5.500-12 5.500',
  walk: 'M4.500 12h14M13 6.500l5.500 5.500-5.500 5.500',
  steal: 'M5 8h14l-1.500 12h-11zM9 8c0-6 6-6 6 0',
  look: 'M2.500 12s3.500-6.500 9.500-6.500S21.500 12 21.500 12s-3.500 6.500-9.500 6.500S2.500 12 2.500 12zM12 9.500a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5z',
  stop: 'M6 6l12 12M18 6 6 18',
};

export interface WorldAtlas {
  /** A white block, for bars. */
  px: Texture;
  /** One chamfered bracket corner; its elbow is at frame (0, 0)'s inner end, top-left corner. */
  corner: Texture;
  reticle: Texture;
  /** Job glyphs on their tag. */
  tag: Record<string, Texture>;
  /** Job glyphs bare, for tinting: designation markers. */
  bare: Record<string, Texture>;
  /** Progress rings, full share = index / RING_STEPS. */
  ring: Texture[];
}

/** Nominal sizes of the frames, in screen pixels. */
export const CORNER_PX = 13;
export const RETICLE_PX = 44;
export const TAG_PX = 20;
export const BARE_PX = 16;
export const RING_PX = 28;

let atlas: WorldAtlas | null = null;

/** The whole atlas, built on first use. Lives as long as the page: the marks are always wanted. */
export function worldAtlas(): WorldAtlas {
  if (atlas) return atlas;
  const R = ATLAS_RES;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.scale(R, R);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const frames: Record<string, [number, number, number, number]> = {};
  let cx = 1;
  let cy = 1;
  let rowH = 0;
  /** Find room for a frame and draw it with the origin at its top-left. */
  const put = (key: string, w: number, h: number, draw: () => void) => {
    if (cx + w + 1 > c.width / R) {
      cx = 1;
      cy += rowH + 1;
      rowH = 0;
    }
    g.save();
    g.translate(cx, cy);
    draw();
    g.restore();
    frames[key] = [cx * R, cy * R, w * R, h * R];
    cx += w + 1;
    rowH = Math.max(rowH, h);
  };

  put('px', 4, 4, () => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 4, 4);
  });

  put('corner', CORNER_PX, CORNER_PX, () => {
    const arm = () => {
      g.beginPath();
      g.moveTo(2, CORNER_PX - 2);
      g.lineTo(2, 5.5);
      g.lineTo(5.5, 2);
      g.lineTo(CORNER_PX - 2, 2);
      g.stroke();
    };
    g.strokeStyle = SOOT;
    g.lineWidth = 3.6;
    arm();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.9;
    arm();
  });

  put('reticle', RETICLE_PX, RETICLE_PX, () => {
    const m = RETICLE_PX / 2;
    g.translate(m, m);
    const gaps = (pass: () => void) => {
      for (let q = 0; q < 4; q++) {
        g.save();
        g.rotate((q * Math.PI) / 2);
        pass();
        g.restore();
      }
    };
    const shape = () => {
      g.beginPath();
      g.arc(0, 0, 14, -Math.PI / 2 + 0.42, -0.42);
      g.stroke();
    };
    const wedge = () => {
      g.beginPath();
      g.moveTo(0, -9.5);
      g.lineTo(4.2, -20);
      g.lineTo(-4.2, -20);
      g.closePath();
    };
    g.strokeStyle = SOOT;
    g.fillStyle = SOOT;
    g.lineWidth = 3.8;
    gaps(shape);
    gaps(() => {
      wedge();
      g.stroke();
    });
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';
    g.lineWidth = 1.8;
    gaps(shape);
    gaps(() => {
      wedge();
      g.fill();
    });
  });

  // A tag is a chamfered plate of soot with a brass edge: the same corner as the brackets.
  for (const [key, d] of Object.entries(GLYPHS)) {
    const path = new Path2D(d);
    put(`tag:${key}`, TAG_PX, TAG_PX, () => {
      const s = TAG_PX;
      const k = 4.5;
      g.beginPath();
      g.moveTo(k, 0.75);
      g.lineTo(s - k, 0.75);
      g.lineTo(s - 0.75, k);
      g.lineTo(s - 0.75, s - k);
      g.lineTo(s - k, s - 0.75);
      g.lineTo(k, s - 0.75);
      g.lineTo(0.75, s - k);
      g.lineTo(0.75, k);
      g.closePath();
      g.fillStyle = SOOT;
      g.globalAlpha = 0.93;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = BRASS;
      g.lineWidth = 1.1;
      g.stroke();
      g.translate(3.4, 3.4);
      g.scale(13.2 / 24, 13.2 / 24);
      g.strokeStyle = TALLOW;
      g.lineWidth = 2.6;
      g.stroke(path);
    });
    put(`bare:${key}`, BARE_PX, BARE_PX, () => {
      g.scale(BARE_PX / 24, BARE_PX / 24);
      g.strokeStyle = SOOT;
      g.lineWidth = 5.4;
      g.stroke(path);
      g.strokeStyle = '#fff';
      g.lineWidth = 2.6;
      g.stroke(path);
    });
  }

  for (let i = 0; i <= RING_STEPS; i++) {
    put(`ring:${i}`, RING_PX, RING_PX, () => {
      const m = RING_PX / 2;
      const r = m - 3;
      g.beginPath();
      g.arc(m, m, r, 0, Math.PI * 2);
      g.strokeStyle = SOOT;
      g.globalAlpha = 0.72;
      g.lineWidth = 5;
      g.stroke();
      g.globalAlpha = 1;
      if (i) {
        g.beginPath();
        g.arc(m, m, r, -Math.PI / 2, -Math.PI / 2 + (i / RING_STEPS) * Math.PI * 2);
        g.strokeStyle = '#fff';
        g.lineWidth = 2.6;
        g.stroke();
      }
      // The notch at twelve o'clock: where it started, and where it will close.
      g.fillStyle = '#fff';
      g.fillRect(m - 0.6, 0.6, 1.2, 4.6);
    });
  }

  const source = Texture.from(c).source;
  source.scaleMode = 'linear';
  source.autoGenerateMipmaps = true;
  const at = (key: string) => {
    const [x, y, w, h] = frames[key];
    return new Texture({ source, frame: new Rectangle(x, y, w, h) });
  };
  const tag: Record<string, Texture> = {};
  const bare: Record<string, Texture> = {};
  for (const key of Object.keys(GLYPHS)) {
    tag[key] = at(`tag:${key}`);
    bare[key] = at(`bare:${key}`);
  }
  const ring: Texture[] = [];
  for (let i = 0; i <= RING_STEPS; i++) ring.push(at(`ring:${i}`));
  atlas = { px: at('px'), corner: at('corner'), reticle: at('reticle'), tag, bare, ring };
  return atlas;
}
