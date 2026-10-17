import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js';

/** Where one cell's pixels sit inside a chunk buffer (reused between calls; copy what you keep). */
export interface CellSlot {
  data: Uint8ClampedArray;
  /** Row stride of `data`, in pixels. */
  stride: number;
  /** Top-left pixel of the cell inside `data`. */
  ox: number;
  oy: number;
}

interface Chunk {
  data: Uint8ClampedArray;
  /** Size in pixels. */
  pw: number;
  ph: number;
  source: BufferImageSource;
  texture: Texture;
  /** Dirty pixel rows [lo, hi), or lo >= hi when clean. */
  lo: number;
  hi: number;
}

export interface BitmapOptions {
  /** Map size in cells. */
  w: number;
  h: number;
  /** Bitmap pixels per cell. */
  px: number;
  /** World units per cell (the sprites are scaled to this). */
  tile: number;
  /** Cells per chunk side. */
  chunk?: number;
  linear?: boolean;
}

/**
 * A map-sized RGBA bitmap kept as a grid of chunk textures fed straight from typed arrays.
 *
 * One big canvas texture had to be re-uploaded whole whenever a single cell changed (a 200x200
 * map at 8 px a cell is 10 MB per upload); here a changed cell only re-sends the few pixel rows
 * of its own chunk. Writing into typed arrays also skips the 2D canvas (putImageData then a
 * canvas-to-texture copy).
 */
export class ChunkedBitmap {
  readonly root = new Container();
  readonly w: number;
  readonly h: number;
  readonly px: number;
  private readonly chunkCells: number;
  private readonly cols: number;
  private readonly chunks: Chunk[] = [];
  private readonly dirty = new Set<Chunk>();
  private readonly slot: CellSlot = { data: new Uint8ClampedArray(0), stride: 0, ox: 0, oy: 0 };
  /** Bytes sent to the GPU by flush() so far (for profiling). */
  uploaded = 0;

  constructor(o: BitmapOptions) {
    this.w = o.w;
    this.h = o.h;
    this.px = o.px;
    this.chunkCells = o.chunk ?? 32;
    const cc = this.chunkCells;
    this.cols = Math.ceil(o.w / cc);
    const rows = Math.ceil(o.h / cc);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const pw = Math.min(cc, o.w - cx * cc) * o.px;
        const ph = Math.min(cc, o.h - cy * cc) * o.px;
        const data = new Uint8ClampedArray(pw * ph * 4);
        const source = new BufferImageSource({
          resource: data,
          width: pw,
          height: ph,
          format: 'rgba8unorm',
          // Callers write colour premultiplied by alpha, as the sprite shader expects.
          alphaMode: 'premultiplied-alpha',
          scaleMode: o.linear ? 'linear' : 'nearest',
        });
        const texture = new Texture({ source });
        const s = new Sprite(texture);
        // Whole-number positions inside the (render group) layer, so neighbouring chunks meet exactly.
        s.position.set(cx * cc * o.tile, cy * cc * o.tile);
        s.scale.set(o.tile / o.px);
        this.root.addChild(s);
        this.chunks.push({ data, pw, ph, source, texture, lo: 0, hi: 0 });
      }
    }
  }

  /**
   * The buffer and offset to paint cell `c` into, and marks those pixel rows for upload. The
   * returned object is shared: use it before the next call.
   */
  cell(c: number): CellSlot {
    const x = c % this.w;
    const y = (c / this.w) | 0;
    const cc = this.chunkCells;
    const k = this.chunks[((y / cc) | 0) * this.cols + ((x / cc) | 0)];
    const oy = (y % cc) * this.px;
    if (k.lo >= k.hi) {
      k.lo = oy;
      k.hi = oy + this.px;
      this.dirty.add(k);
    } else {
      if (oy < k.lo) k.lo = oy;
      if (oy + this.px > k.hi) k.hi = oy + this.px;
    }
    const s = this.slot;
    s.data = k.data;
    s.stride = k.pw;
    s.ox = (x % cc) * this.px;
    s.oy = oy;
    return s;
  }

  /** Mark everything for upload (after repainting the whole map). */
  markAll(): void {
    for (const k of this.chunks) {
      k.lo = 0;
      k.hi = k.ph;
      this.dirty.add(k);
    }
  }

  /** Send the dirty rows of each touched chunk to the GPU, one span per chunk. */
  flush(): void {
    for (const k of this.dirty) {
      if (k.lo === 0 && k.hi === k.ph) k.source.update();
      else k.source.update(k.lo * k.pw, k.hi * k.pw);
      this.uploaded += (k.hi - k.lo) * k.pw * 4;
      k.lo = k.hi = 0;
    }
    this.dirty.clear();
  }

  destroy(): void {
    this.root.destroy({ children: true });
    for (const k of this.chunks) k.texture.destroy(true);
    this.chunks.length = 0;
    this.dirty.clear();
  }
}

/**
 * A small whole-map bitmap (a few pixels per cell) in one texture, fed from a typed array: fog,
 * frost and night light. Cheaper than a canvas (no putImageData, no canvas-to-texture copy), and
 * update() can send just the rows that changed. Pixels are RGBA, colour premultiplied by alpha.
 */
export class MapBitmap {
  readonly data: Uint8ClampedArray;
  readonly source: BufferImageSource;
  readonly texture: Texture;
  readonly sprite: Sprite;

  constructor(
    readonly width: number,
    readonly height: number,
    worldScale: number,
    o: { linear?: boolean } = {},
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    this.source = new BufferImageSource({
      resource: this.data,
      width,
      height,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: o.linear ? 'linear' : 'nearest',
    });
    this.texture = new Texture({ source: this.source });
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(worldScale);
  }

  /** Upload pixel rows [y0, y1), or everything. */
  update(y0 = 0, y1 = this.height): void {
    if (y0 <= 0 && y1 >= this.height) this.source.update();
    else if (y1 > y0) this.source.update(y0 * this.width, y1 * this.width);
  }

  destroy(): void {
    this.sprite.destroy();
    this.texture.destroy(true);
  }
}
