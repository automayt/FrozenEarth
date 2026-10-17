import { DESIG } from '@fe/sim';

/**
 * Pure pixel painters for the map bitmaps (premultiplied RGBA), kept apart from the renderer so
 * tests can run them without a GPU.
 */

/** Pixels per cell in the terrain and overlay bitmaps. */
export const PX = 8;
/** Fog texels per cell, and the shade's colour and strength over a fully hidden interior. */
export const FOG_RES = 2;
const FOG_RGB = [8, 12, 20];
export const FOG_ALPHA = 120 / 255;

/** Designation corner-bracket colours, [r, g, b, alpha]. */
const DESIG_RGBA: Record<number, [number, number, number, number]> = {
  [DESIG.mine]: [240, 180, 60, 0.85],
  [DESIG.cut]: [230, 80, 60, 0.85],
  [DESIG.steal]: [190, 110, 240, 0.9],
};
const DESIG_OTHER: [number, number, number, number] = [120, 220, 90, 0.85];

/**
 * One overlay cell into a premultiplied RGBA buffer: a translucent zone wash (zoneColor < 0 for
 * none) and, for a designation, corner brackets so the cell's content stays visible.
 */
export function paintOverlayCell(data: Uint8ClampedArray, stride: number, ox: number, oy: number, zoneColor: number, zoneAlpha: number, desig: number): void {
  const za = zoneColor < 0 ? 0 : zoneAlpha;
  const zr = ((zoneColor >> 16) & 255) * za;
  const zg = ((zoneColor >> 8) & 255) * za;
  const zb = (zoneColor & 255) * za;
  const dc = desig ? (DESIG_RGBA[desig] ?? DESIG_OTHER) : null;
  const t = PX / 4;
  const l = PX / 2;
  for (let py = 0; py < PX; py++) {
    for (let px = 0; px < PX; px++) {
      let r = zr;
      let g = zg;
      let b = zb;
      let a = za;
      if (dc && ((py < t && px < l) || (px < t && py < l) || (py >= PX - t && px >= PX - l) || (px >= PX - t && py >= PX - l))) {
        const k = 1 - dc[3];
        r = dc[0] * dc[3] + r * k;
        g = dc[1] * dc[3] + g * k;
        b = dc[2] * dc[3] + b * k;
        a = dc[3] + a * k;
      }
      const i = ((oy + py) * stride + ox + px) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a * 255;
    }
  }
}

/**
 * Paint fog texels for cells x0..x1, y0..y1 (inclusive) into a premultiplied RGBA buffer FOG_RES
 * texels a cell. `state` per cell: 0 not indoors, 1 indoors and seen, 2 indoors and hidden.
 * Outdoor cells stay clear. An indoor texel takes the share of hidden cells among the indoor ones
 * meeting at its corner of the cell, so the shade fades across the line between seen and unseen
 * rather than stepping cell by cell; walls and doorways don't count, so a hidden room stays evenly
 * dark right up to its walls.
 */
export function paintFog(data: Uint8ClampedArray, state: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  const tw = w * FOG_RES;
  const half = FOG_RES / 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = y * w + x;
      const indoors = state[c] !== 0;
      for (let ty = 0; ty < FOG_RES; ty++) {
        for (let tx = 0; tx < FOG_RES; tx++) {
          let a = 0;
          if (indoors) {
            const nx = x + (tx < half ? -1 : 1);
            const ny = y + (ty < half ? -1 : 1);
            const s1 = nx >= 0 && nx < w ? state[c - x + nx] : 0;
            const s2 = ny >= 0 && ny < h ? state[ny * w + x] : 0;
            const s3 = s1 || s2 ? (nx >= 0 && nx < w && ny >= 0 && ny < h ? state[ny * w + nx] : 0) : 0;
            const count = 1 + (s1 ? 1 : 0) + (s2 ? 1 : 0) + (s3 ? 1 : 0);
            const hidden = (state[c] === 2 ? 1 : 0) + (s1 === 2 ? 1 : 0) + (s2 === 2 ? 1 : 0) + (s3 === 2 ? 1 : 0);
            a = (hidden / count) * FOG_ALPHA;
          }
          const o = ((y * FOG_RES + ty) * tw + x * FOG_RES + tx) * 4;
          data[o] = FOG_RGB[0] * a;
          data[o + 1] = FOG_RGB[1] * a;
          data[o + 2] = FOG_RGB[2] * a;
          data[o + 3] = 255 * a;
        }
      }
    }
  }
}


