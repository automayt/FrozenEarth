import { describe, expect, it } from 'vitest';
import { DESIG } from '@fe/sim';
import { ChunkedBitmap } from '../src/render/bitmap';
import { FOG_ALPHA, FOG_RES, paintFog, paintOverlayCell, PX } from '../src/render/paint';

describe('ChunkedBitmap', () => {
  it('puts each cell in its chunk, sizes edge chunks to the map, and uploads only touched rows', () => {
    // 40 x 20 cells in 16-cell chunks: 3 x 2 chunks, the last column and row partial.
    const b = new ChunkedBitmap({ w: 40, h: 20, px: 4, tile: 32, chunk: 16 });
    expect(b.root.children.length).toBe(6);
    const s = b.cell(2 * 40 + 35); // x 35, y 2: third chunk column, 8 cells wide
    expect(s.stride).toBe(8 * 4);
    expect(s.ox).toBe(3 * 4);
    expect(s.oy).toBe(2 * 4);
    b.flush();
    // One cell: its 4 pixel rows of a 32-pixel-wide chunk.
    expect(b.uploaded).toBe(4 * 32 * 4);
    // Two cells in the same chunk, on cell rows 1 and 4, go up as one span: pixel rows 4 to 20.
    b.uploaded = 0;
    b.cell(1 * 40 + 1);
    b.cell(4 * 40 + 3);
    b.flush();
    expect(b.uploaded).toBe(16 * 64 * 4);
    // Nothing touched, nothing sent.
    b.uploaded = 0;
    b.flush();
    expect(b.uploaded).toBe(0);
    b.destroy();
  });

  it('writes through to the chunk buffer', () => {
    const b = new ChunkedBitmap({ w: 20, h: 20, px: 2, tile: 32, chunk: 8 });
    const s = b.cell(9 * 20 + 9); // chunk (1, 1), cell (1, 1) inside it
    s.data[((s.oy + 1) * s.stride + s.ox + 1) * 4] = 200;
    const again = b.cell(9 * 20 + 9);
    expect(again.data[((again.oy + 1) * again.stride + again.ox + 1) * 4]).toBe(200);
    b.destroy();
  });
});

describe('paintOverlayCell', () => {
  const px = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.slice((y * PX + x) * 4, (y * PX + x) * 4 + 4));

  it('washes a zone cell evenly, premultiplied', () => {
    const d = new Uint8ClampedArray(PX * PX * 4);
    paintOverlayCell(d, PX, 0, 0, 0xff0000, 0.2, 0);
    expect(px(d, 0, 0)).toEqual([51, 0, 0, 51]);
    expect(px(d, 4, 4)).toEqual([51, 0, 0, 51]);
  });

  it('draws designation brackets in the corners over the zone, leaving the middle clear', () => {
    const d = new Uint8ClampedArray(PX * PX * 4);
    paintOverlayCell(d, PX, 0, 0, -1, 0.2, DESIG.mine);
    expect(px(d, 0, 0)[3]).toBe(Math.round(0.85 * 255));
    expect(px(d, PX - 1, PX - 1)[3]).toBe(Math.round(0.85 * 255));
    expect(px(d, PX / 2, PX / 2)).toEqual([0, 0, 0, 0]);
    // Top-right and bottom-left corners stay open.
    expect(px(d, PX - 1, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('paintFog', () => {
  // A 6 x 4 map: a room of 4 x 2 cells (x 1..4, y 1..2) inside walls.
  const W = 6;
  const H = 4;
  const alphaAt = (d: Uint8ClampedArray, tx: number, ty: number) => d[(ty * W * FOG_RES + tx) * 4 + 3] / 255;
  const room = (hidden: (x: number) => boolean) => {
    const st = new Uint8Array(W * H);
    for (let y = 1; y <= 2; y++) for (let x = 1; x <= 4; x++) st[y * W + x] = hidden(x) ? 2 : 1;
    return st;
  };

  it('shades a hidden room evenly right up to its walls, and nothing outside', () => {
    const d = new Uint8ClampedArray(W * H * FOG_RES * FOG_RES * 4);
    paintFog(d, room(() => true), W, H, 0, 0, W - 1, H - 1);
    for (let ty = FOG_RES; ty < 3 * FOG_RES; ty++) for (let tx = FOG_RES; tx < 5 * FOG_RES; tx++) expect(alphaAt(d, tx, ty)).toBeCloseTo(FOG_ALPHA, 2);
    expect(alphaAt(d, 0, 0)).toBe(0);
    expect(alphaAt(d, 5 * FOG_RES, FOG_RES)).toBe(0);
  });

  it('fades across the line between seen and unseen cells instead of stepping', () => {
    const d = new Uint8ClampedArray(W * H * FOG_RES * FOG_RES * 4);
    // Left half seen, right half hidden.
    paintFog(d, room((x) => x >= 3), W, H, 0, 0, W - 1, H - 1);
    const row = FOG_RES + 1;
    const a = [1, 2, 3, 4].flatMap((x) => [alphaAt(d, x * FOG_RES, row), alphaAt(d, x * FOG_RES + 1, row)]);
    // Deep in the seen half clear, deep in the hidden half full, halfway on either side of the line.
    expect(a[0]).toBe(0);
    expect(a[7]).toBeCloseTo(FOG_ALPHA, 2);
    expect(a[3]).toBeCloseTo(FOG_ALPHA / 2, 2);
    expect(a[4]).toBeCloseTo(FOG_ALPHA / 2, 2);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
  });
});
