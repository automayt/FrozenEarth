import { Container, Sprite, Texture } from 'pixi.js';

/** Supersampling of the mark textures, so they stay smooth when zoomed in. */
const RES = 4;

let textures: { arc: Texture; box: Texture } | null = null;

/**
 * White marks with a dark under-stroke, tinted per use: a short arc (radius `r`, spanning ±0.5 rad
 * around +x, centred on the texture) and a cell outline (`tile` square).
 */
function markTextures(r: number, tile: number): { arc: Texture; box: Texture } {
  if (textures) return textures;
  const size = Math.ceil((r + 6) * 2 * RES);
  const a = document.createElement('canvas');
  a.width = a.height = size;
  const g = a.getContext('2d')!;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(size / 2, size / 2, r * RES, -0.5, 0.5);
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 6 * RES;
  g.stroke();
  g.strokeStyle = '#fff';
  g.lineWidth = 3.5 * RES;
  g.stroke();
  const b = document.createElement('canvas');
  b.width = b.height = tile * RES;
  const h = b.getContext('2d')!;
  h.strokeStyle = 'rgba(255,255,255,0.75)';
  h.lineWidth = 1.5 * RES;
  h.strokeRect(2.75 * RES, 2.75 * RES, (tile - 5.5) * RES, (tile - 5.5) * RES);
  textures = { arc: Texture.from(a), box: Texture.from(b) };
  return textures;
}

/**
 * Pooled sprites for per-frame markers (cover arcs and cover-cell outlines). Moving, turning and
 * tinting sprites is nearly free, where stroking the same arcs into a Graphics every frame meant
 * re-tessellating them all (over a millisecond with twenty drafted colonists under fire).
 */
export class Marks {
  readonly view = new Container();
  private arcs: Sprite[] = [];
  private boxes: Sprite[] = [];
  private nArcs = 0;
  private nBoxes = 0;
  private readonly r: number;
  private readonly tile: number;

  constructor(r: number, tile: number) {
    this.r = r;
    this.tile = tile;
  }

  begin(): void {
    this.nArcs = 0;
    this.nBoxes = 0;
  }

  /** An arc on a circle around (x, y), centred on `angle`. */
  arc(x: number, y: number, angle: number, color: number, alpha: number): void {
    let s = this.arcs[this.nArcs];
    if (!s) {
      s = new Sprite(markTextures(this.r, this.tile).arc);
      s.anchor.set(0.5);
      s.scale.set(1 / RES);
      this.arcs.push(s);
      this.view.addChild(s);
    }
    this.nArcs++;
    s.visible = true;
    s.position.set(x, y);
    s.rotation = angle;
    s.tint = color;
    s.alpha = alpha;
  }

  /** An outline around the cell whose top-left corner is (x, y). */
  box(x: number, y: number, color: number, alpha: number): void {
    let s = this.boxes[this.nBoxes];
    if (!s) {
      s = new Sprite(markTextures(this.r, this.tile).box);
      s.scale.set(1 / RES);
      this.boxes.push(s);
      this.view.addChild(s);
    }
    this.nBoxes++;
    s.visible = true;
    s.position.set(x, y);
    s.tint = color;
    s.alpha = alpha;
  }

  /** Hide whatever this frame didn't use. */
  end(): void {
    for (let i = this.nArcs; i < this.arcs.length; i++) this.arcs[i].visible = false;
    for (let i = this.nBoxes; i < this.boxes.length; i++) this.boxes[i].visible = false;
  }
}
