import { Rng } from './rng';

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Seeded 2D simplex noise in roughly [-1, 1]. */
export class Simplex {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(xin: number, yin: number): number {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const corner = (gi: number, x: number, y: number) => {
      let t0 = 0.5 - x * x - y * y;
      if (t0 < 0) return 0;
      t0 *= t0;
      const g = GRAD[gi % 8];
      return t0 * t0 * (g[0] * x + g[1] * y);
    };
    const n0 = corner(this.perm[ii + this.perm[jj]], x0, y0);
    const n1 = corner(this.perm[ii + i1 + this.perm[jj + j1]], x1, y1);
    const n2 = corner(this.perm[ii + 1 + this.perm[jj + 1]], x2, y2);
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal noise mapped to [0, 1]. */
  fbm(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return (sum / norm + 1) / 2;
  }
}
